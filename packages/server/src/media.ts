import fs from "node:fs/promises";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { id, now } from "./db.js";

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  if (v === "::1" || v === "0.0.0.0") return true;
  if (v.includes(":")) {
    return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const parts = v.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  if (h === "metadata.google.internal") return true;
  if (isIP(h)) return isPrivateIp(h);
  return false;
}

export async function assertSafeHttpsUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("非法媒体地址");
  }
  if (parsed.protocol !== "https:") throw new Error("只允许 HTTPS 媒体地址");
  if (parsed.username || parsed.password) throw new Error("非法媒体地址");
  if (isBlockedHost(parsed.hostname)) throw new Error("非法媒体地址");
  if (!isIP(parsed.hostname)) {
    const addrs = await lookup(parsed.hostname, { all: true });
    if (!addrs.length || addrs.some((row) => isPrivateIp(row.address))) {
      throw new Error("非法媒体地址");
    }
  }
}

export async function persistRemoteFile(mediaDir: string, url: string, extHint: string): Promise<string> {
  await assertSafeHttpsUrl(url);
  const fileId = id("file");
  const ext = extHint.startsWith(".") ? extHint : `.${extHint}`;
  const localPath = path.join(mediaDir, `${fileId}${ext}`);
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`下载媒体失败 ${res.status}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_MEDIA_BYTES) throw new Error("媒体文件过大");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_MEDIA_BYTES) throw new Error("媒体文件过大");
  await fs.writeFile(localPath, buf);
  return localPath;
}

export async function persistBase64(mediaDir: string, b64: string, ext: string): Promise<string> {
  const fileId = id("file");
  const localPath = path.join(mediaDir, `${fileId}${ext}`);
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const buf = Buffer.from(clean, "base64");
  if (buf.length > MAX_MEDIA_BYTES) throw new Error("媒体文件过大");
  await fs.writeFile(localPath, buf);
  return localPath;
}

export function insertMedia(
  db: DatabaseSync,
  row: {
    type: string;
    status: string;
    prompt: string;
    model: string;
    params?: unknown;
    conversationId?: string | null;
    accountId?: string | null;
    resultUrl?: string | null;
    localPath?: string | null;
    error?: string | null;
    providerId?: string | null;
  },
): string {
  const mediaId = id("media");
  const ts = now();
  db.prepare(
    `INSERT INTO media_jobs (id, conversation_id, account_id, type, status, prompt, model, params, result_url, local_path, error, provider_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mediaId,
    row.conversationId ?? null,
    row.accountId ?? null,
    row.type,
    row.status,
    row.prompt,
    row.model,
    JSON.stringify(row.params ?? {}),
    row.resultUrl ?? null,
    row.localPath ?? null,
    row.error ?? null,
    row.providerId ?? null,
    ts,
    ts,
  );
  return mediaId;
}

export function updateMedia(
  db: DatabaseSync,
  mediaId: string,
  patch: Partial<{
    status: string;
    result_url: string | null;
    local_path: string | null;
    error: string | null;
    provider_id: string | null;
  }>,
): void {
  const current = db.prepare("SELECT * FROM media_jobs WHERE id = ?").get(mediaId) as Record<string, unknown> | undefined;
  if (!current) return;
  db.prepare(
    `UPDATE media_jobs SET status=?, result_url=?, local_path=?, error=?, provider_id=?, updated_at=? WHERE id=?`,
  ).run(
    (patch.status ?? current.status) as string,
    (patch.result_url !== undefined ? patch.result_url : current.result_url) as string | null,
    (patch.local_path !== undefined ? patch.local_path : current.local_path) as string | null,
    (patch.error !== undefined ? patch.error : current.error) as string | null,
    (patch.provider_id !== undefined ? patch.provider_id : current.provider_id) as string | null,
    now(),
    mediaId,
  );
}

const MEDIA_EXT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".png": "image/png",
};

export function mediaContentType(filePath: string): string {
  return MEDIA_EXT_TYPES[path.extname(filePath).toLowerCase()] || "image/png";
}

/** 生成内容按 id 存盘后不再改写，30 天强缓存；要登录才能取，所以是 private */
export const MEDIA_CACHE_CONTROL = "private, max-age=2592000, immutable";

/** 下载文件名：agnes-image-20261010-153012-ab12cd.png（纯 ASCII，各浏览器都认） */
export function mediaDownloadName(row: { id: string; type: string; created_at: number }, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase() || (row.type === "video" ? ".mp4" : ".png");
  const d = new Date(Number(row.created_at) || Date.now());
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const kind = row.type === "video" ? "video" : "image";
  const tail = row.id.replace(/[^A-Za-z0-9]/g, "").slice(-6) || "media";
  return `agnes-${kind}-${stamp}-${tail}${ext}`;
}

export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 一次请求出多张图：每张独立跑，最多 limit 张同时进行 */
export async function runPool<T>(count: number, limit: number, task: (index: number) => Promise<T>): Promise<T[]> {
  const out = new Array<T>(count);
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const index = next++;
      out[index] = await task(index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, count)) }, worker));
  return out;
}

export const MAX_IMAGES_PER_REQUEST = 4;
export const MAX_IMAGE_PARALLEL = 3;

export function imageCountOf(raw: unknown): number {
  const n = Math.floor(Number(raw) || 1);
  return Math.max(1, Math.min(MAX_IMAGES_PER_REQUEST, n));
}

/** 授权服务器中转在退回额度后，会在错误 JSON 里加 agnes_refunded: true */
export function relayRefundedFlag(err: unknown): boolean {
  const body = err && typeof err === "object" ? (err as { body?: unknown }).body : undefined;
  if (typeof body !== "string" || !body.includes("agnes_refunded")) return false;
  try {
    return Boolean((JSON.parse(body) as { agnes_refunded?: unknown }).agnes_refunded);
  } catch {
    return false;
  }
}

export function mediaPublicPath(mediaId: string, publicOrigin = ""): string {
  const rel = `/api/media/${mediaId}`;
  const origin = publicOrigin.replace(/\/$/, "");
  return origin ? `${origin}${rel}` : rel;
}

/**
 * 从 `/api/media/:id` 或带 PUBLIC_API_ORIGIN 的绝对地址里抽出 id。
 * 这类地址要登录才能下，不能交给 Agnes 去 GET（会 401，count_token_failed）。
 */
export function mediaIdFromRef(ref: string): string {
  const raw = String(ref || "").trim();
  if (!raw || raw.startsWith("data:")) return "";
  const pathName = raw.startsWith("/")
    ? raw.split("?")[0]
    : (() => {
        try {
          return new URL(raw).pathname;
        } catch {
          return "";
        }
      })();
  const m = /^\/api\/media\/([^/]+)$/.exec(pathName);
  return m?.[1] ?? "";
}
