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
  /** 试用采纳反馈时先记在这里，下次激活卡密叠到到期日 */
  bonus_days: number;
  user_id?: string | null;
};

export type LicenseKeyRow = {
  id: string;
  code_hash: string;
  code_hint: string;
  /** 明文卡密，运营后台随时可查可复制；历史卡密（只存过哈希）为空串 */
  code_plain: string;
  chat_quota: number;
  status: "unused" | "redeemed" | "revoked";
  redeemed_device_hash: string | null;
  redeemed_user_id?: string | null;
  redeemed_at: number | null;
  plan_id: string | null;
  customer_id: string | null;
  note: string;
  allow_image: number;
  allow_video: number;
  allow_agent: number;
  created_at: number;
  /** 0 = 永久 */
  duration_days: number;
  is_super: number;
  image_quota: number;
  video_quota: number;
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

export function normalizeLicenseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashLicenseCode(code: string): string {
  return createHash("sha256").update(normalizeLicenseCode(code), "utf8").digest("hex");
}

export function formatLicenseCode(compact: string): string {
  const c = normalizeLicenseCode(compact);
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}`;
}

export function generateLicenseCode(): string {
  const bytes = randomBytes(16);
  let compact = "";
  for (const b of bytes) compact += CODE_ALPH[b % CODE_ALPH.length];
  return formatLicenseCode(compact);
}

export function publicEntitlement(row: EntitlementRow, db?: DatabaseSync): EntitlementPublic {
  const quotas = db
    ? getQuotaSettings(db)
    : { trialChatQuota: 30, leadBonusQuota: 50, feedbackRewardDays: 7, betaMonthlyEnabled: true };
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
export function repairDesktopTrialQuota(db: DatabaseSync, deviceHash: string): EntitlementRow | undefined {
  const row = getEntitlement(db, deviceHash);
  if (!row || row.plan !== "trial" || row.status === "revoked" || row.chat_quota > 0) return row;
  const quota = getQuotaSettings(db).trialChatQuota;
  if (quota <= 0) return row;
  db.prepare("UPDATE entitlements SET chat_quota = ?, updated_at = ? WHERE id = ? AND plan = 'trial' AND chat_quota <= 0").run(
    quota,
    now(),
    row.id,
  );
  return getEntitlement(db, deviceHash);
}

export function listEntitlements(db: DatabaseSync, q = ""): EntitlementRow[] {
  const text = q.trim();
  if (!text) {
    return db.prepare("SELECT * FROM entitlements ORDER BY updated_at DESC LIMIT 300").all() as EntitlementRow[];
  }
  const like = `%${text}%`;
  return db
    .prepare(
      "SELECT * FROM entitlements WHERE device_hash LIKE ? OR lead_wechat LIKE ? OR license_id LIKE ? ORDER BY updated_at DESC LIMIT 300",
    )
    .all(like, like, like) as EntitlementRow[];
}

export function getEntitlementById(db: DatabaseSync, entitlementId: string): EntitlementRow | undefined {
  return db.prepare("SELECT * FROM entitlements WHERE id = ?").get(entitlementId) as EntitlementRow | undefined;
}

export function startTrial(db: DatabaseSync, deviceHash: string, quota = getQuotaSettings(db).trialChatQuota): EntitlementRow {
  const existing = getEntitlement(db, deviceHash);
  if (existing) return existing;
  const ts = now();
  const rowId = id("e");
  // 免费试用可以体验对话 / Agent / 出图 / 出视频；出图出视频按天卡额度，不吃这里的次数
  db.prepare(
    `INSERT INTO entitlements (id, device_hash, plan, status, chat_used, chat_quota, lead_wechat, lead_bonus_applied, license_id, allow_image, allow_video, allow_agent, created_at, updated_at)
     VALUES (?, ?, 'trial', 'active', 0, ?, '', 0, NULL, 1, 1, 1, ?, ?)`,
  ).run(rowId, deviceHash, quota, ts, ts);
  return getEntitlement(db, deviceHash) as EntitlementRow;
}

export function applyLead(db: DatabaseSync, deviceHash: string, wechat: string, applyBonus = true): EntitlementRow {
  const wechatNorm = wechat.trim().slice(0, 64);
  if (wechatNorm.length < 2) throw new Error("请填写微信联系方式");
  const row = getEntitlement(db, deviceHash);
  if (!row) throw new Error("该设备还没有试用或卡密");
  if (row.lead_wechat && row.lead_wechat !== wechatNorm) throw new Error("该设备已登记过其他微信");
  const taken = db.prepare("SELECT id FROM entitlements WHERE lead_wechat = ? AND id != ?").get(wechatNorm, row.id) as
    | { id: string }
    | undefined;
  if (taken) throw new Error("该微信已登记在其他设备");
  const ts = now();
  let nextQuota = row.chat_quota;
  let bonus = row.lead_bonus_applied;
  if (applyBonus && !row.lead_bonus_applied && row.chat_quota > 0) {
    nextQuota = row.chat_quota + getQuotaSettings(db).leadBonusQuota;
    bonus = 1;
  }
  const nextStatus = row.plan === "trial" && row.status === "exhausted" && nextQuota > row.chat_used ? "active" : row.status;
  db.prepare(
    "UPDATE entitlements SET lead_wechat=?, lead_bonus_applied=?, chat_quota=?, status=?, updated_at=? WHERE id=?",
  ).run(wechatNorm, bonus, nextQuota, nextStatus, ts, row.id);
  return getEntitlement(db, deviceHash) as EntitlementRow;
}

export function consumeChat(db: DatabaseSync, deviceHash: string): EntitlementRow {
  const row = getEntitlement(db, deviceHash);
  if (!row) throw new Error("需要先试用或激活卡密");
  if (row.status === "revoked") throw new Error("授权已作废");
  if (Number(row.is_super)) return row;
  if (isExpired(row)) throw new Error("授权已到期，请续期");
  if (row.chat_quota > 0 && row.chat_used >= row.chat_quota) {
    if (row.status !== "exhausted") {
      db.prepare("UPDATE entitlements SET status='exhausted', updated_at=? WHERE id=?").run(now(), row.id);
    }
    throw new Error("试用对话次数已用完，可激活卡密");
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

export function issueLicenses(
  db: DatabaseSync,
  opts: { count: number; planId?: string; customerId?: string; note?: string; deduct?: boolean; allowDisabled?: boolean },
): { id: string; code: string; hint: string; planId: string | null }[] {
  const n = Math.min(Math.max(Math.floor(opts.count), 1), 50);
  const plan = opts.planId
    ? (db.prepare("SELECT * FROM plans WHERE id = ?").get(opts.planId) as
        | {
            id: string;
            chat_quota: number;
            allow_image: number;
            allow_video: number;
            allow_agent: number;
            price_cents: number;
            enabled: number;
            duration_days: number;
            is_super: number;
            image_quota: number;
            video_quota: number;
          }
        | undefined)
    : undefined;
  if (opts.planId && !plan) throw new Error("套餐不存在");
  if (plan && !plan.enabled && !opts.allowDisabled) throw new Error("套餐已停用");
  if (opts.customerId) {
    const customer = db.prepare("SELECT id, wallet_cents FROM customers WHERE id = ?").get(opts.customerId) as
      | { id: string; wallet_cents: number }
      | undefined;
    if (!customer) throw new Error("客户不存在");
    if (opts.deduct && plan) {
      const cost = plan.price_cents * n;
      if (customer.wallet_cents < cost) throw new Error("客户余额不足");
      const ts = now();
      db.prepare("UPDATE customers SET wallet_cents=?, updated_at=? WHERE id=?").run(customer.wallet_cents - cost, ts, customer.id);
      db.prepare("INSERT INTO wallet_ledger (id, customer_id, delta_cents, reason, created_at) VALUES (?, ?, ?, ?, ?)").run(
        id("led"),
        customer.id,
        -cost,
        `发卡 ${n} 张${plan.id ? `（${plan.id}）` : ""}`,
        ts,
      );
    }
  }
  const ts = now();
  const out: { id: string; code: string; hint: string; planId: string | null }[] = [];
  for (let i = 0; i < n; i++) {
    const code = generateLicenseCode();
    const rowId = id("k");
    db.prepare(
      `INSERT INTO license_keys (id, code_hash, code_hint, code_plain, chat_quota, status, redeemed_device_hash, redeemed_at, plan_id, customer_id, note, allow_image, allow_video, allow_agent, created_at, duration_days, is_super, image_quota, video_quota)
       VALUES (?, ?, ?, ?, ?, 'unused', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rowId,
      hashLicenseCode(code),
      code.slice(-4),
      code,
      plan ? plan.chat_quota : 0,
      plan?.id ?? null,
      opts.customerId || null,
      (opts.note ?? "").trim().slice(0, 200),
      plan ? plan.allow_image : 1,
      plan ? plan.allow_video : 1,
      plan ? plan.allow_agent : 1,
      ts,
      plan ? Number(plan.duration_days ?? 0) : 0,
      plan ? Number(plan.is_super ?? 0) : 0,
      plan ? Number(plan.image_quota ?? 0) : 0,
      plan ? Number(plan.video_quota ?? 0) : 0,
    );
    out.push({ id: rowId, code, hint: code.slice(-4), planId: plan?.id ?? null });
  }
  return out;
}

export type LicenseKeyPublic = Omit<LicenseKeyRow, "code_hash">;

const LICENSE_COLUMNS =
  "id, code_hint, code_plain, chat_quota, status, redeemed_device_hash, redeemed_at, plan_id, customer_id, note, allow_image, allow_video, allow_agent, created_at, duration_days, is_super, image_quota, video_quota";

export function listLicenses(db: DatabaseSync, q = "", status = ""): LicenseKeyPublic[] {
  const text = q.trim();
  const st = status.trim();
  let sql = `SELECT ${LICENSE_COLUMNS} FROM license_keys`;
  const args: string[] = [];
  const where: string[] = [];
  if (text) {
    // 存了明文之后整串卡密也能搜。卡密带分隔符入库，所以去掉分隔符再比一次，
    // 这样贴 "ABCD-EFGH-..." 和贴 "ABCDEFGH..." 都能命中。
    where.push(
      "(code_plain LIKE ? OR REPLACE(code_plain, '-', '') LIKE ? OR code_hint LIKE ? OR note LIKE ? OR redeemed_device_hash LIKE ? OR id LIKE ?)",
    );
    const raw = `%${text}%`;
    args.push(raw, `%${normalizeLicenseCode(text) || text}%`, raw, raw, raw, raw);
  }
  if (st) {
    where.push("status = ?");
    args.push(st);
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY created_at DESC LIMIT 300";
  return db.prepare(sql).all(...args) as LicenseKeyPublic[];
}

export function getLicense(db: DatabaseSync, licenseId: string): LicenseKeyPublic | undefined {
  return db.prepare(`SELECT ${LICENSE_COLUMNS} FROM license_keys WHERE id = ?`).get(licenseId) as
    | LicenseKeyPublic
    | undefined;
}

/**
 * 只删未使用和已作废的卡。已激活的卡还挂着某台设备的授权，直接删会留下一条查不到来源的
 * 授权，所以先作废（会吊销设备）再删。
 */
export function deleteLicenses(db: DatabaseSync, ids: string[]): { deleted: number; skipped: number } {
  const wanted = [...new Set(ids.map((s) => String(s || "").trim()).filter(Boolean))];
  if (!wanted.length) return { deleted: 0, skipped: 0 };
  const marks = wanted.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, status FROM license_keys WHERE id IN (${marks})`)
    .all(...wanted) as Array<{ id: string; status: string }>;
  const removable = rows.filter((row) => row.status !== "redeemed").map((row) => row.id);
  const skipped = rows.length - removable.length;
  if (!removable.length) return { deleted: 0, skipped };
  const delMarks = removable.map(() => "?").join(", ");
  db.prepare(`UPDATE entitlements SET license_id=NULL WHERE license_id IN (${delMarks})`).run(...removable);
  db.prepare(`DELETE FROM license_keys WHERE id IN (${delMarks})`).run(...removable);
  return { deleted: removable.length, skipped };
}

export function activateLicense(db: DatabaseSync, deviceHash: string, code: string): EntitlementRow {
  const compact = normalizeLicenseCode(code);
  if (compact.length !== 16) throw new Error("卡密格式不正确");
  const key = db.prepare("SELECT * FROM license_keys WHERE code_hash = ?").get(hashLicenseCode(compact)) as
    | LicenseKeyRow
    | undefined;
  if (!key || key.status === "revoked") throw new Error("卡密无效");
  const ts = now();
  if (key.status === "redeemed") {
    if (key.redeemed_device_hash !== deviceHash) throw new Error("该卡密已在其他设备使用");
  } else {
    db.prepare("UPDATE license_keys SET status='redeemed', redeemed_device_hash=?, redeemed_at=? WHERE id=?").run(
      deviceHash,
      ts,
      key.id,
    );
  }
  const existing = getEntitlement(db, deviceHash);
  const superKey = Boolean(Number(key.is_super ?? 0));
  const durationDays = Math.max(0, Number(key.duration_days ?? 0));
  const keyQuota = Math.max(0, Number(key.chat_quota ?? 0));
  const wasSuper = Boolean(Number(existing?.is_super ?? 0));
  const nextSuper = superKey || wasSuper;
  const image = nextSuper ? 1 : Number(key.allow_image ?? 1);
  const video = nextSuper ? 1 : Number(key.allow_video ?? 1);
  const agent = nextSuper ? 1 : Number(key.allow_agent ?? 1);

  const renewing = existing?.plan === "licensed";
  // 已是永久/超管就不因为贴了张月卡而退回到有期限
  const alreadyPermanent = nextSuper || (renewing && (existing?.expires_at ?? null) === null);
  let nextExpires: number | null;
  if (nextSuper || durationDays === 0 || alreadyPermanent) {
    nextExpires = null;
  } else {
    const prev = Number(existing?.expires_at ?? 0);
    const base = prev > ts ? prev : ts;
    nextExpires = base + durationDays * DAY_MS;
  }
  const pendingBonus = Math.max(0, Number(existing?.bonus_days ?? 0));
  if (nextExpires != null && pendingBonus > 0) nextExpires += pendingBonus * DAY_MS;

  // 额度：超管/不限为 0；同为付费授权则叠加续费包；试用升级按卡密重置
  const stack = (keyAmount: number, prev: number): number => {
    if (nextSuper || keyAmount === 0) return 0;
    if (renewing && prev === 0) return 0;
    return renewing ? prev + keyAmount : keyAmount;
  };
  const nextQuota = stack(keyQuota, Number(existing?.chat_quota ?? 0));
  const nextImageQuota = stack(Math.max(0, Number(key.image_quota ?? 0)), Number(existing?.image_quota ?? 0));
  const nextVideoQuota = stack(Math.max(0, Number(key.video_quota ?? 0)), Number(existing?.video_quota ?? 0));
  const nextUsed = renewing ? Number(existing?.chat_used ?? 0) : 0;
  const nextImageUsed = renewing ? Number(existing?.image_used ?? 0) : 0;
  const nextVideoUsed = renewing ? Number(existing?.video_used ?? 0) : 0;

  if (existing) {
    db.prepare(
      `UPDATE entitlements SET plan='licensed', status='active', chat_used=?, chat_quota=?, license_id=?, allow_image=?, allow_video=?, allow_agent=?,
        expires_at=?, is_super=?, image_quota=?, image_used=?, video_quota=?, video_used=?, bonus_days=0, updated_at=? WHERE id=?`,
    ).run(
      nextUsed,
      nextQuota,
      key.id,
      image,
      video,
      agent,
      nextExpires,
      nextSuper ? 1 : 0,
      nextImageQuota,
      nextImageUsed,
      nextVideoQuota,
      nextVideoUsed,
      ts,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO entitlements (id, device_hash, plan, status, chat_used, chat_quota, lead_wechat, lead_bonus_applied, license_id, allow_image, allow_video, allow_agent, created_at, updated_at, expires_at, is_super, image_quota, image_used, video_quota, video_used)
       VALUES (?, ?, 'licensed', 'active', 0, ?, '', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0)`,
    ).run(
      id("e"),
      deviceHash,
      nextQuota,
      key.id,
      image,
      video,
      agent,
      ts,
      ts,
      nextExpires,
      nextSuper ? 1 : 0,
      nextImageQuota,
      nextVideoQuota,
    );
  }
  return getEntitlement(db, deviceHash) as EntitlementRow;
}

/** 激活码记在账号上。同一张卡换设备登录仍然是这个账号的额度。 */
export function activateLicenseForUser(db: DatabaseSync, userId: string, code: string, deviceHash: string): EntitlementRow {
  if (!userId) throw new Error("请先登录后再激活卡密");
  const accountKey = `acct:${userId}`;
  const compact = normalizeLicenseCode(code);
  if (compact.length !== 16) throw new Error("卡密格式不正确");
  const key = db.prepare("SELECT * FROM license_keys WHERE code_hash = ?").get(hashLicenseCode(compact)) as
    | LicenseKeyRow
    | undefined;
  if (!key || key.status === "revoked") throw new Error("卡密无效");
  const boundUser = String(key.redeemed_user_id || "");
  if (key.status === "redeemed") {
    if (boundUser && boundUser !== userId) throw new Error("该卡密已在其他账号使用");
    const holder = String(key.redeemed_device_hash || "");
    const sameDevice = !holder || holder === deviceHash || holder === accountKey;
    if (!boundUser && !sameDevice) throw new Error("该卡密已在其他设备使用");
    db.prepare("UPDATE license_keys SET redeemed_device_hash=? WHERE id=?").run(accountKey, key.id);
  }
  const row = activateLicense(db, accountKey, code);
  const ts = now();
  db.prepare("UPDATE license_keys SET redeemed_user_id=?, redeemed_device_hash=? WHERE id=?").run(
    userId,
    deviceHash || accountKey,
    key.id,
  );
  db.prepare("UPDATE entitlements SET user_id=?, updated_at=? WHERE id=?").run(userId, ts, row.id);
  return getEntitlementByUser(db, userId) as EntitlementRow;
}

/** 这台设备上已激活、还没归到别人名下的卡，注册或登录时挂到当前账号。 */
export function attachDeviceLicense(db: DatabaseSync, userId: string, deviceHash: string): boolean {
  if (!userId || !deviceHash) return false;
  const mine = getEntitlementByUser(db, userId);
  if (mine?.plan === "licensed" && mine.status !== "revoked") return false;
  const deviceRow = getEntitlement(db, deviceHash);
  if (!deviceRow || deviceRow.plan !== "licensed" || deviceRow.status === "revoked") return false;
  if (deviceRow.user_id && deviceRow.user_id !== userId) return false;
  const keyId = String(deviceRow.license_id || "");
  const key = keyId
    ? (db.prepare("SELECT id, redeemed_user_id FROM license_keys WHERE id = ?").get(keyId) as { id: string; redeemed_user_id?: string | null } | undefined)
    : undefined;
  if (key?.redeemed_user_id && key.redeemed_user_id !== userId) return false;
  const ts = now();
  db.prepare("UPDATE entitlements SET user_id=?, updated_at=? WHERE id=?").run(userId, ts, deviceRow.id);
  if (key) db.prepare("UPDATE license_keys SET redeemed_user_id=?, status='redeemed' WHERE id=?").run(userId, key.id);
  return true;
}

/** 公测赠卡固定用在售价目里的基础版月卡，不另造一套额度。 */
export const BETA_PLAN_ID = "basic_1m";

export type BetaOffer = {
  open: boolean;
  planName: string;
  durationDays: number;
  chatQuota: number;
  imageQuota: number;
  videoQuota: number;
  rewardDays: number;
  claimed: boolean;
  eligible: boolean;
};

type BetaPlan = {
  id: string;
  name: string;
  chat_quota: number;
  duration_days: number;
  image_quota: number;
  video_quota: number;
};

function betaPlan(db: DatabaseSync): BetaPlan | undefined {
  return db.prepare("SELECT id, name, chat_quota, duration_days, image_quota, video_quota FROM plans WHERE id = ?").get(BETA_PLAN_ID) as
    | BetaPlan
    | undefined;
}

/** 只对公网 IP 限领一次。内网地址多半是反代没把真实 IP 传进来，拿来限领会把所有人挡在同一次上。 */
export function betaIpLimited(ip: string): boolean {
  const raw = ip.trim().toLowerCase().replace(/^::ffff:/, "");
  if (!raw || raw === "unknown" || raw === "localhost" || raw === "::1" || raw === "0.0.0.0") return false;
  if (raw.startsWith("127.") || raw.startsWith("10.") || raw.startsWith("192.168.") || raw.startsWith("169.254.")) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(raw)) return false;
  if (raw.startsWith("fc") || raw.startsWith("fd") || raw.startsWith("fe80:")) return false;
  return true;
}

function shanghaiDate(ms: number): string {
  return new Date(ms).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}

export function betaOffer(db: DatabaseSync, deviceHash: string, userId = ""): BetaOffer {
  const settings = getQuotaSettings(db);
  const plan = betaPlan(db);
  const claimed =
    (deviceHash ? Boolean(db.prepare("SELECT 1 AS x FROM beta_claims WHERE device_hash = ?").get(deviceHash)) : false) ||
    (userId ? Boolean(db.prepare("SELECT 1 AS x FROM beta_claims WHERE user_id = ?").get(userId)) : false);
  const row = deviceHash ? getEntitlement(db, deviceHash) : undefined;
  const blocked = row?.plan === "licensed" || row?.status === "revoked" || userHasLiveLicense(db, userId);
  const open = settings.betaMonthlyEnabled && Boolean(plan);
  return {
    open,
    planName: plan?.name || "基础版 · 月卡",
    durationDays: Number(plan?.duration_days ?? 30),
    chatQuota: Number(plan?.chat_quota ?? 1000),
    imageQuota: Number(plan?.image_quota ?? 300),
    videoQuota: Number(plan?.video_quota ?? 30),
    rewardDays: settings.feedbackRewardDays,
    claimed,
    eligible: open && Boolean(deviceHash) && !claimed && !blocked,
  };
}

/** 老的领取记录只存了完整 IP，补上网络块（内网 / 无效地址记成 "-"，不再重复扫） */
function backfillBetaBlocks(db: DatabaseSync): void {
  const rows = db.prepare("SELECT device_hash, ip FROM beta_claims WHERE ip_block = ''").all() as Array<{ device_hash: string; ip: string }>;
  const update = db.prepare("UPDATE beta_claims SET ip_block = ? WHERE device_hash = ?");
  for (const row of rows) update.run(betaIpLimited(row.ip || "") ? ipBlock(row.ip) : "-", row.device_hash);
}

function isUniqueError(err: unknown): boolean {
  const code = String((err as { code?: string } | null)?.code || "");
  const msg = err instanceof Error ? err.message : String(err);
  return code.includes("SQLITE_CONSTRAINT") || /unique/i.test(msg);
}

/**
 * 给这台设备发一张基础版月卡并立刻激活。一台设备一次；同一个公网 IP 也一次，
 * 避免换设备码反复领。已有卡密授权的不发。
 */
export function claimBetaMonth(
  db: DatabaseSync,
  deviceHash: string,
  ip: string,
  userId = "",
): { row: EntitlementRow; notice: string } {
  if (!deviceHash) throw new Error("缺少设备码");
  const settings = getQuotaSettings(db);
  if (!settings.betaMonthlyEnabled) throw new Error("公测领卡已结束");
  if (!betaPlan(db)) throw new Error("基础版月卡套餐不存在");
  const existing = getEntitlement(db, deviceHash);
  if (existing?.status === "revoked") throw new Error("授权已作废，不能领取公测月卡");
  if (existing?.plan === "licensed") throw new Error("这台设备已经有授权，不能再领公测月卡");
  if (db.prepare("SELECT 1 AS x FROM beta_claims WHERE device_hash = ?").get(deviceHash)) {
    throw new Error("这台设备已经领过公测月卡");
  }
  if (userId && db.prepare("SELECT 1 AS x FROM beta_claims WHERE user_id = ?").get(userId)) {
    throw new Error("这个账号已经领过公测月卡");
  }
  // IPv6 按 /64 算：同一户换个地址后缀不算新网络
  backfillBetaBlocks(db);
  const block = betaIpLimited(ip) ? ipBlock(ip) : "";
  if (block) {
    const taken = db.prepare("SELECT device_hash FROM beta_claims WHERE ip = ? OR ip_block = ? LIMIT 1").get(ip, block) as
      | { device_hash: string }
      | undefined;
    if (taken && taken.device_hash !== deviceHash) throw new Error("这个网络已经领过公测月卡");
  }
  const ts = now();
  try {
    db.prepare("INSERT INTO beta_claims (device_hash, ip, ip_block, user_id, license_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)").run(
      deviceHash,
      ip || "",
      block,
      userId || null,
      ts,
    );
  } catch (err) {
    if (isUniqueError(err)) throw new Error("这台设备已经领过公测月卡");
    throw err;
  }
  let keyId = "";
  let activated = false;
  try {
    const [key] = issueLicenses(db, { count: 1, planId: BETA_PLAN_ID, note: "公测月卡", allowDisabled: true });
    keyId = key.id;
    const row = activateLicense(db, deviceHash, key.code);
    activated = true;
    db.prepare("UPDATE beta_claims SET license_id = ? WHERE device_hash = ?").run(key.id, deviceHash);
    const until = row.expires_at ? shanghaiDate(Number(row.expires_at)) : "";
    const notice = `公测月卡已开通${until ? `，有效至 ${until}` : ""}。到「反馈」提交问题，被采纳后会在到期日上增加相应天数（默认 ${settings.feedbackRewardDays} 天）。`;
    return { row, notice };
  } catch (err) {
    if (!activated) {
      db.prepare("DELETE FROM beta_claims WHERE device_hash = ?").run(deviceHash);
      if (keyId) db.prepare("DELETE FROM license_keys WHERE id = ? AND status = 'unused'").run(keyId);
    }
    throw err;
  }
}

export type GrantDaysResult = {
  applied: "expires" | "pending" | "noop";
  expiresAt: number | null;
  pendingDays: number;
  message: string;
};

/** 采纳需求反馈时给该设备加授权天数。已有到期日的立刻延长；试用先记待加赠。 */
export function grantLicenseDays(db: DatabaseSync, deviceHash: string, days: number): GrantDaysResult {
  const row = getEntitlement(db, deviceHash);
  if (!row) throw new Error("该设备还没有试用或卡密");
  if (row.status === "revoked") throw new Error("授权已作废");
  const n = Math.max(1, Math.min(365, Math.floor(Number(days) || 0)));
  const ts = now();
  if (Number(row.is_super)) {
    return { applied: "noop", expiresAt: null, pendingDays: 0, message: "超级管理员无需加时" };
  }
  if (row.plan === "licensed" && (row.expires_at === null || row.expires_at === undefined)) {
    return { applied: "noop", expiresAt: null, pendingDays: 0, message: "该授权没有到期日，无需加时" };
  }
  if (row.plan === "licensed" && row.expires_at) {
    const base = Number(row.expires_at) > ts ? Number(row.expires_at) : ts;
    const next = base + n * DAY_MS;
    const nextStatus = row.status === "exhausted" ? row.status : "active";
    db.prepare("UPDATE entitlements SET expires_at=?, status=?, updated_at=? WHERE id=?").run(next, nextStatus, ts, row.id);
    return { applied: "expires", expiresAt: next, pendingDays: Number(row.bonus_days ?? 0), message: `授权已延长 ${n} 天` };
  }
  const pending = Number(row.bonus_days ?? 0) + n;
  db.prepare("UPDATE entitlements SET bonus_days=?, updated_at=? WHERE id=?").run(pending, ts, row.id);
  return { applied: "pending", expiresAt: null, pendingDays: pending, message: `已记入待加赠 ${n} 天，下次激活卡密时叠加` };
}

/** 付费档出图/出视频：从卡的周期总量里扣。免费档不走这里（走每日额度）。 */
export function consumeMedia(db: DatabaseSync, deviceHash: string, kind: "image" | "video"): EntitlementRow {
  const row = getEntitlement(db, deviceHash);
  if (!row) throw new Error("需要先试用或激活卡密");
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

export function revokeLicense(db: DatabaseSync, licenseId: string): void {
  const key = db.prepare("SELECT * FROM license_keys WHERE id = ?").get(licenseId) as LicenseKeyRow | undefined;
  if (!key) throw new Error("卡密不存在");
  db.prepare("UPDATE license_keys SET status='revoked' WHERE id=?").run(licenseId);
  if (key.redeemed_device_hash) {
    db.prepare("UPDATE entitlements SET status='revoked', updated_at=? WHERE device_hash=?").run(now(), key.redeemed_device_hash);
  }
}

export function revokeDevice(db: DatabaseSync, entitlementId: string): EntitlementRow {
  const row = getEntitlementById(db, entitlementId);
  if (!row) throw new Error("设备记录不存在");
  db.prepare("UPDATE entitlements SET status='revoked', updated_at=? WHERE id=?").run(now(), row.id);
  if (row.license_id) db.prepare("UPDATE license_keys SET status='revoked' WHERE id=?").run(row.license_id);
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
  if (!row) throw new EntitlementError("需要先试用或激活卡密", 403);
  const pub = publicEntitlement(row);
  if (pub.expired) throw new EntitlementError("授权已到期，请续期", 403);
  if (feature === "chat" && !pub.allowChat) {
    throw new EntitlementError(pub.status === "exhausted" ? "试用对话次数已用完，可激活卡密" : "当前授权不可对话", 403);
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
export function recentTrialsFromBlock(db: DatabaseSync, ip: string, at = Date.now()): number {
  const block = ipBlock(ip);
  if (!block || !betaIpLimited(ip)) return 0;
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM entitlements WHERE trial_ip = ? AND plan = 'trial' AND created_at > ?")
    .get(block, at - DAY_MS) as { n: number };
  return Number(row.n) || 0;
}

export function markTrialIp(db: DatabaseSync, deviceHash: string, ip: string): void {
  const block = betaIpLimited(ip) ? ipBlock(ip) : "";
  if (!block) return;
  db.prepare("UPDATE entitlements SET trial_ip = ? WHERE device_hash = ? AND trial_ip = ''").run(block, deviceHash);
}

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

/** OSS / local-authority: with a local AGNES_API_KEY and no LICENSE_SERVER_URL,
 *  grant an unlimited operator entitlement so the user is not gated by card-key UI. */
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
