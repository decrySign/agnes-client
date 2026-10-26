import type { DatabaseSync } from "node:sqlite";
import { getKv, id, now, setKv } from "./db.js";

export type PlanRow = {
  id: string;
  name: string;
  chat_quota: number;
  allow_image: number;
  allow_video: number;
  allow_agent: number;
  price_cents: number;
  enabled: number;
  sort_order: number;
  created_at: number;
  /** 0 = 永久（只留给超管卡，不再对外售卖） */
  duration_days: number;
  /** 超级管理员版：不限次数 + 永不过期 + 全功能 */
  is_super: number;
  /** 卡有效期内可出图总量，0 = 不限 */
  image_quota: number;
  /** 卡有效期内可出视频总量，0 = 不限 */
  video_quota: number;
};

export type CustomerRow = {
  id: string;
  name: string;
  wechat: string;
  note: string;
  wallet_cents: number;
  created_at: number;
  updated_at: number;
  user_id?: string | null;
};

export type QuotaSettings = {
  trialChatQuota: number;
  leadBonusQuota: number;
  /** 运营采纳一条需求反馈时默认赠送的授权天数 */
  feedbackRewardDays: number;
  /** 公测：桌面端首次使用可领取一张基础版月卡 */
  betaMonthlyEnabled: boolean;
};

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function getQuotaSettings(db: DatabaseSync): QuotaSettings {
  return {
    trialChatQuota: intKv(db, "trial_chat_quota", envInt("TRIAL_CHAT_QUOTA", 30)),
    leadBonusQuota: intKv(db, "lead_bonus_quota", envInt("LEAD_BONUS_QUOTA", 50)),
    feedbackRewardDays: intKv(db, "feedback_reward_days", envInt("FEEDBACK_REWARD_DAYS", 7)),
    betaMonthlyEnabled: boolKv(db, "beta_monthly_enabled", true),
  };
}

export function saveQuotaSettings(db: DatabaseSync, next: Partial<QuotaSettings>): QuotaSettings {
  const cur = getQuotaSettings(db);
  const trial = clampQuota(next.trialChatQuota ?? cur.trialChatQuota, 1, 10_000);
  const bonus = clampQuota(next.leadBonusQuota ?? cur.leadBonusQuota, 0, 10_000);
  const reward = clampQuota(next.feedbackRewardDays ?? cur.feedbackRewardDays, 1, 365);
  const beta = next.betaMonthlyEnabled === undefined ? cur.betaMonthlyEnabled : Boolean(next.betaMonthlyEnabled);
  setKv(db, "trial_chat_quota", String(trial));
  setKv(db, "lead_bonus_quota", String(bonus));
  setKv(db, "feedback_reward_days", String(reward));
  setKv(db, "beta_monthly_enabled", beta ? "1" : "0");
  return getQuotaSettings(db);
}

function boolKv(db: DatabaseSync, key: string, fallback: boolean): boolean {
  const raw = getKv(db, key);
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true";
}

function intKv(db: DatabaseSync, key: string, fallback: number): number {
  const raw = getKv(db, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function clampQuota(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function listPlans(db: DatabaseSync): PlanRow[] {
  return db.prepare("SELECT * FROM plans ORDER BY sort_order ASC, created_at ASC").all() as PlanRow[];
}

export function getPlan(db: DatabaseSync, planId: string): PlanRow | undefined {
  return db.prepare("SELECT * FROM plans WHERE id = ?").get(planId) as PlanRow | undefined;
}

export type PlanInput = {
  id?: string;
  name: string;
  chatQuota: number;
  allowImage: boolean;
  allowVideo: boolean;
  allowAgent: boolean;
  priceYuan: number;
  enabled?: boolean;
  sortOrder?: number;
  /** 0 = 永久 */
  durationDays?: number;
  isSuper?: boolean;
  imageQuota?: number;
  videoQuota?: number;
};

export function upsertPlan(db: DatabaseSync, body: PlanInput): PlanRow {
  const name = body.name.trim().slice(0, 40);
  if (!name) throw new Error("套餐需要名称");
  const isSuper = Boolean(body.isSuper);
  // 超管版的语义就是无限 + 永久 + 全开，不接受相互矛盾的入参
  const chatQuota = isSuper ? 0 : clampQuota(body.chatQuota, 0, 10_000_000);
  const durationDays = isSuper ? 0 : clampQuota(body.durationDays ?? 0, 0, 3650);
  const imageQuota = isSuper ? 0 : clampQuota(body.imageQuota ?? 0, 0, 10_000_000);
  const videoQuota = isSuper ? 0 : clampQuota(body.videoQuota ?? 0, 0, 10_000_000);
  const allowImage = isSuper ? 1 : body.allowImage ? 1 : 0;
  const allowVideo = isSuper ? 1 : body.allowVideo ? 1 : 0;
  const allowAgent = isSuper ? 1 : body.allowAgent ? 1 : 0;
  const priceCents = Math.max(0, Math.round(body.priceYuan * 100));
  const ts = now();
  const existingId = body.id?.trim();
  if (existingId) {
    const row = getPlan(db, existingId);
    if (!row) throw new Error("套餐不存在");
    db.prepare(
      "UPDATE plans SET name=?, chat_quota=?, allow_image=?, allow_video=?, allow_agent=?, price_cents=?, enabled=?, sort_order=?, duration_days=?, is_super=?, image_quota=?, video_quota=? WHERE id=?",
    ).run(
      name,
      chatQuota,
      allowImage,
      allowVideo,
      allowAgent,
      priceCents,
      body.enabled === false ? 0 : 1,
      body.sortOrder ?? row.sort_order,
      durationDays,
      isSuper ? 1 : 0,
      imageQuota,
      videoQuota,
      existingId,
    );
    return getPlan(db, existingId) as PlanRow;
  }
  const planId = id("plan");
  db.prepare(
    `INSERT INTO plans (id, name, chat_quota, allow_image, allow_video, allow_agent, price_cents, enabled, sort_order, created_at, duration_days, is_super, image_quota, video_quota)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    planId,
    name,
    chatQuota,
    allowImage,
    allowVideo,
    allowAgent,
    priceCents,
    body.enabled === false ? 0 : 1,
    body.sortOrder ?? 100,
    ts,
    durationDays,
    isSuper ? 1 : 0,
    imageQuota,
    videoQuota,
  );
  return getPlan(db, planId) as PlanRow;
}

export function listCustomers(db: DatabaseSync, q = ""): CustomerRow[] {
  const text = q.trim();
  if (!text) {
    return db.prepare("SELECT * FROM customers ORDER BY updated_at DESC LIMIT 300").all() as CustomerRow[];
  }
  const like = `%${text}%`;
  return db
    .prepare("SELECT * FROM customers WHERE name LIKE ? OR wechat LIKE ? OR note LIKE ? OR user_id LIKE ? ORDER BY updated_at DESC LIMIT 300")
    .all(like, like, like, like) as CustomerRow[];
}

/** 自助注册的账号在后台「客户与余额」里占一行。已有则不重复建。 */
export function ensureCustomerForUser(db: DatabaseSync, userId: string, username: string): CustomerRow {
  const existing = db.prepare("SELECT * FROM customers WHERE user_id = ?").get(userId) as CustomerRow | undefined;
  if (existing) return existing;
  const ts = now();
  const customerId = id("cus");
  db.prepare(
    "INSERT INTO customers (id, name, wechat, note, wallet_cents, user_id, created_at, updated_at) VALUES (?, ?, '', ?, 0, ?, ?, ?)",
  ).run(customerId, username.trim().slice(0, 40) || userId, "自助注册", userId, ts, ts);
  return getCustomer(db, customerId) as CustomerRow;
}

export function getCustomer(db: DatabaseSync, customerId: string): CustomerRow | undefined {
  return db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId) as CustomerRow | undefined;
}

export function upsertCustomer(
  db: DatabaseSync,
  body: { id?: string; name: string; wechat?: string; note?: string },
): CustomerRow {
  const name = body.name.trim().slice(0, 40);
  if (!name) throw new Error("客户需要名称");
  const wechat = (body.wechat ?? "").trim().slice(0, 64);
  const note = (body.note ?? "").trim().slice(0, 2000);
  const ts = now();
  if (wechat) {
    const taken = db
      .prepare("SELECT id FROM customers WHERE wechat = ? AND id != ?")
      .get(wechat, body.id || "") as { id: string } | undefined;
    if (taken) throw new Error("该微信已绑定其他客户");
  }
  if (body.id) {
    const row = getCustomer(db, body.id);
    if (!row) throw new Error("客户不存在");
    db.prepare("UPDATE customers SET name=?, wechat=?, note=?, updated_at=? WHERE id=?").run(name, wechat, note, ts, body.id);
    return getCustomer(db, body.id) as CustomerRow;
  }
  const customerId = id("cus");
  db.prepare(
    "INSERT INTO customers (id, name, wechat, note, wallet_cents, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
  ).run(customerId, name, wechat, note, ts, ts);
  return getCustomer(db, customerId) as CustomerRow;
}

export function adjustWallet(db: DatabaseSync, customerId: string, yuan: number, reason: string): CustomerRow {
  const row = getCustomer(db, customerId);
  if (!row) throw new Error("客户不存在");
  if (!Number.isFinite(yuan) || yuan === 0) throw new Error("调账金额不能为 0");
  const delta = Math.round(yuan * 100);
  const next = row.wallet_cents + delta;
  if (next < 0) throw new Error("余额不足");
  const note = reason.trim().slice(0, 200) || (delta > 0 ? "充值" : "扣款");
  const ts = now();
  db.prepare("UPDATE customers SET wallet_cents=?, updated_at=? WHERE id=?").run(next, ts, customerId);
  db.prepare("INSERT INTO wallet_ledger (id, customer_id, delta_cents, reason, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id("led"),
    customerId,
    delta,
    note,
    ts,
  );
  return getCustomer(db, customerId) as CustomerRow;
}

export function listLedger(db: DatabaseSync, customerId: string): Array<{ id: string; delta_cents: number; reason: string; created_at: number }> {
  return db
    .prepare("SELECT id, delta_cents, reason, created_at FROM wallet_ledger WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100")
    .all(customerId) as Array<{ id: string; delta_cents: number; reason: string; created_at: number }>;
}

export function overviewStats(db: DatabaseSync): {
  trials: number;
  licensed: number;
  unusedKeys: number;
  customers: number;
  leads: number;
  walletYuan: number;
  openFeedbacks: number;
  betaClaims: number;
} {
  const trials = (db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE plan='trial'").get() as { c: number }).c;
  const licensed = (db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE plan='licensed'").get() as { c: number }).c;
  const unusedKeys = (db.prepare("SELECT COUNT(*) AS c FROM license_keys WHERE status='unused'").get() as { c: number }).c;
  const customers = (db.prepare("SELECT COUNT(*) AS c FROM customers").get() as { c: number }).c;
  const leads = (db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE lead_wechat != ''").get() as { c: number }).c;
  const wallet = (db.prepare("SELECT COALESCE(SUM(wallet_cents), 0) AS s FROM customers").get() as { s: number }).s;
  const openFeedbacks = (db.prepare("SELECT COUNT(*) AS c FROM feedbacks WHERE status='open'").get() as { c: number }).c;
  const betaClaims = (db.prepare("SELECT COUNT(*) AS c FROM beta_claims").get() as { c: number }).c;
  return {
    trials: Number(trials),
    licensed: Number(licensed),
    unusedKeys: Number(unusedKeys),
    customers: Number(customers),
    leads: Number(leads),
    walletYuan: Number(wallet) / 100,
    openFeedbacks: Number(openFeedbacks),
    betaClaims: Number(betaClaims),
  };
}
