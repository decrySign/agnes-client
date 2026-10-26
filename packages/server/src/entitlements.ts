import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getQuotaSettings } from "./catalog.js";
import { id, now } from "./db.js";

const CODE_ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type EntitlementRow = {
  id: string;
  device_hash: string;
  plan: "trial" | "licensed";
  status: "active" | "exhausted" | "revoked";
  chat_used: number;
  chat_quota: number;
  lead_wechat: string;
  lead_bonus_applied: number;
  license_id: string | null;
  allow_image: number;
  allow_video: number;
  allow_agent: number;
  created_at: number;
  updated_at: number;
  /** null = 永不过期（超管版 / 试用） */
  expires_at: number | null;
  is_super: number;
  /** 付费档：卡有效期内的图/视频总量，0 = 不限（免费档走每日额度，不用这里） */
  image_quota: number;
  image_used: number;
  video_quota: number;
  video_used: number;
  /** 试用采纳反馈时先记在这里，下次配置 AGNES_API_KEY叠到到期日 */
  bonus_days: number;
  user_id?: string | null;
};



export type EntitlementPublic = {
  plan: "trial" | "licensed";
  status: "active" | "exhausted" | "revoked";
  chatUsed: number;
  chatQuota: number;
  remaining: number | null;
  allowChat: boolean;
  allowAgent: boolean;
  allowImage: boolean;
  allowVideo: boolean;
  hasLead: boolean;
  trialQuota: number;
  leadBonus: number;
  /** null = 永不过期 */
  expiresAt: number | null;
  expired: boolean;
  isSuper: boolean;
  /** 付费档的图/视频额度；remaining 为 null 表示不限（免费档由每日额度控制） */
  imageUsed: number;
  imageQuota: number;
  imageRemaining: number | null;
  videoUsed: number;
  videoQuota: number;
  videoRemaining: number | null;
  pendingBonusDays: number;
};

export const DAY_MS = 24 * 60 * 60 * 1000;

export function isExpired(row: Pick<EntitlementRow, "expires_at" | "is_super">, at = Date.now()): boolean {
  if (Number(row.is_super)) return false;
  const expires = row.expires_at;
  if (expires === null || expires === undefined) return false;
  return Number(expires) <= at;
}

export function parseDeviceHash(raw: string | undefined): string {
  const hash = (raw || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}





export function publicEntitlement(row: EntitlementRow, db?: DatabaseSync): EntitlementPublic {
  const quotas = db
    ? getQuotaSettings(db)
    : { trialChatQuota: 30, leadBonusQuota: 50, betaMonthlyEnabled: true };
  const superAdmin = Boolean(Number(row.is_super));
  const unlimited = superAdmin || row.chat_quota <= 0;
  const expired = isExpired(row);
  const remaining = unlimited ? null : Math.max(0, row.chat_quota - row.chat_used);
  const licensed = row.plan === "licensed" && row.status !== "revoked" && !expired;
  const allowChat = row.status === "active" && !expired && (unlimited || row.chat_used < row.chat_quota);
  // 免费试用也能体验出图/出视频/Agent，用量由每日额度卡住（见 usage.ts）
  const tryable = row.plan === "trial" && row.status !== "revoked" && !expired;
  const mediaLeft = (quota: number, used: number): number | null =>
    superAdmin || quota <= 0 ? null : Math.max(0, quota - used);
  return {
    plan: row.plan,
    status: row.status,
    chatUsed: row.chat_used,
    chatQuota: row.chat_quota,
    remaining,
    allowChat,
    allowAgent: superAdmin || ((licensed || tryable) && Boolean(row.allow_agent)),
    allowImage: superAdmin || ((licensed || tryable) && Boolean(row.allow_image)),
    allowVideo: superAdmin || ((licensed || tryable) && Boolean(row.allow_video)),
    hasLead: Boolean(row.lead_wechat),
    trialQuota: quotas.trialChatQuota,
    leadBonus: quotas.leadBonusQuota,
    expiresAt: superAdmin ? null : (row.expires_at ?? null),
    expired,
    isSuper: superAdmin,
    imageUsed: Number(row.image_used ?? 0),
    imageQuota: Number(row.image_quota ?? 0),
    imageRemaining: mediaLeft(Number(row.image_quota ?? 0), Number(row.image_used ?? 0)),
    videoUsed: Number(row.video_used ?? 0),
    videoQuota: Number(row.video_quota ?? 0),
    videoRemaining: mediaLeft(Number(row.video_quota ?? 0), Number(row.video_used ?? 0)),
    pendingBonusDays: Math.max(0, Number(row.bonus_days ?? 0)),
  };
}

export function getEntitlement(db: DatabaseSync, deviceHash: string): EntitlementRow | undefined {
  return db.prepare("SELECT * FROM entitlements WHERE device_hash = ?").get(deviceHash) as EntitlementRow | undefined;
}

export function getEntitlementByUser(db: DatabaseSync, userId: string): EntitlementRow | undefined {
  if (!userId) return undefined;
  return db.prepare("SELECT * FROM entitlements WHERE user_id = ?").get(userId) as EntitlementRow | undefined;
}

/** 账号上的付费授权优先于这台设备的试用。 */
export function entitlementForViewer(db: DatabaseSync, userId: string, deviceHash: string): EntitlementRow | undefined {
  if (userId) {
    const owned = getEntitlementByUser(db, userId);
    if (owned && owned.plan === "licensed" && owned.status !== "revoked") return owned;
  }
  return deviceHash ? getEntitlement(db, deviceHash) : undefined;
}

/** 这个账号已经有一张还在有效期内的卡。 */
export function userHasLiveLicense(db: DatabaseSync, userId: string): boolean {
  if (!userId) return false;
  const owned = getEntitlementByUser(db, userId);
  return Boolean(owned && owned.plan === "licensed" && owned.status !== "revoked" && !isExpired(owned));
}

/**
 * 网页试用把 chat_quota 记成 0，靠每天的次数封顶。桌面端转发给授权服务器时曾经走了同一条，
 * 侧栏就把「不限」显示成剩余 0 次。桌面客户端来查状态或再点试用时，补回价目里的试用次数。
 */


export function getEntitlementById(db: DatabaseSync, entitlementId: string): EntitlementRow | undefined {
  return db.prepare("SELECT * FROM entitlements WHERE id = ?").get(entitlementId) as EntitlementRow | undefined;
}



export function consumeChat(db: DatabaseSync, deviceHash: string): EntitlementRow {
  const row = getEntitlement(db, deviceHash);
  if (!row) throw new Error("请先配置 AGNES_API_KEY");
  if (row.status === "revoked") throw new Error("授权已作废");
  if (Number(row.is_super)) return row;
  if (isExpired(row)) throw new Error("授权已到期，请续期");
  if (row.chat_quota > 0 && row.chat_used >= row.chat_quota) {
    if (row.status !== "exhausted") {
      db.prepare("UPDATE entitlements SET status='exhausted', updated_at=? WHERE id=?").run(now(), row.id);
    }
    throw new Error("对话额度已用完，请配置 AGNES_API_KEY");
  }
  const used = row.chat_used + 1;
  const exhausted = row.chat_quota > 0 && used >= row.chat_quota;
  db.prepare("UPDATE entitlements SET chat_used=?, status=?, updated_at=? WHERE id=?").run(
    used,
    exhausted ? "exhausted" : row.status,
    now(),
    row.id,
  );
  return getEntitlement(db, deviceHash) as EntitlementRow;
}




/** 采纳需求反馈时给该设备加授权天数。已有到期日的立刻延长；试用先记待加赠。 */

/** 付费档出图/出视频：从卡的周期总量里扣。免费档不走这里（走每日额度）。 */
export function consumeMedia(db: DatabaseSync, deviceHash: string, kind: "image" | "video"): EntitlementRow {
  const row = getEntitlement(db, deviceHash);
  if (!row) throw new Error("请先配置 AGNES_API_KEY");
  if (row.status === "revoked") throw new Error("授权已作废");
  if (Number(row.is_super)) return row;
  if (isExpired(row)) throw new Error("授权已到期，请续期");
  const quota = Number(kind === "image" ? row.image_quota : row.video_quota) || 0;
  if (quota <= 0) return row;
  const used = Number(kind === "image" ? row.image_used : row.video_used) || 0;
  if (used >= quota) {
    throw new Error(kind === "image" ? `本次套餐的出图额度已用完（${quota} 张）` : `本次套餐的视频额度已用完（${quota} 条）`);
  }
  const column = kind === "image" ? "image_used" : "video_used";
  db.prepare(`UPDATE entitlements SET ${column}=?, updated_at=? WHERE id=?`).run(used + 1, now(), row.id);
  return getEntitlement(db, deviceHash) as EntitlementRow;
}

/** 上游失败时把刚扣的额度还回去 */
export function refundMedia(db: DatabaseSync, deviceHash: string, kind: "image" | "video"): void {
  const row = getEntitlement(db, deviceHash);
  if (!row || Number(row.is_super)) return;
  const column = kind === "image" ? "image_used" : "video_used";
  const used = Number(kind === "image" ? row.image_used : row.video_used) || 0;
  if (used <= 0) return;
  db.prepare(`UPDATE entitlements SET ${column}=?, updated_at=? WHERE id=?`).run(used - 1, now(), row.id);
}


export function revokeDevice(db: DatabaseSync, entitlementId: string): EntitlementRow {
  const row = getEntitlementById(db, entitlementId);
  if (!row) throw new Error("设备记录不存在");
  db.prepare("UPDATE entitlements SET status='revoked', updated_at=? WHERE id=?").run(now(), row.id);
  return getEntitlementById(db, entitlementId) as EntitlementRow;
}

export class EntitlementError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function requireFeature(row: EntitlementRow | undefined, feature: "chat" | "agent" | "image" | "video"): EntitlementPublic {
  if (!row) throw new EntitlementError("请先配置 AGNES_API_KEY", 403);
  const pub = publicEntitlement(row);
  if (pub.expired) throw new EntitlementError("授权已到期，请续期", 403);
  if (feature === "chat" && !pub.allowChat) {
    throw new EntitlementError(pub.status === "exhausted" ? "对话额度已用完，请配置 AGNES_API_KEY" : "当前授权不可对话", 403);
  }
  if (feature === "image" && !pub.allowImage) throw new EntitlementError("当前授权不可出图", 403);
  if (feature === "video" && !pub.allowVideo) throw new EntitlementError("当前授权不可出视频", 403);
  if (feature === "agent" && !pub.allowAgent) throw new EntitlementError("当前授权不可使用 Agent", 403);
  return pub;
}

/** 上游失败时把刚扣的一次对话还回去（已用完的顺带恢复成可用） */
export function refundChat(db: DatabaseSync, deviceHash: string): void {
  const row = getEntitlement(db, deviceHash);
  if (!row || Number(row.is_super) || Number(row.chat_used) <= 0) return;
  const used = Number(row.chat_used) - 1;
  const status = row.status === "exhausted" && (row.chat_quota <= 0 || used < row.chat_quota) ? "active" : row.status;
  db.prepare("UPDATE entitlements SET chat_used=?, status=?, updated_at=? WHERE id=?").run(used, status, now(), row.id);
}

/**
 * 限流用的网络块：IPv4 用完整地址，IPv6 取前 64 位。家宽和机房一般整段 /64 都归同一个人，
 * 按完整 IPv6 地址限领，换个后缀就绕过去了。
 */
export function ipBlock(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "").replace(/^::ffff:(?=\d+\.)/, "");
  if (!raw || !raw.includes(":")) return raw;
  let groups: string[];
  if (raw.includes("::")) {
    const [head = "", tail = ""] = raw.split("::", 2);
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  } else {
    groups = raw.split(":");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, "") || "0")
    .join(":")}::/64`;
}

/** 这个网络 24 小时内已经新开了几台桌面试用 */


export const QUOTA_TICKET_REFUND_MS = 30 * 60 * 1000;

export type QuotaTicketRow = {
  id: string;
  kind: "chat" | "image" | "video";
  bill_hash: string;
  device_hash: string;
  chat_ticket: string;
  ip: string;
  daily: number;
  succeeded: number;
  refunded: number;
  created_at: number;
};

/** 扣一次额度就开一张单据。桌面端上游失败时凭它退一次，中转成功用过的单据不能退。 */
export function createQuotaTicket(
  db: DatabaseSync,
  input: { kind: QuotaTicketRow["kind"]; billHash: string; deviceHash: string; chatTicket?: string; ip?: string; daily?: boolean },
): string {
  const ts = now();
  const ticketId = `qt_${randomBytes(18).toString("hex")}`;
  db.prepare("DELETE FROM quota_tickets WHERE created_at < ?").run(ts - 2 * DAY_MS);
  db.prepare(
    "INSERT INTO quota_tickets (id, kind, bill_hash, device_hash, chat_ticket, ip, daily, succeeded, refunded, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)",
  ).run(ticketId, input.kind, input.billHash, input.deviceHash, input.chatTicket || "", input.ip || "", input.daily ? 1 : 0, ts);
  return ticketId;
}

/** 中转把这张对话票据真正送到了上游：之后就不能再退 */
export function markChatTicketUsed(db: DatabaseSync, chatTicket: string): void {
  if (!chatTicket) return;
  db.prepare("UPDATE quota_tickets SET succeeded = 1 WHERE chat_ticket = ? AND refunded = 0").run(chatTicket);
}

/** 退过额度的对话票据不能再拿来打中转 */
export function chatTicketRefunded(db: DatabaseSync, chatTicket: string): boolean {
  if (!chatTicket) return false;
  return Boolean(db.prepare("SELECT 1 AS x FROM quota_tickets WHERE chat_ticket = ? AND refunded = 1 LIMIT 1").get(chatTicket));
}

export function refundQuotaTicket(
  db: DatabaseSync,
  ticketId: string,
  deviceHash: string,
  kind: QuotaTicketRow["kind"],
  at = Date.now(),
): { ok: true; row: QuotaTicketRow } | { ok: false; error: string } {
  const row = db.prepare("SELECT * FROM quota_tickets WHERE id = ?").get(String(ticketId || "")) as QuotaTicketRow | undefined;
  if (!row || row.device_hash !== deviceHash || row.kind !== kind) return { ok: false, error: "退还凭证无效" };
  if (Number(row.refunded)) return { ok: false, error: "这次已经退还过了" };
  if (Number(row.succeeded)) return { ok: false, error: "这次请求已经用到模型，不能退还" };
  if (at - Number(row.created_at) > QUOTA_TICKET_REFUND_MS) return { ok: false, error: "退还凭证已过期" };
  const changed = db.prepare("UPDATE quota_tickets SET refunded = 1 WHERE id = ? AND refunded = 0 AND succeeded = 0").run(row.id);
  if (!Number(changed.changes)) return { ok: false, error: "这次已经退还过了" };
  if (kind === "chat") refundChat(db, row.bill_hash);
  else refundMedia(db, row.bill_hash, kind);
  return { ok: true, row };
}

/** 后台「重置中转令牌」：这一刻之前签发的令牌全部作废，旧版不过期令牌也不再认 */
export function relayNotBefore(db: DatabaseSync, deviceHash: string): number {
  if (!deviceHash) return 0;
  const row = db.prepare("SELECT not_before FROM relay_revocations WHERE device_hash = ?").get(deviceHash) as
    | { not_before: number }
    | undefined;
  return Number(row?.not_before ?? 0) || 0;
}

export function resetRelayToken(db: DatabaseSync, deviceHash: string, at = Date.now()): number {
  db.prepare(
    "INSERT INTO relay_revocations (device_hash, not_before) VALUES (?, ?) ON CONFLICT(device_hash) DO UPDATE SET not_before = excluded.not_before",
  ).run(deviceHash, at);
  return at;
}


export function ensureLocalKeyOperator(db: DatabaseSync, deviceHash: string): EntitlementRow {
  if (!deviceHash) throw new Error("缺少设备标识");
  const existing = getEntitlement(db, deviceHash);
  if (existing && Number(existing.is_super)) return existing;
  const ts = now();
  if (!existing) {
    const rowId = id("e");
    db.prepare(
      `INSERT INTO entitlements (id, device_hash, plan, status, chat_used, chat_quota, lead_wechat, lead_bonus_applied, license_id, allow_image, allow_video, allow_agent, created_at, updated_at, is_super, image_quota, video_quota, expires_at)
       VALUES (?, ?, 'licensed', 'active', 0, 0, '', 0, NULL, 1, 1, 1, ?, ?, 1, 0, 0, NULL)`,
    ).run(rowId, deviceHash, ts, ts);
  } else {
    db.prepare(
      `UPDATE entitlements SET plan='licensed', status='active', chat_quota=0, allow_image=1, allow_video=1, allow_agent=1, is_super=1, image_quota=0, video_quota=0, expires_at=NULL, updated_at=? WHERE id=?`,
    ).run(ts, existing.id);
  }
  return getEntitlement(db, deviceHash) as EntitlementRow;
}
