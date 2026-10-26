import { createHmac } from "node:crypto";
import { tokensMatch } from "./security.js";

/**
 * 桌面端不再自带 Token Plan 密钥：模型调用改打授权服务器的 /api/relay，由服务器用自己的
 * AGNES_API_KEY 转发到上游。令牌是 HMAC(secret, deviceHash)，无状态、绑定单台设备，
 * 客户端拿不到别的设备的令牌，也伪造不出来。
 */
const TOKEN_PREFIX = "agnes-relay:v1:";
const TOKEN_V2_PREFIX = "agnes-relay:v2:";
const CHAT_TICKET_PREFIX = "agnes-chat:v1:";
/** 一轮用户消息的通行证。Agent 循环里多次打模型都复用这一张，过期后再扣一次。 */
export const CHAT_TICKET_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * v2 令牌带签发 / 到期时间。客户端每次查授权状态（每条消息前都会查）都会拿到新的，
 * 所以 30 天只是「长期不联网的设备」的上限。
 */
export const RELAY_TOKEN_TTL_MS = 30 * DAY_MS;

export const RELAY_PATH = "/api/relay";

/** 旧版令牌：HMAC(secret, device)，不过期。只用于兼容已经装好的老客户端。 */
export function legacyRelayTokenFor(secret: string, deviceHash: string): string {
  if (!secret || !deviceHash) return "";
  return createHmac("sha256", secret).update(`${TOKEN_PREFIX}${deviceHash}`).digest("hex");
}

/**
 * 签发时间按天取整，同一天内令牌不变，客户端不会每次轮询都换一枚。
 * notBefore 是后台「重置中转令牌」的时间：之前签的全部作废，新签的从这一刻起算。
 */
export function relayTokenFor(secret: string, deviceHash: string, nowMs = Date.now(), notBefore = 0): string {
  if (!secret || !deviceHash) return "";
  const iat = Math.max(Math.floor(nowMs / DAY_MS) * DAY_MS, Math.floor(notBefore));
  const exp = iat + RELAY_TOKEN_TTL_MS;
  const mac = createHmac("sha256", secret).update(`${TOKEN_V2_PREFIX}${deviceHash}:${iat}:${exp}`).digest("hex");
  return `r2.${iat}.${exp}.${mac}`;
}

export type RelayTokenCheck = {
  /** 旧版不过期令牌还认不认；被重置过的设备一律不认 */
  acceptLegacy?: boolean;
  notBefore?: number;
  now?: number;
};

export function verifyRelayToken(secret: string, deviceHash: string, token: string, opts: RelayTokenCheck = {}): boolean {
  if (!secret || !deviceHash) return false;
  const raw = String(token || "").trim();
  const notBefore = Math.max(0, Number(opts.notBefore) || 0);
  if (!raw.startsWith("r2.")) {
    if (opts.acceptLegacy === false || notBefore > 0) return false;
    return tokensMatch(raw, legacyRelayTokenFor(secret, deviceHash));
  }
  const parts = raw.split(".");
  if (parts.length !== 4) return false;
  const iat = Number(parts[1]);
  const exp = Number(parts[2]);
  const at = opts.now ?? Date.now();
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return false;
  if (exp <= at || exp - iat !== RELAY_TOKEN_TTL_MS || iat > at + DAY_MS || iat < notBefore) return false;
  const mac = createHmac("sha256", secret).update(`${TOKEN_V2_PREFIX}${deviceHash}:${iat}:${exp}`).digest("hex");
  return tokensMatch(raw, `r2.${iat}.${exp}.${mac}`);
}

export function chatTicketFor(secret: string, deviceHash: string, expMs: number): string {
  if (!secret || !deviceHash || !Number.isFinite(expMs)) return "";
  const exp = Math.floor(expMs);
  const mac = createHmac("sha256", secret).update(`${CHAT_TICKET_PREFIX}${deviceHash}:${exp}`).digest("hex");
  return `${exp}.${mac}`;
}

export function issueChatTicket(secret: string, deviceHash: string, now = Date.now()): { ticket: string; exp: number } {
  const exp = now + CHAT_TICKET_TTL_MS;
  return { ticket: chatTicketFor(secret, deviceHash, exp), exp };
}

/** 票据绑设备、带过期时间。长期 HMAC 只证明是哪台设备，不能单独放行对话。 */
export function verifyChatTicket(secret: string, deviceHash: string, ticket: string, now = Date.now()): boolean {
  const raw = String(ticket || "").trim();
  const dot = raw.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(raw.slice(0, dot));
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = chatTicketFor(secret, deviceHash, exp);
  if (!expected) return false;
  return tokensMatch(raw, expected);
}

export function bearerOf(header: string | undefined): string {
  const raw = (header ?? "").trim();
  return raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : "";
}

export type RelayEndpoints = {
  baseUrl: string;
  videoPollUrl: string;
};

/** 客户端侧：把授权服务器地址翻成 SDK 能直接用的 baseUrl / 轮询地址。 */
export function relayEndpoints(licenseServerUrl: string): RelayEndpoints | null {
  const origin = String(licenseServerUrl || "").trim().replace(/\/+$/, "");
  if (!origin) return null;
  return {
    baseUrl: `${origin}${RELAY_PATH}`,
    videoPollUrl: `${origin}${RELAY_PATH}/videos/poll`,
  };
}

/** 中继只打固定的 Agnes 地址，不是通用代理。这些上限防止一张有效凭证把连接和内存堆满。 */
export const RELAY_CHAT_MAX_BYTES = 8 * 1024 * 1024;
export const RELAY_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const RELAY_STREAM_IDLE_MS = 3 * 60 * 1000;
export const RELAY_FETCH_TIMEOUT_MS = 10 * 60 * 1000;

/** 总时长上限。定时器不挡住进程退出；真正占着进程的是还没关的连接。 */
export function relayDeadline(ms: number, client?: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  timer.unref?.();
  if (!client) return ctrl.signal;
  const stop = () => {
    clearTimeout(timer);
    if (!ctrl.signal.aborted) ctrl.abort();
  };
  if (client.aborted) stop();
  else client.addEventListener("abort", stop, { once: true });
  return ctrl.signal;
}
export const RELAY_MAX_INFLIGHT = 8;

const relayInflight = new Map<string, number>();

export function tryAcquireRelay(deviceHash: string, max = RELAY_MAX_INFLIGHT): boolean {
  const current = relayInflight.get(deviceHash) ?? 0;
  if (current >= max) return false;
  relayInflight.set(deviceHash, current + 1);
  return true;
}

export function releaseRelay(deviceHash: string): void {
  const next = (relayInflight.get(deviceHash) ?? 1) - 1;
  if (next <= 0) relayInflight.delete(deviceHash);
  else relayInflight.set(deviceHash, next);
}

export function resetRelayInflight(): void {
  relayInflight.clear();
}

export async function readBodyLimited(req: Request, max: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > max) return { ok: false };
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    parts.push(value);
  }
  return { ok: true, text: Buffer.concat(parts).toString("utf8") };
}

/** 上游不再出数据、或客户端断开时，结束这路流并释放占用。 */
export function relayStream(
  source: ReadableStream<Uint8Array>,
  idleMs: number,
  client: AbortSignal,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    client.removeEventListener("abort", onAbort);
    onDone();
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      finish();
      void reader.cancel().catch(() => undefined);
    }, idleMs);
    timer.unref?.();
  };
  const onAbort = () => {
    finish();
    void reader.cancel().catch(() => undefined);
  };
  arm();
  if (client.aborted) onAbort();
  else client.addEventListener("abort", onAbort, { once: true });
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (finished) {
          controller.close();
          return;
        }
        arm();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel() {
      finish();
      return reader.cancel();
    },
  });
}
