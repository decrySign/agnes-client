import fs from "node:fs";
import path from "node:path";
import { assertSafeWorkspaceRoot, DEFAULT_COMMAND_ALLOW, parseToolTimeouts, type ApprovalMode } from "@agnes/agent";
import { DEFAULT_BASE_URL, DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from "@agnes/sdk";
import type { DatabaseSync } from "node:sqlite";
import { parseAllowedIps, parseTrustedProxies, type IpPolicy } from "./security.js";
import { relayEndpoints } from "./relay.js";
import { resolveUpdateDir } from "./updates.js";
import { getKv } from "./db.js";

// Desktop keeps its portable state in the SQLite `kv` table so copying
// agnes.sqlite migrates chats + personas + media + workspace path together.
// The API key stays machine-bound (safeStorage) and device_hash stays machine
// bound on purpose — moving to a new machine re-enters the key and re-activates.
export const DESKTOP_WORKSPACE_KV = "desktop.workspaceRoot";

export type AppConfig = {
  apiKey: string;
  baseUrl: string;
  workspaceRoot: string;
  dataDir: string;
  mediaDir: string;
  port: number;
  host: string;
  authToken: string;
  chatModel: string;
  imageModel: string;
  videoModel: string;
  autoApply: boolean;
  /** Codex 式审批策略，桌面端可在顶栏切；autoApply 由它推导 */
  approvalMode: ApprovalMode;
  /** 桌面命令允许规则。危险命令不在这里，始终要问 */
  commandAllow: string;
  /** 每种工具单独的超时（毫秒），桌面端设置里改；空 = 全部用内置默认 */
  toolTimeouts?: Record<string, number>;
  desktopMode: boolean;
  webDist: string | null;
  adminDist: string | null;
  adminUser: string;
  adminPassword: string;
  adminHost: string;
  webHost: string;
  apiHost: string;
  publicApiOrigin: string;
  isProduction: boolean;
  allowTerminal: boolean;
  allowWrites: boolean;
  corsOrigin: string;
  maxUploadBytes: number;
  trustProxy: boolean;
  allowedIps: IpPolicy;
  trustedProxies: IpPolicy;
  licenseServerUrl: string;
  /** HMAC key for desktop relay tokens. Empty = relay disabled on this instance. */
  relaySecret: string;
  /** Desktop only: model calls go through the license server instead of a local key. */
  relayManaged: boolean;
  desktopDownloadUrl: string;
  updateDir: string;
  ip2regionDb: string;
  logAllRequests: boolean;
  webQuota: WebIpQuota;
  /** 公测月卡只给登录的云端账号领（默认关；开了以后一个账号只能领一次） */
  betaRequireLogin: boolean;
  /** 继续接受旧版（不过期）中转令牌。老客户端拿到新令牌前要靠它，默认开 */
  relayAcceptLegacyTokens: boolean;
};

export type WebIpQuota = {
  hourApi: number;
  fiveHourApi: number;
  hourTrial: number;
  fiveHourTrial: number;
  hourChat: number;
  fiveHourChat: number;
  hourImage: number;
  fiveHourImage: number;
  hourVideo: number;
  fiveHourVideo: number;
  hourAuth: number;
  fiveHourAuth: number;
  hourLead: number;
  fiveHourLead: number;
  hourActivate: number;
  fiveHourActivate: number;
  dailyChat: number;
  dailyImage: number;
  videoLimit: number;
  videoDays: number;
  /** 同一网络（IPv4 单个地址 / IPv6 /64）24 小时内最多新开几台桌面试用，0 = 不限 */
  trialNewPerIpDay: number;
};

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function parsePublicHttpUrl(raw: string, isProduction: boolean, name: string): string {
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} 不是合法地址`);
  }
  if (parsed.username || parsed.password) throw new Error(`${name} 不能带账号口令`);
  if (isProduction && parsed.protocol !== "https:") {
    throw new Error(`生产环境 ${name} 必须是 HTTPS`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${name} 只支持 http/https`);
  return parsed.origin + parsed.pathname.replace(/\/$/, "") + parsed.search;
}

function parseLicenseServerUrl(raw: string, isProduction: boolean): string {
  return parsePublicHttpUrl(raw, isProduction, "LICENSE_SERVER_URL");
}

function uniq(items: string[]): string[] {
  return [...new Set(items)];
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function loadWebQuota(): WebIpQuota {
  return {
    hourApi: intEnv("WEB_IP_HOUR_API", 1200),
    fiveHourApi: intEnv("WEB_IP_FIVE_HOUR_API", 3000),
    hourTrial: intEnv("WEB_IP_HOUR_TRIAL", 8),
    fiveHourTrial: intEnv("WEB_IP_FIVE_HOUR_TRIAL", 16),
    hourChat: intEnv("WEB_IP_HOUR_CHAT", 60),
    fiveHourChat: intEnv("WEB_IP_FIVE_HOUR_CHAT", 120),
    hourImage: intEnv("WEB_IP_HOUR_IMAGE", 20),
    fiveHourImage: intEnv("WEB_IP_FIVE_HOUR_IMAGE", 40),
    hourVideo: intEnv("WEB_IP_HOUR_VIDEO", 10),
    fiveHourVideo: intEnv("WEB_IP_FIVE_HOUR_VIDEO", 20),
    hourAuth: intEnv("WEB_IP_HOUR_AUTH", 20),
    fiveHourAuth: intEnv("WEB_IP_FIVE_HOUR_AUTH", 40),
    hourLead: intEnv("WEB_IP_HOUR_LEAD", 3),
    fiveHourLead: intEnv("WEB_IP_FIVE_HOUR_LEAD", 5),
    hourActivate: intEnv("WEB_IP_HOUR_ACTIVATE", 8),
    fiveHourActivate: intEnv("WEB_IP_FIVE_HOUR_ACTIVATE", 16),
    dailyChat: intEnv("WEB_DAILY_CHAT", 30),
    // 免费档：图 10 张/天、视频 1 条/天
    dailyImage: intEnv("WEB_DAILY_IMAGE", 10),
    videoLimit: intEnv("WEB_VIDEO_LIMIT", 1),
    videoDays: intEnv("WEB_VIDEO_DAYS", 1),
    trialNewPerIpDay: intEnv("TRIAL_NEW_PER_IP_DAY", 3),
  };
}

export function loadConfig(repoRoot = process.cwd()): AppConfig {
  const dataDir = path.resolve(repoRoot, process.env.DATA_DIR || path.join(repoRoot, "data"));
  const workspaceRoot = path.resolve(repoRoot, process.env.WORKSPACE_ROOT || path.join(dataDir, "workspace"));
  const mediaDir = path.join(dataDir, "media");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  assertSafeWorkspaceRoot(workspaceRoot);
  const webDistEnv = process.env.WEB_DIST;
  const adminDistEnv = process.env.ADMIN_DIST;
  const isProduction = process.env.NODE_ENV === "production";
  const desktopMode = bool(process.env.DESKTOP_MODE, false);
  const authToken = process.env.APP_AUTH_TOKEN?.trim() || "";
  const apiKey = process.env.AGNES_API_KEY?.trim() || "";
  if (isProduction && !desktopMode && !apiKey) {
    throw new Error("生产环境必须设置 AGNES_API_KEY");
  }
  const licenseServerUrl = ""; // OSS demo: always local authority (BYOK). Commercial relay is not shipped.
  // Falls back to the API key so an existing deploy gets a working relay with no new env.
  // Rotating AGNES_API_KEY just invalidates issued tokens; clients re-fetch on next status call.
  const relaySecret = desktopMode ? "" : process.env.RELAY_SECRET?.trim() || apiKey;
  // Desktop with a remote authority and no local key of its own: relay everything.
  const relayManaged = desktopMode && Boolean(licenseServerUrl);
  const desktopDownloadUrl = parsePublicHttpUrl(process.env.DESKTOP_DOWNLOAD_URL?.trim() || "", isProduction, "DESKTOP_DOWNLOAD_URL");
  const webHost = hostnameOf(process.env.WEB_HOST);
  const apiHost = hostnameOf(process.env.API_HOST);
  const adminHost = hostnameOf(process.env.ADMIN_HOST);
  const publicApiOrigin = parsePublicHttpUrl(process.env.PUBLIC_API_ORIGIN?.trim() || "", isProduction, "PUBLIC_API_ORIGIN")
    || (apiHost ? `https://${apiHost}` : "");
  const corsOrigin = process.env.CORS_ORIGIN?.trim() || (webHost ? `https://${webHost}` : "");
  const relay = relayManaged ? relayEndpoints(licenseServerUrl) : null;
  return {
    apiKey,
    baseUrl: process.env.AGNES_BASE_URL?.trim() || relay?.baseUrl || DEFAULT_BASE_URL,
    workspaceRoot,
    dataDir,
    mediaDir,
    port: Number(process.env.PORT || 8787),
    host: desktopMode ? "127.0.0.1" : process.env.HOST || "0.0.0.0",
    authToken,
    chatModel: process.env.AGNES_CHAT_MODEL || DEFAULT_CHAT_MODEL,
    imageModel: process.env.AGNES_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
    videoModel: process.env.AGNES_VIDEO_MODEL || DEFAULT_VIDEO_MODEL,
    autoApply: desktopMode ? bool(process.env.AUTO_APPLY, false) : false,
    approvalMode: approvalFromLegacy(desktopMode ? bool(process.env.AUTO_APPLY, false) : false),
    commandAllow: DEFAULT_COMMAND_ALLOW,
    toolTimeouts: {},
    desktopMode,
    webDist: webDistEnv ? path.resolve(webDistEnv) : null,
    adminDist: adminDistEnv ? path.resolve(adminDistEnv) : null,
    adminUser: process.env.ADMIN_USER?.trim() || "",
    adminPassword: process.env.ADMIN_PASSWORD ?? "",
    adminHost,
    webHost,
    apiHost,
    publicApiOrigin,
    isProduction,
    allowTerminal: desktopMode,
    allowWrites: desktopMode && bool(process.env.ALLOW_WRITES, true),
    corsOrigin,
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024),
    trustProxy: bool(process.env.TRUST_PROXY, false),
    allowedIps: parseAllowedIps(process.env.ALLOWED_IPS || "", { desktopMode }),
    trustedProxies: parseTrustedProxies(process.env.TRUSTED_PROXIES || "", desktopMode),
    licenseServerUrl,
    relaySecret,
    relayManaged,
    desktopDownloadUrl,
    updateDir: resolveUpdateDir(process.env.UPDATE_DIR || "", dataDir),
    ip2regionDb: process.env.IP2REGION_DB
      ? path.resolve(repoRoot, process.env.IP2REGION_DB)
      : path.join(dataDir, "ip2region.xdb"),
    logAllRequests: bool(process.env.REQUEST_LOG_ALL, false),
    webQuota: loadWebQuota(),
    betaRequireLogin: bool(process.env.BETA_REQUIRE_LOGIN, false),
    relayAcceptLegacyTokens: bool(process.env.RELAY_ACCEPT_LEGACY_TOKENS, true),
  };
}

export function hostnameOf(header: string | undefined): string {
  return (header || "").split(",")[0].trim().split(":")[0].toLowerCase();
}

export function isAdminHost(hostHeader: string | undefined, cfg: Pick<AppConfig, "adminHost" | "desktopMode">): boolean {
  if (cfg.desktopMode || !cfg.adminHost) return false;
  return hostnameOf(hostHeader) === cfg.adminHost;
}

export function isApiHost(hostHeader: string | undefined, cfg: Pick<AppConfig, "apiHost" | "desktopMode">): boolean {
  if (cfg.desktopMode || !cfg.apiHost) return false;
  return hostnameOf(hostHeader) === cfg.apiHost;
}

export function isWebHost(hostHeader: string | undefined, cfg: Pick<AppConfig, "webHost" | "desktopMode">): boolean {
  if (cfg.desktopMode || !cfg.webHost) return false;
  return hostnameOf(hostHeader) === cfg.webHost;
}

export function isKnownHost(hostHeader: string | undefined, cfg: Pick<AppConfig, "webHost" | "apiHost" | "adminHost" | "desktopMode">): boolean {
  if (cfg.desktopMode || (!cfg.webHost && !cfg.apiHost)) return true;
  const host = hostnameOf(hostHeader);
  if (!host || host === "localhost" || host === "127.0.0.1") return true;
  return host === cfg.webHost || host === cfg.apiHost || host === cfg.adminHost;
}

export const DESKTOP_APPROVAL_KV = "desktop.approvalMode";
export const DESKTOP_COMMAND_ALLOW_KV = "desktop.commandAllow";
export const DESKTOP_TOOL_TIMEOUTS_KV = "desktop.toolTimeouts";
/** 桌面端在设置里选的默认对话模型；以前只存在内存里，重启就回到默认 */
export const DESKTOP_CHAT_MODEL_KV = "desktop.chatModel";

export function parseApprovalMode(raw: unknown, fallback: ApprovalMode): ApprovalMode {
  const v = String(raw ?? "").trim();
  return v === "suggest" || v === "auto-edit" || v === "full-auto" ? v : fallback;
}

/** 旧的 AUTO_APPLY 二元开关映射到 Codex 三档：true = full-auto，false = suggest */
export function approvalFromLegacy(autoApply: boolean): ApprovalMode {
  return autoApply ? "full-auto" : "suggest";
}

export function applyDesktopWorkspace(db: DatabaseSync, cfg: AppConfig): void {
  if (!cfg.desktopMode) return;
  const savedMode = getKv(db, DESKTOP_APPROVAL_KV);
  if (savedMode) {
    cfg.approvalMode = parseApprovalMode(savedMode, cfg.approvalMode);
    cfg.autoApply = cfg.approvalMode !== "suggest";
  }
  const savedAllow = (getKv(db, DESKTOP_COMMAND_ALLOW_KV) || "").trim();
  if (savedAllow) cfg.commandAllow = savedAllow;
  const savedTimeouts = (getKv(db, DESKTOP_TOOL_TIMEOUTS_KV) || "").trim();
  if (savedTimeouts) {
    try {
      cfg.toolTimeouts = parseToolTimeouts(JSON.parse(savedTimeouts));
    } catch {
      /* 库里的值坏了或旧版本不认识：当作没设，全部用内置默认 */
    }
  }
  // 自定义模型是否还在由 createApp 校验（那时 provider 密钥才解得开）
  const savedModel = (getKv(db, DESKTOP_CHAT_MODEL_KV) || "").trim();
  if (savedModel) cfg.chatModel = savedModel.slice(0, 200);
  const saved = (getKv(db, DESKTOP_WORKSPACE_KV) || "").trim();
  if (!saved) return;
  try {
    const resolved = path.resolve(saved);
    assertSafeWorkspaceRoot(resolved);
    fs.mkdirSync(resolved, { recursive: true });
    cfg.workspaceRoot = resolved;
  } catch {
    /* stored path is unsafe/unavailable on this machine: keep the env default */
  }
}

export function publicSettings(cfg: AppConfig) {
  return {
    hasApiKey: cfg.desktopMode ? Boolean(cfg.apiKey) : undefined,
    // Relay-managed desktops never ask the user for a key, so the UI hides that field.
    relayManaged: cfg.desktopMode ? cfg.relayManaged : undefined,
    baseUrl: cfg.baseUrl,
    workspaceRoot: cfg.desktopMode ? cfg.workspaceRoot : undefined,
    desktopMode: cfg.desktopMode,
    chatModel: cfg.chatModel,
    imageModel: cfg.imageModel,
    videoModel: cfg.videoModel,
    autoApply: cfg.autoApply,
    approvalMode: cfg.desktopMode ? cfg.approvalMode : undefined,
    commandAllow: cfg.desktopMode ? cfg.commandAllow : undefined,
    toolTimeouts: cfg.desktopMode ? (cfg.toolTimeouts ?? {}) : undefined,
    authRequired: Boolean(cfg.authToken),
    storage: cfg.desktopMode ? "local" : "server",
    dataDir: cfg.desktopMode ? cfg.dataDir : undefined,
    licenseRemote: Boolean(cfg.licenseServerUrl),
    desktopDownloadUrl:
      cfg.desktopDownloadUrl ||
      (cfg.publicApiOrigin ? `${cfg.publicApiOrigin}/api/updates/desktop` : "/api/updates/desktop"),
    allowTerminal: cfg.allowTerminal,
    allowWrites: cfg.allowWrites,
    models: {
      chat: uniq([cfg.chatModel, "agnes-3.0-flash", "agnes-2.5-flash", "agnes-2.5-pro"]),
      image: uniq([cfg.imageModel, "agnes-image-2.5-flash", "agnes-image-2.1-flash"]),
      video: uniq([cfg.videoModel, "agnes-video-2.5-flash", "agnes-video-2.5"]),
    },
  };
}
