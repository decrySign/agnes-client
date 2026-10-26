import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { AgnesClient, DEFAULT_CHAT_MODEL, sanitizeToolCalls, VIDEO_POLL_PATH } from "@agnes/sdk";
import type { ChatContentPart, ChatMessage } from "@agnes/sdk";
import {
  appendAllowRule,
  assertInside,
  assertSafeWorkspaceRoot,
  collectSymbols,
  disallowedReason,
  expandMentions,
  gitSummary,
  listSkills,
  normalizeAllowText,
  compactBudget,
  compactForModel,
  messageChars,
  parseSummaryCache,
  planModelSummary,
  projectContext,
  rankSymbols,
  readProjectRules,
  readSkill,
  REFUSAL_TEXT,
  revertConversationCommits,
  ruleForCommand,
  runAgent,
  Workspace,
  ensureGitReady,
  withWorkspaceLock,
  ensureSharedMcpHub,
  getMcpStatus,
  getSharedMcpHub,
  loadMergedMcpConfig,
  disposeBgTerminalsForConv,
  formatBgTerminalPreamble,
  mergeToolTimeouts,
  parseToolTimeoutsPatch,
} from "@agnes/agent";
import type { DiffProposal, PlanVerdict, RunAgentResult, ToolRuntime } from "@agnes/agent";
import {
  DESKTOP_APPROVAL_KV,
  DESKTOP_CHAT_MODEL_KV,
  DESKTOP_COMMAND_ALLOW_KV,
  DESKTOP_TOOL_TIMEOUTS_KV,
  DESKTOP_WORKSPACE_KV,
  isAdminHost,
  isApiHost,
  isKnownHost,
  parseApprovalMode,
  publicSettings,
  type AppConfig,
} from "./config.js";
import { desktopZipPath, readUpdateManifest, updatePackagePath } from "./updates.js";
import {
  configureProviderSecrets,
  customModelId,
  deleteProvider,
  findProvider,
  KEY_FOR_NEW_ORIGIN,
  listPublicProviders,
  parseCustomModel,
  sameProviderOrigin,
  parseProtocol,
  probeModels,
  resolveCustomChat,
  upsertProvider,
  capsForModel,
  loadBuiltinCaps,
  modelCapsMap,
  parseModelCapsMap,
  saveBuiltinCaps,
} from "./providers.js";
import { parseCustomModel as parseCustomModelForUsage } from "./providers.js";
import { createTurnTracker, deleteTurnUsage, deleteTurnUsageSince, listTurnUsage } from "./turn-usage.js";
import { normalizeGoal } from "@agnes/agent";
import { ensureCustomerForUser } from "./catalog.js";
import { getKv, id, now, setKv, type ConversationRow, type DiffRow, type MediaRow, type MessageRow, type PersonaRow } from "./db.js";
import {
  accountFromSession,
  cookieValue,
  createProfile,
  createSession,
  deleteSession,
  ensureDefaultProfile,
  ensureProfileForDevice,
  listAccounts,
  publicAccount,
  sessionCookie,
} from "./accounts.js";
import {
  ensureLocalKeyOperator,
  chatTicketRefunded,
  consumeChat,
  consumeMedia,
  createQuotaTicket,
  entitlementForViewer,
  getEntitlement,
  markChatTicketUsed,
  parseDeviceHash,
  publicEntitlement,
  refundChat,
  refundMedia,
  refundQuotaTicket,
  relayNotBefore,
  repairDesktopTrialQuota,
  startTrial,
  userHasLiveLicense,
  type BetaOffer,
  type EntitlementPublic,
} from "./entitlements.js";
import { loginUser, logoutUser, registerUser, userCookie, userFromToken, type CloudUser } from "./users.js";
import { createFeedback, listMine, readFeedbackFile } from "./feedback.js";
// OSS: relay module removed — local shims; /api/oss-no-relay routes deleted.
function isRelayPath(_p: string): boolean { return false; }
async function licenseFetch(..._a: unknown[]): Promise<{ status: number; data: any }> {
  return { status: 404, data: { error: "oss-local-only" } };
}
function bearerOf(_h: string | undefined): string { return ""; }
function issueChatTicket(..._a: unknown[]): { ticket: string; exp: number } { return { ticket: "", exp: 0 }; }
function verifyChatTicket(..._a: unknown[]): boolean { return false; }
function readBodyLimited(..._a: unknown[]): Promise<string> { return Promise.resolve(""); }
const RELAY_PATH = "/api/oss-no-relay";
const RELAY_CHAT_MAX_BYTES = 1;
const RELAY_FETCH_TIMEOUT_MS = 1;
const RELAY_MEDIA_MAX_BYTES = 1;
const RELAY_STREAM_IDLE_MS = 1;
function relayDeadline(..._a: unknown[]): number { return 0; }
function relayStream(..._a: unknown[]): never { throw new Error("oss"); }
function relayTokenFor(..._a: unknown[]): string { return ""; }
function releaseRelay(..._a: unknown[]): void {}
function tryAcquireRelay(..._a: unknown[]): boolean { return false; }
function verifyRelayToken(..._a: unknown[]): boolean { return false; }
function relayEndpoints(_b: string): { baseUrl: string; videoPollUrl: string } { return { baseUrl: "", videoPollUrl: "" }; }
import {
  deleteWorkspace,
  ensureWorkspace,
  getWorkspace,
  listWorkspaces,
  makeWorkspaceDir,
  normalizeRoot,
  reorderWorkspaces,
  touchWorkspace,
  updateWorkspace,
  WorkspaceRootError,
} from "./workspaces.js";
import {
  MEDIA_CACHE_CONTROL,
  attachmentDisposition,
  MAX_IMAGE_PARALLEL,
  imageCountOf,
  insertMedia,
  mediaContentType,
  relayRefundedFlag,
  runPool,
  mediaDownloadName,
  mediaIdFromRef,
  mediaPublicPath,
  persistBase64,
  persistRemoteFile,
  updateMedia,
} from "./media.js";
import { ensureMediaPreview } from "./preview.js";
import {
  createGroup,
  deleteGroup,
  listGroups,
  moveConversationToGroup,
  renameGroup,
  reorderGroups,
} from "./conversation-groups.js";

/** 免费档图/视频的按天余量（授权服务器 /api/entitlements/status 下发，中转模式的桌面端用它） */
type MediaQuotaPublic = {
  image: { used: number; remaining: number | null; limit: number };
  video: { used: number; remaining: number | null; limit: number; windowDays: number };
};
import { ipAllowlist, ipFusedGuard, publicError, quotaThenFuse, rateLimit, requestIp, safeDownloadName, safeUploadName, tokensMatch } from "./security.js";
import {
  DAILY_CHAT_EXHAUSTED,
  insertRequestLog,
  inspectDailyChat,
  inspectQuota,
  kindFromPath,
  quotaExhaustedMessage,
  refundQuota,
  shouldLogRequest,
  takeDailyChat,
  takeQuota,
} from "./usage.js";

/** 上下文摘录（对话里自动的、/compact 手动的）最多等这么久，超时改用机械摘录 / 报错 */
const SUMMARY_TIMEOUT_MS = 90_000;

type Waiter = {
  resolve: (v: "applied" | "rejected" | "stale") => void;
};

const waiters = new Map<string, Waiter>();
/**
 * 按对话隔离的停止开关。同一对话未结束再发 409；同一工作区的多个 Agent 可以并行
 * （Cursor / Codex 都允许），写文件和 git 提交由 @agnes/agent 的 withWorkspaceLock 按目录排队。
 */
const abortors = new Map<string, AbortController>();

type CommandWaiter = { convId: string; command: string; resolve: (v: "approved" | "denied") => void };
/** 待审批的终端命令，只活在内存里：进程一重启就当拒绝处理 */
const commandWaiters = new Map<string, CommandWaiter>();
type GitSetupWaiter = { convId: string; resolve: (v: "install" | "skip" | "redetect") => void };
const gitSetupWaiters = new Map<string, GitSetupWaiter>();
type QuestionWaiter = { convId: string; resolve: (answer: string) => void };
const questionWaiters = new Map<string, QuestionWaiter>();
type PlanWaiter = { convId: string; resolve: (v: PlanVerdict) => void };
const planWaiters = new Map<string, PlanWaiter>();
/**
 * 还在等用户处理的卡片（提问 / 方案 / 命令审批），按对话存一份原始事件。
 * 桌面端刷新或切走再回来时，界面靠它把卡片和停止按钮补回来；本轮结束就清掉。
 */
const pendingCards = new Map<string, Map<string, Record<string, unknown>>>();

/** 停掉一个对话的这一轮，并把挂着的命令审批 / git 设置放掉，否则工具会一直等到超时 */
function stopConv(convId: string): void {
  abortors.get(convId)?.abort();
  for (const w of commandWaiters.values()) if (w.convId === convId) w.resolve("denied");
  for (const w of gitSetupWaiters.values()) if (w.convId === convId) w.resolve("skip");
}

/** 等这些对话的这一轮收尾（最多 5 秒） */
async function waitStopped(ids: string[]): Promise<void> {
  for (let i = 0; i < 50 && ids.some((id) => abortors.has(id)); i++) await new Promise((r) => setTimeout(r, 100));
}

function holdCard(convId: string, event: { id: string } & Record<string, unknown>): void {
  const cards = pendingCards.get(convId) ?? new Map<string, Record<string, unknown>>();
  cards.set(event.id, event);
  pendingCards.set(convId, cards);
}

function dropCard(convId: string, cardId: string): void {
  pendingCards.get(convId)?.delete(cardId);
}

export type MessageAttachment = { type: "image"; mediaId?: string; url?: string; name?: string };


/** 子代理步骤入库前限大小：单个字符串截到 4000 字，总量按 UTF-8 字节超 256KB 就丢最早的步骤，单步仍超限则换成摘要 */
const SUB_STEP_STR_MAX = 4000;
const SUB_STEPS_JSON_MAX = 256 * 1024;
function capSubSteps(steps: unknown): string {
  const clip = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.length <= SUB_STEP_STR_MAX) return v;
      // 别把代理对（emoji 等）从中间切开
      let end = SUB_STEP_STR_MAX;
      const c = v.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1;
      return v.slice(0, end) + `…[已截断 ${v.length - end} 字]`;
    }
    if (Array.isArray(v)) return v.map(clip);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clip(x);
      return out;
    }
    return v;
  };
  let list = Array.isArray(steps) ? (steps.map(clip) as unknown[]) : [];
  let dropped = 0;
  const size = (s: string) => Buffer.byteLength(s, "utf8");
  let json = JSON.stringify({ sub_steps: list });
  while (size(json) > SUB_STEPS_JSON_MAX && list.length > 1) {
    const cut = Math.max(1, Math.ceil(list.length / 4));
    list = list.slice(cut);
    dropped += cut;
    json = JSON.stringify({ sub_steps: list, sub_steps_dropped: dropped });
  }
  if (size(json) > SUB_STEPS_JSON_MAX) {
    // 只剩一个步骤仍超限（字段太多）：换成一行摘要，保证入库大小有上限
    const last = list[0] as Record<string, unknown> | undefined;
    const name = last && typeof last.name === "string" ? last.name : "step";
    const summary: Record<string, unknown> = { name, result: `[步骤过大，已省略：约 ${Math.round(size(json) / 1024)}KB]` };
    // 保留归属字段，刷新后还能挂回所属子代理
    for (const k of ["id", "parent", "parent_id", "tool_call_id", "status"]) {
      const x = last?.[k];
      if (typeof x === "string" || typeof x === "number") summary[k] = typeof x === "string" ? x.slice(0, 200) : x;
    }
    json = JSON.stringify({ sub_steps: [summary], sub_steps_dropped: dropped + (list.length - 1) });
  }
  return json;
}

export function parseAttachments(raw: unknown): MessageAttachment[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: MessageAttachment[] = [];
  for (const item of list.slice(0, 6)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.type !== "image") continue;
    const mediaId = typeof rec.mediaId === "string" ? rec.mediaId : "";
    const rawUrl = typeof rec.url === "string" ? rec.url : "";
    // data URL 只给预览用，不能写进 sqlite
    const url = rawUrl && !/^data:/i.test(rawUrl) ? rawUrl : "";
    if (!mediaId && !url) continue;
    out.push({
      type: "image",
      ...(mediaId ? { mediaId } : {}),
      ...(url ? { url } : {}),
      ...(typeof rec.name === "string" ? { name: rec.name.slice(0, 120) } : {}),
    });
  }
  return out;
}

function rowToMessage(row: MessageRow): ChatMessage {
  const msg: ChatMessage = {
    role: row.role as ChatMessage["role"],
    content: row.content,
  };
  if (row.tool_call_id) msg.tool_call_id = row.tool_call_id;
  if (row.tool_calls) {
    try {
      const parsed = JSON.parse(row.tool_calls) as unknown;
      if (Array.isArray(parsed)) msg.tool_calls = sanitizeToolCalls(parsed as ChatMessage["tool_calls"]);
    } catch {
      /* ignore */
    }
  }
  return msg;
}

function cookieToken(header: string | undefined): string {
  return cookieValue(header, "agnes_token");
}



function skipAppToken(pathName: string): boolean {
  return (
    isRelayPath(pathName) ||
    pathName === "/api/health" ||
    pathName === "/api/session" ||
    pathName === "/api/auth" ||
    pathName === "/api/entitlements/status" ||
    pathName === "/api/users/register" ||
    pathName === "/api/users/login" ||
    pathName === "/api/users/logout" ||
    pathName === "/api/entitlements/consume" ||
    pathName === "/api/entitlements/consume-media" ||
    pathName === "/api/entitlements/refund-media" ||
    pathName === "/api/entitlements/refund-chat" ||
    pathName === "/api/updates/latest" ||
    pathName === "/api/updates/package" ||
    pathName === "/api/updates/desktop"
  );
}

function skipAccount(pathName: string): boolean {
  return (
    skipAppToken(pathName) ||
    pathName === "/api/accounts" ||
    pathName === "/api/accounts/select" ||
    pathName === "/api/accounts/logout" ||
    pathName === "/api/licenses" ||
    pathName.startsWith("/api/licenses/")
  );
}

function clip(text: string, max: number): string {
  return text.trim().slice(0, max);
}

function parsePersona(body: { name?: string; body?: string; greeting?: string }): { name: string; body: string; greeting: string } | { error: string } {
  const name = clip(body.name ?? "", 40);
  const personaBody = clip(body.body ?? "", 8000);
  const greeting = clip(body.greeting ?? "", 500);
  if (!name || !personaBody) return { error: "人设需要名称和正文" };
  if (disallowedReason(personaBody, "chat")) return { error: REFUSAL_TEXT };
  return { name, body: personaBody, greeting };
}

function parseProfileName(name: string): string | { error: string } {
  const next = clip(name, 32);
  if (next.length < 1) return { error: "档案名不能为空" };
  if (/\s/.test(next)) return { error: "档案名不能含空格" };
  return next;
}

function ownConv(db: DatabaseSync, convId: string, accountId: string): ConversationRow | undefined {
  return db.prepare("SELECT * FROM conversations WHERE id = ? AND account_id = ?").get(convId, accountId) as
    | ConversationRow
    | undefined;
}

function ownPersona(db: DatabaseSync, personaId: string, accountId: string): PersonaRow | undefined {
  return db.prepare("SELECT * FROM personas WHERE id = ? AND account_id = ?").get(personaId, accountId) as
    | PersonaRow
    | undefined;
}

function ownMedia(db: DatabaseSync, mediaId: string, accountId: string): MediaRow | undefined {
  return db.prepare("SELECT * FROM media_jobs WHERE id = ? AND account_id = ?").get(mediaId, accountId) as
    | MediaRow
    | undefined;
}

function ownDiff(db: DatabaseSync, diffId: string, accountId: string): DiffRow | undefined {
  return db
    .prepare(
      `SELECT d.* FROM diffs d
       INNER JOIN conversations c ON c.id = d.conversation_id
       WHERE d.id = ? AND c.account_id = ?`,
    )
    .get(diffId, accountId) as DiffRow | undefined;
}

type AppEnv = { Variables: { accountId: string } };


function betaOffer(..._a: unknown[]): null { return null; }
function attachDeviceLicense(..._a: unknown[]): void {}
function markTrialIp(..._a: unknown[]): void {}
function recentTrialsFromBlock(..._a: unknown[]): number { return 0; }

export function createApp(cfg: AppConfig, db: DatabaseSync): Hono<AppEnv> {
  // OSS_FORCE_LOCAL
  cfg.licenseServerUrl = "";
  cfg.relayManaged = false;
  cfg.relaySecret = "";
  cfg.adminHost = "";
  const app = new Hono<AppEnv>();
  void ensureSharedMcpHub(loadMergedMcpConfig(cfg.dataDir, cfg.workspaceRoot)).catch((err) => {
    console.error("[mcp] hub start:", err instanceof Error ? err.message : err);
  });
  if (cfg.desktopMode) {
    // provider 密钥落盘前加密；桌面打包版由 Electron safeStorage 提供系统钥匙串
    configureProviderSecrets(cfg.dataDir);
    if (parseCustomModel(cfg.chatModel) && !resolveCustomChat(db, cfg.chatModel)) cfg.chatModel = DEFAULT_CHAT_MODEL;
  }
  const localRelay = cfg.relayManaged ? relayEndpoints(cfg.licenseServerUrl) : null;
  const agnes = new AgnesClient({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    ...(localRelay ? { videoPollUrl: localRelay.videoPollUrl } : {}),
  });
  // Desktop starts with no key at all and gets one from the license server (see applyRelayCredential).
  let relayToken = "";
  let chatTicket = "";
  let cloudUserToken = "";
  let relayDevice = "";

  function deviceOf(c: { req: { header: (name: string) => string | undefined } }): string {
    return parseDeviceHash(c.req.header("x-agnes-device"));
  }

  function userTokenFrom(c: { req: { header: (name: string) => string | undefined } }): string {
    const header = String(c.req.header("x-agnes-user") || "").trim();
    if (header) return header;
    return cookieValue(c.req.header("cookie"), "agnes_user");
  }

  function signedInUser(c: { req: { header: (name: string) => string | undefined } }): CloudUser | undefined {
    return userFromToken(db, userTokenFrom(c) || (cfg.desktopMode ? cloudUserToken : ""));
  }

  function viewerEntitlement(c: { req: { header: (name: string) => string | undefined } }) {
    const user = signedInUser(c);
    const row = entitlementForViewer(db, user?.id || "", deviceOf(c));
    if (!row) return null;
    const pub = publicEntitlement(row, db);
    if (!cfg.desktopMode && c.req.header("x-agnes-client") !== "desktop") return { ...pub, allowAgent: false };
    return pub;
  }

  function billingHash(c: { req: { header: (name: string) => string | undefined } }): string {
    const user = signedInUser(c);
    const row = user ? entitlementForViewer(db, user.id, "") : undefined;
    if (row?.plan === "licensed" && row.status !== "revoked") return row.device_hash;
    return deviceOf(c);
  }

  function rememberCloudUser(token: string): void {
    cloudUserToken = token;
    if (!relayDevice) return;
    agnes.setHeaders({
      "x-agnes-device": relayDevice,
      ...(token ? { "x-agnes-user": token } : {}),
      ...(chatTicket ? { "x-agnes-chat-ticket": chatTicket } : {}),
    });
  }

  function workspaceOf(deviceHash: string) {
    return cfg.desktopMode ? ensureDefaultProfile(db) : ensureProfileForDevice(db, deviceHash);
  }

  /**
   * 对话级工作区：Agent 各自盯着不同的目录，没设过的沿用设置页那个默认值。
   * 存进来时已经校验过，这里再兜一次，防止目录被挪走或手改库留下坏值。
   */
  function workspaceRootOf(conv?: { workspace_id?: string | null; workspace_root?: string | null } | null): string {
    if (!cfg.desktopMode) return cfg.workspaceRoot;
    // 一个工作区下多个 Agent 共用同一个目录；老数据里直接挂在对话上的 workspace_root 只作兜底
    let custom = "";
    if (conv?.workspace_id) {
      const ws = db.prepare("SELECT root FROM workspaces WHERE id = ?").get(conv.workspace_id) as { root: string } | undefined;
      custom = ws?.root ?? "";
    }
    if (!custom) custom = String(conv?.workspace_root || "").trim();
    if (!custom) return cfg.workspaceRoot;
    try {
      assertSafeWorkspaceRoot(custom);
      fs.mkdirSync(custom, { recursive: true });
      return custom;
    } catch {
      return cfg.workspaceRoot;
    }
  }

  /**
   * 带图的用户消息要转成 OpenAI 的 content parts 才会被模型看见。图存在媒体目录里，
   * 这里读回来内联成 data URI —— 上游拿不到我们本机的 127.0.0.1，也拿不到要登录的 /api/media。
   */
  async function rowToModelMessage(row: MessageRow): Promise<ChatMessage> {
    const base = rowToMessage(row);
    if (row.role !== "user" || !row.attachments) return base;
    let images: MessageAttachment[];
    try {
      images = parseAttachments(JSON.parse(row.attachments));
    } catch {
      return base;
    }
    if (!images.length) return base;
    const parts: ChatContentPart[] = [];
    const text = typeof base.content === "string" ? base.content : "";
    if (text) parts.push({ type: "text", text });
    for (const img of images) {
      const url = await attachmentDataUri(img);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
    if (parts.length <= (text ? 1 : 0)) return base;
    return { ...base, content: parts };
  }

  async function attachmentDataUri(img: MessageAttachment): Promise<string> {
    if (img.url && /^data:image\//i.test(img.url)) return img.url;
    const mediaId = img.mediaId || mediaIdFromRef(img.url || "");
    if (mediaId) {
      const row = db.prepare("SELECT local_path FROM media_jobs WHERE id = ?").get(mediaId) as
        | { local_path: string | null }
        | undefined;
      const local = row?.local_path;
      if (local) {
        try {
          assertInside(cfg.mediaDir, local);
          const buf = await fsPromises.readFile(local);
          const ext = path.extname(local).toLowerCase();
          const mime =
            ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
          return `data:${mime};base64,${buf.toString("base64")}`;
        } catch {
          return "";
        }
      }
      // 自家 /api/media 要登录，Agnes 去下载会 401，宁可缺图也不把这个 URL 交出去
      return "";
    }
    if (img.url && /^https:\/\//i.test(img.url)) return img.url;
    return "";
  }

  /** 工作区类接口按 ?workspaceId= 或 ?conversationId= 定位，都不传就落到默认工作区 */
  function workspaceOfRequest(c: Context): Workspace {
    const accountId = c.get("accountId");
    const wsId = c.req.query("workspaceId") || "";
    if (wsId) {
      const ws = getWorkspace(db, wsId, accountId);
      if (ws) return new Workspace(workspaceRootOf({ workspace_id: ws.id }));
    }
    const convId = c.req.query("conversationId") || "";
    const conv = convId ? ownConv(db, convId, accountId) : undefined;
    return new Workspace(workspaceRootOf(conv));
  }

  /**
   * 建/改 Agent 对话时决定它挂哪个工作区：优先 workspaceId，其次 workspaceRoot（找不到就建一个），
   * 都没给就用设置页默认目录对应的工作区。Agent 对话必有工作区，否则侧栏没法按工作区分组。
   */
  function resolveWorkspaceForConv(
    accountId: string,
    body: { workspaceId?: string; workspaceRoot?: string },
  ): { id: string } | { error: string } {
    if (!cfg.desktopMode) return { error: "网页版没有工作区" };
    try {
      if (typeof body.workspaceId === "string" && body.workspaceId.trim()) {
        const ws = getWorkspace(db, body.workspaceId.trim(), accountId);
        return ws ? { id: ws.id } : { error: "工作区不存在" };
      }
      const root = typeof body.workspaceRoot === "string" && body.workspaceRoot.trim() ? body.workspaceRoot : cfg.workspaceRoot;
      return { id: ensureWorkspace(db, accountId, root).id };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function resolveMediaRef(ref: string): Promise<string> {
    const raw = ref.trim();
    if (!raw) return raw;
    if (raw.startsWith("data:")) return raw;
    const owned = mediaIdFromRef(raw);
    if (owned) {
      const uri = await attachmentDataUri({ type: "image", mediaId: owned, url: raw });
      return uri || "";
    }
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!cfg.desktopMode) return raw;
    const ws = new Workspace(cfg.workspaceRoot);
    return ws.fileToDataUri(raw).catch(() => raw);
  }

  function sidFor(accountId: string): string {
    return sessionCookie(createSession(db, accountId).token, cfg.isProduction, 30 * 24 * 3600);
  }

  async function webAccount(
    c: { req: { header: (name: string) => string | undefined } },
    opts?: { allowCookieOnly?: boolean },
  ): Promise<{
    account: ReturnType<typeof accountFromSession>;
    setCookie?: string;
  }> {
    const cookieAccount = accountFromSession(db, cookieValue(c.req.header("cookie"), "agnes_sid"));
    if (cfg.desktopMode) return { account: cookieAccount };
    const deviceHash = deviceOf(c);
    if (!deviceHash) {
      // <img src="/api/media/:id"> 带得了 Cookie，带不了 x-agnes-device
      if (opts?.allowCookieOnly && cookieAccount) return { account: cookieAccount };
      return { account: undefined };
    }
    const ent = await entitlementNow(deviceHash);
    if (!ent) return { account: undefined };
    const bound = ensureProfileForDevice(db, deviceHash);
    if (cookieAccount?.id === bound.id) return { account: cookieAccount };
    return { account: bound, setCookie: sidFor(bound.id) };
  }

  async function licenseFetch(
    pathName: string,
    deviceHash: string,
    method: string,
    body?: unknown,
    timeoutMs = 12_000,
  ): Promise<{ status: number; data: unknown }> {
    const res = await fetch(`${cfg.licenseServerUrl}${pathName}`, {
      method,
      headers: {
      "Content-Type": "application/json",
      "x-agnes-device": deviceHash,
      "x-agnes-client": "desktop",
      ...(cloudUserToken ? { "x-agnes-user": cloudUserToken } : {}),
    },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({ error: "授权服务无响应" }))) as unknown;
    if (res.status === 200) applyRelayCredential(deviceHash, data);
    return { status: res.status, data };
  }

  /**
   * 桌面端：授权服务器在试用/激活/状态响应里回一枚设备绑定的中转令牌，拿到就把 SDK 切到
   * 中转通道。没有这一步本机进程就没有模型访问权，Agent 也就跑不起来。
   */
  function applyRelayCredential(deviceHash: string, data: unknown): void {
    if (!cfg.relayManaged || !deviceHash) return;
    relayDevice = deviceHash;
    const relay = (data as { relay?: { token?: string; baseUrl?: string; videoPollUrl?: string } }).relay;
    const token = String(relay?.token || "").trim();
    const nextTicket = String((data as { chatTicket?: string }).chatTicket || "").trim();
    if (nextTicket) chatTicket = nextTicket;
    if (token && token !== relayToken) {
      relayToken = token;
      cfg.apiKey = token;
      agnes.setApiKey(token);
      if (relay?.baseUrl) agnes.setBaseUrl(relay.baseUrl);
      if (relay?.videoPollUrl) agnes.setVideoPollUrl(relay.videoPollUrl);
    }
    if (!token && !nextTicket) return;
    agnes.setHeaders({
      "x-agnes-device": deviceHash,
      ...(cloudUserToken ? { "x-agnes-user": cloudUserToken } : {}),
      ...(chatTicket ? { "x-agnes-chat-ticket": chatTicket } : {}),
    });
  }

  /**
   * 返回不为空就是不能调模型的原因。中转模式下凭证是跟授权状态一起回来的，所以先补一次
   * 状态查询再判断，避免刚启动就报「没配密钥」。
   */
  function settingsPayload() {
    const providers = cfg.desktopMode ? listPublicProviders(db) : [];
    const pub = publicSettings(cfg);
    const extra = providers.flatMap((provider) => provider.models.map((model) => customModelId(provider.id, model)));
    const chat = [...new Set([...pub.models.chat, ...extra])];
    return {
      ...pub,
      providers,
      models: { ...pub.models, chat },
      // 每个可选模型的能力：输入框据此拦图片，设置页显示文档值
      modelCaps: modelCapsMap(db, chat, providers),
      ...(cfg.desktopMode ? { builtinModelCaps: loadBuiltinCaps(db, pub.models.chat.filter((m) => !parseCustomModel(m))) } : {}),
    };
  }

  async function ensureModelAccess(deviceHash: string, model = ""): Promise<string | null> {
    if (parseCustomModel(model)) {
      if (!cfg.desktopMode) return "自定义模型只在桌面客户端使用";
      return resolveCustomChat(db, model) ? null : "这个对话用的自定义模型已删除或没有密钥，请在输入框下方换一个模型";
    }
    if (cfg.apiKey) return null;
    if (!cfg.relayManaged) return "未配置 AGNES_API_KEY";
    if (deviceHash) await entitlementNow(deviceHash).catch(() => null);
    return cfg.apiKey ? null : "还没拿到模型通道凭证：请到「设置」里配置 AGNES_API_KEY，已激活的话重启客户端再试";
  }

  /** 对话级模型校验：网页只能用列表里的内置模型，自定义模型只在桌面端且要能解析出密钥 */
  function chatModelProblem(model: string): string | null {
    if (!model) return null;
    if (model.length > 200) return "模型名太长";
    if (parseCustomModel(model)) {
      if (!cfg.desktopMode) return "自定义模型只在桌面客户端使用";
      return resolveCustomChat(db, model) ? null : "这个自定义模型不存在，或还没有密钥";
    }
    if (!cfg.desktopMode && !publicSettings(cfg).models.chat.includes(model)) return "网页版不能使用这个模型";
    return null;
  }

  async function entitlementNow(deviceHash: string): Promise<EntitlementPublic | null> {
    if (!deviceHash) return null;
    if (false /* oss */) {
      const remote = await licenseFetch("/api/entitlements/status", deviceHash, "GET");
      if (remote.status !== 200) return null;
      return (remote.data as { entitlement?: EntitlementPublic }).entitlement ?? (remote.data as EntitlementPublic);
    }
    const row = getEntitlement(db, deviceHash);
    return row ? publicEntitlement(row, db) : null;
  }

  /** 付费档扣图/视频额度；桌面生产走 LICENSE_SERVER_URL 时转给授权服务器 */
  /** 返回授权服务器给的退还单据（本机扣的不需要） */
  async function consumeMediaQuota(deviceHash: string, kind: "image" | "video"): Promise<string> {
    if (false /* oss */) {
      const remote = await licenseFetch("/api/entitlements/consume-media", deviceHash, "POST", { kind });
      if (remote.status !== 200) {
        throw new Error((remote.data as { error?: string }).error || "额度校验失败");
      }
      return String((remote.data as { refundTicket?: string }).refundTicket || "");
    }
    consumeMedia(db, deviceHash, kind);
    return "";
  }

  /** 返回这次是否真的退回了（界面据此决定显示「次数已退回」） */
  async function refundMediaQuota(deviceHash: string, kind: "image" | "video", ticket = ""): Promise<boolean> {
    try {
      if (false /* oss */) {
        // 旧授权服务器没有单据也照发，它会按旧逻辑退；新服务器只认单据
        const remote = await licenseFetch("/api/entitlements/refund-media", deviceHash, "POST", { kind, ticket });
        return remote.status === 200;
      }
      const row = getEntitlement(db, deviceHash);
      const quota = Number(kind === "image" ? row?.image_quota : row?.video_quota) || 0;
      const used = Number(kind === "image" ? row?.image_used : row?.video_used) || 0;
      refundMedia(db, deviceHash, kind);
      return Boolean(row && !Number(row.is_super) && quota > 0 && used > 0);
    } catch {
      /* 退还失败不该盖掉上游的真实报错 */
      return false;
    }
  }

  /** 多张出图前的余量：null = 不限或查不到（查不到时由逐张扣费兜底） */
  async function imageRemainingFor(c: Context, ent: EntitlementPublic | null): Promise<number | null> {
    if (!ent || ent.isSuper) return null;
    if (ent.plan === "licensed") return ent.imageRemaining ?? null;
    if (false /* oss */) {
      const remote = await licenseFetch("/api/entitlements/status", deviceOf(c), "GET");
      const image = (remote.data as { mediaQuota?: { image?: { remaining?: number | null } } } | null)?.mediaQuota?.image;
      return typeof image?.remaining === "number" ? image!.remaining! : null;
    }
    if (q.dailyImage <= 0) return null;
    return inspectQuota(db, requestIp(c, proxy), deviceOf(c), "image", q.dailyImage, 1).remaining;
  }

  function webCopy(message: string): string {
    if (cfg.desktopMode) return message;
    if (message.includes("用完")) return "试用对话次数已用完。Agent 和改文件请用付费桌面版";
    if (message.includes("试用或激活") || message.includes("API Key")) return "需要先开始试用";
    return message;
  }

  function featureDenied(ent: EntitlementPublic | null, feature: "chat" | "agent" | "image" | "video"): string | null {
    if (feature === "agent" && !cfg.desktopMode) return "网页版只能对话。Agent 和改文件请用付费桌面版";
    if (!ent) return webCopy("需要先试用或配置 AGNES_API_KEY");
    if (feature === "chat" && !ent.allowChat) {
      return webCopy(ent.status === "exhausted" ? "试用对话次数已用完，可配置 AGNES_API_KEY" : "当前授权不可对话");
    }
    if (feature === "image" && cfg.desktopMode && !ent.allowImage) return "当前授权不可出图";
    if (feature === "video" && cfg.desktopMode && !ent.allowVideo) return "当前授权不可出视频";
    if (feature === "agent" && !ent.allowAgent) return "当前授权不可使用 Agent";
    return null;
  }

  const proxy = { trustProxy: cfg.trustProxy, trustedProxies: cfg.trustedProxies };
  const web = !cfg.desktopMode;
  const q = cfg.webQuota;
  const pass = async (_c: unknown, next: Next) => next();
  const fuse = (kind: string, hourMax: number, fiveHourMax: number) =>
    web ? quotaThenFuse(kind, hourMax, fiveHourMax, proxy) : pass;
  app.use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      referrerPolicy: "no-referrer",
      crossOriginResourcePolicy: cfg.corsOrigin ? "cross-origin" : "same-origin",
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        mediaSrc: ["'self'", "https:"],
        connectSrc: [...new Set(["'self'", cfg.corsOrigin, cfg.publicApiOrigin].filter(Boolean))],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
      },
    }),
  );
  app.use("*", async (c, next) => {
    if (cfg.desktopMode) {
      const token = userTokenFrom(c);
      if (token) cloudUserToken = token;
    }
    await next();
  });
  app.use("*", async (c, next) => {
    if (isKnownHost(c.req.header("host"), cfg)) return next();
    return c.json({ error: "unknown host" }, 404);
  });
  app.use("*", ipAllowlist(cfg.allowedIps, proxy, (pathName) => pathName === "/api/health"));
  if (cfg.corsOrigin) {
    app.use(
      "*",
      cors({
        origin: cfg.corsOrigin,
        credentials: true,
        allowHeaders: ["Content-Type", "Authorization", "x-agnes-device", "x-agnes-token"],
        exposeHeaders: ["Retry-After", "Content-Disposition", "X-Agnes-Preview"],
      }),
    );
  }
  app.use("/api/*", bodyLimit({ maxSize: cfg.maxUploadBytes }));
  // 访客熔断是给浏览器流量定的。中转是桌面端的模型通道，一条 Agent 消息就可能打十几次，
  // 走这套会被整段掐断；它的真实上限是卡里的额度，另配一条宽松的自有限流。
  const skipVisitorFuse = (pathName: string) => pathName === "/api/health" || isRelayPath(pathName);
  if (web) {
    app.use("/api/*", ipFusedGuard(proxy, skipVisitorFuse));
    app.use("/api/*", quotaThenFuse("api", q.hourApi, q.fiveHourApi, proxy, skipVisitorFuse));
  }
  // 桌面端切换会话会连打 GET，180/分钟很容易 429；读会话接口剔出限流桶，整体上限可用 AGNES_API_RATE_PER_MIN 调
  const apiRateMax = Math.max(30, Number(process.env.AGNES_API_RATE_PER_MIN || (web ? 90 : 600)) || (web ? 90 : 600));
  const apiRate = rateLimit(apiRateMax, 60_000, "api", proxy);
  const skipApiRate = (pathName: string, method: string) => {
    if (isRelayPath(pathName) || pathName === "/api/health") return true;
    if (method === "GET" && (pathName === "/api/conversations" || pathName === "/api/settings" || pathName === "/api/workspaces" || pathName === "/api/mcp")) return true;
    if (method === "GET" && /^\/api\/conversations\/[^/]+(\/pending)?$/.test(pathName)) return true;
    return false;
  };
  app.use("/api/*", async (c, next) => {
    const pathName = new URL(c.req.url).pathname;
    return skipApiRate(pathName, c.req.method) ? next() : apiRate(c, next);
  });
  if (web) {
    app.use("/api/*", async (c, next) => {
      const pathName = new URL(c.req.url).pathname;
      if (pathName === "/api/health") return next();
      const started = Date.now();
      await next();
      if (!cfg.logAllRequests && !shouldLogRequest(c.req.method, pathName)) return;
      try {
        insertRequestLog(db, {
          method: c.req.method,
          path: pathName,
          status: c.res.status,
          durationMs: Date.now() - started,
          ip: requestIp(c, proxy),
          deviceHash: deviceOf(c),
          kind: kindFromPath(pathName),
          error: c.res.status >= 400 ? String(c.res.status) : "",
          userAgent: c.req.header("user-agent") ?? "",
        });
      } catch {
        /* logging must not break the request */
      }
    });
  }

  app.use("/api/*", async (c, next) => {
    const pathName = new URL(c.req.url).pathname;
    if (skipAppToken(pathName) || !cfg.authToken) return next();
    const header = c.req.header("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const token = bearer || c.req.header("x-agnes-token") || cookieToken(c.req.header("cookie"));
    if (!tokensMatch(token, cfg.authToken)) return c.json({ error: "Unauthorized" }, 401);
    return next();
  });

  app.use("/api/*", async (c, next) => {
    const pathName = new URL(c.req.url).pathname;
    if (skipAccount(pathName)) return next();
    const allowCookieOnly =
      c.req.method === "GET" &&
      (/^\/api\/media\/[^/]+$/.test(pathName) || /^\/api\/feedbacks\/[^/]+\/files\/[^/]+$/.test(pathName));
    const attached = await webAccount(c, { allowCookieOnly });
    if (attached.setCookie) c.header("Set-Cookie", attached.setCookie);
    if (!attached.account) {
      return c.json({ error: cfg.desktopMode ? "需要选择本机档案" : "需要先开始试用" }, 401);
    }
    c.set("accountId", attached.account.id);
    return next();
  });

  app.use("/api/*", async (c, next) => {
    if (cfg.desktopMode) return next();
    const pathName = new URL(c.req.url).pathname;
    if (pathName === "/api/workspace" || pathName.startsWith("/api/workspace/")) {
      return c.json({ error: "网页版没有工作区" }, 404);
    }
    return next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/updates/latest", (c) => c.json(readUpdateManifest(cfg.updateDir)));
  app.get("/api/updates/package", rateLimit(web ? 8 : 20, 60_000, "update", proxy), async (c) => {
    const file = updatePackagePath(cfg.updateDir);
    if (!file) return c.json({ error: "没有更新包", code: "AGNES_UPDATE_NONE" }, 404);
    const { size } = fs.statSync(file);
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="app.asar"',
        "Content-Length": String(size),
      },
    });
  });
  app.get("/api/updates/desktop", rateLimit(web ? 8 : 20, 60_000, "update", proxy), async (c) => {
    const file = desktopZipPath(cfg.updateDir);
    if (!file) return c.json({ error: "还没有桌面安装包" }, 404);
    const { size } = fs.statSync(file);
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="Agnes-win-x64.zip"',
        "Content-Length": String(size),
      },
    });
  });

  // ---- 桌面端模型中转 ----
  // 客户端不再自带 Token Plan 密钥：它把模型调用打到这里，由本实例用自己的 AGNES_API_KEY
  // 转发到上游。凭证是绑定设备的 HMAC 令牌，额度在这里扣，客户端删本机库也绕不过去。
  const relayOn = web && Boolean(cfg.relaySecret) && Boolean(cfg.apiKey);
  const relayRate = rateLimit(600, 60_000, "relay", proxy);

  type RelayCaller = { deviceHash: string; billingHash: string; ent: EntitlementPublic };

  function relayCaller(c: Context, feature: "chat" | "image" | "video"): RelayCaller | Response {
    if (!relayOn) return c.json({ error: "本实例未开启模型中转" }, 404);
    const deviceHash = deviceOf(c);
    if (!deviceHash) return c.json({ error: "缺少设备码" }, 400);
    const tokenOk = verifyRelayToken(cfg.relaySecret, deviceHash, bearerOf(c.req.header("authorization")), {
      acceptLegacy: cfg.relayAcceptLegacyTokens,
      notBefore: relayNotBefore(db, deviceHash),
    });
    if (!tokenOk) {
      return c.json({ error: "中转凭证无效，请重新激活" }, 401);
    }
    const user = signedInUser(c);
    const row = entitlementForViewer(db, user?.id || "", deviceHash);
    if (!row) return c.json({ error: "需要先试用或配置 AGNES_API_KEY" }, 403);
    const ent = publicEntitlement(row, db);
    if (ent.status === "revoked") return c.json({ error: "授权已停用" }, 403);
    if (ent.expired) return c.json({ error: "授权已到期，请续期" }, 403);
    if (feature === "chat" && !ent.allowChat) {
      return c.json({ error: ent.status === "exhausted" ? "对话次数已用完，可续期API Key" : "当前授权不可对话" }, 403);
    }
    if (feature === "image" && !ent.allowImage) return c.json({ error: "当前授权不可出图" }, 403);
    if (feature === "video" && !ent.allowVideo) return c.json({ error: "当前授权不可出视频" }, 403);
    return { deviceHash, billingHash: row.device_hash || deviceHash, ent };
  }

  function relayChatTicket(c: Context, deviceHash: string): Response | null {
    const ticket = c.req.header("x-agnes-chat-ticket") || "";
    if (!verifyChatTicket(cfg.relaySecret, deviceHash, ticket) || chatTicketRefunded(db, ticket)) {
      return c.json({ error: "对话票据无效或已过期，请重新发送" }, 403);
    }
    return null;
  }

  function chatTicketPayload(deviceHash: string): { chatTicket: string; chatTicketExp: number } | undefined {
    if (!relayOn || !deviceHash) return undefined;
    const issued = issueChatTicket(cfg.relaySecret, deviceHash);
    if (!issued.ticket) return undefined;
    return { chatTicket: issued.ticket, chatTicketExp: issued.exp };
  }

  /** 付费档扣卡内总量，免费档按天扣；Agent 里的出图工具也被这层挡住。返回 true 表示真的扣了一次。 */
  function relayTakeMedia(c: Context, who: RelayCaller, kind: "image" | "video"): Response | boolean {
    if (who.ent.isSuper) return false;
    if (who.ent.plan === "licensed") {
      try {
        consumeMedia(db, who.billingHash, kind);
        return Number(kind === "image" ? who.ent.imageQuota : who.ent.videoQuota) > 0;
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 429);
      }
    }
    const limit = kind === "image" ? q.dailyImage : q.videoLimit;
    if (limit <= 0) return false;
    const days = kind === "image" ? 1 : q.videoDays;
    const took = takeQuota(db, requestIp(c, proxy), who.deviceHash, kind, limit, days);
    if (!took.ok) return c.json({ error: quotaExhaustedMessage(kind, limit) }, 429);
    return true;
  }

  function relayRefundMedia(c: Context, who: RelayCaller, kind: "image" | "video", charged: boolean): boolean {
    if (!charged || who.ent.isSuper) return false;
    if (who.ent.plan === "licensed") refundMedia(db, who.billingHash, kind);
    else refundQuota(db, requestIp(c, proxy), who.deviceHash, kind);
    return true;
  }

  /** 中转把上游错误原样回给桌面端；退过额度时在 JSON 里加标记，桌面端据此显示「次数已退回」 */
  async function markRelayRefunded(res: Response, refunded: boolean): Promise<Response> {
    if (!refunded) return res;
    const text = await res.text().catch(() => "");
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { error: text };
    } catch {
      payload = { error: text || "上游失败" };
    }
    payload.agnes_refunded = true;
    return new Response(JSON.stringify(payload), { status: res.status, headers: { "Content-Type": "application/json" } });
  }

  function upstreamHeaders(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` };
  }

  /** 授权服务器侧：连同授权状态一起下发中转凭证，桌面端据此接管模型调用。 */
  function relayPayload(deviceHash: string) {
    if (!relayOn || !deviceHash) return undefined;
    const origin = (cfg.publicApiOrigin || "").replace(/\/+$/, "");
    return {
      token: relayTokenFor(cfg.relaySecret, deviceHash, Date.now(), relayNotBefore(db, deviceHash)),
      baseUrl: origin ? `${origin}${RELAY_PATH}` : undefined,
      videoPollUrl: origin ? `${origin}${RELAY_PATH}/videos/poll` : undefined,
    };
  }

  async function relayJson(c: Context, url: string, body: string): Promise<Response> {
    const upstream = await fetch(url, { method: "POST", headers: upstreamHeaders(), body });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") || "application/json" },
    });
  }





  app.post("/api/auth", rateLimit(web ? 8 : 20, 60_000, "auth", proxy), fuse("auth", q.hourAuth, q.fiveHourAuth), async (c) => {
    const body = await c.req.json<{ token?: string }>().catch(() => ({ token: "" }));
    const given = body.token?.trim() || "";
    if (!cfg.authToken || tokensMatch(given, cfg.authToken)) {
      const cookie = [
        `agnes_token=${encodeURIComponent(given || cfg.authToken)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        cfg.isProduction ? "Secure" : "",
      ]
        .filter(Boolean)
        .join("; ");
      return c.json({ ok: true }, 200, { "Set-Cookie": cookie });
    }
    return c.json({ error: "口令不正确" }, 401);
  });

  app.get("/api/session", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const appToken = bearer || c.req.header("x-agnes-token") || cookieToken(c.req.header("cookie"));
    const appAuthed = !cfg.authToken || tokensMatch(appToken, cfg.authToken);
    const pub = publicSettings(cfg);
    const deviceHash = deviceOf(c);
    let entitlement: EntitlementPublic | null = null;
    let beta: BetaOffer | null = null;
    let cloudUser: { username: string } | null = null;
    let remoteMedia: MediaQuotaPublic | null = null;
    try {
      if (cfg.licenseServerUrl && deviceHash) {
        const remote = await licenseFetch("/api/entitlements/status", deviceHash, "GET");
        if (remote.status === 200) {
          const data = remote.data as {
            entitlement?: EntitlementPublic | null;
            beta?: BetaOffer | null;
            user?: { username?: string } | null;
            mediaQuota?: MediaQuotaPublic | null;
          };
          entitlement = data.entitlement ?? null;
          beta = data.beta ?? null;
          // 中转模式下免费档的图/视频在授权服务器那边按天扣，本机计数一直是 0
          remoteMedia = cfg.relayManaged ? (data.mediaQuota ?? null) : null;
          cloudUser = data.user?.username ? { username: data.user.username } : null;
        }
      } else {
        if (c.req.header("x-agnes-client") === "desktop" && deviceHash) repairDesktopTrialQuota(db, deviceHash);
        entitlement = viewerEntitlement(c);
        const user = signedInUser(c);
        cloudUser = user ? { username: user.username } : null;
        beta = betaOffer(db, deviceHash, user?.id || "");
      }
    } catch {
      entitlement = null;
    }
    const attached = await webAccount(c);
    const daily = web ? inspectDailyChat(db, requestIp(c, proxy), deviceHash, q.dailyChat) : null;
    // 免费档（网页 + 桌面试用）的图/视频按天算；付费档看 entitlement 里的周期额度
    const freeMedia = !entitlement || (entitlement.plan === "trial" && !entitlement.isSuper);
    const dailyImage = !freeMedia
      ? null
      : remoteMedia?.image
        ? remoteMedia.image
        : inspectQuota(db, requestIp(c, proxy), deviceHash, "image", q.dailyImage, 1);
    const videoQuota = !freeMedia
      ? null
      : remoteMedia?.video
        ? remoteMedia.video
        : inspectQuota(db, requestIp(c, proxy), deviceHash, "video", q.videoLimit, q.videoDays);
    const body = {
      authRequired: Boolean(cfg.authToken),
      appAuthed,
      account: attached.account ? publicAccount(attached.account, cfg.desktopMode) : null,
      profiles: cfg.desktopMode ? listAccounts(db) : [],
      entitlement,
      cloudUser,
      dailyChat: daily
        ? { used: daily.used, remaining: daily.remaining, limit: daily.limit }
        : undefined,
      dailyImage: dailyImage
        ? { used: dailyImage.used, remaining: dailyImage.remaining, limit: dailyImage.limit }
        : undefined,
      videoQuota: videoQuota
        ? {
            used: videoQuota.used,
            remaining: videoQuota.remaining,
            limit: videoQuota.limit,
            windowDays: videoQuota.windowDays,
          }
        : undefined,
      storage: pub.storage,
      desktopMode: pub.desktopMode,
      desktopDownloadUrl: pub.desktopDownloadUrl,
      dataDir: pub.dataDir,
      beta,
    };
    if (attached.setCookie) return c.json(body, 200, { "Set-Cookie": attached.setCookie });
    return c.json(body);
  });



  app.get("/api/feedbacks", async (c) => {
    const deviceHash = deviceOf(c);
    if (!deviceHash) return c.json({ error: "缺少设备码" }, 400);
    if (false /* oss */) {
      const remote = await licenseFetch("/api/feedbacks", deviceHash, "GET");
      return c.json(remote.data as object, remote.status as 200);
    }
    return c.json(listMine(db, deviceHash));
  });

  app.post("/api/feedbacks", rateLimit(web ? 8 : 20, 60_000, "feedback", proxy), async (c) => {
    const deviceHash = deviceOf(c);
    if (!deviceHash) return c.json({ error: "缺少设备码" }, 400);
    const body = (await c.req.json<{ title?: string; body?: string; kind?: string; images?: string[]; contact?: string }>().catch(() => ({}))) as {
      title?: string;
      body?: string;
      kind?: string;
      images?: string[];
      contact?: string;
    };
    if (false /* oss */) {
      const remote = await licenseFetch(
        "/api/feedbacks",
        deviceHash,
        "POST",
        { ...body, client: "desktop" },
        60_000,
      );
      return c.json(remote.data as object, remote.status as 200);
    }
    try {
      const row = await createFeedback(db, cfg.dataDir, {
        deviceHash,
        title: body.title,
        body: body.body,
        kind: body.kind,
        images: body.images,
        contact: body.contact,
        client: cfg.desktopMode ? "desktop" : "web",
      });
      return c.json(row);
    } catch (err) {
      return c.json({ error: publicError(err, cfg.isProduction) }, 400);
    }
  });

  app.get("/api/feedbacks/:id/files/:name", async (c) => {
    const feedbackId = c.req.param("id");
    const name = decodeURIComponent(c.req.param("name") || "");
    const deviceHash =
      deviceOf(c) ||
      String(
        (db.prepare("SELECT device_hash FROM accounts WHERE id = ?").get(c.get("accountId")) as { device_hash?: string } | undefined)
          ?.device_hash || "",
      );
    if (false /* oss */) {
      if (!deviceHash) return c.json({ error: "缺少设备码" }, 400);
      try {
        const res = await fetch(`${cfg.licenseServerUrl}/api/feedbacks/${encodeURIComponent(feedbackId)}/files/${encodeURIComponent(name)}`, {
          headers: { "x-agnes-device": deviceHash },
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return c.json({ error: "文件不存在" }, 404);
        return new Response(res.body, {
          headers: {
            "Content-Type": res.headers.get("content-type") || "image/jpeg",
            "Cache-Control": "private, max-age=3600",
          },
        });
      } catch {
        return c.json({ error: "文件不存在" }, 404);
      }
    }
    try {
      const file = await readFeedbackFile(db, cfg.dataDir, feedbackId, name, deviceHash);
      return new Response(file.buf, {
        headers: { "Content-Type": file.mime, "Cache-Control": "private, max-age=3600" },
      });
    } catch {
      return c.json({ error: "文件不存在" }, 404);
    }
  });


  app.get("/api/entitlements/status", async (c) => {
    const deviceHash = deviceOf(c);
    if (!deviceHash) return c.json({ error: "缺少设备码" }, 400);
    if (false) { /* oss */ }
    if (cfg.apiKey) ensureLocalKeyOperator(db, deviceHash);
    const user = signedInUser(c);
    const row = entitlementForViewer(db, user?.id || "", deviceHash);
    const pub = row ? publicEntitlement(row, db) : null;
    // 免费档的图/视频按天算（和中转端点 relayTakeMedia 同一套计数），桌面端据此显示余量、多张出图前预检
    const freeMedia = !pub || (pub.plan !== "licensed" && !pub.isSuper);
    const ip = requestIp(c, proxy);
    const imageNow = freeMedia ? inspectQuota(db, ip, deviceHash, "image", q.dailyImage, 1) : null;
    const videoNow = freeMedia ? inspectQuota(db, ip, deviceHash, "video", q.videoLimit, q.videoDays) : null;
    const mediaQuota: MediaQuotaPublic | undefined =
      imageNow && videoNow
        ? {
            image: { used: imageNow.used, remaining: imageNow.remaining, limit: imageNow.limit },
            video: { used: videoNow.used, remaining: videoNow.remaining, limit: videoNow.limit, windowDays: videoNow.windowDays },
          }
        : undefined;
    return c.json({
      entitlement: pub && !cfg.desktopMode && c.req.header("x-agnes-client") !== "desktop" ? { ...pub, allowAgent: false } : pub,
      mediaQuota,
      user: user ? { username: user.username } : null,
      relay: row ? relayPayload(deviceHash) : undefined,
      beta: betaOffer(db, deviceHash, user?.id || ""),
    });
  });


  app.post("/api/entitlements/consume", fuse("chat", q.hourChat, q.fiveHourChat), async (c) => {
    const deviceHash = deviceOf(c);
    if (!deviceHash) return c.json({ error: "缺少设备码" }, 400);
    if (false /* oss */) {
      const remote = await licenseFetch("/api/entitlements/consume", deviceHash, "POST", {});
      return c.json(remote.data as Record<string, unknown>, remote.status as 400);
    }
    const bill = billingHash(c) || deviceHash;
    const ip = requestIp(c, proxy);
    let tookDaily = false;
    try {
      if (web && q.dailyChat > 0 && !bill.startsWith("acct:")) {
        const daily = takeDailyChat(db, ip, deviceHash, q.dailyChat);
        if (!daily.ok) return c.json({ error: DAILY_CHAT_EXHAUSTED }, 429);
        tookDaily = true;
      }
      const row = consumeChat(db, bill);
      const ticket = chatTicketPayload(deviceHash);
      // 老客户端不认 refundTicket，多一个字段不影响它们
      const refundTicket = createQuotaTicket(db, {
        kind: "chat",
        billHash: bill,
        deviceHash,
        chatTicket: ticket?.chatTicket,
        ip,
        daily: tookDaily,
      });
      return c.json({ ok: true, entitlement: publicEntitlement(row, db), ...ticket, refundTicket });
    } catch (err) {
      if (tookDaily) refundQuota(db, ip, deviceHash, "chat");
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 403);
    }
  });

  /** 桌面端：这轮消息一个上游事件都没拿到就失败了，凭 consume 给的单据退一次 */
  app.post("/api/entitlements/refund-chat", async (c) => {
    const deviceHash = deviceOf(c);
    if (!deviceHash) return c.json({ error: "缺少设备码" }, 400);
    const body = await c.req.json<{ ticket?: string }>().catch(() => ({}) as { ticket?: string });
    const refunded = refundQuotaTicket(db, String(body.ticket || ""), deviceHash, "chat");
    if (!refunded.ok) return c.json({ error: refunded.error }, 409);
    if (Number(refunded.row.daily)) refundQuota(db, refunded.row.ip, deviceHash, "chat");
    const row = getEntitlement(db, refunded.row.bill_hash);
    return c.json({ ok: true, entitlement: row ? publicEntitlement(row, db) : null });
  });

  // 授权权威侧：桌面端设了 LICENSE_SERVER_URL 时由客户端转发过来扣/退媒体额度
  app.post("/api/entitlements/consume-media", async (c) => {
    const deviceHash = deviceOf(c);
    if (!deviceHash) return c.json({ error: "缺少设备码" }, 400);
    const body = await c.req.json<{ kind?: string }>().catch(() => ({}) as { kind?: string });
    const kind = body.kind === "video" ? "video" : "image";
    try {
      const bill = billingHash(c) || deviceHash;
      const row = consumeMedia(db, bill, kind);
      const refundTicket = createQuotaTicket(db, { kind, billHash: bill, deviceHash });
      return c.json({ ok: true, entitlement: publicEntitlement(row, db), refundTicket });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 429);
    }
  });

  // 以前只凭设备码就能退，任何人都能把自己的出图 / 视频用量一直退回 0。现在必须带 consume-media 给的单据，每张只退一次
  app.post("/api/entitlements/refund-media", async (c) => {
    const deviceHash = deviceOf(c);
    if (!deviceHash) return c.json({ error: "缺少设备码" }, 400);
    const body = await c.req.json<{ kind?: string; ticket?: string }>().catch(() => ({}) as { kind?: string; ticket?: string });
    const kind = body.kind === "video" ? "video" : "image";
    const refunded = refundQuotaTicket(db, String(body.ticket || ""), deviceHash, kind);
    if (!refunded.ok) return c.json({ error: refunded.error }, 409);
    return c.json({ ok: true });
  });




  app.post("/api/users/register", async (c) => {
    const deviceHash = deviceOf(c);
    const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({ username: "", password: "" }));
    if (false /* oss */) {
      const remote = await fetch(`${cfg.licenseServerUrl}/api/users/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agnes-device": deviceHash },
        body: JSON.stringify({ username: body.username, password: body.password }),
        signal: AbortSignal.timeout(12_000),
      });
      const data = (await remote.json().catch(() => ({ error: "授权服务无响应" }))) as { token?: string; error?: string };
      if (remote.status === 200 && data.token) {
        rememberCloudUser(String(data.token || ""));
      }
      const tok = data.token ? String(data.token) : "";
      const headers = tok ? { "Set-Cookie": userCookie(tok, cfg.isProduction && !cfg.desktopMode) } : undefined;
      return c.json(data, remote.status as 200, headers);
    }
    try {
      const created = registerUser(db, body.username ?? "", body.password ?? "");
      ensureCustomerForUser(db, created.user.id, created.user.username);
      if (deviceHash) attachDeviceLicense(db, created.user.id, deviceHash);
      rememberCloudUser(created.token);
      return c.json(
        { ok: true, token: created.token, user: { username: created.user.username } },
        200,
        { "Set-Cookie": userCookie(created.token, cfg.isProduction && !cfg.desktopMode) },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("已经有人用了") ? 409 : 400);
    }
  });

  app.post("/api/users/login", async (c) => {
    const deviceHash = deviceOf(c);
    const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({ username: "", password: "" }));
    if (false /* oss */) {
      const remote = await fetch(`${cfg.licenseServerUrl}/api/users/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agnes-device": deviceHash },
        body: JSON.stringify({ username: body.username, password: body.password }),
        signal: AbortSignal.timeout(12_000),
      });
      const data = (await remote.json().catch(() => ({ error: "授权服务无响应" }))) as { token?: string; error?: string };
      if (remote.status === 200 && data.token) {
        rememberCloudUser(String(data.token || ""));
      }
      const tok = data.token ? String(data.token) : "";
      const headers = tok ? { "Set-Cookie": userCookie(tok, cfg.isProduction && !cfg.desktopMode) } : undefined;
      return c.json(data, remote.status as 200, headers);
    }
    try {
      const found = loginUser(db, body.username ?? "", body.password ?? "");
      ensureCustomerForUser(db, found.user.id, found.user.username);
      if (deviceHash) attachDeviceLicense(db, found.user.id, deviceHash);
      rememberCloudUser(found.token);
      return c.json(
        { ok: true, token: found.token, user: { username: found.user.username } },
        200,
        { "Set-Cookie": userCookie(found.token, cfg.isProduction && !cfg.desktopMode) },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 401);
    }
  });

  app.post("/api/users/logout", (c) => {
    const token = userTokenFrom(c) || cloudUserToken;
    if (!cfg.licenseServerUrl) logoutUser(db, token);
    if (cloudUserToken === token) rememberCloudUser("");
    return c.json({ ok: true }, 200, { "Set-Cookie": userCookie("", cfg.isProduction && !cfg.desktopMode, true) });
  });

  app.get("/api/accounts", (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页不使用本机档案" }, 404);
    return c.json(listAccounts(db));
  });

  app.post("/api/accounts", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页不使用本机档案" }, 404);
    const deviceHash = deviceOf(c);
    const ent = await entitlementNow(deviceHash);
    if (!ent) return c.json({ error: "需要先试用或配置 AGNES_API_KEY" }, 403);
    const body = await c.req.json<{ name?: string }>().catch(() => ({ name: "" }));
    const parsed = parseProfileName(body.name ?? "");
    if (typeof parsed !== "string") return c.json({ error: parsed.error }, 400);
    try {
      const account = createProfile(db, parsed);
      return c.json(
        { ok: true, account: publicAccount(account, true) },
        200,
        { "Set-Cookie": sidFor(account.id) },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("已被使用") ? 409 : 500);
    }
  });

  app.post("/api/accounts/select", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页不使用本机档案" }, 404);
    const deviceHash = deviceOf(c);
    const ent = await entitlementNow(deviceHash);
    if (!ent) return c.json({ error: "需要先试用或配置 AGNES_API_KEY" }, 403);
    const body = await c.req.json<{ id?: string }>().catch(() => ({ id: "" }));
    const row = db.prepare("SELECT id, name FROM accounts WHERE id = ?").get(body.id ?? "") as
      | { id: string; name: string }
      | undefined;
    if (!row) return c.json({ error: "档案不存在" }, 404);
    return c.json({ ok: true, account: row }, 200, { "Set-Cookie": sidFor(row.id) });
  });

  app.post("/api/accounts/logout", (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页不使用本机档案" }, 404);
    deleteSession(db, cookieValue(c.req.header("cookie"), "agnes_sid"));
    return c.json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", cfg.isProduction, 0) });
  });

  app.get("/api/accounts/me", (c) => {
    const row = db.prepare("SELECT id, name, created_at FROM accounts WHERE id = ?").get(c.get("accountId")) as
      | { id: string; name: string; created_at: number }
      | undefined;
    if (!row) return c.json({ error: cfg.desktopMode ? "需要选择本机档案" : "需要先开始试用" }, 401);
    const pub = publicSettings(cfg);
    return c.json({
      account: { id: row.id, name: cfg.desktopMode ? row.name : "当前设备" },
      storage: pub.storage,
      dataDir: pub.dataDir,
    });
  });

  app.get("/api/settings", (c) => c.json(settingsPayload()));

  app.get("/api/mcp", (c) => c.json(getMcpStatus()));

  app.post("/api/mcp/reload", async (c) => {
    try {
      const hub = await ensureSharedMcpHub(loadMergedMcpConfig(cfg.dataDir, cfg.workspaceRoot));
      return c.json({ ok: true, ...{ servers: hub.status() } });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/personas", (c) => {
    const rows = db
      .prepare("SELECT * FROM personas WHERE account_id = ? ORDER BY updated_at DESC")
      .all(c.get("accountId")) as PersonaRow[];
    return c.json(rows);
  });

  app.post("/api/personas", async (c) => {
    const parsed = parsePersona((await c.req.json().catch(() => ({}))) as { name?: string; body?: string; greeting?: string });
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const accountId = c.get("accountId");
    const personaId = id("p");
    const ts = now();
    db.prepare(
      "INSERT INTO personas (id, name, body, greeting, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(personaId, parsed.name, parsed.body, parsed.greeting, accountId, ts, ts);
    return c.json(ownPersona(db, personaId, accountId));
  });

  app.put("/api/personas/:id", async (c) => {
    const accountId = c.get("accountId");
    const existing = ownPersona(db, c.req.param("id"), accountId);
    if (!existing) return c.json({ error: "not found" }, 404);
    const parsed = parsePersona((await c.req.json().catch(() => ({}))) as { name?: string; body?: string; greeting?: string });
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    db.prepare("UPDATE personas SET name=?, body=?, greeting=?, updated_at=? WHERE id=? AND account_id=?").run(
      parsed.name,
      parsed.body,
      parsed.greeting,
      now(),
      existing.id,
      accountId,
    );
    return c.json(ownPersona(db, existing.id, accountId));
  });

  app.delete("/api/personas/:id", (c) => {
    const accountId = c.get("accountId");
    const personaId = c.req.param("id");
    const existing = ownPersona(db, personaId, accountId);
    if (!existing) return c.json({ error: "not found" }, 404);
    db.prepare("UPDATE conversations SET persona_id=NULL WHERE persona_id=? AND account_id=?").run(personaId, accountId);
    db.prepare("DELETE FROM personas WHERE id=? AND account_id=?").run(personaId, accountId);
    return c.json({ ok: true });
  });

  app.put("/api/settings", async (c) => {
    const body = await c.req.json<{
      apiKey?: string;
      workspaceRoot?: string;
      autoApply?: boolean;
      chatModel?: string;
      imageModel?: string;
      videoModel?: string;
      approvalMode?: string;
      commandAllow?: string;
      rememberCommand?: string;
      toolTimeouts?: unknown;
      builtinModelCaps?: unknown;
    }>();
    // 第一步只校验：会被拒的字段全部先查完，任何一项不合法就直接返回，这次请求什么都不写（内存里的 cfg 和库都不动）
    const builtinIds = publicSettings(cfg).models.chat.filter((m) => !parseCustomModel(m));
    let nextBuiltinCaps: ReturnType<typeof parseModelCapsMap> | undefined;
    if (cfg.desktopMode && body.builtinModelCaps !== undefined) {
      try {
        nextBuiltinCaps = parseModelCapsMap(body.builtinModelCaps, builtinIds);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    const rememberRule = cfg.desktopMode && typeof body.rememberCommand === "string" ? ruleForCommand(body.rememberCommand) : undefined;
    if (rememberRule === null) return c.json({ error: "这类命令不能加入允许规则" }, 400);
    let nextToolTimeouts: Record<string, number> | undefined;
    if (cfg.desktopMode && body.toolTimeouts !== undefined) {
      // 按项合并：只带一项时其他项不动；值为 null / "" 表示删掉这一项、恢复默认；整个传 null = 全部恢复默认。
      // 任何一项不合法就整体 400，这次什么都不写
      try {
        nextToolTimeouts = mergeToolTimeouts(cfg.toolTimeouts, parseToolTimeoutsPatch(body.toolTimeouts));
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    let nextModel: string | undefined;
    // 网页部署里这是全站共用的配置，访客不能改；模型由 .env 决定，每个对话可以在输入框下方单独换
    if (cfg.desktopMode && typeof body.chatModel === "string" && body.chatModel.trim()) {
      nextModel = body.chatModel.trim().slice(0, 200);
      if (parseCustomModel(nextModel) && !resolveCustomChat(db, nextModel)) {
        return c.json({ error: "这个自定义模型不存在" }, 400);
      }
    }
    let nextRoot: string | undefined;
    if (cfg.desktopMode && typeof body.workspaceRoot === "string" && body.workspaceRoot.trim()) {
      // 不安全（磁盘根目录、系统目录）返回 400，和工作区接口同一句文案
      try {
        nextRoot = normalizeRoot(body.workspaceRoot);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }

    // 第二步全部通过再写。建工作区目录可能失败，放在最前面：失败时直接 400，其他设置都还没动
    if (nextRoot) {
      try {
        makeWorkspaceDir(nextRoot);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    if (nextBuiltinCaps) saveBuiltinCaps(db, nextBuiltinCaps, builtinIds);
    if (cfg.desktopMode && typeof body.approvalMode === "string") {
      cfg.approvalMode = parseApprovalMode(body.approvalMode, cfg.approvalMode);
      cfg.autoApply = cfg.approvalMode !== "suggest";
      setKv(db, DESKTOP_APPROVAL_KV, cfg.approvalMode);
    } else if (cfg.desktopMode && typeof body.autoApply === "boolean") {
      // 旧客户端还在发 autoApply：映射到三档里最接近的
      cfg.autoApply = body.autoApply;
      cfg.approvalMode = body.autoApply ? "full-auto" : "suggest";
      setKv(db, DESKTOP_APPROVAL_KV, cfg.approvalMode);
    }
    if (cfg.desktopMode && typeof body.commandAllow === "string") {
      cfg.commandAllow = normalizeAllowText(body.commandAllow);
      setKv(db, DESKTOP_COMMAND_ALLOW_KV, cfg.commandAllow);
    }
    if (rememberRule) {
      cfg.commandAllow = appendAllowRule(cfg.commandAllow, rememberRule);
      setKv(db, DESKTOP_COMMAND_ALLOW_KV, cfg.commandAllow);
    }
    if (nextToolTimeouts) {
      cfg.toolTimeouts = nextToolTimeouts;
      setKv(db, DESKTOP_TOOL_TIMEOUTS_KV, JSON.stringify(nextToolTimeouts));
    }
    if (nextModel) {
      cfg.chatModel = nextModel;
      setKv(db, DESKTOP_CHAT_MODEL_KV, nextModel);
    }
    if (cfg.desktopMode && typeof body.imageModel === "string" && body.imageModel.trim()) cfg.imageModel = body.imageModel.trim().slice(0, 200);
    if (cfg.desktopMode && typeof body.videoModel === "string" && body.videoModel.trim()) cfg.videoModel = body.videoModel.trim().slice(0, 200);
    if (cfg.desktopMode) {
      // 中转模式下 apiKey 是服务器签发的凭证，不能被前端贴进来的值顶掉
      if (!cfg.relayManaged && typeof body.apiKey === "string" && body.apiKey.trim()) {
        cfg.apiKey = body.apiKey.trim();
        agnes.setApiKey(cfg.apiKey);
      }
      if (nextRoot) {
        cfg.workspaceRoot = nextRoot;
        setKv(db, DESKTOP_WORKSPACE_KV, nextRoot);
      }
    }
    return c.json(settingsPayload());
  });

  app.post("/api/providers/probe", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "自定义模型只在桌面客户端使用" }, 404);
    const body = await c.req
      .json<{ baseUrl?: string; apiKey?: string; protocol?: string; providerId?: string }>()
      .catch(() => ({ baseUrl: "", apiKey: "", protocol: "", providerId: "" }));
    try {
      const stored = body.providerId ? findProvider(db, body.providerId) : undefined;
      const baseUrl = String(body.baseUrl || stored?.baseUrl || "");
      // 已存的密钥只发给原来的域名：改了地址又没重填密钥，就别把旧密钥带到新地址去
      if (stored && !body.apiKey && body.baseUrl && !sameProviderOrigin(stored.baseUrl, String(body.baseUrl))) {
        return c.json({ error: KEY_FOR_NEW_ORIGIN }, 400);
      }
      const probed = await probeModels(
        baseUrl,
        String(body.apiKey || stored?.apiKey || ""),
        parseProtocol(body.protocol || stored?.protocol || "openai-completions"),
      );
      return c.json(probed);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/providers", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "自定义模型只在桌面客户端使用" }, 404);
    try {
      const body = await c.req.json<{ id?: string; name?: string; baseUrl?: string; protocol?: string; apiKey?: string; models?: unknown }>();
      upsertProvider(db, body);
      return c.json(settingsPayload());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.put("/api/providers/:id", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "自定义模型只在桌面客户端使用" }, 404);
    try {
      const body = await c.req.json<{ name?: string; baseUrl?: string; protocol?: string; apiKey?: string; models?: unknown }>();
      upsertProvider(db, body, c.req.param("id"));
      return c.json(settingsPayload());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/providers/:id", (c) => {
    if (!cfg.desktopMode) return c.json({ error: "自定义模型只在桌面客户端使用" }, 404);
    try {
      const providerId = c.req.param("id");
      deleteProvider(db, providerId);
      if (parseCustomModel(cfg.chatModel)?.providerId === providerId) {
        cfg.chatModel = DEFAULT_CHAT_MODEL;
        setKv(db, DESKTOP_CHAT_MODEL_KV, DEFAULT_CHAT_MODEL);
      }
      // 用这个 provider 的对话改回默认模型，否则这些对话以后每条都报「模型不存在」
      const prefix = `custom|${providerId}|`;
      db.prepare("UPDATE conversations SET model = ? WHERE substr(model, 1, ?) = ?").run(cfg.chatModel, prefix.length, prefix);
      return c.json(settingsPayload());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/conversations", (c) => {
    const rows = db
      .prepare("SELECT * FROM conversations WHERE account_id = ? ORDER BY updated_at DESC")
      .all(c.get("accountId")) as ConversationRow[];
    return c.json(rows);
  });

  // ---- 对话分组：「对话」页签里的自定义文件夹，网页和桌面都有，按账号隔离 ----
  app.get("/api/conversation-groups", (c) => c.json(listGroups(db, c.get("accountId"))));

  app.post("/api/conversation-groups", async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    try {
      return c.json(createGroup(db, c.get("accountId"), body.name));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/conversation-groups/reorder", async (c) => {
    const body = await c.req.json<{ ids?: string[] }>().catch(() => ({}) as { ids?: string[] });
    return c.json(reorderGroups(db, c.get("accountId"), body.ids));
  });

  app.patch("/api/conversation-groups/:id", async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    try {
      return c.json(renameGroup(db, c.get("accountId"), c.req.param("id"), body.name));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("不存在") ? 404 : 400);
    }
  });

  app.delete("/api/conversation-groups/:id", (c) => {
    try {
      const released = deleteGroup(db, c.get("accountId"), c.req.param("id"));
      return c.json({ ok: true, released });
    } catch {
      return c.json({ error: "分组不存在" }, 404);
    }
  });

  app.put("/api/conversations/:id/group", async (c) => {
    const accountId = c.get("accountId");
    const conv = ownConv(db, c.req.param("id"), accountId);
    if (!conv) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ groupId?: string | null }>().catch(() => ({}) as { groupId?: string | null });
    const groupId = typeof body.groupId === "string" && body.groupId.trim() ? body.groupId.trim() : null;
    try {
      moveConversationToGroup(db, accountId, conv.id, groupId);
    } catch {
      return c.json({ error: "分组不存在" }, 404);
    }
    return c.json(ownConv(db, conv.id, accountId));
  });

  // ---- 工作区：一个项目目录 + 下面的多个 Agent（Codex 的 project / threads）----
  app.get("/api/workspaces", (c) => {
    if (!cfg.desktopMode) return c.json([]);
    return c.json(listWorkspaces(db, c.get("accountId")));
  });

  app.post("/api/workspaces", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页版没有工作区" }, 404);
    const body = (await c.req.json<{ root?: string; name?: string }>().catch(() => ({}))) as { root?: string; name?: string };
    if (!body.root?.trim()) return c.json({ error: "缺少目录" }, 400);
    try {
      const ws = ensureWorkspace(db, c.get("accountId"), body.root, body.name ?? "");
      if (body.name?.trim() && ws.name !== body.name.trim()) updateWorkspace(db, ws.id, c.get("accountId"), { name: body.name });
      return c.json(listWorkspaces(db, c.get("accountId")).find((w) => w.id === ws.id));
    } catch (err) {
      // 目录问题的文案是给人看的，生产环境也原样返回，不能被 publicError 换成「请求失败」
      return c.json({ error: err instanceof WorkspaceRootError ? err.message : publicError(err, cfg.isProduction) }, 400);
    }
  });

  app.patch("/api/workspaces/:id", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页版没有工作区" }, 404);
    const body = (await c.req.json<{ name?: string; root?: string; pinned?: boolean }>().catch(() => ({}))) as {
      name?: string;
      root?: string;
      pinned?: boolean;
    };
    try {
      const ws = updateWorkspace(db, c.req.param("id"), c.get("accountId"), body);
      return c.json(listWorkspaces(db, c.get("accountId")).find((w) => w.id === ws.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 目录问题一律 400（路径里碰巧带「不存在」也不能变成 404）
      return c.json({ error: msg }, !(err instanceof WorkspaceRootError) && msg.includes("不存在") ? 404 : 400);
    }
  });

  app.post("/api/workspaces/reorder", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页版没有工作区" }, 404);
    const body = (await c.req.json<{ ids?: string[] }>().catch(() => ({}))) as { ids?: string[] };
    try {
      return c.json(reorderWorkspaces(db, c.get("accountId"), Array.isArray(body.ids) ? body.ids : []));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("不存在") ? 404 : 400);
    }
  });

  app.delete("/api/workspaces/:id", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页版没有工作区" }, 404);
    const cascade = c.req.query("cascade") === "1";
    try {
      if (cascade) {
        const ids = (db.prepare("SELECT id FROM conversations WHERE workspace_id = ? AND account_id = ?").all(c.req.param("id"), c.get("accountId")) as { id: string }[]).map((r) => r.id).filter((id) => abortors.has(id));
        for (const id of ids) stopConv(id);
        if (ids.length) await waitStopped(ids);
        const allIds = (db.prepare("SELECT id FROM conversations WHERE workspace_id = ? AND account_id = ?").all(c.req.param("id"), c.get("accountId")) as { id: string }[]).map((r) => r.id);
        for (const id of allIds) disposeBgTerminalsForConv(id);
      }
      return c.json({ ok: true, ...deleteWorkspace(db, c.req.param("id"), c.get("accountId"), cascade) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("不存在") ? 404 : 409);
    }
  });

  app.get("/api/workspaces/:id/guide", (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页版没有工作区" }, 404);
    const ws = getWorkspace(db, c.req.param("id"), c.get("accountId"));
    if (!ws) return c.json({ error: "not found" }, 404);
    const rules = readProjectRules(ws.root);
    const skills = listSkills(ws.root).map((skill) => ({
      name: skill.name,
      title: skill.title,
      description: skill.description,
      source: skill.source,
    }));
    return c.json({ rules, skills });
  });

  app.get("/api/workspaces/:id/skill", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页版没有工作区" }, 404);
    const ws = getWorkspace(db, c.req.param("id"), c.get("accountId"));
    if (!ws) return c.json({ error: "not found" }, 404);
    const name = String(c.req.query("name") || "");
    const skills = listSkills(ws.root);
    const body = await readSkill(skills, name);
    if (body.startsWith("没有这个技能") || body.startsWith("当前工作区没有配置")) {
      return c.json({ error: body }, 404);
    }
    return c.json({ name, body });
  });

  app.post("/api/conversations", async (c) => {
    const body = (await c.req.json<{
      title?: string;
      mode?: "chat" | "agent";
      model?: string;
      persona_id?: string | null;
      workspaceId?: string;
      workspaceRoot?: string;
    }>().catch(() => ({}))) as {
      title?: string;
      mode?: "chat" | "agent";
      model?: string;
      persona_id?: string | null;
      workspaceId?: string;
      workspaceRoot?: string;
    };
    const accountId = c.get("accountId");
    const convId = id("c");
    const ts = now();
    const mode = body.mode === "agent" ? "agent" : "chat";
    const model = (typeof body.model === "string" && body.model.trim()) || cfg.chatModel;
    const badModel = chatModelProblem(model);
    if (badModel) return c.json({ error: badModel }, 400);
    let personaId = body.persona_id?.trim() || null;
    if (mode === "agent") {
      const denied = featureDenied(await entitlementNow(deviceOf(c)), "agent");
      if (denied) return c.json({ error: denied }, 403);
    }
    if (personaId && !ownPersona(db, personaId, accountId)) {
      return c.json({ error: "人设不存在" }, 400);
    }
    // Agent 必挂工作区；chat 不挂（chat 就是聊天，不碰文件）
    let workspaceId: string | null = null;
    if (mode === "agent") {
      const ws = resolveWorkspaceForConv(accountId, body);
      if ("error" in ws) return c.json({ error: ws.error }, 400);
      workspaceId = ws.id;
      touchWorkspace(db, workspaceId);
    }
    const defaultTitle = mode === "agent" ? "新任务" : "新对话";
    if (!personaId && mode === "chat") {
      const preset = db
        .prepare("SELECT id FROM personas WHERE account_id = ? AND name = ? ORDER BY updated_at DESC LIMIT 1")
        .get(accountId, "通用助手") as { id: string } | undefined;
      personaId = preset?.id ?? null;
    }
    db.prepare(
      "INSERT INTO conversations (id, title, mode, model, persona_id, account_id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(convId, body.title?.trim() || defaultTitle, mode, model, personaId, accountId, workspaceId, ts, ts);
    if (personaId) {
      const persona = ownPersona(db, personaId, accountId);
      const greeting = persona?.greeting.trim();
      if (greeting) {
        db.prepare(
          "INSERT INTO messages (id, conversation_id, role, content, tool_call_id, tool_calls, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id("m"), convId, "assistant", greeting, null, null, null, ts);
      }
    }
    return c.json(ownConv(db, convId, accountId));
  });

  app.get("/api/conversations/:id", (c) => {
    const conv = ownConv(db, c.req.param("id"), c.get("accountId"));
    if (!conv) return c.json({ error: "not found" }, 404);
    const messages = db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(conv.id) as MessageRow[];
    const diffs = db
      .prepare("SELECT * FROM diffs WHERE conversation_id = ? ORDER BY created_at DESC")
      .all(conv.id) as DiffRow[];
    return c.json({ ...conv, messages, diffs });
  });

  app.patch("/api/conversations/:id", async (c) => {
    const accountId = c.get("accountId");
    const conv = ownConv(db, c.req.param("id"), accountId);
    if (!conv) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{
      title?: string;
      mode?: "chat" | "agent";
      model?: string;
      persona_id?: string | null;
      workspaceId?: string;
      workspaceRoot?: string;
      planMode?: boolean;
      /** 对话目标；空串或 null 清除 */
      goal?: string | null;
    }>();
    // 目标超长直接拒绝（和 /goal 一致），不静默截断；按合并空白后的长度算
    if (body.goal !== undefined && body.goal !== null) {
      if (typeof body.goal !== "string") return c.json({ error: "目标要是文字" }, 400);
      if (body.goal.replace(/\s+/g, " ").trim().length > 500) return c.json({ error: "目标太长了，最多 500 字。" }, 400);
    }
    const personaId =
      body.persona_id === undefined ? conv.persona_id : body.persona_id?.trim() ? body.persona_id.trim() : null;
    if (personaId && !ownPersona(db, personaId, accountId)) {
      return c.json({ error: "人设不存在" }, 400);
    }
    const nextMode = body.mode ?? conv.mode;
    if (nextMode === "agent") {
      const denied = featureDenied(await entitlementNow(deviceOf(c)), "agent");
      if (denied) return c.json({ error: denied }, 403);
    }
    // 移动到别的工作区，或从 chat 切成 agent 时补上工作区
    let nextWorkspaceId = conv.workspace_id;
    const wantsMove = body.workspaceId !== undefined || body.workspaceRoot !== undefined;
    if (nextMode === "agent" && (wantsMove || !nextWorkspaceId)) {
      const ws = resolveWorkspaceForConv(accountId, body);
      if ("error" in ws) return c.json({ error: ws.error }, 400);
      nextWorkspaceId = ws.id;
      touchWorkspace(db, ws.id);
    }
    if (nextMode === "chat") nextWorkspaceId = null;
    let planMode = Number(conv.plan_mode) ? 1 : 0;
    if (nextMode !== "agent") planMode = 0;
    else if (typeof body.planMode === "boolean") planMode = body.planMode ? 1 : 0;
    let nextModel = conv.model;
    if (typeof body.model === "string" && body.model.trim() && body.model.trim() !== conv.model) {
      nextModel = body.model.trim();
      const badModel = chatModelProblem(nextModel);
      if (badModel) return c.json({ error: badModel }, 400);
    }
    db.prepare(
      "UPDATE conversations SET title=?, mode=?, model=?, persona_id=?, workspace_id=?, workspace_root=NULL, plan_mode=?, updated_at=? WHERE id=? AND account_id=?",
    ).run(body.title ?? conv.title, nextMode, nextModel, personaId, nextWorkspaceId, planMode, now(), conv.id, accountId);
    if (body.goal !== undefined) {
      db.prepare("UPDATE conversations SET goal=? WHERE id=? AND account_id=?").run(normalizeGoal(body.goal ?? ""), conv.id, accountId);
    }
    if (personaId && personaId !== conv.persona_id) {
      const count = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?").get(conv.id) as { c: number };
      const persona = ownPersona(db, personaId, accountId) as PersonaRow;
      if (Number(count.c) === 0 && persona.greeting.trim()) {
        db.prepare(
          "INSERT INTO messages (id, conversation_id, role, content, tool_call_id, tool_calls, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id("m"), conv.id, "assistant", persona.greeting.trim(), null, null, null, now());
      }
    }
    return c.json(ownConv(db, conv.id, accountId));
  });

  app.delete("/api/conversations/:id", async (c) => {
    const accountId = c.get("accountId");
    const conv = ownConv(db, c.req.param("id"), accountId);
    if (!conv) return c.json({ error: "not found" }, 404);
    // 删正在跑的对话：先停掉并放掉挂着的审批，等这一轮收尾再删，避免往已删对话里写消息
    if (abortors.has(conv.id)) {
      stopConv(conv.id);
      await waitStopped([conv.id]);
    }
    disposeBgTerminalsForConv(conv.id);
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conv.id);
    db.prepare("DELETE FROM diffs WHERE conversation_id = ?").run(conv.id);
    deleteTurnUsage(db, conv.id);
    db.prepare("DELETE FROM conversations WHERE id = ? AND account_id = ?").run(conv.id, accountId);
    return c.json({ ok: true });
  });

  app.post("/api/conversations/:id/stop", (c) => {
    const conv = ownConv(db, c.req.param("id"), c.get("accountId"));
    if (!conv) return c.json({ error: "not found" }, 404);
    stopConv(conv.id);
    return c.json({ ok: true });
  });

  /**
   * 强制压缩「发给模型」的上下文：写入 conv.summary.* 缓存，不删界面消息。
   * 对话正在跑时拒绝。斜杠 /compact confirm 走这里。
   */
  app.post("/api/conversations/:id/compact", async (c) => {
    const accountId = c.get("accountId");
    const conv = ownConv(db, c.req.param("id"), accountId);
    if (!conv) return c.json({ error: "not found" }, 404);
    if (abortors.has(conv.id)) return c.json({ error: "正在生成，先停止后再压缩" }, 409);

    const rows = db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(conv.id) as MessageRow[];
    const history = rows.map((row) => rowToMessage(row));
    const before = history.reduce((n, m) => n + messageChars(m), 0);
    const summaryKey = `conv.summary.${conv.id}`;
    // 和对话里一样按这个模型的压缩阈值算；旧摘录还对得上就滚动合并
    const budgetPlan = compactBudget(capsForModel(db, conv.model || cfg.chatModel));
    const plan = planModelSummary(history, budgetPlan.budget, { ...budgetPlan.options, previous: parseSummaryCache(getKv(db, summaryKey)) });

    if (!plan) {
      const preview = compactForModel(history, budgetPlan.budget, undefined, budgetPlan.options);
      return c.json({
        before,
        after: preview.stats.after,
        note: preview.stats.changed
          ? `上下文略长，已做机械压缩预览（${before} → ${preview.stats.after} 字）。界面消息未删。`
          : "上下文未超预算，无需压缩。",
      });
    }

    const customChat = resolveCustomChat(db, conv.model || cfg.chatModel);
    const client = customChat?.client ?? agnes;
    const model = customChat?.model || conv.model || cfg.chatModel;
    let digest = "";
    const deadline = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
    try {
      for await (const event of client.chatCompletionsStream(
        {
          model,
          messages: [{ role: "user", content: plan.prompt }],
          temperature: 0.2,
          max_tokens: 800,
        },
        { signal: deadline },
      )) {
        if (event.type === "content") digest += event.text;
        if (digest.length > 4500) break;
      }
    } catch (err) {
      if (deadline.aborted) return c.json({ error: `模型 ${SUMMARY_TIMEOUT_MS / 1000} 秒内没有给出摘录，压缩未写入` }, 502);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
    digest = digest.trim();
    if (!digest) {
      return c.json({ error: "模型未返回摘录，压缩未写入" }, 502);
    }
    setKv(db, summaryKey, JSON.stringify({ count: plan.count, text: digest.slice(0, 8000) }));
    const packed = compactForModel(history, budgetPlan.budget, digest, budgetPlan.options);
    return c.json({
      before: packed.stats.before,
      after: packed.stats.after,
      note: `已压缩当前对话发给模型的上下文（${packed.stats.before} → ${packed.stats.after} 字），并写入摘录缓存。界面消息未删；其它会话不受影响。`,
    });
  });

  /**
   * 这个对话是否还在跑，以及还在等用户处理的卡片。桌面端刷新、切走再回来时，
   * 界面没有原来的 SSE 了，靠这个把提问 / 方案 / 命令审批卡片和停止按钮补回来。
   */
  app.get("/api/conversations/:id/pending", (c) => {
    const conv = ownConv(db, c.req.param("id"), c.get("accountId"));
    if (!conv) return c.json({ error: "not found" }, 404);
    return c.json({
      running: abortors.has(conv.id),
      cards: [...(pendingCards.get(conv.id)?.values() ?? [])],
    });
  });

  /** 命令审批：只有该对话的主人能批 */
  function commandOwner(c: Context): CommandWaiter | Response {
    const w = commandWaiters.get(c.req.param("id") || "");
    if (!w) return c.json({ error: "该命令已不在等待审批" }, 404);
    if (!ownConv(db, w.convId, c.get("accountId"))) return c.json({ error: "not found" }, 404);
    return w;
  }

  app.post("/api/commands/:id/approve", (c) => {
    const w = commandOwner(c);
    if (w instanceof Response) return w;
    w.resolve("approved");
    return c.json({ ok: true });
  });

  app.post("/api/commands/:id/deny", (c) => {
    const w = commandOwner(c);
    if (w instanceof Response) return w;
    w.resolve("denied");
    return c.json({ ok: true });
  });

  app.post("/api/questions/:id/answer", async (c) => {
    const w = questionWaiters.get(c.req.param("id") || "");
    if (!w) return c.json({ error: "这个问题已经不在等回答" }, 404);
    if (!ownConv(db, w.convId, c.get("accountId"))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ text?: string }>().catch(() => ({ text: "" }));
    const text = String(body.text || "").trim().slice(0, 500);
    if (!text) return c.json({ error: "请选择一个选项或写一句回答" }, 400);
    w.resolve(text);
    questionWaiters.delete(c.req.param("id") || "");
    return c.json({ ok: true });
  });

  app.post("/api/plans/:id/approve", (c) => {
    const w = planWaiters.get(c.req.param("id") || "");
    if (!w) return c.json({ error: "这份方案已经不在等确认" }, 404);
    if (!ownConv(db, w.convId, c.get("accountId"))) return c.json({ error: "not found" }, 404);
    w.resolve({ action: "approve" });
    planWaiters.delete(c.req.param("id") || "");
    return c.json({ ok: true });
  });

  app.post("/api/plans/:id/revise", async (c) => {
    const w = planWaiters.get(c.req.param("id") || "");
    if (!w) return c.json({ error: "这份方案已经不在等确认" }, 404);
    if (!ownConv(db, w.convId, c.get("accountId"))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ note?: string }>().catch(() => ({ note: "" }));
    w.resolve({ action: "revise", note: String(body.note || "").trim().slice(0, 1000) });
    planWaiters.delete(c.req.param("id") || "");
    return c.json({ ok: true });
  });

  app.post("/api/git-setup/:id/:action", (c) => {
    const action = c.req.param("action") || "";
    if (action !== "install" && action !== "skip" && action !== "redetect") {
      return c.json({ error: "unknown action" }, 400);
    }
    const w = gitSetupWaiters.get(c.req.param("id") || "");
    if (!w) return c.json({ error: "该说明已失效" }, 404);
    if (!ownConv(db, w.convId, c.get("accountId"))) return c.json({ error: "not found" }, 404);
    w.resolve(action);
    gitSetupWaiters.delete(c.req.param("id") || "");
    return c.json({ ok: true });
  });

  /**
   * 回退到某条消息之前（把它和之后的全删掉）。ChatGPT 的「编辑消息」就是回退 + 重发；
   * 顺带把那之后产生的待确认 diff 一起作废，免得界面上还挂着已经不属于任何消息的改动。
   */
  app.post("/api/conversations/:id/messages/:mid/rewind", (c) => {
    const conv = ownConv(db, c.req.param("id"), c.get("accountId"));
    if (!conv) return c.json({ error: "not found" }, 404);
    if (abortors.has(conv.id)) return c.json({ error: "正在生成，先停止" }, 409);
    const target = db
      .prepare("SELECT id, created_at FROM messages WHERE id = ? AND conversation_id = ?")
      .get(c.req.param("mid"), conv.id) as { id: string; created_at: number } | undefined;
    if (!target) return c.json({ error: "not found" }, 404);
    db.prepare("DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?").run(conv.id, target.created_at);
    db.prepare("UPDATE diffs SET status='rejected' WHERE conversation_id = ? AND status = 'pending' AND created_at >= ?").run(
      conv.id,
      target.created_at,
    );
    deleteTurnUsageSince(db, conv.id, target.created_at);
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now(), conv.id);
    return c.json({ ok: true });
  });

  /**
   * 撤销上一轮：删掉最后一条用户消息和它之后的全部内容（与 rewind 同一套），
   * 原话返回给界面放回输入框。工具改过的文件不撤销（要撤销文件走 /restore）。
   */
  app.post("/api/conversations/:id/undo", (c) => {
    const conv = ownConv(db, c.req.param("id"), c.get("accountId"));
    if (!conv) return c.json({ error: "not found" }, 404);
    if (abortors.has(conv.id)) return c.json({ error: "正在生成，先停止" }, 409);
    const target = db
      .prepare("SELECT id, content, attachments, created_at FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1")
      .get(conv.id) as { id: string; content: string | null; attachments: string | null; created_at: number } | undefined;
    if (!target) return c.json({ error: "没有可以撤销的一轮" }, 400);
    const removed = db
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND created_at >= ?")
      .get(conv.id, target.created_at) as { c: number };
    db.prepare("DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?").run(conv.id, target.created_at);
    db.prepare("UPDATE diffs SET status='rejected' WHERE conversation_id = ? AND status = 'pending' AND created_at >= ?").run(
      conv.id,
      target.created_at,
    );
    deleteTurnUsageSince(db, conv.id, target.created_at);
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now(), conv.id);
    let attachments: unknown[] = [];
    try {
      const parsed = JSON.parse(target.attachments || "[]");
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {
      attachments = [];
    }
    return c.json({
      ok: true,
      messageId: target.id,
      text: target.content ?? "",
      attachments,
      removedMessages: Number(removed.c),
      filesReverted: false,
      usage: listTurnUsage(db, conv.id, 1).total,
    });
  });

  /** 把这条用户消息之后、本对话的 Agnes 自动提交 revert 掉。聊天记录不动。 */
  app.post("/api/conversations/:id/restore", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页版没有工作区" }, 404);
    if (!cfg.allowWrites) return c.json({ error: "当前部署已禁止写文件" }, 403);
    const conv = ownConv(db, c.req.param("id"), c.get("accountId"));
    if (!conv) return c.json({ error: "not found" }, 404);
    if (abortors.has(conv.id)) return c.json({ error: "正在生成，先停止" }, 409);
    const body = (await c.req.json<{ messageId?: string }>().catch(() => ({}))) as { messageId?: string };
    const target = db
      .prepare("SELECT id, role, created_at FROM messages WHERE id = ? AND conversation_id = ?")
      .get(body.messageId ?? "", conv.id) as { id: string; role: string; created_at: number } | undefined;
    if (!target || target.role !== "user") return c.json({ error: "只能回退到一条用户消息" }, 400);
    const root = workspaceRootOf(conv);
    const result = await revertConversationCommits(root, conv.id, target.created_at);
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ ok: true, reverted: result.reverted });
  });

  app.post("/api/conversations/:id/messages", rateLimit(web ? 20 : 60, 60_000, "msg", proxy), fuse("chat", q.hourChat, q.fiveHourChat), async (c) => {
    const convId = c.req.param("id") || "";
    const accountId = c.get("accountId");
    const conv = ownConv(db, convId, accountId);
    if (!conv) return c.json({ error: "not found" }, 404);
    const noModelAccess = await ensureModelAccess(deviceOf(c), conv.model || cfg.chatModel);
    if (noModelAccess) return c.json({ error: noModelAccess }, 400);
    const body = await c.req.json<{ content?: string; attachments?: unknown[]; regenerate?: boolean; planMode?: boolean }>();
    const regenerate = body.regenerate === true;
    let userText = (body.content ?? "").trim();
    const images = regenerate ? [] : parseAttachments(body.attachments);
    if (regenerate) {
      const lastUser = db
        .prepare("SELECT id, content, created_at FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1")
        .get(convId) as { id: string; content: string | null; created_at: number } | undefined;
      if (!lastUser) return c.json({ error: "没有可重新生成的消息" }, 400);
      userText = (lastUser.content ?? "").trim();
    }
    if (!userText && !images.length) return c.json({ error: "empty" }, 400);
    // 前端已经拦过；这里再兜一层，免得旧前端或脚本把图发给不支持图片的模型
    if (images.length && capsForModel(db, conv.model || cfg.chatModel).supportsImages === false) {
      return c.json({ error: "当前模型不支持图片输入：请去掉图片，或换一个支持图片的模型再发" }, 400);
    }

    if (abortors.has(convId)) return c.json({ error: "正在生成，先停止" }, 409);
    const controller = new AbortController();
    abortors.set(convId, controller);
    const releaseRun = () => {
      abortors.delete(convId);
      pendingCards.delete(convId);
    };
    // 这条消息扣过的额度。上游一个事件都没回就失败时退回去
    let charge: { bill: string; dailyIp: string | null; remoteTicket: string | null; deviceHash: string } | null = null;
    const refundCharge = async () => {
      const taken = charge;
      charge = null;
      if (!taken) return;
      try {
        if (taken.remoteTicket !== null) {
          // 旧授权服务器没有这个接口（404），那就只能不退
          if (taken.remoteTicket) await licenseFetch("/api/entitlements/refund-chat", taken.deviceHash, "POST", { ticket: taken.remoteTicket });
          return;
        }
        refundChat(db, taken.bill);
        if (taken.dailyIp !== null) refundQuota(db, taken.dailyIp, taken.deviceHash, "chat");
      } catch {
        /* 退还失败不该盖掉上游的真实报错 */
      }
    };

    try {
    // 计划模式跟着这条消息一起提交：先切开关再立刻发送时，PATCH 可能还没落库
    if (cfg.desktopMode && conv.mode === "agent" && typeof body.planMode === "boolean") {
      db.prepare("UPDATE conversations SET plan_mode = ?, updated_at = ? WHERE id = ?").run(body.planMode ? 1 : 0, now(), convId);
    }
    if (regenerate) {
      const lastUser = db
        .prepare("SELECT id, created_at FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1")
        .get(convId) as { id: string; created_at: number } | undefined;
      if (lastUser) {
        db.prepare("DELETE FROM messages WHERE conversation_id = ? AND created_at > ? AND role != 'user'").run(convId, lastUser.created_at);
        deleteTurnUsageSince(db, convId, lastUser.created_at + 1);
        db.prepare("UPDATE diffs SET status='rejected' WHERE conversation_id = ? AND status = 'pending' AND created_at > ?").run(
          convId,
          lastUser.created_at,
        );
      }
    }
    const blockedChat = Boolean(disallowedReason(userText, "chat"));
    const deviceHash = deviceOf(c);
    let ent = cfg.licenseServerUrl ? await entitlementNow(deviceHash) : viewerEntitlement(c);
    if (cfg.desktopMode && conv.mode === "agent") {
      const denied = featureDenied(ent, "agent");
      if (denied) {
        releaseRun();
        return c.json({ error: denied }, 403);
      }
    }
    const usingCustomModel = Boolean(parseCustomModel(conv.model || cfg.chatModel));
    if (!blockedChat && !usingCustomModel) {
      const deniedChat = featureDenied(ent, "chat");
      if (deniedChat) {
        releaseRun();
        return c.json({ error: deniedChat }, 403);
      }
      const bill = billingHash(c) || deviceHash;
      let dailyIp: string | null = null;
      if (web && q.dailyChat > 0 && !bill.startsWith("acct:")) {
        const ip = requestIp(c, proxy);
        const daily = takeDailyChat(db, ip, deviceHash, q.dailyChat);
        if (!daily.ok) {
          releaseRun();
          return c.json({ error: DAILY_CHAT_EXHAUSTED }, 429);
        }
        dailyIp = ip;
      }
      if (false /* oss */) {
        const remote = await licenseFetch("/api/entitlements/consume", deviceHash, "POST", {});
        if (remote.status !== 200) {
          releaseRun();
          const data = remote.data as { error?: string };
          return c.json({ error: data.error || "授权校验失败" }, remote.status as 403);
        }
        ent = (remote.data as { entitlement?: EntitlementPublic }).entitlement ?? ent;
        charge = {
          bill,
          dailyIp: null,
          remoteTicket: String((remote.data as { refundTicket?: string }).refundTicket || ""),
          deviceHash,
        };
      } else {
        try {
          consumeChat(db, bill);
          charge = { bill, dailyIp, remoteTicket: null, deviceHash };
          const row = getEntitlement(db, bill);
          ent = row ? publicEntitlement(row, db) : ent;
        } catch (err) {
          if (dailyIp !== null) refundQuota(db, dailyIp, deviceHash, "chat");
          releaseRun();
          return c.json({ error: webCopy(err instanceof Error ? err.message : String(err)) }, 403);
        }
      }
    }

    if (!regenerate) {
      const userId = id("m");
      db.prepare(
        "INSERT INTO messages (id, conversation_id, role, content, tool_call_id, tool_calls, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(userId, convId, "user", userText, null, null, JSON.stringify(images), now());
    }
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now(), convId);
    if (conv.title === "新对话" || conv.title === "新任务") {
      const title = blockedChat ? "已拦截" : userText.slice(0, 32) || `图片 ${images.length} 张`;
      db.prepare("UPDATE conversations SET title=?, updated_at=? WHERE id=?").run(title, now(), convId);
    }

    const historyRows = db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(convId) as MessageRow[];
    const history = await Promise.all(historyRows.map((row) => rowToModelMessage(row)));

    c.header("X-Accel-Buffering", "no");
    c.header("Cache-Control", "no-cache, no-transform");
    return streamSSE(c, async (stream) => {
      let writes = Promise.resolve();
      // 页面断开后写入会失败：吞掉，别让一次写失败把还在跑的 Agent 当成上游出错
      const send = (event: string, data: unknown) => {
        writes = writes.then(() => (stream.aborted || stream.closed ? undefined : stream.writeSSE({ event, data: JSON.stringify(data) }))).catch(() => {});
        return writes;
      };
      // 网页：关掉标签页就停，不再替一个没人看的页面烧额度。桌面：刷新后能从 /pending 接回来，继续跑
      stream.onAbort(() => {
        if (web) controller.abort();
      });
      let result: RunAgentResult | null = null;
      let sawUpstream = false;
      // 每轮用量/结束原因：usage、retry 事件累加，finish 时落库并推一条 turn_usage
      const turn = createTurnTracker();
      let turnModel = conv.model || cfg.chatModel;
      let turnProvider = "agnes";
      try {
        await send("status", { type: "status", phase: "start" });
        await stream.write(`:${" ".repeat(2048)}\n\n`);
        const convRoot = workspaceRootOf(conv);
        const workspace = new Workspace(convRoot);
        const planCapable = Boolean(cfg.desktopMode && conv.mode === "agent");
        // 每次都读库：本轮进行中用户在顶栏切了计划模式，后面的工具调用立刻按新状态走
        const readPlanMode = () => {
          if (!planCapable) return false;
          const row = db.prepare("SELECT plan_mode FROM conversations WHERE id = ?").get(convId) as { plan_mode: number } | undefined;
          return Number(row?.plan_mode) === 1;
        };
        const runtime: ToolRuntime = {
          workspaceRoot: convRoot,
          // 每次写文件再读档：顶栏切到「只问命令 / 全自动」后，本轮后面的写入也不再弹应用
          get autoApply() {
            return cfg.approvalMode !== "suggest";
          },
          allowTerminal: Boolean(cfg.desktopMode) && Boolean(ent?.allowAgent),
          allowWrites: Boolean(cfg.desktopMode) && cfg.allowWrites && Boolean(ent?.allowAgent),
          allowImage: Boolean(cfg.desktopMode) && Boolean(ent?.allowImage),
          allowVideo: Boolean(cfg.desktopMode) && Boolean(ent?.allowVideo),
          // 每次跑命令时再读档：审批卡里点「始终允许」后，本轮剩下的命令也不再问
          get confirmCommands() {
            return cfg.approvalMode !== "full-auto";
          },
          get approvalMode() {
            return cfg.approvalMode;
          },
          get commandAllow() {
            return cfg.commandAllow;
          },
          // 每次调用工具时再读档：设置里改了超时，本轮后面的调用就按新的来
          get toolTimeouts() {
            return cfg.toolTimeouts;
          },
          conversationId: convId,
          gitCheckpoints: Boolean(cfg.desktopMode),
          get planMode() {
            return readPlanMode();
          },
          onPlanModeChange: (active) => {
            db.prepare("UPDATE conversations SET plan_mode = ?, updated_at = ? WHERE id = ?").run(active ? 1 : 0, now(), convId);
            void send("plan_mode", { type: "plan_mode", active });
          },
          waitForGitSetup: (setupId) =>
            new Promise<"install" | "skip" | "redetect">((resolve) => {
              let settled = false;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const done = (v: "install" | "skip" | "redetect") => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                gitSetupWaiters.delete(setupId);
                controller.signal.removeEventListener("abort", onAbort);
                resolve(v);
              };
              const onAbort = () => done("skip");
              timer = setTimeout(() => done("skip"), 15 * 60_000);
              if (controller.signal.aborted) {
                done("skip");
                return;
              }
              controller.signal.addEventListener("abort", onAbort, { once: true });
              gitSetupWaiters.set(setupId, {
                convId,
                resolve: done,
              });
            }),
          waitForCommand: (cmdId, command) =>
            new Promise<"approved" | "denied">((resolve) => {
              let settled = false;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const done = (v: "approved" | "denied") => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                commandWaiters.delete(cmdId);
                dropCard(convId, cmdId);
                controller.signal.removeEventListener("abort", onAbort);
                resolve(v);
              };
              const onAbort = () => done("denied");
              timer = setTimeout(() => done("denied"), 10 * 60_000);
              if (controller.signal.aborted) {
                done("denied");
                return;
              }
              controller.signal.addEventListener("abort", onAbort, { once: true });
              commandWaiters.set(cmdId, {
                convId,
                command,
                resolve: done,
              });
            }),
          waitForQuestion: (qid) =>
            new Promise<string>((resolve) => {
              let settled = false;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const done = (answer: string) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                questionWaiters.delete(qid);
                dropCard(convId, qid);
                controller.signal.removeEventListener("abort", onAbort);
                resolve(answer);
              };
              const onAbort = () => done("");
              timer = setTimeout(() => done(""), 15 * 60_000);
              if (controller.signal.aborted) {
                done("");
                return;
              }
              controller.signal.addEventListener("abort", onAbort, { once: true });
              questionWaiters.set(qid, { convId, resolve: done });
            }),
          waitForPlan: (planId) =>
            new Promise<PlanVerdict>((resolve) => {
              let settled = false;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const done = (v: PlanVerdict) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                planWaiters.delete(planId);
                dropCard(convId, planId);
                controller.signal.removeEventListener("abort", onAbort);
                resolve(v);
              };
              const onAbort = () => done({ action: "cancel", note: "用户停止了这一轮" });
              timer = setTimeout(() => done({ action: "cancel", note: "等待确认超时" }), 15 * 60_000);
              if (controller.signal.aborted) {
                done({ action: "cancel", note: "用户停止了这一轮" });
                return;
              }
              controller.signal.addEventListener("abort", onAbort, { once: true });
              planWaiters.set(planId, { convId, resolve: done });
            }),
          emit: (event) => {
            if (event.type === "token" || event.type === "thinking" || event.type === "tool_start" || event.type === "usage") sawUpstream = true;
            turn.onEvent(event as { type: string });
            if (event.type === "finish") {
              const rec = turn.finish(db, { conversationId: convId, model: turnModel, provider: turnProvider, finishReason: event.reason });
              if (rec) {
                const out = send(event.type, event);
                void send("turn_usage", { type: "turn_usage", ...rec });
                return out;
              }
            }
            if (event.type === "question" || event.type === "plan_review" || event.type === "command") holdCard(convId, event);
            if (event.type === "diff") {
              const d = event.diff;
              const status = cfg.approvalMode !== "suggest" ? "applied" : "pending";
              db.prepare(
                "INSERT INTO diffs (id, conversation_id, path, original, proposed, unified, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              ).run(d.id, convId, d.path, d.original, d.proposed, d.unified, status, now());
              return send(event.type, { ...event, status });
            }
            return send(event.type, event);
          },
          waitForApply: (diff: DiffProposal) =>
            new Promise<"applied" | "rejected" | "stale">((resolve) => {
              let settled = false;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const done = (value: "applied" | "rejected" | "stale") => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                waiters.delete(diff.id);
                controller.signal.removeEventListener("abort", onAbort);
                resolve(value);
              };
              const onAbort = () => done("rejected");
              timer = setTimeout(() => done("rejected"), 10 * 60_000);
              if (controller.signal.aborted) {
                done("rejected");
                return;
              }
              controller.signal.addEventListener("abort", onAbort, { once: true });
              waiters.set(diff.id, {
                resolve: done,
              });
            }),
          saveImage: async ({ prompt, url, b64 }) => {
            let localPath: string | undefined;
            if (b64) localPath = await persistBase64(cfg.mediaDir, b64, ".png");
            else if (url) {
              try {
                localPath = await persistRemoteFile(cfg.mediaDir, url, ".png");
              } catch {
                localPath = undefined;
              }
            }
            const mediaId = insertMedia(db, {
              type: "image",
              status: "completed",
              prompt,
              model: cfg.imageModel,
              conversationId: convId,
              accountId,
              resultUrl: url ?? null,
              localPath: localPath ?? null,
            });
            return { id: mediaId, publicUrl: url || mediaPublicPath(mediaId, cfg.publicApiOrigin), localPath };
          },
          saveVideo: async ({ prompt, url, videoId }) => {
            let localPath: string | undefined;
            try {
              localPath = await persistRemoteFile(cfg.mediaDir, url, ".mp4");
            } catch {
              localPath = undefined;
            }
            const mediaId = insertMedia(db, {
              type: "video",
              status: "completed",
              prompt,
              model: cfg.videoModel,
              conversationId: convId,
              accountId,
              resultUrl: url,
              localPath: localPath ?? null,
              providerId: videoId,
            });
            return { id: mediaId, publicUrl: url || mediaPublicPath(mediaId, cfg.publicApiOrigin), localPath };
          },
          signal: controller.signal,
          mcp: getSharedMcpHub() ?? undefined,
        };

        const personaRow = conv.persona_id ? ownPersona(db, conv.persona_id, accountId) : undefined;
        const agentMode = cfg.desktopMode && conv.mode === "agent";
        // @文件 只展开到模型侧那份消息，库里存的还是用户原话
        if (agentMode && userText) {
          const last = history[history.length - 1];
          if (last?.role === "user") {
            const expanded = await expandMentions(workspace, userText);
            if (expanded.attached.length) {
              if (typeof last.content === "string") last.content = expanded.content;
              else if (Array.isArray(last.content)) {
                const idx = last.content.findIndex((p) => p.type === "text");
                if (idx >= 0) (last.content[idx] as { type: "text"; text: string }).text = expanded.content;
                else last.content.unshift({ type: "text", text: expanded.content });
              }
              await send("status", { type: "status", phase: "mentions", files: expanded.attached });
            }
          }
        }
        let snapshot = agentMode ? await projectContext(convRoot).catch(() => "") : "";
        if (agentMode) {
          const bgNote = formatBgTerminalPreamble(convId);
          if (bgNote) snapshot = snapshot ? snapshot + "\n\n" + bgNote : bgNote;
        }
        const rules = agentMode ? readProjectRules(convRoot) : null;
        if (agentMode && cfg.allowWrites) await ensureGitReady(runtime);
        const summaryKey = `conv.summary.${convId}`;
        const customChat = resolveCustomChat(db, conv.model || cfg.chatModel);
        turnModel = customChat?.model || conv.model || cfg.chatModel;
        turnProvider = customChat ? (parseCustomModelForUsage(conv.model || cfg.chatModel)?.providerId ?? "custom") : "agnes";
        result = await runAgent({
          agnes,
          chatClient: customChat?.client,
          caps: capsForModel(db, conv.model || cfg.chatModel),
          model: customChat?.model || conv.model || cfg.chatModel,
          mode: agentMode ? "agent" : "chat",
          history,
          workspace,
          runtime,
          imageModel: cfg.imageModel,
          videoModel: cfg.videoModel,
          persona: personaRow ? { name: personaRow.name, body: personaRow.body } : null,
          skills: cfg.desktopMode ? listSkills(convRoot) : [],
          projectContext: snapshot,
          projectRules: rules?.text ?? "",
          goal: String(conv.goal || ""),
          summaryCache: parseSummaryCache(getKv(db, summaryKey)),
          summarize: async (prompt) => {
            let out = "";
            // 摘录最多等 90 秒。超时当普通失败（loop 改用机械摘录），不能当成用户点了停止
            const deadline = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
            try {
              for await (const event of (customChat?.client ?? agnes).chatCompletionsStream(
                {
                  model: customChat?.model || conv.model || cfg.chatModel,
                  messages: [{ role: "user", content: prompt }],
                  temperature: 0.2,
                  max_tokens: 800,
                },
                { signal: AbortSignal.any([controller.signal, deadline]) },
              )) {
                if (event.type === "content") out += event.text;
                if (out.length > 4500) break;
              }
            } catch (err) {
              if (!controller.signal.aborted && deadline.aborted) throw new Error(`上下文摘录超过 ${SUMMARY_TIMEOUT_MS / 1000} 秒没完成`);
              throw err;
            }
            return out;
          },
          onSummaryCache: (cache) => {
            setKv(db, summaryKey, JSON.stringify(cache));
          },
        });

        if (result.upstreamFailed) await refundCharge();
        for (const msg of result.extra) {
          const nested =
            msg.role === "tool" && msg.tool_call_id && result.nestedSteps?.[msg.tool_call_id]
              ? capSubSteps(result.nestedSteps[msg.tool_call_id])
              : null;
          db.prepare(
            "INSERT INTO messages (id, conversation_id, role, content, tool_call_id, tool_calls, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            id("m"),
            convId,
            msg.role,
            typeof msg.content === "string" ? msg.content : msg.content ? JSON.stringify(msg.content) : null,
            msg.tool_call_id ?? null,
            msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
            nested,
            now(),
          );
        }
        db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now(), convId);
      } catch (err) {
        if (!result && !sawUpstream) await refundCharge();
        await send("error", { type: "error", message: publicError(err, cfg.isProduction) });
      } finally {
        // 没走到 finish 就结束（异常）：也记一条，结束原因 error
        if (result || sawUpstream) {
          try {
            const rec = turn.finish(db, { conversationId: convId, model: turnModel, provider: turnProvider, finishReason: result ? "stop" : "error" });
            if (rec) await send("turn_usage", { type: "turn_usage", ...rec });
          } catch {
            /* 记账失败不影响本轮 */
          }
        }
        releaseRun();
        await send("done", { ok: true });
      }
    });
    } catch (err) {
      await refundCharge();
      releaseRun();
      throw err;
    }
  });

  /** 每轮用量记录：最新在前；total 为整个会话合计 */
  app.get("/api/usage", (c) => {
    const convId = c.req.query("conversationId") || "";
    if (!convId) return c.json({ error: "缺少 conversationId" }, 400);
    if (!ownConv(db, convId, c.get("accountId"))) return c.json({ error: "not found" }, 404);
    const limit = Number(c.req.query("limit") || 50);
    return c.json({ conversationId: convId, ...listTurnUsage(db, convId, limit) });
  });

  app.get("/api/diffs", (c) => {
    const accountId = c.get("accountId");
    const convId = c.req.query("conversationId");
    const status = c.req.query("status") || "pending";
    if (convId && !ownConv(db, convId, accountId)) return c.json({ error: "not found" }, 404);
    const rows = convId
      ? (db
          .prepare("SELECT * FROM diffs WHERE conversation_id = ? AND status = ? ORDER BY created_at DESC")
          .all(convId, status) as DiffRow[])
      : (db
          .prepare(
            `SELECT d.* FROM diffs d
             INNER JOIN conversations c ON c.id = d.conversation_id
             WHERE c.account_id = ? AND d.status = ?
             ORDER BY d.created_at DESC`,
          )
          .all(accountId, status) as DiffRow[]);
    return c.json(rows);
  });

  app.post("/api/diffs/:id/apply", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页版没有工作区" }, 404);
    if (!cfg.allowWrites) return c.json({ error: "当前部署已禁止写文件" }, 403);
    const row = ownDiff(db, c.req.param("id"), c.get("accountId"));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status !== "pending") return c.json({ error: "这条改动已经处理过了" }, 400);
    // diff 属于哪个对话就写回哪个工作区，别落到默认目录去
    const ws = new Workspace(workspaceRootOf(ownConv(db, row.conversation_id, c.get("accountId"))));
    // 同目录可能还有别的 Agent 在写：带锁落盘，并且只在文件仍是这次 diff 的原文时才写，
    // 否则等于把别人（或自己后来）的改动盖掉——那正是记录"串"掉的来源
    const outcome = await withWorkspaceLock(ws.root, async () => {
      let current = "";
      try {
        current = ws.exists(row.path) ? await ws.readFile(row.path) : "";
      } catch {
        current = "";
      }
      if (current === row.proposed) return "applied" as const;
      if (current !== row.original) return "stale" as const;
      await ws.writeFile(row.path, row.proposed);
      return "applied" as const;
    });
    if (outcome === "stale") {
      db.prepare("UPDATE diffs SET status=? WHERE id=?").run("rejected", row.id);
      waiters.get(row.id)?.resolve("stale");
      waiters.delete(row.id);
      return c.json({ error: `${row.path} 在这次改动提出之后又被修改过（可能是另一个 Agent），已作废，请让它重新读取后再改` }, 409);
    }
    db.prepare("UPDATE diffs SET status=? WHERE id=?").run("applied", row.id);
    waiters.get(row.id)?.resolve("applied");
    waiters.delete(row.id);
    return c.json({ ok: true });
  });

  app.post("/api/diffs/:id/reject", (c) => {
    const row = ownDiff(db, c.req.param("id"), c.get("accountId"));
    if (!row) return c.json({ error: "not found" }, 404);
    db.prepare("UPDATE diffs SET status=? WHERE id=?").run("rejected", row.id);
    waiters.get(row.id)?.resolve("rejected");
    waiters.delete(row.id);
    return c.json({ ok: true });
  });

  /**
   * 撤销一次已应用的写入：把 diff 里存的 original 写回去。这是 Cursor「checkpoint 回退」的
   * 最小版——只回退这一个文件、只回退到这次改动之前。文件如果后来又被别的 diff 改过，
   * 后面那些改动也会被一起覆盖掉，所以拒绝掉"文件当前内容 ≠ 这次 proposed"的情况。
   */
  app.post("/api/diffs/:id/revert", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页版没有工作区" }, 404);
    if (!cfg.allowWrites) return c.json({ error: "当前部署已禁止写文件" }, 403);
    const row = ownDiff(db, c.req.param("id"), c.get("accountId"));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status !== "applied") return c.json({ error: "只有已应用的改动可以撤销" }, 400);
    const ws = new Workspace(workspaceRootOf(ownConv(db, row.conversation_id, c.get("accountId"))));
    let outcome: "ok" | "changed" | { error: unknown };
    try {
      outcome = await withWorkspaceLock(ws.root, async () => {
        const current = ws.exists(row.path) ? await ws.readFile(row.path) : "";
        if (current !== row.proposed) return "changed" as const;
        await ws.writeFile(row.path, row.original);
        return "ok" as const;
      });
    } catch (err) {
      outcome = { error: err };
    }
    if (typeof outcome === "object") return c.json({ error: publicError(outcome.error, cfg.isProduction) }, 400);
    if (outcome === "changed") {
      return c.json({ error: "文件在这次改动之后又被修改过，不能直接撤销，请手动处理" }, 409);
    }
    db.prepare("UPDATE diffs SET status=? WHERE id=?").run("reverted", row.id);
    return c.json({ ok: true });
  });

  // 多模态输入：图片先落到媒体目录，消息里只存 mediaId，避免把 base64 塞进 sqlite
  app.post("/api/uploads/image", rateLimit(web ? 10 : 40, 60_000, "upload", proxy), async (c) => {
    const accountId = c.get("accountId");
    const body = (await c.req
      .json<{ dataUrl?: string; name?: string; conversationId?: string }>()
      .catch(() => ({}))) as { dataUrl?: string; name?: string; conversationId?: string };
    const dataUrl = String(body.dataUrl || "");
    const mime = /^data:(image\/(png|jpe?g|webp|gif));base64,/i.exec(dataUrl)?.[1];
    if (!mime) return c.json({ error: "只支持 png / jpg / webp / gif 图片" }, 400);
    const ext = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : mime === "image/gif" ? ".gif" : ".jpg";
    try {
      const localPath = await persistBase64(cfg.mediaDir, dataUrl, ext);
      const mediaId = insertMedia(db, {
        type: "upload",
        status: "completed",
        prompt: String(body.name || "").slice(0, 120),
        model: "",
        conversationId: body.conversationId || null,
        accountId,
        localPath,
      });
      return c.json({ id: mediaId, url: mediaPublicPath(mediaId, cfg.publicApiOrigin) });
    } catch (err) {
      return c.json({ error: publicError(err, cfg.isProduction) }, 400);
    }
  });

  app.get("/api/workspace", async (c) => {
    const depth = Math.min(Math.max(Number(c.req.query("depth") || 3), 1), 4);
    const rel = c.req.query("path") || ".";
    const ws = workspaceOfRequest(c);
    const [tree, git] = await Promise.all([ws.listDir(rel, depth), cfg.desktopMode ? gitSummary(ws.root) : null]);
    return c.json({
      root: ws.root,
      tree,
      skills: cfg.desktopMode ? listSkills(ws.root).map((s) => s.name) : [],
      git: git ? { branch: git.branch, changed: git.changed.length } : null,
    });
  });

  app.get("/api/workspace/symbols", async (c) => {
    if (!cfg.desktopMode) return c.json({ error: "网页版没有工作区" }, 404);
    const q = String(c.req.query("q") || "").slice(0, 80);
    if (!q.trim() || q.includes("/") || q.includes("\\") || q.includes("..")) return c.json({ hits: [] });
    const ws = workspaceOfRequest(c);
    const hits = rankSymbols(await collectSymbols(ws.root), q, 8);
    return c.json({ hits });
  });

  app.get("/api/workspace/file", async (c) => {
    const rel = c.req.query("path");
    if (!rel) return c.json({ error: "path required" }, 400);
    const ws = workspaceOfRequest(c);
    try {
      const content = await ws.readFile(rel);
      return c.json({ path: rel, content });
    } catch (err) {
      return c.json({ error: publicError(err, cfg.isProduction) }, 400);
    }
  });

  app.put("/api/workspace/file", async (c) => {
    if (!cfg.allowWrites) return c.json({ error: "当前部署已禁止写文件" }, 403);
    const body = await c.req.json<{ path: string; content: string }>();
    const ws = workspaceOfRequest(c);
    await withWorkspaceLock(ws.root, () => ws.writeFile(body.path, body.content));
    return c.json({ ok: true });
  });

  app.get("/api/workspace/download", async (c) => {
    const rel = c.req.query("path");
    if (!rel) return c.json({ error: "path required" }, 400);
    const ws = workspaceOfRequest(c);
    const abs = ws.readablePath(rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return c.json({ error: "file not found" }, 404);
    }
    const data = await fsPromises.readFile(abs);
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeDownloadName(path.basename(abs))}"`,
    });
  });

  app.post("/api/workspace/upload", async (c) => {
    if (!cfg.allowWrites) return c.json({ error: "当前部署已禁止写文件" }, 403);
    const form = await c.req.parseBody();
    const destRel = String(form.path || "");
    const file = form.file;
    if (!file || typeof file === "string") return c.json({ error: "file required" }, 400);
    let filename: string;
    try {
      filename = safeUploadName(file.name);
    } catch (err) {
      return c.json({ error: publicError(err, cfg.isProduction) }, 400);
    }
    const ws = workspaceOfRequest(c);
    const dest = destRel ? `${destRel.replace(/\\/g, "/")}/${filename}` : filename;
    const abs = ws.resolve(dest);
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > cfg.maxUploadBytes) return c.json({ error: "文件过大" }, 413);
    await fsPromises.mkdir(path.dirname(abs), { recursive: true });
    await fsPromises.writeFile(abs, buf);
    return c.json({ ok: true, path: ws.relative(abs) });
  });

  app.post("/api/images/generate", rateLimit(web ? 8 : 30, 60_000, "img", proxy), fuse("image", q.hourImage, q.fiveHourImage), async (c) => {
    const entForImage = cfg.licenseServerUrl ? await entitlementNow(deviceOf(c)) : viewerEntitlement(c);
    const denied = featureDenied(entForImage, "image");
    if (denied) return c.json({ error: denied }, 403);
    const noModelAccess = await ensureModelAccess(deviceOf(c));
    if (noModelAccess) return c.json({ error: noModelAccess }, 400);
    const accountId = c.get("accountId");
    const body = await c.req.json<{
      prompt: string;
      size?: string;
      ratio?: string;
      images?: string[];
      conversationId?: string;
      count?: number;
    }>();
    if (body.conversationId && !ownConv(db, body.conversationId, accountId)) {
      return c.json({ error: "not found" }, 404);
    }
    if (disallowedReason(body.prompt ?? "", "media")) {
      return c.json({ error: REFUSAL_TEXT }, 400);
    }
    // 中转生效时额度由授权服务器在中转端点扣，本机再扣一次就成双份
    const paidImage = !cfg.relayManaged && entForImage?.plan === "licensed" && !entForImage.isSuper;
    // 免费档（网页 + 桌面试用）：每天 N 张，按设备与访客 IP 取高
    const freeImage = !paidImage && !cfg.relayManaged && q.dailyImage > 0 && !entForImage?.isSuper;
    // 一次 1–4 张：每张是独立任务、独立扣一次；余量不够整单直接拒，不出半截
    const count = imageCountOf(body.count);
    if (count > 1 && !entForImage?.isSuper) {
      const left = await imageRemainingFor(c, entForImage);
      if (left !== null && left < count) {
        const error = left <= 0 ? "出图额度已用完" : `剩余出图额度不足：这次要 ${count} 张，只剩 ${left} 张`;
        return c.json({ error, remaining: left }, 429);
      }
    }
    const imageUris = await Promise.all((body.images ?? []).map((p) => resolveMediaRef(p)));
    const billTo = billingHash(c) || deviceOf(c);
    type ImageItem =
      | { id: string; url: string; mediaUrl: string; local: boolean }
      | { error: string; refunded: boolean; status: 429 | 500 };
    const generateOne = async (): Promise<ImageItem> => {
      let ticket = "";
      if (paidImage) {
        // 付费档：扣卡有效期内的出图总量
        try {
          ticket = await consumeMediaQuota(billTo, "image");
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err), refunded: false, status: 429 };
        }
      } else if (freeImage) {
        const daily = takeQuota(db, requestIp(c, proxy), deviceOf(c), "image", q.dailyImage, 1);
        if (!daily.ok) return { error: quotaExhaustedMessage("image", q.dailyImage), refunded: false, status: 429 };
      }
      try {
        const result = await agnes.generateImage({
          model: cfg.imageModel,
          prompt: body.prompt,
          size: body.size ?? "2K",
          ratio: body.ratio ?? "1:1",
          image: imageUris.length ? imageUris : undefined,
          responseFormat: "url",
        });
        let localPath: string | undefined;
        if (result.b64Json) localPath = await persistBase64(cfg.mediaDir, result.b64Json, ".png");
        else if (result.url) {
          try {
            localPath = await persistRemoteFile(cfg.mediaDir, result.url, ".png");
          } catch {
            /* keep remote url */
          }
        }
        const mediaId = insertMedia(db, {
          type: "image",
          status: "completed",
          prompt: body.prompt,
          model: cfg.imageModel,
          conversationId: body.conversationId,
          accountId,
          resultUrl: result.url ?? null,
          localPath: localPath ?? null,
          params: { size: body.size, ratio: body.ratio },
        });
        return {
          id: mediaId,
          url: result.url || mediaPublicPath(mediaId, cfg.publicApiOrigin),
          mediaUrl: mediaPublicPath(mediaId, cfg.publicApiOrigin),
          local: Boolean(localPath),
        };
      } catch (err) {
        let refunded = false;
        if (paidImage) refunded = await refundMediaQuota(billTo, "image", ticket);
        else if (freeImage) {
          refundQuota(db, requestIp(c, proxy), deviceOf(c), "image");
          refunded = true;
        } else if (false /* oss */) refunded = relayRefundedFlag(err);
        console.error("[images/generate]", err instanceof Error ? err.message : err);
        return { error: publicError(err, cfg.isProduction), refunded, status: 500 };
      }
    };
    const items = await runPool(count, MAX_IMAGE_PARALLEL, () => generateOne());
    if (count === 1) {
      const only = items[0];
      if ("error" in only) return c.json({ error: only.error, refunded: only.refunded }, only.status);
      return c.json({ ...only, items });
    }
    const ok = items.filter((item) => !("error" in item)).length;
    return c.json({ items: items.map((item) => ("error" in item ? { error: item.error, refunded: item.refunded } : item)), ok, failed: count - ok });
  });

  app.post("/api/videos/generate", rateLimit(web ? 3 : 12, 60_000, "vid", proxy), fuse("video", q.hourVideo, q.fiveHourVideo), async (c) => {
    const entForVideo = cfg.licenseServerUrl ? await entitlementNow(deviceOf(c)) : viewerEntitlement(c);
    const denied = featureDenied(entForVideo, "video");
    if (denied) return c.json({ error: denied }, 403);
    const noModelAccess = await ensureModelAccess(deviceOf(c));
    if (noModelAccess) return c.json({ error: noModelAccess }, 400);
    const accountId = c.get("accountId");
    const body = await c.req.json<{
      prompt: string;
      seconds?: string;
      aspectRatio?: string;
      mode?: "text" | "keyframe" | "reference";
      firstFrame?: string;
      lastFrame?: string;
      images?: string[];
      conversationId?: string;
    }>();
    if (body.conversationId && !ownConv(db, body.conversationId, accountId)) {
      return c.json({ error: "not found" }, 404);
    }
    if (disallowedReason(body.prompt ?? "", "media")) {
      return c.json({ error: REFUSAL_TEXT }, 400);
    }
    const paidVideo = !cfg.relayManaged && entForVideo?.plan === "licensed" && !entForVideo.isSuper;
    let videoRefundTicket = "";
    if (paidVideo) {
      try {
        videoRefundTicket = await consumeMediaQuota(billingHash(c) || deviceOf(c), "video");
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 429);
      }
    } else if (!cfg.relayManaged && q.videoLimit > 0 && !entForVideo?.isSuper) {
      const daily = takeQuota(db, requestIp(c, proxy), deviceOf(c), "video", q.videoLimit, q.videoDays);
      if (!daily.ok) return c.json({ error: quotaExhaustedMessage("video", q.videoLimit, q.videoDays) }, 429);
    }
    try {
      const created = await agnes.createVideo({
        model: cfg.videoModel,
        prompt: body.prompt,
        mode: body.mode ?? "text",
        seconds: body.seconds ?? "5",
        size: "720P",
        aspectRatio: body.aspectRatio ?? "16:9",
        firstFrame: body.firstFrame ? await resolveMediaRef(body.firstFrame) : undefined,
        lastFrame: body.lastFrame ? await resolveMediaRef(body.lastFrame) : undefined,
        images: body.images ? await Promise.all(body.images.map((p) => resolveMediaRef(p))) : undefined,
      });
      const mediaId = insertMedia(db, {
        type: "video",
        status: "processing",
        prompt: body.prompt,
        model: cfg.videoModel,
        conversationId: body.conversationId,
        accountId,
        providerId: created.videoId,
        params: body,
      });
      void (async () => {
        try {
          const done = await agnes.waitForVideo(created.videoId, { modelName: cfg.videoModel });
          let localPath: string | undefined;
          if (done.url) {
            try {
              localPath = await persistRemoteFile(cfg.mediaDir, done.url, ".mp4");
            } catch {
              localPath = undefined;
            }
          }
          updateMedia(db, mediaId, {
            status: "completed",
            result_url: done.url ?? null,
            local_path: localPath ?? null,
          });
        } catch (err) {
          updateMedia(db, mediaId, {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return c.json({ id: mediaId, videoId: created.videoId, status: "processing" });
    } catch (err) {
      let refunded = false;
      if (paidVideo) refunded = await refundMediaQuota(billingHash(c) || deviceOf(c), "video", videoRefundTicket);
      else if (!cfg.relayManaged && q.videoLimit > 0 && !entForVideo?.isSuper) {
        refundQuota(db, requestIp(c, proxy), deviceOf(c), "video");
        refunded = true;
      } else if (false /* oss */) refunded = relayRefundedFlag(err);
      console.error("[videos/generate]", err instanceof Error ? err.message : err);
      return c.json({ error: publicError(err, cfg.isProduction), refunded }, 500);
    }
  });

  app.get("/api/videos/:id", (c) => {
    const row = ownMedia(db, c.req.param("id"), c.get("accountId"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({
      ...row,
      playUrl: row.local_path ? mediaPublicPath(row.id, cfg.publicApiOrigin) : row.result_url,
    });
  });

  app.get("/api/media", (c) => {
    const accountId = c.get("accountId");
    const type = c.req.query("type");
    const rows = (
      type
        ? db
            .prepare("SELECT * FROM media_jobs WHERE account_id = ? AND type = ? ORDER BY created_at DESC LIMIT 100")
            .all(accountId, type)
        : db.prepare("SELECT * FROM media_jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT 100").all(accountId)
    ) as MediaRow[];
    return c.json(
      rows.map((row) => ({
        ...row,
        playUrl: row.local_path ? mediaPublicPath(row.id, cfg.publicApiOrigin) : row.result_url,
      })),
    );
  });

  app.get("/api/media/:id", async (c) => {
    const row = ownMedia(db, c.req.param("id"), c.get("accountId"));
    if (!row?.local_path || !fs.existsSync(row.local_path)) {
      if (row?.result_url) return c.redirect(row.result_url);
      return c.json({ error: "not found" }, 404);
    }
    try {
      assertInside(cfg.mediaDir, row.local_path);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    const type = mediaContentType(row.local_path);
    // ?download=1 一定给原图并带 attachment；?preview=1 给长边 800 的 WebP，生成不了就回落原图
    const download = c.req.query("download") === "1";
    const wantPreview = !download && c.req.query("preview") === "1" && type.startsWith("image/") && type !== "image/gif";
    let filePath = row.local_path;
    let contentType = type;
    let previewState = "";
    if (wantPreview) {
      const preview = await ensureMediaPreview(cfg.dataDir, row.id, row.local_path);
      if (preview) {
        filePath = preview;
        contentType = "image/webp";
        previewState = "webp";
      } else {
        previewState = "original";
      }
    }
    const data = await fsPromises.readFile(filePath);
    const headers: Record<string, string> = { "Content-Type": contentType, "Cache-Control": MEDIA_CACHE_CONTROL };
    if (previewState) headers["X-Agnes-Preview"] = previewState;
    if (download) headers["Content-Disposition"] = attachmentDisposition(mediaDownloadName(row, row.local_path));
    if (cfg.corsOrigin) headers["Cross-Origin-Resource-Policy"] = "cross-origin";
    return c.body(new Uint8Array(data), 200, headers);
  });

  app.all("/admin", (c) => c.json({ error: "not found" }, 404));
  app.all("/admin/*", (c) => c.json({ error: "not found" }, 404));

  if (cfg.webDist && fs.existsSync(cfg.webDist)) {
    const dist = cfg.webDist;
    app.use("/*", async (c, next) => {
      if (isApiHost(c.req.header("host"), cfg)) return c.json({ error: "not found" }, 404);
      return next();
    });
    app.use("/*", async (c, next) => {
      await next();
      const pathName = new URL(c.req.url).pathname;
      const type = c.res.headers.get("content-type") || "";
      if (pathName === "/" || pathName.endsWith(".html") || type.includes("text/html")) {
        c.res.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    });
    app.use("/*", serveStatic({ root: dist }));
    app.get("*", async (c) => {
      if (isApiHost(c.req.header("host"), cfg)) return c.json({ error: "not found" }, 404);
      const html = await fsPromises.readFile(path.join(dist, "index.html"), "utf8");
      return c.html(html, 200, { "Cache-Control": "no-cache, no-store, must-revalidate" });
    });
  }

  return app;
}
