import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type ConversationRow = {
  id: string;
  title: string;
  mode: "chat" | "agent";
  model: string;
  persona_id: string | null;
  account_id: string | null;
  /** 旧字段：迁移前直接挂在对话上的目录，新数据不再写 */
  workspace_root: string | null;
  /** 所属工作区（workspaces.id），Agent 对话必有，chat 为空 */
  workspace_id: string | null;
  /** 1 = 计划模式：先出方案，批准后才改文件 */
  plan_mode?: number;
  /** 对话目标，空串 = 未设 */
  goal?: string;
  /** 「对话」页签里的自定义分组（conversation_groups.id），空 = 未分组，按日期显示 */
  group_id?: string | null;
  created_at: number;
  updated_at: number;
};

export type WorkspaceRow = {
  id: string;
  account_id: string | null;
  name: string;
  root: string;
  pinned: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

export type PersonaRow = {
  id: string;
  name: string;
  body: string;
  greeting: string;
  account_id: string | null;
  created_at: number;
  updated_at: number;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  attachments: string | null;
  created_at: number;
};

export type DiffRow = {
  id: string;
  conversation_id: string;
  path: string;
  original: string;
  proposed: string;
  unified: string;
  status: string;
  created_at: number;
};

export type MediaRow = {
  id: string;
  conversation_id: string | null;
  account_id: string | null;
  type: string;
  status: string;
  prompt: string;
  model: string;
  params: string;
  result_url: string | null;
  local_path: string | null;
  error: string | null;
  provider_id: string | null;
  created_at: number;
  updated_at: number;
};

export function openDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "agnes.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'chat',
      model TEXT NOT NULL,
      persona_id TEXT,
      account_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      greeting TEXT NOT NULL DEFAULT '',
      account_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      attachments TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS diffs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      path TEXT NOT NULL,
      original TEXT,
      proposed TEXT,
      unified TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_jobs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      account_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model TEXT NOT NULL,
      params TEXT NOT NULL,
      result_url TEXT,
      local_path TEXT,
      error TEXT,
      provider_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      device_hash TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entitlements (
      id TEXT PRIMARY KEY,
      device_hash TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      chat_used INTEGER NOT NULL DEFAULT 0,
      chat_quota INTEGER NOT NULL,
      lead_wechat TEXT NOT NULL DEFAULT '',
      lead_bonus_applied INTEGER NOT NULL DEFAULT 0,
      license_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS license_keys (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      code_hint TEXT NOT NULL,
      chat_quota INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      redeemed_device_hash TEXT,
      redeemed_at INTEGER,
      plan_id TEXT,
      customer_id TEXT,
      note TEXT NOT NULL DEFAULT '',
      allow_image INTEGER NOT NULL DEFAULT 1,
      allow_video INTEGER NOT NULL DEFAULT 1,
      allow_agent INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      wechat TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      wallet_cents INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_ledger (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      delta_cents INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      chat_quota INTEGER NOT NULL DEFAULT 0,
      allow_image INTEGER NOT NULL DEFAULT 0,
      allow_video INTEGER NOT NULL DEFAULT 0,
      allow_agent INTEGER NOT NULL DEFAULT 0,
      price_cents INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_counters (
      day TEXT NOT NULL,
      subject TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (day, subject, kind)
    );
    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      ip TEXT NOT NULL,
      device_hash TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS feedbacks (
      id TEXT PRIMARY KEY,
      device_hash TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',
      images TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      reward_days INTEGER NOT NULL DEFAULT 0,
      reward_applied TEXT NOT NULL DEFAULT '',
      admin_note TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      client TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      reviewed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(account_id);
    CREATE INDEX IF NOT EXISTS idx_personas_account ON personas(account_id);
    CREATE INDEX IF NOT EXISTS idx_media_account ON media_jobs(account_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_diffs_conversation ON diffs(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_entitlements_device ON entitlements(device_hash);
    CREATE INDEX IF NOT EXISTS idx_entitlements_wechat ON entitlements(lead_wechat);
    CREATE INDEX IF NOT EXISTS idx_licenses_hash ON license_keys(code_hash);
    CREATE INDEX IF NOT EXISTS idx_customers_wechat ON customers(wechat);
    CREATE TABLE IF NOT EXISTS beta_claims (
      device_hash TEXT PRIMARY KEY,
      ip TEXT NOT NULL DEFAULT '',
      license_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_beta_claims_ip ON beta_claims(ip);
  `);
  migrateColumns(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_licenses_customer ON license_keys(customer_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ledger_customer ON wallet_ledger(customer_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_request_logs_kind ON request_logs(kind, created_at)");
  seedPlans(db);
  return db;
}

/**
 * 把旧版直接写在对话上的 workspace_root 收进 workspaces 表：同一账号同一目录合并成一个工作区。
 * 每次启动都跑，但只处理还没有 workspace_id 的行，幂等且便宜。
 */
function migrateWorkspaceRoots(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT id, account_id, workspace_root FROM conversations WHERE workspace_id IS NULL AND workspace_root IS NOT NULL AND workspace_root != ''",
    )
    .all() as Array<{ id: string; account_id: string | null; workspace_root: string }>;
  if (!rows.length) return;
  const ts = now();
  for (const row of rows) {
    const root = path.resolve(row.workspace_root);
    let ws = db
      .prepare("SELECT id FROM workspaces WHERE root = ? AND (account_id IS ? OR account_id = ?)")
      .get(root, row.account_id, row.account_id) as { id: string } | undefined;
    if (!ws) {
      const wsId = id("ws");
      db.prepare("INSERT INTO workspaces (id, account_id, name, root, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        wsId,
        row.account_id,
        path.basename(root) || root,
        root,
        ts,
        ts,
      );
      ws = { id: wsId };
    }
    db.prepare("UPDATE conversations SET workspace_id = ? WHERE id = ?").run(ws.id, row.id);
  }
}

function addColumn(db: DatabaseSync, table: string, column: string, sqlType: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
  }
}

function migrateColumns(db: DatabaseSync): void {
  addColumn(db, "conversations", "persona_id", "TEXT");
  addColumn(db, "conversations", "account_id", "TEXT");
  // 工作区是一等实体（workspaces 表），一个工作区下挂多个 Agent 对话。
  // workspace_root 是早先直接挂在对话上的目录，保留做迁移来源，下面把它们收进 workspaces。
  addColumn(db, "conversations", "workspace_root", "TEXT");
  addColumn(db, "conversations", "workspace_id", "TEXT");
  addColumn(db, "conversations", "plan_mode", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "goal", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "workspaces", "pinned", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "workspaces", "sort_order", "INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_workspaces_account ON workspaces(account_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id)");
  migrateWorkspaceRoots(db);
  addColumn(db, "personas", "account_id", "TEXT");
  addColumn(db, "media_jobs", "account_id", "TEXT");
  addColumn(db, "accounts", "device_hash", "TEXT");
  addColumn(db, "license_keys", "plan_id", "TEXT");
  addColumn(db, "license_keys", "customer_id", "TEXT");
  addColumn(db, "license_keys", "note", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "license_keys", "allow_image", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "license_keys", "allow_video", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "license_keys", "allow_agent", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "entitlements", "allow_image", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "entitlements", "allow_video", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "entitlements", "allow_agent", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "request_logs", "user_agent", "TEXT NOT NULL DEFAULT ''");
  // 时长制：duration_days 0 = 永久（现在只留给超管卡）；is_super = 超级管理员版
  addColumn(db, "plans", "duration_days", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "plans", "is_super", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "license_keys", "duration_days", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "license_keys", "is_super", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "entitlements", "expires_at", "INTEGER");
  addColumn(db, "entitlements", "is_super", "INTEGER NOT NULL DEFAULT 0");
  // 付费档的图/视频按「卡有效期内总量」给额度，0 = 不限
  addColumn(db, "plans", "image_quota", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "plans", "video_quota", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "license_keys", "image_quota", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "license_keys", "video_quota", "INTEGER NOT NULL DEFAULT 0");
  // 卡密是运营自己的库存，发出去之前要能反复查看和补发，只存哈希等于发完就找不回来了。
  // code_hash 仍然保留给激活校验；历史卡密没有明文可补，列表里显示为空。
  addColumn(db, "license_keys", "code_plain", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "entitlements", "image_quota", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "entitlements", "image_used", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "entitlements", "video_quota", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "entitlements", "video_used", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "entitlements", "bonus_days", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "feedbacks", "ticket_seq", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "feedbacks", "ticket_no", "TEXT NOT NULL DEFAULT ''");
  const unnumbered = db.prepare("SELECT id FROM feedbacks WHERE ticket_seq = 0 OR ticket_no = '' ORDER BY created_at ASC").all() as Array<{ id: string }>;
  if (unnumbered.length) {
    const base = Number(
      (db.prepare("SELECT COALESCE(MAX(CASE WHEN ticket_seq > 0 THEN ticket_seq END), 1000) AS n FROM feedbacks").get() as { n: number }).n,
    ) || 1000;
    const setTicket = db.prepare("UPDATE feedbacks SET ticket_seq = ?, ticket_no = ? WHERE id = ?");
    unnumbered.forEach((row, index) => {
      const seq = base + index + 1;
      setTicket.run(seq, `FB-${seq}`, row.id);
    });
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_feedbacks_ticket_seq ON feedbacks(ticket_seq) WHERE ticket_seq > 0");
  addColumn(db, "entitlements", "user_id", "TEXT");
  addColumn(db, "license_keys", "redeemed_user_id", "TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cloud_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_user ON entitlements(user_id) WHERE user_id IS NOT NULL");
  addColumn(db, "customers", "user_id", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_user ON customers(user_id) WHERE user_id IS NOT NULL");
  const unboundUsers = db
    .prepare(
      `SELECT id, username, created_at FROM cloud_users u
       WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.user_id = u.id)`,
    )
    .all() as Array<{ id: string; username: string; created_at: number }>;
  const insertCustomer = db.prepare(
    "INSERT INTO customers (id, name, wechat, note, wallet_cents, user_id, created_at, updated_at) VALUES (?, ?, '', ?, 0, ?, ?, ?)",
  );
  for (const user of unboundUsers) {
    const ts = user.created_at || Date.now();
    insertCustomer.run(id("cus"), user.username, "自助注册", user.id, ts, ts);
  }
  addColumn(db, "feedbacks", "kind", "TEXT NOT NULL DEFAULT 'other'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_feedbacks_device ON feedbacks(device_hash, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_feedbacks_kind ON feedbacks(kind, created_at DESC)");
  // 免费试用改为可以体验 Agent 与出图/出视频（日额度另外卡），历史试用行一并放开
  if (!getKv(db, "migrated_trial_try_all")) {
    db.exec("UPDATE entitlements SET allow_image=1, allow_video=1, allow_agent=1 WHERE plan='trial'");
    setKv(db, "migrated_trial_try_all", "1");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_device ON accounts(device_hash)");
  if (!getKv(db, "migrated_licensed_flags")) {
    db.exec(
      "UPDATE entitlements SET allow_image=1, allow_video=1, allow_agent=1 WHERE plan='licensed' AND allow_image=0 AND allow_video=0 AND allow_agent=0",
    );
    setKv(db, "migrated_licensed_flags", "1");
  }
  // 扣额度留一张单据：上游没成功时凭单据退还一次，成功用过的不能再退
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_tickets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      bill_hash TEXT NOT NULL,
      device_hash TEXT NOT NULL,
      chat_ticket TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      daily INTEGER NOT NULL DEFAULT 0,
      succeeded INTEGER NOT NULL DEFAULT 0,
      refunded INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quota_tickets_chat ON quota_tickets(chat_ticket);
    CREATE INDEX IF NOT EXISTS idx_quota_tickets_created ON quota_tickets(created_at);
    CREATE TABLE IF NOT EXISTS relay_revocations (
      device_hash TEXT PRIMARY KEY,
      not_before INTEGER NOT NULL
    );
  `);
  addColumn(db, "beta_claims", "user_id", "TEXT");
  addColumn(db, "beta_claims", "ip_block", "TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_beta_claims_user ON beta_claims(user_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_beta_claims_block ON beta_claims(ip_block)");
  addColumn(db, "entitlements", "trial_ip", "TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entitlements_trial_ip ON entitlements(trial_ip, created_at)");
  // 对话自定义分组（只加表和列，不动旧数据）
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_groups (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_groups_account ON conversation_groups(account_id, sort_order);
  `);
  addColumn(db, "conversations", "group_id", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_group ON conversations(group_id)");
  // 运营对反馈的回复（Markdown + 截图），和采纳 / 不采纳分开，可以多条
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_replies (
      id TEXT PRIMARY KEY,
      feedback_id TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      images TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_replies_feedback ON feedback_replies(feedback_id, created_at);
  `);
}

type PlanSeed = {
  id: string;
  name: string;
  chatQuota: number;
  imageQuota: number;
  videoQuota: number;
  durationDays: number;
  priceCents: number;
  sort: number;
  isSuper?: number;
  enabled?: number;
};

// 订阅制：三档按额度区分，全档都能用 Agent / 出图 / 出视频。
// 额度是「该卡有效期内的总量」，季/半年/年卡按月份倍数放大，价格给阶梯优惠。
// 不做永久版；duration_days 0 只留给超管卡。
const TIERS: Array<{ key: string; name: string; chat: number; image: number; video: number; monthly: number }> = [
  { key: "basic", name: "基础版", chat: 1000, image: 300, video: 30, monthly: 1800 },
  { key: "plus", name: "Plus", chat: 3000, image: 800, video: 80, monthly: 3000 },
  { key: "pro", name: "Pro", chat: 8000, image: 2000, video: 200, monthly: 5000 },
];

// 各周期的实收价（分）：月价×月数再打折，取整到好记的数字
const TERMS: Array<{ key: string; label: string; months: number; days: number; price: Record<string, number> }> = [
  { key: "1m", label: "月卡", months: 1, days: 30, price: { basic: 1800, plus: 3000, pro: 5000 } },
  { key: "3m", label: "季卡", months: 3, days: 90, price: { basic: 4800, plus: 7900, pro: 13500 } },
  { key: "6m", label: "半年卡", months: 6, days: 180, price: { basic: 8800, plus: 14800, pro: 24800 } },
  { key: "12m", label: "年卡", months: 12, days: 365, price: { basic: 15800, plus: 25800, pro: 43800 } },
];

function buildDefaultPlans(): PlanSeed[] {
  const out: PlanSeed[] = [];
  TIERS.forEach((tier, ti) => {
    TERMS.forEach((term, si) => {
      out.push({
        id: `${tier.key}_${term.key}`,
        name: `${tier.name} · ${term.label}`,
        chatQuota: tier.chat * term.months,
        imageQuota: tier.image * term.months,
        videoQuota: tier.video * term.months,
        durationDays: term.days,
        priceCents: term.price[tier.key],
        sort: (ti + 1) * 100 + si * 10,
      });
    });
  });
  out.push({
    id: "super",
    name: "超级管理员版",
    chatQuota: 0,
    imageQuota: 0,
    videoQuota: 0,
    durationDays: 0,
    priceCents: 0,
    sort: 900,
    isSuper: 1,
    enabled: 0,
  });
  return out;
}

const DEFAULT_PLANS = buildDefaultPlans();

function insertPlan(db: DatabaseSync, plan: PlanSeed, ts: number): void {
  db.prepare(
    `INSERT INTO plans (id, name, chat_quota, allow_image, allow_video, allow_agent, price_cents, enabled, sort_order, created_at, duration_days, is_super, image_quota, video_quota)
     VALUES (?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.id,
    plan.name,
    plan.chatQuota,
    plan.priceCents,
    plan.enabled ?? 1,
    plan.sort,
    ts,
    plan.durationDays,
    plan.isSuper ?? 0,
    plan.imageQuota,
    plan.videoQuota,
  );
}

function seedPlans(db: DatabaseSync): void {
  const ts = now();
  if (getKv(db, "seeded_plans_v3")) return;
  for (const plan of DEFAULT_PLANS) {
    const exists = db.prepare("SELECT id FROM plans WHERE id = ?").get(plan.id) as { id: string } | undefined;
    if (!exists) insertPlan(db, plan, ts);
  }
  // 不再卖永久版和旧价目：停售但保留记录，已发出去的卡还能查到出处
  db.exec("UPDATE plans SET enabled=0 WHERE is_super=0 AND duration_days=0");
  db.exec(
    "UPDATE plans SET enabled=0 WHERE id IN ('week7','month30','quarter90','year365','forever','plus','chat100')",
  );
  setKv(db, "seeded_plans_v3", "1");
}

export function getKv(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKv(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export type PersonaPreset = { name: string; body: string; greeting: string };

/** 每个对话空间都带上这些，避免人设页和对话都是空白。 */
export const DEFAULT_PERSONAS: PersonaPreset[] = [
  {
    name: "通用助手",
    body: "你是一位清楚、好相处的中文助手。先用一两句给结论，再按需要补步骤或例子。语气自然，像同事说话，不要客套和空话。用户没问的不要展开。不确定就直说，不要编。",
    greeting: "你好，我是通用助手。直接说你想办的事就行，我先给结论。",
  },
  {
    name: "文案编辑",
    body: "你是中文文案编辑。按用户要的语气改稿：更顺、更短、读起来像人话。先给改后的全文，再用三五条说明改了什么。不要擅自加口号、emoji 或营销腔。用户给了原文就基于原文改，不要另起一篇。",
    greeting: "把原文发我，再说一下给谁看、想要的语气和篇幅。",
  },
  {
    name: "翻译",
    body: "你是中英双向翻译。默认把中文译成自然的英文，英文译成自然的中文。保留专有名词、数字和格式。先给译文，必要时用一两句注明歧义。不要加原文没有的发挥。用户指定了目标语言就按指定的来。",
    greeting: "发一段文字过来。没说语言的话，中文我会译成英文，英文译成中文。",
  },
  {
    name: "编程搭档",
    body: "你是务实的编程搭档。先指出要改哪里，再给能直接用的代码。解释短，优先贴合用户现有的写法，不另起一套架构。不确定的接口不要假装记得。用户问原因时再展开。",
    greeting: "说一下你在用的语言和想改的行为。有报错就把报错贴过来。",
  },
  {
    name: "讲解",
    body: "你是耐心的讲解者。默认用日常比喻把事情讲明白，再给一个很小的例子。避免术语堆砌；必须用术语时先给一句人话。一次只讲一个重点，讲完问要不要继续往下。",
    greeting: "想弄懂哪一件事？我用大白话和一个小例子来讲。",
  },
  {
    name: "头脑风暴",
    body: "你是点子搭档。先给 5 个方向不同的想法，每个想法一两句，并标出适合什么情况。不要一上来否定。用户选定一个之后，再帮他把那一个收成可执行的下一步。",
    greeting: "题目是什么、给谁用、有什么限制？我先给几个不同方向。",
  },
];

const LEGACY_PERSONA_BODIES: Record<string, string> = {
  通用助手: "你是耐心、简洁的中文助手。先给结论，再补必要说明。不要装腔作势。",
  文案编辑: "你是中文文案编辑。按用户指定的语气改稿：更顺、更短、更适合阅读。改完用条目说明改了什么。不要擅自加营销口号。",
};

export function seedPersonas(db: DatabaseSync, accountId: string): void {
  const flag = `persona_defaults_v2:${accountId}`;
  if (getKv(db, flag) === "1") return;
  const rows = db.prepare("SELECT id, name, body FROM personas WHERE account_id = ?").all(accountId) as Array<{
    id: string;
    name: string;
    body: string;
  }>;
  const byName = new Map(rows.map((row) => [row.name, row]));
  const ts = now();
  const insert = db.prepare(
    "INSERT INTO personas (id, name, body, greeting, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const refresh = db.prepare("UPDATE personas SET body = ?, greeting = ?, updated_at = ? WHERE id = ?");
  DEFAULT_PERSONAS.forEach((preset, index) => {
    const stamp = ts + (DEFAULT_PERSONAS.length - index);
    const found = byName.get(preset.name);
    if (!found) {
      insert.run(id("p"), preset.name, preset.body, preset.greeting, accountId, stamp, stamp);
      return;
    }
    if (found.body === LEGACY_PERSONA_BODIES[preset.name]) {
      refresh.run(preset.body, preset.greeting, stamp, found.id);
    }
  });
  setKv(db, flag, "1");
}

export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function now(): number {
  return Date.now();
}
