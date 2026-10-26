import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { AgnesApiError, describeNetworkError } from "@agnes/sdk";

export function tokensMatch(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

const buckets = new Map<string, { count: number; resetAt: number }>();
const ipFuses = new Map<string, number>();

function sweepLimits(now: number): void {
  if (buckets.size > 10_000) {
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  }
  if (ipFuses.size > 10_000) {
    for (const [key, until] of ipFuses) {
      if (now >= until) ipFuses.delete(key);
    }
  }
}

export function takeRate(key: string, max: number, windowMs: number): { ok: boolean; resetAt: number } {
  const now = Date.now();
  sweepLimits(now);
  const cur = buckets.get(key);
  if (!cur || now >= cur.resetAt) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { ok: true, resetAt };
  }
  if (cur.count >= max) return { ok: false, resetAt: cur.resetAt };
  cur.count += 1;
  return { ok: true, resetAt: cur.resetAt };
}

export function allowRate(key: string, max: number, windowMs: number): boolean {
  return takeRate(key, max, windowMs).ok;
}

export function isLoopbackIp(ip: string): boolean {
  return normalizeIp(ip) === "127.0.0.1";
}

const HOUR_MS = 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * HOUR_MS;

export function hitIpQuota(
  ip: string,
  kind: string,
  hourMax: number,
  fiveHourMax: number,
): { ok: boolean; retryAfterSec: number } {
  if (!ip || isLoopbackIp(ip)) return { ok: true, retryAfterSec: 0 };
  const now = Date.now();
  const fusedUntil = ipFuses.get(ip);
  if (fusedUntil && now < fusedUntil) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((fusedUntil - now) / 1000)) };
  }
  if (fusedUntil) ipFuses.delete(ip);
  if (hourMax > 0) {
    const hour = takeRate(`qh:${kind}:${ip}`, hourMax, HOUR_MS);
    if (!hour.ok) {
      ipFuses.set(ip, hour.resetAt);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((hour.resetAt - now) / 1000)) };
    }
  }
  if (fiveHourMax > 0) {
    const five = takeRate(`q5:${kind}:${ip}`, fiveHourMax, FIVE_HOUR_MS);
    if (!five.ok) {
      ipFuses.set(ip, five.resetAt);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((five.resetAt - now) / 1000)) };
    }
  }
  return { ok: true, retryAfterSec: 0 };
}

function fuseJson(c: Context, retryAfterSec: number) {
  c.header("Retry-After", String(retryAfterSec));
  return c.json({ error: "该网络访问过于频繁，已暂时熔断" }, 429);
}

export function ipFusedGuard(proxy: ProxyTrust, skipPath: (pathName: string) => boolean) {
  return async (c: Context, next: Next) => {
    const pathName = new URL(c.req.url).pathname;
    if (skipPath(pathName)) return next();
    const ip = requestIp(c, proxy);
    const fused = hitIpQuota(ip, "probe", 0, 0);
    if (!fused.ok) return fuseJson(c, fused.retryAfterSec);
    return next();
  };
}

export function quotaThenFuse(
  kind: string,
  hourMax: number,
  fiveHourMax: number,
  proxy: ProxyTrust,
  skipPath?: (pathName: string) => boolean,
) {
  return async (c: Context, next: Next) => {
    if (skipPath?.(new URL(c.req.url).pathname)) return next();
    const ip = requestIp(c, proxy);
    const hit = hitIpQuota(ip, kind, hourMax, fiveHourMax);
    if (!hit.ok) return fuseJson(c, hit.retryAfterSec);
    return next();
  };
}

export type IpPolicy = {
  allowAll: boolean;
  rules: string[];
};

export type ProxyTrust = {
  trustProxy: boolean;
  trustedProxies: IpPolicy;
};

export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "localhost" || ip === "::1" || ip === "0:0:0:0:0:0:0:1") return "127.0.0.1";
  if (ip === "0.0.0.0") return "";
  return ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function expandIpv6(ip: string): string | null {
  if (ip.includes(".")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1) {
    const parts = ip.split(":");
    if (parts.length !== 8) return null;
    return parts.map((p) => p.padStart(4, "0")).join(":");
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const filled = [...head, ...Array(missing).fill("0"), ...tail];
  if (filled.length !== 8 || filled.some((p) => !/^[0-9a-f]{0,4}$/i.test(p))) return null;
  return filled.map((p) => p.padStart(4, "0")).join(":");
}

function ipv6ToBig(ip: string): bigint | null {
  const expanded = expandIpv6(ip);
  if (!expanded) return null;
  try {
    return BigInt(`0x${expanded.replaceAll(":", "")}`);
  } catch {
    return null;
  }
}

export function ipMatchesRule(ip: string, rule: string): boolean {
  const host = normalizeIp(ip);
  const spec = rule.trim().toLowerCase();
  if (!host || !spec) return false;
  if (spec === "*" || spec === "any") return true;
  if (spec === "loopback" || spec === "localhost") return host === "127.0.0.1";
  if (!spec.includes("/")) return host === normalizeIp(spec);
  const [baseRaw, bitsRaw] = spec.split("/");
  const bits = Number(bitsRaw);
  const base = normalizeIp(baseRaw);
  if (!base || !Number.isInteger(bits) || bits < 0) return false;
  if (isIP(host) === 4 && isIP(base) === 4) {
    if (bits > 32) return false;
    const ipN = ipv4ToInt(host);
    const baseN = ipv4ToInt(base);
    if (ipN === null || baseN === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipN & mask) === (baseN & mask);
  }
  if (isIP(host) === 6 && isIP(base) === 6) {
    if (bits > 128) return false;
    const ipN = ipv6ToBig(host);
    const baseN = ipv6ToBig(base);
    if (ipN === null || baseN === null) return false;
    const shift = 128n - BigInt(bits);
    const mask = bits === 0 ? 0n : (~0n << shift) & ((1n << 128n) - 1n);
    return (ipN & mask) === (baseN & mask);
  }
  return false;
}

function splitRules(raw: string): string[] {
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

export function parseAllowedIps(raw: string, opts: { desktopMode: boolean }): IpPolicy {
  if (opts.desktopMode) return { allowAll: true, rules: [] };
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "any") return { allowAll: true, rules: [] };
  return { allowAll: false, rules: splitRules(trimmed) };
}

const DEFAULT_TRUSTED_PROXIES = ["127.0.0.1", "127.0.0.0/8", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];

export function parseTrustedProxies(raw: string, desktopMode: boolean): IpPolicy {
  if (desktopMode) return { allowAll: true, rules: [] };
  const trimmed = raw.trim();
  if (trimmed === "*" || trimmed.toLowerCase() === "any") return { allowAll: true, rules: [] };
  if (!trimmed) return { allowAll: false, rules: DEFAULT_TRUSTED_PROXIES };
  return { allowAll: false, rules: splitRules(trimmed) };
}

export function isIpAllowed(ip: string, policy: IpPolicy): boolean {
  if (policy.allowAll) return true;
  return policy.rules.some((rule) => ipMatchesRule(ip, rule));
}

export function pickClientIp(
  socketRaw: string,
  headers: { realIp?: string; forwardedFor?: string },
  proxy: ProxyTrust,
): string {
  const socket = normalizeIp(socketRaw);
  const fallback = socket || "127.0.0.1";
  if (!proxy.trustProxy) return fallback;
  if (socket && !isIpAllowed(socket, proxy.trustedProxies)) return fallback;
  const real = normalizeIp(headers.realIp || "");
  if (real && isIP(real)) return real;
  const forwarded = (headers.forwardedFor || "")
    .split(",")
    .map((part) => normalizeIp(part))
    .filter((part) => Boolean(part) && isIP(part));
  if (forwarded.length) return forwarded[forwarded.length - 1];
  return fallback;
}

function socketIp(c: Context): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return normalizeIp(incoming?.socket?.remoteAddress || "");
}

export function requestIp(c: Context, proxy: ProxyTrust): string {
  return pickClientIp(
    socketIp(c),
    {
      realIp: c.req.header("x-real-ip"),
      forwardedFor: c.req.header("x-forwarded-for"),
    },
    proxy,
  );
}

export function clientIp(c: Context, proxy: ProxyTrust): string {
  return requestIp(c, proxy);
}

export function rateLimit(max: number, windowMs: number, prefix: string, proxy: ProxyTrust) {
  return async (c: Context, next: Next) => {
    const ip = requestIp(c, proxy);
    if (!allowRate(`${prefix}:${ip}`, max, windowMs)) {
      return c.json({ error: "请求过于频繁，请稍后再试" }, 429);
    }
    return next();
  };
}

export function ipAllowlist(policy: IpPolicy, proxy: ProxyTrust, skipPath: (pathName: string) => boolean) {
  return async (c: Context, next: Next) => {
    if (policy.allowAll) return next();
    const pathName = new URL(c.req.url).pathname;
    if (skipPath(pathName)) return next();
    const ip = requestIp(c, proxy);
    if (!isIpAllowed(ip, policy)) {
      return c.json({ error: "禁止访问" }, 403);
    }
    return next();
  };
}

export function describeIpPolicy(policy: IpPolicy): string {
  if (policy.allowAll) return "any";
  return policy.rules.join(", ") || "(empty)";
}

export function safeDownloadName(name: string): string {
  const base = name.replace(/[\r\n"]/g, "").replace(/[^\w.\u4e00-\u9fff-]+/g, "_");
  return base.slice(0, 80) || "download";
}

export function safeUploadName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() || "upload";
  if (base === "." || base === ".." || base.includes("\0")) throw new Error("非法文件名");
  return base.slice(0, 120);
}

export function publicError(err: unknown, production: boolean): string {
  // Agnes 上游的业务错误（队列满、402、429）已经是给人看的中文，生产环境也要原样给界面
  if (err instanceof AgnesApiError) return err.message;
  if (err instanceof Error && (err.message === "fetch failed" || err.message.startsWith("连接模型通道失败"))) {
    return describeNetworkError(err);
  }
  if (!production && err instanceof Error) return err.message;
  return "请求失败";
}
