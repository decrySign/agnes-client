import type { DatabaseSync } from "node:sqlite";
import { isLoopbackIp } from "./security.js";
import { id, now } from "./db.js";
function ipSource(ip: string): string {
  const v = (ip || "").trim().toLowerCase();
  if (!v || v === "127.0.0.1" || v === "::1" || v.startsWith("127.")) return "本机";
  return "公网";
}
import { parseUserAgent } from "./useragent.js";

export type DailyChatStatus = {
  ok: boolean;
  used: number;
  remaining: number | null;
  limit: number;
  windowDays: number;
  hit?: "ip" | "device";
};

export type RequestLogRow = {
  id: string;
  created_at: number;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  ip: string;
  device_hash: string;
  kind: string;
  error: string;
  user_agent: string;
};

export type RequestLogView = RequestLogRow & {
  ipSource: string;
  os: string;
  browser: string;
};

export function shanghaiDay(ts = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(ts));
}

function countDaily(db: DatabaseSync, day: string, subject: string, kind: string): number {
  const row = db.prepare("SELECT count FROM daily_counters WHERE day=? AND subject=? AND kind=?").get(day, subject, kind) as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0);
}

function bumpDaily(db: DatabaseSync, day: string, subject: string, kind: string): void {
  db.prepare(
    "INSERT INTO daily_counters (day, subject, kind, count) VALUES (?, ?, ?, 1) ON CONFLICT(day, subject, kind) DO UPDATE SET count = count + 1",
  ).run(day, subject, kind);
}

export function shanghaiDaysBack(windowDays: number, ts = Date.now()): string[] {
  const n = Math.max(1, Math.floor(windowDays));
  const days: string[] = [];
  for (let i = 0; i < n; i++) days.push(shanghaiDay(ts - i * 24 * 3600 * 1000));
  return days;
}

function usedInWindow(db: DatabaseSync, days: string[], subject: string, kind: string): number {
  let used = 0;
  for (const day of days) used += countDaily(db, day, subject, kind);
  return used;
}

/** 本机 IP 不计（自用/开发），但只要有设备码就按设备计，免得桌面免费版无上限 */
function countableIp(ip: string): boolean {
  return Boolean(ip) && !isLoopbackIp(ip);
}

export function inspectQuota(
  db: DatabaseSync,
  ip: string,
  deviceHash: string,
  kind: string,
  limit: number,
  windowDays = 1,
): DailyChatStatus {
  const window = Math.max(1, Math.floor(windowDays));
  if (limit <= 0) return { ok: true, used: 0, remaining: null, limit, windowDays: window };
  const useIp = countableIp(ip);
  if (!useIp && !deviceHash) return { ok: true, used: 0, remaining: limit, limit, windowDays: window };
  const days = shanghaiDaysBack(window);
  const ipUsed = useIp ? usedInWindow(db, days, `ip:${ip}`, kind) : 0;
  const deviceUsed = deviceHash ? usedInWindow(db, days, `device:${deviceHash}`, kind) : 0;
  const used = Math.max(ipUsed, deviceUsed);
  return {
    ok: used < limit,
    used,
    remaining: Math.max(0, limit - used),
    limit,
    windowDays: window,
    hit: ipUsed >= limit ? "ip" : deviceUsed >= limit ? "device" : undefined,
  };
}

export function takeQuota(
  db: DatabaseSync,
  ip: string,
  deviceHash: string,
  kind: string,
  limit: number,
  windowDays = 1,
): DailyChatStatus {
  const window = Math.max(1, Math.floor(windowDays));
  if (limit <= 0) return { ok: true, used: 0, remaining: null, limit, windowDays: window };
  const useIp = countableIp(ip);
  if (!useIp && !deviceHash) return { ok: true, used: 0, remaining: limit, limit, windowDays: window };
  const days = shanghaiDaysBack(window);
  const today = days[0];
  const ipKey = useIp ? `ip:${ip}` : "";
  const deviceKey = deviceHash ? `device:${deviceHash}` : "";
  db.exec("BEGIN IMMEDIATE");
  try {
    const ipUsed = ipKey ? usedInWindow(db, days, ipKey, kind) : 0;
    const deviceUsed = deviceKey ? usedInWindow(db, days, deviceKey, kind) : 0;
    const used = Math.max(ipUsed, deviceUsed);
    if (used >= limit) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        used,
        remaining: 0,
        limit,
        windowDays: window,
        hit: ipUsed >= limit ? "ip" : "device",
      };
    }
    if (ipKey) bumpDaily(db, today, ipKey, kind);
    if (deviceKey) bumpDaily(db, today, deviceKey, kind);
    db.exec("COMMIT");
    const next = used + 1;
    return { ok: true, used: next, remaining: Math.max(0, limit - next), limit, windowDays: window };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function refundQuota(db: DatabaseSync, ip: string, deviceHash: string, kind: string): void {
  const useIp = countableIp(ip);
  if (!useIp && !deviceHash) return;
  const today = shanghaiDay();
  const dec = (subject: string) => {
    const row = db.prepare("SELECT count FROM daily_counters WHERE day=? AND subject=? AND kind=?").get(today, subject, kind) as
      | { count: number }
      | undefined;
    if (row && Number(row.count) > 0) {
      db.prepare("UPDATE daily_counters SET count = count - 1 WHERE day=? AND subject=? AND kind=?").run(today, subject, kind);
    }
  };
  if (useIp) dec(`ip:${ip}`);
  if (deviceHash) dec(`device:${deviceHash}`);
}

export function inspectDailyChat(db: DatabaseSync, ip: string, deviceHash: string, limit: number): DailyChatStatus {
  return inspectQuota(db, ip, deviceHash, "chat", limit, 1);
}

export function takeDailyChat(db: DatabaseSync, ip: string, deviceHash: string, limit: number): DailyChatStatus {
  return takeQuota(db, ip, deviceHash, "chat", limit, 1);
}

export function quotaExhaustedMessage(kind: "chat" | "image" | "video", limit: number, windowDays = 1): string {
  if (kind === "chat") return DAILY_CHAT_EXHAUSTED;
  if (kind === "image") return `今日出图次数已用完（每天 ${limit} 张）`;
  return `近 ${windowDays} 天视频次数已用完（每 ${windowDays} 天 ${limit} 条）`;
}

// Only the requests that actually hit Agnes or move a quota are worth logging.
// Config fetches / list reads / polling (session, settings, conversations,
// personas, media list, video poll, updates, diffs, workspace) are noise.
export function shouldLogRequest(method: string, pathName: string): boolean {
  if (method !== "POST") return false;
  if (pathName.endsWith("/messages")) return true;
  if (pathName === "/api/images/generate") return true;
  if (pathName === "/api/videos/generate") return true;
  if (pathName === "/api/oss-no-relay/videos") return true;
  if (pathName === "/api/oss-no-relay/images/generations") return true;
  if (pathName === "/api/oss-removed/trial") return true;
  if (pathName === "/api/entitlements/consume") return true;
  if (pathName === "/api/oss-removed/activate") return true;
  if (pathName === "/api/oss-removed/beta-month") return true;
  if (pathName === "/api/feedbacks") return true;
  if (pathName === "/api/auth") return true;
  return false;
}

export function kindFromPath(pathName: string): string {
  if (pathName.includes("/messages")) return "chat";
  if (pathName.includes("/entitlements/trial")) return "trial";
  if (pathName.includes("/entitlements/beta-month")) return "beta";
  if (pathName.includes("/entitlements/activate")) return "activate";
  if (pathName.includes("/entitlements/consume")) return "consume";
  if (pathName.includes("/images")) return "image";
  if (pathName.includes("/videos")) return "video";
  if (pathName.includes("/updates")) return "update";
  if (pathName.includes("/feedbacks")) return "feedback";
  if (pathName.includes("/auth")) return "auth";
  return "api";
}

export function insertRequestLog(
  db: DatabaseSync,
  row: {
    method: string;
    path: string;
    status: number;
    durationMs: number;
    ip: string;
    deviceHash: string;
    kind: string;
    error?: string;
    userAgent?: string;
  },
): void {
  db.prepare(
    "INSERT INTO request_logs (id, created_at, method, path, status, duration_ms, ip, device_hash, kind, error, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id("rl"),
    now(),
    row.method.slice(0, 16),
    row.path.slice(0, 240),
    row.status,
    Math.max(0, Math.floor(row.durationMs)),
    row.ip.slice(0, 64),
    row.deviceHash.slice(0, 64),
    row.kind.slice(0, 32),
    (row.error ?? "").slice(0, 200),
    (row.userAgent ?? "").slice(0, 400),
  );
  if (Math.random() < 0.02) pruneRequestLogs(db);
}

function enrichLog(row: RequestLogRow): RequestLogView {
  const { os, browser } = parseUserAgent(row.user_agent);
  return { ...row, ipSource: ipSource(row.ip), os, browser };
}

export function pruneRequestLogs(db: DatabaseSync, keepMs = 30 * 24 * 3600 * 1000): void {
  db.prepare("DELETE FROM request_logs WHERE created_at < ?").run(Date.now() - keepMs);
}

export function listRequestLogs(
  db: DatabaseSync,
  query: { q?: string; kind?: string; http?: string; page?: number; pageSize?: number },
): { items: RequestLogView[]; total: number; stats: { today: number; todayChat: number; todayError: number; today429: number } } {
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 50, 1), 200);
  const page = Math.max(Number(query.page) || 1, 1);
  const offset = (page - 1) * pageSize;
  const where: string[] = [];
  const args: Array<string | number> = [];
  const text = (query.q ?? "").trim();
  if (text) {
    where.push("(ip LIKE ? OR device_hash LIKE ? OR path LIKE ? OR error LIKE ?)");
    const like = `%${text}%`;
    args.push(like, like, like, like);
  }
  if (query.kind) {
    where.push("kind = ?");
    args.push(query.kind);
  }
  if (query.http === "ok") where.push("status < 400");
  if (query.http === "err") where.push("status >= 400");
  if (query.http === "429") where.push("status = 429");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM request_logs ${clause}`).get(...args) as { c: number }).c;
  const items = db
    .prepare(`SELECT * FROM request_logs ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, offset) as RequestLogRow[];
  const dayStart = Date.parse(`${shanghaiDay()}T00:00:00+08:00`);
  const statsRow = db
    .prepare(
      "SELECT COUNT(*) AS today, SUM(CASE WHEN kind='chat' THEN 1 ELSE 0 END) AS todayChat, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) AS todayError, SUM(CASE WHEN status=429 THEN 1 ELSE 0 END) AS today429 FROM request_logs WHERE created_at >= ?",
    )
    .get(dayStart) as { today: number; todayChat: number; todayError: number; today429: number };
  return {
    items: items.map(enrichLog),
    total: Number(total),
    stats: {
      today: Number(statsRow.today || 0),
      todayChat: Number(statsRow.todayChat || 0),
      todayError: Number(statsRow.todayError || 0),
      today429: Number(statsRow.today429 || 0),
    },
  };
}

export const DAILY_CHAT_EXHAUSTED = "今日对话次数已用完（每浏览器 / IP / 设备每天 30 次）";
