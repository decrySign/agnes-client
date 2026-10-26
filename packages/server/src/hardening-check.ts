import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentSystem,
  assertContentPolicyFixtures,
  createIntroStripper,
  expandMentions,
  extractMentions,
  listSkills,
  parseComposerCommand,
  parseFrontmatter,
  projectContext,
  readSkill,
  selectTools,
  skillsPromptSection,
  toolResultFailed,
  Workspace,
} from "@agnes/agent";
import { AgnesApiError, isTransientNetworkError, upstreamErrorLog } from "@agnes/sdk";
import { createApp, parseAttachments } from "./app.js";
import { applyDesktopWorkspace, DESKTOP_WORKSPACE_KV, loadConfig, publicSettings } from "./config.js";
import {
  chatTicketFor,
  issueChatTicket,
  readBodyLimited,
  RELAY_MAX_INFLIGHT,
  relayEndpoints,
  legacyRelayTokenFor,
  relayTokenFor,
  releaseRelay,
  resetRelayInflight,
  tryAcquireRelay,
  verifyChatTicket,
  verifyRelayToken,
} from "./relay.js";
import { openDb, setKv } from "./db.js";
import {
  assertProviderUrl,
  customModelId,
  findProvider,
  listPublicProviders,
  loadProviders,
  parseCustomModel,
  PROVIDERS_KV,
  sameProviderOrigin,
  upsertProvider,
} from "./providers.js";
import { registerUser } from "./users.js";
import { assertSafeHttpsUrl, mediaIdFromRef } from "./media.js";
import { hitIpQuota, ipMatchesRule, parseAllowedIps, parseTrustedProxies, pickClientIp, publicError, safeUploadName, tokensMatch } from "./security.js";
import { inspectQuota, refundQuota, shanghaiDay, shanghaiDaysBack, shouldLogRequest, takeQuota } from "./usage.js";
import { ipSource } from "./geoip.js";
import { parseUserAgent } from "./useragent.js";
import { listPlans, upsertPlan } from "./catalog.js";
import {
  activateLicense,
  attachDeviceLicense,
  getEntitlementByUser,
  betaOffer,
  chatTicketRefunded,
  claimBetaMonth,
  consumeChat,
  createQuotaTicket,
  ipBlock,
  markChatTicketUsed,
  markTrialIp,
  QUOTA_TICKET_REFUND_MS,
  recentTrialsFromBlock,
  refundQuotaTicket,
  relayNotBefore,
  resetRelayToken,
  consumeMedia,
  DAY_MS,
  deleteLicenses,
  getEntitlement,
  getLicense,
  issueLicenses,
  listLicenses,
  publicEntitlement,
  refundMedia,
  requireFeature,
  revokeLicense,
  startTrial,
} from "./entitlements.js";

function fail(message: string): never {
  throw new Error(message);
}

function cookieNamed(res: Response, name: string): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const part = raw
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.toLowerCase().startsWith(`${name.toLowerCase()}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

async function expectReject(label: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  fail(`expected reject: ${label}`);
}

async function main(): Promise<void> {
  assertContentPolicyFixtures();
  const canned = createIntroStripper(false);
  const cannedOut =
    canned.push("你好！我是由 Sapiens AI 开发的 Agnes。") + canned.push("今天开会改到三点。") + canned.flush();
  if (cannedOut !== "今天开会改到三点。") fail("strip sapiens intro");
  const follow = createIntroStripper(true);
  const followOut = follow.push("你好\n\n") + follow.push("用 HTTPS。") + follow.flush();
  if (followOut !== "用 HTTPS。") fail("strip follow-up hello");
  const keep = createIntroStripper(false);
  const keepOut = keep.push("你好，会议改到三点。") + keep.flush();
  if (keepOut !== "你好，会议改到三点。") fail("keep real hello sentence");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agnes-harden-"));
  fs.writeFileSync(path.join(tmp, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(tmp, "ok.txt"), "hello\n");

  const ws = new Workspace(tmp);
  await expectReject("os root", () => new Workspace(path.parse(process.cwd()).root));
  await expectReject("parent path", () => ws.resolve(".."));
  await expectReject("null byte", () => ws.resolve("ok.txt\0x"));
  await expectReject("unc path", () => ws.resolve("\\\\localhost\\c$\\windows"));
  await expectReject("secret read", () => ws.readFile(".env"));
  await expectReject("secret write", () => ws.writeFile(".env", "x"));
  await expectReject("git write", () => ws.writeFile(".git/hooks/pre-commit", "x"));
  await expectReject("sqlite write", () => ws.writeFile("agnes.sqlite", "x"));
  await expectReject("glob escape", () => ws.glob("../**/*"));
  const text = await ws.readFile("ok.txt");
  if (text.trim() !== "hello") fail("workspace read");

  const noTerm = selectTools("agent", { allowTerminal: false, allowWrites: true });
  if (noTerm.some((t) => t.function.name === "run_terminal")) fail("terminal tool should be omitted");
  const noWrite = selectTools("agent", { allowTerminal: false, allowWrites: false });
  if (noWrite.some((t) => t.function.name === "write_file" || t.function.name === "apply_patch")) {
    fail("write tools should be omitted");
  }

  if (tokensMatch("a", "ab") || tokensMatch("", "x") || !tokensMatch("abc", "abc")) fail("token compare");
  await expectReject("upload parent name", () => safeUploadName(".."));
  if (safeUploadName("dir/keep.txt") !== "keep.txt") fail("upload basename");

  await expectReject("http media", () => assertSafeHttpsUrl("http://example.com/a.png"));
  await expectReject("loopback media", () => assertSafeHttpsUrl("https://127.0.0.1/a.png"));
  await expectReject("private media", () => assertSafeHttpsUrl("https://192.168.1.1/a.png"));
  await expectReject("localhost media", () => assertSafeHttpsUrl("https://localhost/a.png"));

  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    APP_AUTH_TOKEN: process.env.APP_AUTH_TOKEN,
    ALLOW_TERMINAL: process.env.ALLOW_TERMINAL,
    AUTO_APPLY: process.env.AUTO_APPLY,
    DATA_DIR: process.env.DATA_DIR,
    WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
    DESKTOP_MODE: process.env.DESKTOP_MODE,
    LICENSE_SERVER_URL: process.env.LICENSE_SERVER_URL,
    ALLOWED_IPS: process.env.ALLOWED_IPS,
    TRUST_PROXY: process.env.TRUST_PROXY,
    TRUSTED_PROXIES: process.env.TRUSTED_PROXIES,
    ADMIN_USER: process.env.ADMIN_USER,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_HOST: process.env.ADMIN_HOST,
    AGNES_API_KEY: process.env.AGNES_API_KEY,
    AGNES_BASE_URL: process.env.AGNES_BASE_URL,
    RELAY_SECRET: process.env.RELAY_SECRET,
    WEB_DAILY_CHAT: process.env.WEB_DAILY_CHAT,
    WEB_DAILY_IMAGE: process.env.WEB_DAILY_IMAGE,
    WEB_VIDEO_LIMIT: process.env.WEB_VIDEO_LIMIT,
    WEB_VIDEO_DAYS: process.env.WEB_VIDEO_DAYS,
    WEB_IP_HOUR_TRIAL: process.env.WEB_IP_HOUR_TRIAL,
    WEB_IP_FIVE_HOUR_TRIAL: process.env.WEB_IP_FIVE_HOUR_TRIAL,
    UPDATE_DIR: process.env.UPDATE_DIR,
    WEB_HOST: process.env.WEB_HOST,
    API_HOST: process.env.API_HOST,
  };

  process.env.NODE_ENV = "production";
  process.env.APP_AUTH_TOKEN = "";
  process.env.AGNES_API_KEY = "";
  process.env.DATA_DIR = path.join(tmp, "data");
  process.env.WORKSPACE_ROOT = path.join(tmp, "ws");
  await expectReject("prod api key required", () => loadConfig(tmp));

  process.env.AGNES_API_KEY = "test-agnes-key";
  process.env.APP_AUTH_TOKEN = "test-auth-token-value";
  process.env.ALLOW_TERMINAL = "true";
  process.env.AUTO_APPLY = "true";
  process.env.DESKTOP_MODE = "1";
  process.env.HOST = "0.0.0.0";
  const deskCfg = loadConfig(tmp);
  if (deskCfg.host !== "127.0.0.1") fail("desktop must bind loopback");
  if (publicSettings(deskCfg).storage !== "local") fail("desktop storage should be local");

  // 桌面端有授权服务器时，模型调用改走中转，本机不需要也不该持有签名密钥
  process.env.AGNES_BASE_URL = "";
  process.env.LICENSE_SERVER_URL = "https://relay.test";
  const relayDesk = loadConfig(tmp);
  if (!relayDesk.relayManaged) fail("桌面端有授权服务器时应走中转");
  if (relayDesk.baseUrl !== "https://relay.test/api/relay") fail("桌面端 baseUrl 应指向中转");
  if (relayDesk.relaySecret) fail("桌面端不该持有中转签名密钥");
  if (publicSettings(relayDesk).relayManaged !== true) fail("前端应知道密钥由服务端托管");
  const relayUrls = relayEndpoints("https://relay.test/");
  if (relayUrls?.videoPollUrl !== "https://relay.test/api/relay/videos/poll") fail("视频轮询也要指向中转");
  if (relayEndpoints("")) fail("没有授权服务器就没有中转地址");

  process.env.DESKTOP_MODE = "";
  process.env.LICENSE_SERVER_URL = "";
  process.env.ALLOWED_IPS = "";
  process.env.TRUST_PROXY = "";
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASSWORD = "test-admin-pass";
  process.env.ADMIN_HOST = "admin.test";
  const cfg = loadConfig(tmp);
  if (!cfg.isProduction) fail("production flag");
  if (cfg.allowTerminal) fail("web terminal cannot be enabled");
  if (cfg.autoApply) fail("web autoApply should stay off");
  if (!cfg.allowedIps.allowAll) fail("public web must allow any visitor IP by default");

  const db = openDb(cfg.dataDir);
  const app = createApp(cfg, db);
  const health = await app.request("/api/health");
  if (health.status !== 200) fail("health");
  const denied = await app.request("/api/settings");
  if (denied.status !== 401) fail("unauth settings");
  const badLogin = await app.request("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "nope" }),
  });
  if (badLogin.status !== 401) fail("bad login");
  const okLogin = await app.request("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "test-auth-token-value" }),
  });
  if (okLogin.status !== 200) fail("login");
  const sessionOpen = await app.request("/api/session");
  if (sessionOpen.status !== 200) fail("session open");
  const sessionUnauthed = (await sessionOpen.json()) as { appAuthed: boolean };
  if (sessionUnauthed.appAuthed) fail("session should not be app-authed without token");

  const settingsNeedAccount = await app.request("/api/settings", {
    headers: { authorization: "Bearer test-auth-token-value" },
  });
  if (settingsNeedAccount.status !== 401) fail("settings need account");

  const deviceA = "a".repeat(64);
  const trialNoDevice = await app.request("/api/entitlements/trial", { method: "POST" });
  if (trialNoDevice.status !== 400) fail("trial needs device hash");

  const trialA = await app.request("/api/entitlements/trial", {
    method: "POST",
    headers: { "x-agnes-device": deviceA },
  });
  if (trialA.status !== 200) fail("start trial");
  const webTrialBody = (await trialA.json()) as { entitlement?: { chatQuota?: number } };
  if (webTrialBody.entitlement?.chatQuota !== 0) fail("网页试用额度应为 0，按天封顶");
  const desktopTrialDevice = "c".repeat(64);
  const desktopTrial = await app.request("/api/entitlements/trial", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agnes-device": desktopTrialDevice },
    body: "{}",
  });
  if (desktopTrial.status !== 200) fail("desktop device trial");
  const repaired = await app.request("/api/entitlements/status", {
    headers: { "x-agnes-device": desktopTrialDevice, "x-agnes-client": "desktop" },
  });
  const repairedBody = (await repaired.json()) as { entitlement?: { plan?: string; chatQuota?: number } };
  if (repairedBody.entitlement?.plan !== "trial" || repairedBody.entitlement.chatQuota !== 30) {
    fail(`桌面端来查状态应把 0 次试用补成 30，实际 ${repairedBody.entitlement?.chatQuota}`);
  }
  const betaDevice = "f".repeat(64);
  const betaSession = await app.request("/api/session", { headers: { "x-agnes-device": betaDevice } });
  const betaSeen = (await betaSession.json()) as { beta?: { open?: boolean; eligible?: boolean } };
  if (!betaSeen.beta?.open || !betaSeen.beta?.eligible) fail("新设备应能领取公测月卡");
  const betaBrowser = await app.request("/api/entitlements/beta-month", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agnes-device": betaDevice, origin: "https://example.com" },
    body: "{}",
  });
  if (betaBrowser.status !== 403) fail("网页不能领公测月卡");
  const betaClaimed = await app.request("/api/entitlements/beta-month", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agnes-device": betaDevice,
      "x-agnes-client": "desktop",
      "sec-fetch-mode": "cors",
    },
    body: "{}",
  });
  if (betaClaimed.status !== 200) fail(`claim beta month: ${await betaClaimed.text()}`);
  const betaBody = (await betaClaimed.json()) as { entitlement?: { plan?: string; chatQuota?: number }; notice?: string; beta?: { claimed?: boolean; eligible?: boolean } };
  if (betaBody.entitlement?.plan !== "licensed" || betaBody.entitlement.chatQuota !== 1000) fail("公测领取应立即开通基础版月卡");
  if (!betaBody.notice?.includes("反馈")) fail("领取结果应说明采纳反馈会加时");
  if (!betaBody.beta?.claimed || betaBody.beta.eligible) fail("领过之后不能再领");
  const betaAgain = await app.request("/api/entitlements/beta-month", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agnes-device": betaDevice },
    body: "{}",
  });
  if (betaAgain.status !== 409) fail("同一设备重复领取应拒绝");
  const aliceSid = cookieNamed(trialA, "agnes_sid");
  if (!aliceSid) fail("trial session cookie");
  const authHeaders = {
    authorization: "Bearer test-auth-token-value",
    cookie: `agnes_sid=${aliceSid}`,
    "x-agnes-device": deviceA,
    "Content-Type": "application/json",
  };
  const agentDenied = await app.request("/api/conversations", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ mode: "agent" }),
  });
  if (agentDenied.status !== 403) fail("web must not start agent even on trial");
  const trialSession = await app.request("/api/session", {
    headers: { cookie: `agnes_sid=${aliceSid}`, "x-agnes-device": deviceA },
  });
  if (trialSession.status !== 200) fail("trial session");
  const trialBody = (await trialSession.json()) as {
    entitlement?: { allowImage?: boolean; allowVideo?: boolean; allowAgent?: boolean };
    dailyImage?: { limit: number };
    videoQuota?: { limit: number; windowDays: number };
  };
  // 免费档网页可以出图出视频；Agent 标记关掉，接口也会拒绝
  if (!trialBody.entitlement?.allowImage || !trialBody.entitlement?.allowVideo) fail("免费档应能体验出图/出视频");
  if (trialBody.entitlement.allowAgent) fail("网页会话不应打开 Agent");
  if (trialBody.dailyImage?.limit !== 10) fail("免费档每日出图应为 10 张");
  if (trialBody.videoQuota?.limit !== 1 || trialBody.videoQuota.windowDays !== 1) fail("免费档视频应为每天 1 条");

  const consumeOnce = await app.request("/api/entitlements/consume", {
    method: "POST",
    headers: { "x-agnes-device": deviceA },
  });
  if (consumeOnce.status !== 200) fail("web trial consume");
  const publicLead = await app.request("/api/entitlements/lead", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agnes-device": deviceA },
    body: JSON.stringify({ wechat: "wx_test_user" }),
  });
  if (publicLead.status !== 404) fail("public lead must be admin-only");
  const publicIssue = await app.request("/api/licenses", {
    method: "POST",
    headers: { authorization: "Bearer test-auth-token-value", "Content-Type": "application/json" },
    body: JSON.stringify({ count: 1 }),
  });
  if (publicIssue.status !== 404) fail("public issue must be admin-only");

  const publicAdmin = await app.request("/admin/api/overview");
  if (publicAdmin.status !== 404) fail("public /admin must 404");
  const adminDenied = await app.request("/api/me", { headers: { host: "admin.test" } });
  if (adminDenied.status !== 401) fail("admin overview needs login");
  const adminLogin = await app.request("/api/login", {
    method: "POST",
    headers: { host: "admin.test", "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-admin-pass" }),
  });
  if (adminLogin.status !== 200) fail("admin login");
  const adminCookie = cookieNamed(adminLogin, "agnes_admin");
  if (!adminCookie) fail("admin cookie");
  const adminHeaders = { host: "admin.test", cookie: `agnes_admin=${adminCookie}`, "Content-Type": "application/json" };
  const logsPage = await app.request("/api/logs?pageSize=10", { headers: adminHeaders });
  if (logsPage.status !== 200) fail("admin request logs");
  const bonus = await app.request("/api/devices", { headers: adminHeaders });
  if (bonus.status !== 200) fail("admin devices");
  const devices = (await bonus.json()) as Array<{ id: string; deviceHash: string }>;
  const aliceDevice = devices.find((d) => d.deviceHash === deviceA);
  if (!aliceDevice) fail("admin should see trial device");
  const leadOk = await app.request(`/api/devices/${aliceDevice.id}/lead`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ wechat: "wx_test_user", applyBonus: true }),
  });
  if (leadOk.status !== 200) fail("admin lead bonus");
  const issued = await app.request("/api/keys", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ count: 1, planId: "basic_1m" }),
  });
  if (issued.status !== 200) fail("admin issue license");
  const keys = (await issued.json()) as { keys: Array<{ code: string }> };
  const registered = await app.request("/api/users/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agnes-device": deviceA },
    body: JSON.stringify({ username: "alice", password: "password1" }),
  });
  if (registered.status !== 200) fail(`register: ${await registered.text()}`);
  const userCookie = cookieNamed(registered, "agnes_user");
  if (!userCookie) fail("register cookie");
  const registeredCustomer = db.prepare("SELECT user_id FROM customers WHERE name = ?").get("alice") as { user_id?: string } | undefined;
  if (!registeredCustomer?.user_id) fail("register should show up in customers");
  const needLogin = await app.request("/api/entitlements/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agnes-device": deviceA },
    body: JSON.stringify({ code: keys.keys[0]?.code }),
  });
  if (needLogin.status !== 401) fail("activate without login should 401");
  const activated = await app.request("/api/entitlements/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agnes-device": deviceA,
      cookie: `agnes_user=${userCookie}`,
    },
    body: JSON.stringify({ code: keys.keys[0]?.code }),
  });
  if (activated.status !== 200) fail(`activate license: ${await activated.text()}`);
  const otherDevice = await app.request("/api/entitlements/status", {
    headers: { "x-agnes-device": "ab".repeat(32), cookie: `agnes_user=${userCookie}` },
  });
  const otherBody = (await otherDevice.json()) as { entitlement?: { plan?: string } };
  if (otherBody.entitlement?.plan !== "licensed") fail("license should follow the account");
  const browserView = await app.request("/api/entitlements/status", {
    headers: {
      "x-agnes-device": deviceA,
      cookie: `agnes_user=${userCookie}`,
      origin: "https://example.com",
      "x-agnes-client": "web",
    },
  });
  const browserEnt = (await browserView.json()) as { entitlement?: { allowAgent?: boolean } };
  if (browserEnt.entitlement?.allowAgent !== false) fail("web license must not enable agent");
  const licensedAgent = await app.request("/api/conversations", {
    method: "POST",
    headers: {
      authorization: "Bearer test-auth-token-value",
      cookie: `agnes_sid=${cookieNamed(activated, "agnes_sid") || aliceSid}`,
      "x-agnes-device": deviceA,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mode: "agent" }),
  });
  if (licensedAgent.status !== 403) fail("web must not start agent");

  const PIXEL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const fbAuth = {
    authorization: "Bearer test-auth-token-value",
    cookie: `agnes_sid=${aliceSid}`,
    "x-agnes-device": deviceA,
    "Content-Type": "application/json",
  };
  const fbRes = await app.request("/api/feedbacks", {
    method: "POST",
    headers: fbAuth,
    body: JSON.stringify({
      title: "想要暗色主题",
      body: "希望桌面端能一键切暗色，并附上设置页截图。",
      kind: "ux",
      images: [PIXEL],
      contact: "wx_fb",
    }),
  });
  if (fbRes.status !== 200) fail(`submit feedback: ${await fbRes.text()}`);
  const submitted = (await fbRes.json()) as { id: string; images: Array<{ url: string }>; status: string; kind: string };
  if (submitted.status !== "open" || submitted.kind !== "ux" || !submitted.images[0]?.url) fail("feedback should store screenshot and kind");
  if (!/^FB-\d+$/.test((submitted as { ticketNo?: string }).ticketNo || "")) fail("feedback should have a ticket number");
  const noKind = await app.request("/api/feedbacks", {
    method: "POST",
    headers: fbAuth,
    body: JSON.stringify({ body: "这段没有类型不能入库，请补上分类。" }),
  });
  if (noKind.status !== 400) fail("feedback without kind should 400");
  const badKind = await app.request("/api/feedbacks", {
    method: "POST",
    headers: fbAuth,
    body: JSON.stringify({ body: "这段类型不对也不能入库，请用四类之一。", kind: "nope" }),
  });
  if (badKind.status !== 400) fail("feedback with unknown kind should 400");
  const imgRes = await app.request(submitted.images[0].url, { headers: fbAuth });
  if (imgRes.status !== 200) fail("feedback image");
  if (!(imgRes.headers.get("content-type") || "").includes("image/png")) fail("feedback image content-type");
  const mine = await app.request("/api/feedbacks", { headers: fbAuth });
  const mineRows = (await mine.json()) as Array<{ id: string }>;
  if (!mineRows.some((row) => row.id === submitted.id)) fail("mine should include new feedback");
  const adminList = await app.request("/api/feedbacks?status=open&kind=ux", { headers: adminHeaders });
  if (adminList.status !== 200) fail("admin feedback list");
  const fbListed = (await adminList.json()) as { items: Array<{ id: string; kind?: string }>; open: number };
  if (!fbListed.items.some((row) => row.id === submitted.id && row.kind === "ux") || fbListed.open < 1) fail("admin should see open feedback kind");
  const licensedRow = db.prepare("SELECT device_hash, expires_at FROM entitlements WHERE plan='licensed' AND user_id IS NOT NULL").get() as {
    device_hash: string;
    expires_at: number;
  };
  const beforeExp = Number(licensedRow?.expires_at ?? 0);
  const adopted = await app.request(`/api/feedbacks/${submitted.id}/adopt`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ days: 5, note: "做暗色" }),
  });
  if (adopted.status !== 200) fail(`adopt: ${await adopted.text()}`);
  const adoptedBody = (await adopted.json()) as { status: string; rewardDays: number; rewardApplied: string };
  if (adoptedBody.status !== "adopted" || adoptedBody.rewardDays !== 5 || adoptedBody.rewardApplied !== "expires") {
    fail(`adopt result ${JSON.stringify(adoptedBody)}`);
  }
  if (Math.abs(Number(getEntitlement(db, licensedRow.device_hash)?.expires_at ?? 0) - (beforeExp + 5 * DAY_MS)) > 2000) {
    fail("adopt should extend license days");
  }
  const againAdopt = await app.request(`/api/feedbacks/${submitted.id}/adopt`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ days: 5 }),
  });
  if (againAdopt.status !== 400) fail("repeat adopt should 400");
  const deviceFb = "ab".repeat(32);
  const trialStart = await app.request("/api/entitlements/trial", { method: "POST", headers: { "x-agnes-device": deviceFb } });
  if (trialStart.status !== 200) fail("trial device for feedback");
  const trialFb = await app.request("/api/feedbacks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agnes-device": deviceFb,
      authorization: "Bearer test-auth-token-value",
    },
    body: JSON.stringify({ body: "试用用户也想提一个小建议关于导出聊天记录。", kind: "idea" }),
  });
  if (trialFb.status !== 200) fail(`trial feedback: ${await trialFb.text()}`);
  const trialRow = (await trialFb.json()) as { id: string };
  const pendingAdopt = await app.request(`/api/feedbacks/${trialRow.id}/adopt`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ days: 7 }),
  });
  if (pendingAdopt.status !== 200) fail(`trial adopt: ${await pendingAdopt.text()}`);
  const pendingBody = (await pendingAdopt.json()) as { rewardApplied: string };
  if (pendingBody.rewardApplied !== "pending") fail("trial adopt should pending bonus days");
  if (Number(getEntitlement(db, deviceFb)?.bonus_days) !== 7) fail("bonus_days should be 7");

  const webCreate = await app.request("/api/accounts", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "alice" }),
  });
  if (webCreate.status !== 404) fail("web must not expose local profiles");

  const authed = await app.request("/api/settings", {
    headers: { authorization: "Bearer test-auth-token-value", cookie: `agnes_sid=${aliceSid}`, "x-agnes-device": deviceA },
  });
  if (authed.status !== 200) fail("bearer settings");
  const publicCfg = (await authed.json()) as { workspaceRoot?: string; hasApiKey?: boolean; desktopDownloadUrl?: string };
  if (publicCfg.workspaceRoot || publicCfg.hasApiKey) fail("web settings must not expose workspace or api key");
  if (!publicCfg.desktopDownloadUrl?.endsWith("/api/updates/desktop")) {
    fail(`download url should point at the desktop zip: ${publicCfg.desktopDownloadUrl}`);
  }
  const personas = await app.request("/api/personas", {
    headers: { authorization: "Bearer test-auth-token-value", cookie: `agnes_sid=${aliceSid}`, "x-agnes-device": deviceA },
  });
  if (personas.status !== 200) fail("list personas");
  const made = await app.request("/api/personas", {
    method: "POST",
    headers: {
      authorization: "Bearer test-auth-token-value",
      cookie: `agnes_sid=${aliceSid}`,
      "x-agnes-device": deviceA,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "测试人设", body: "你是简洁的测试助手。" }),
  });
  if (made.status !== 200) fail("create persona");
  const secretConv = await app.request("/api/conversations", {
    method: "POST",
    headers: {
      authorization: "Bearer test-auth-token-value",
      cookie: `agnes_sid=${aliceSid}`,
      "x-agnes-device": deviceA,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "alice-secret" }),
  });
  if (secretConv.status !== 200) fail("alice conversation");
  const aliceConv = (await secretConv.json()) as { id: string };

  const deviceB = "b".repeat(64);
  const trialB = await app.request("/api/entitlements/trial", {
    method: "POST",
    headers: { "x-agnes-device": deviceB },
  });
  if (trialB.status !== 200) fail("start trial b");
  const bobSid = cookieNamed(trialB, "agnes_sid");
  const bobList = await app.request("/api/conversations", {
    headers: { authorization: "Bearer test-auth-token-value", cookie: `agnes_sid=${bobSid}`, "x-agnes-device": deviceB },
  });
  if (bobList.status !== 200) fail("bob list");
  const bobConvs = (await bobList.json()) as Array<{ title: string }>;
  if (bobConvs.some((row) => row.title === "alice-secret")) fail("device isolation leaked conversation");
  const bobPeek = await app.request(`/api/conversations/${aliceConv.id}`, {
    headers: { authorization: "Bearer test-auth-token-value", cookie: `agnes_sid=${bobSid}`, "x-agnes-device": deviceB },
  });
  if (bobPeek.status !== 404) fail("device isolation should 404");

  const tinyPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const uploaded = await app.request("/api/uploads/image", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ dataUrl: tinyPng, name: "dot.png" }),
  });
  if (uploaded.status !== 200) fail(`upload image: ${await uploaded.text()}`);
  const uploadedBody = (await uploaded.json()) as { id: string; url: string };
  if (!uploadedBody.id || !uploadedBody.url.includes(uploadedBody.id)) fail("upload 应返回 media id 和播放地址");
  const imgCookieOnly = await app.request(`/api/media/${uploadedBody.id}`, {
    headers: { authorization: "Bearer test-auth-token-value", cookie: `agnes_sid=${aliceSid}` },
  });
  if (imgCookieOnly.status !== 200) fail("缩略图请求只有 cookie、没有设备头也应能读");
  if (!(imgCookieOnly.headers.get("content-type") || "").startsWith("image/")) fail("媒体应返回图片");
  const imgAnon = await app.request(`/api/media/${uploadedBody.id}`, {
    headers: { authorization: "Bearer test-auth-token-value" },
  });
  if (imgAnon.status !== 401) fail("没有会话不能读上传图");
  const imgBob = await app.request(`/api/media/${uploadedBody.id}`, {
    headers: { authorization: "Bearer test-auth-token-value", cookie: `agnes_sid=${bobSid}`, "x-agnes-device": deviceB },
  });
  if (imgBob.status !== 404) fail("不能读别人的上传图");

  const autoBind = await app.request("/api/settings", {
    headers: { authorization: "Bearer test-auth-token-value", "x-agnes-device": deviceA },
  });
  if (autoBind.status !== 200) fail("web should bind workspace from device without picking a profile");

  // 网页部署的模型是全站共用的：访客 PUT /api/settings 不能改掉所有人的模型
  const modelsBefore = [cfg.chatModel, cfg.imageModel, cfg.videoModel].join("|");
  await app.request("/api/settings", {
    method: "PUT",
    headers: {
      authorization: "Bearer test-auth-token-value",
      cookie: `agnes_sid=${aliceSid}`,
      "x-agnes-device": deviceA,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ chatModel: "evil-chat", imageModel: "evil-image", videoModel: "evil-video" }),
  });
  if ([cfg.chatModel, cfg.imageModel, cfg.videoModel].join("|") !== modelsBefore) fail("网页访客不能改全站模型");

  const escaped = await app.request("/api/workspace/file?path=" + encodeURIComponent(".."), {
    headers: { authorization: "Bearer test-auth-token-value", cookie: `agnes_sid=${aliceSid}`, "x-agnes-device": deviceA },
  });
  if (escaped.status !== 404) fail("web workspace should be unavailable");

  if (!ipMatchesRule("10.1.2.3", "10.0.0.0/8") || ipMatchesRule("11.0.0.1", "10.0.0.0/8")) fail("ipv4 cidr");
  if (!ipMatchesRule("2001:db8::1", "2001:db8::/32")) fail("ipv6 cidr");
  const defaultTrust = { trustProxy: true, trustedProxies: parseTrustedProxies("", false) };
  if (pickClientIp("8.8.8.8", { realIp: "127.0.0.1" }, defaultTrust) !== "8.8.8.8") {
    fail("public socket must ignore spoofed x-real-ip");
  }
  if (pickClientIp("127.0.0.1", { realIp: "10.1.2.3" }, defaultTrust) !== "10.1.2.3") {
    fail("loopback proxy may use x-real-ip");
  }
  if (pickClientIp("", { forwardedFor: "1.1.1.1, 10.0.0.9" }, { trustProxy: false, trustedProxies: defaultTrust.trustedProxies }) !== "127.0.0.1") {
    fail("xff ignored without TRUST_PROXY");
  }
  if (pickClientIp("", { forwardedFor: "1.1.1.1, 10.0.0.9" }, defaultTrust) !== "10.0.0.9") {
    fail("rightmost xff is the client hop");
  }
  const spoofed = await app.request("/api/session", { headers: { "x-forwarded-for": "8.8.8.8" } });
  if (spoofed.status !== 200) fail("in-process without TRUST_PROXY stays loopback");

  process.env.ALLOWED_IPS = "10.0.0.0/8";
  process.env.TRUST_PROXY = "true";
  const ipCfg = loadConfig(tmp);
  if (!parseAllowedIps("10.0.0.0/8", { desktopMode: false }).rules.length) fail("parse allowlist");
  const ipApp = createApp(ipCfg, db);
  const blocked = await ipApp.request("/api/session", { headers: { "x-real-ip": "8.8.8.8" } });
  if (blocked.status !== 403) fail("allowlist should block public ip");
  const office = await ipApp.request("/api/session", { headers: { "x-real-ip": "10.9.8.7" } });
  if (office.status !== 200) fail("allowlist should pass office cidr");
  const healthOpen = await ipApp.request("/api/health", { headers: { "x-real-ip": "8.8.8.8" } });
  if (healthOpen.status !== 200) fail("health stays open outside allowlist");
  const xffSpoof = await ipApp.request("/api/session", { headers: { "x-forwarded-for": "10.1.1.1, 8.8.8.8" } });
  if (xffSpoof.status !== 403) fail("leftmost xff spoof should not win");
  const xffOk = await ipApp.request("/api/session", { headers: { "x-forwarded-for": "8.8.8.8, 10.1.1.1" } });
  if (xffOk.status !== 200) fail("rightmost xff after proxy overwrite");

  process.env.DESKTOP_MODE = "1";
  process.env.ALLOWED_IPS = "10.0.0.0/8";
  const deskOpen = loadConfig(tmp);
  if (!deskOpen.allowedIps.allowAll) fail("desktop skips ip allowlist");
  process.env.DESKTOP_MODE = "";

  const quotaIp = "198.51.100.40";
  if (!hitIpQuota(quotaIp, "unit-hour", 2, 0).ok || !hitIpQuota(quotaIp, "unit-hour", 2, 0).ok) fail("hour quota allows 2");
  if (hitIpQuota(quotaIp, "unit-hour", 2, 0).ok) fail("hour quota should fuse on 3");
  if (hitIpQuota(quotaIp, "other-kind", 99, 99).ok) fail("fused ip should trip other kinds");
  if (!hitIpQuota("127.0.0.1", "unit-hour", 1, 1).ok) fail("loopback skips fuse");
  const fiveIp = "198.51.100.41";
  if (!hitIpQuota(fiveIp, "unit-five", 0, 2).ok || !hitIpQuota(fiveIp, "unit-five", 0, 2).ok) fail("five-hour quota allows 2");
  if (hitIpQuota(fiveIp, "unit-five", 0, 2).ok) fail("five-hour quota should fuse on 3");

  process.env.ALLOWED_IPS = "";
  process.env.TRUST_PROXY = "true";
  process.env.WEB_IP_HOUR_TRIAL = "2";
  process.env.WEB_IP_FIVE_HOUR_TRIAL = "3";
  const fuseCfg = loadConfig(tmp);
  if (fuseCfg.webQuota.hourTrial !== 2) fail("trial hour quota env");
  const fuseApp = createApp(fuseCfg, db);
  const attacker = "203.0.113.88";
  for (let i = 0; i < 2; i++) {
    const device = (i === 0 ? "c" : "d").repeat(64);
    const started = await fuseApp.request("/api/entitlements/trial", {
      method: "POST",
      headers: { "x-real-ip": attacker, "x-agnes-device": device },
    });
    if (started.status !== 200) fail(`trial from public ip ${i}`);
  }
  const fusedTrial = await fuseApp.request("/api/entitlements/trial", {
    method: "POST",
    headers: { "x-real-ip": attacker, "x-agnes-device": "e".repeat(64) },
  });
  if (fusedTrial.status !== 429) fail("third trial in one hour should fuse the ip");
  if (!fusedTrial.headers.get("retry-after")) fail("fuse retry-after");
  const fusedSession = await fuseApp.request("/api/session", { headers: { "x-real-ip": attacker } });
  if (fusedSession.status !== 429) fail("fused ip should block other api");
  const fusedHealth = await fuseApp.request("/api/health", { headers: { "x-real-ip": attacker } });
  if (fusedHealth.status !== 200) fail("health stays open during fuse");

  process.env.WEB_DAILY_CHAT = "2";
  process.env.WEB_DAILY_IMAGE = "2";
  process.env.WEB_VIDEO_LIMIT = "1";
  process.env.WEB_VIDEO_DAYS = "3";
  process.env.TRUST_PROXY = "true";
  process.env.ALLOWED_IPS = "";
  const dailyCfg = loadConfig(tmp);
  if (dailyCfg.webQuota.dailyChat !== 2) fail("daily chat quota env");
  if (dailyCfg.webQuota.dailyImage !== 2) fail("daily image quota env");
  if (dailyCfg.webQuota.videoLimit !== 1 || dailyCfg.webQuota.videoDays !== 3) fail("video window env");
  if (shanghaiDaysBack(3).length !== 3) fail("shanghai window length");
  const dailyDb = openDb(path.join(tmp, "daily"));
  const dailyApp = createApp(dailyCfg, dailyDb);
  const dailyIp = "203.0.113.91";
  const dailyDev = "f".repeat(64);
  const dailyTrial = await dailyApp.request("/api/entitlements/trial", {
    method: "POST",
    headers: { "x-real-ip": dailyIp, "x-agnes-device": dailyDev },
  });
  if (dailyTrial.status !== 200) fail("daily trial");
  const dailySid = cookieNamed(dailyTrial, "agnes_sid");
  const dailyHeaders = {
    authorization: "Bearer test-auth-token-value",
    cookie: `agnes_sid=${dailySid}`,
    "x-agnes-device": dailyDev,
    "x-real-ip": dailyIp,
    "Content-Type": "application/json",
  };
  for (let i = 0; i < 2; i++) {
    const used = await dailyApp.request("/api/entitlements/consume", {
      method: "POST",
      headers: dailyHeaders,
    });
    if (used.status !== 200) fail(`daily consume ${i}`);
  }
  const dailyDenied = await dailyApp.request("/api/entitlements/consume", {
    method: "POST",
    headers: dailyHeaders,
  });
  if (dailyDenied.status !== 429) fail("third chat in one day should 429");
  const dailySession = await dailyApp.request("/api/session", {
    headers: dailyHeaders,
  });
  if (dailySession.status !== 200) fail("daily cap must not fuse the ip");

  const today = shanghaiDay();
  dailyDb.prepare("INSERT INTO daily_counters (day, subject, kind, count) VALUES (?, ?, ?, ?)").run(today, `ip:${dailyIp}`, "image", 2);
  dailyDb.prepare("INSERT INTO daily_counters (day, subject, kind, count) VALUES (?, ?, ?, ?)").run(today, `device:${dailyDev}`, "image", 2);
  const imageDenied = await dailyApp.request("/api/images/generate", {
    method: "POST",
    headers: dailyHeaders,
    body: JSON.stringify({ prompt: "a cat" }),
  });
  if (imageDenied.status !== 429) fail("third image in one day should 429");
  const yday = shanghaiDay(Date.now() - 24 * 3600 * 1000);
  dailyDb.prepare("INSERT INTO daily_counters (day, subject, kind, count) VALUES (?, ?, ?, ?)").run(yday, `ip:${dailyIp}`, "video", 1);
  dailyDb.prepare("INSERT INTO daily_counters (day, subject, kind, count) VALUES (?, ?, ?, ?)").run(yday, `device:${dailyDev}`, "video", 1);
  const videoDenied = await dailyApp.request("/api/videos/generate", {
    method: "POST",
    headers: dailyHeaders,
    body: JSON.stringify({ prompt: "a rainy street" }),
  });
  if (videoDenied.status !== 429) fail("video within 3-day window should 429");
  const mediaSession = await dailyApp.request("/api/session", { headers: dailyHeaders });
  const mediaBody = (await mediaSession.json()) as {
    dailyImage?: { remaining: number };
    videoQuota?: { remaining: number; windowDays: number };
  };
  if (mediaBody.dailyImage?.remaining !== 0) fail("session should show image quota empty");
  if (mediaBody.videoQuota?.remaining !== 0 || mediaBody.videoQuota.windowDays !== 3) fail("session should show video quota empty");

  const emptyLatest = await app.request("/api/updates/latest");
  if (emptyLatest.status !== 200) fail("update latest open");
  const emptyMan = (await emptyLatest.json()) as { version?: string };
  if (emptyMan.version) fail("empty update dir should have blank version");
  const nonePkg = await app.request("/api/updates/package");
  if (nonePkg.status !== 404) fail("missing package 404");
  const updateDir = path.join(tmp, "data", "updates");
  fs.mkdirSync(updateDir, { recursive: true });
  fs.writeFileSync(path.join(updateDir, "app.asar"), "asar-bytes");
  fs.writeFileSync(
    path.join(updateDir, "latest.json"),
    JSON.stringify({
      version: "0.1.1",
      sha256: "a".repeat(64),
      size: 10,
      file: "app.asar",
      electron: "38.1.2",
      notes: "这是给用户看的两句。\n第二句。",
    }),
  );
  const gotLatest = await app.request("/api/updates/latest");
  const man = (await gotLatest.json()) as { version?: string; size?: number; notes?: string };
  if (man.version !== "0.1.1" || man.size !== 10) fail("update manifest");
  if (man.notes !== "这是给用户看的两句。\n第二句。") fail("update notes");
  const pkgRes = await app.request("/api/updates/package");
  if (pkgRes.status !== 200) fail("update package");
  const buf = Buffer.from(await pkgRes.arrayBuffer());
  if (buf.toString() !== "asar-bytes") fail("update package bytes");
  fs.writeFileSync(
    path.join(updateDir, "latest.json"),
    JSON.stringify({ version: "0.1.2", sha256: "b".repeat(64), file: "../secret.asar" }),
  );
  const escapePkg = await app.request("/api/updates/package");
  if (escapePkg.status !== 404) fail("update path escape");
  const noZip = await app.request("/api/updates/desktop");
  if (noZip.status !== 404) fail("missing desktop zip 404");
  fs.writeFileSync(path.join(updateDir, "Agnes-win-x64.zip"), "zip-bytes");
  const zipRes = await app.request("/api/updates/desktop");
  if (zipRes.status !== 200) fail("desktop zip");
  if (Buffer.from(await zipRes.arrayBuffer()).toString() !== "zip-bytes") fail("desktop zip bytes");
  if (!String(zipRes.headers.get("content-disposition") || "").includes("Agnes-win-x64.zip")) {
    fail("desktop zip filename");
  }

  const refundDb = openDb(path.join(tmp, "refund"));
  const refundIp = "203.0.113.99";
  const refundDev = "1".repeat(64);
  const first = takeQuota(refundDb, refundIp, refundDev, "video", 1, 3);
  if (!first.ok || first.remaining !== 0) fail("refund: first take uses the only slot");
  if (takeQuota(refundDb, refundIp, refundDev, "video", 1, 3).ok) fail("refund: second take blocked");
  refundQuota(refundDb, refundIp, refundDev, "video");
  if (!inspectQuota(refundDb, refundIp, refundDev, "video", 1, 3).ok) fail("refund should return the slot after upstream failure");
  refundQuota(refundDb, refundIp, refundDev, "video");
  if (inspectQuota(refundDb, refundIp, refundDev, "video", 1, 3).used !== 0) fail("refund must not go negative");

  const win = parseUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  if (win.os !== "Windows 10/11" || !win.browser.startsWith("Chrome ")) fail("parse windows chrome ua");
  const iOs = parseUserAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
  );
  if (!iOs.os.startsWith("iOS ") || !iOs.browser.startsWith("Safari ")) fail("parse iphone safari ua");
  const edge = parseUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  );
  if (!edge.browser.startsWith("Edge ")) fail("edge must win over chrome token");
  if (parseUserAgent("").os !== "" || parseUserAgent(undefined).browser !== "") fail("empty ua stays blank");
  if (ipSource("127.0.0.1") !== "本机") fail("loopback ip source");
  if (ipSource("10.1.2.3") !== "内网") fail("private ip source");
  if (ipSource("::ffff:192.168.1.9") !== "内网") fail("mapped private ip source");
  if (ipSource("8.8.8.8") !== "公网") fail("public ip source without db falls back");

  const wsDb = openDb(path.join(tmp, "wsmigrate"));
  const deskWsCfg = { desktopMode: true, workspaceRoot: path.join(tmp, "ws-default") } as Parameters<typeof applyDesktopWorkspace>[1];
  applyDesktopWorkspace(wsDb, deskWsCfg);
  if (deskWsCfg.workspaceRoot !== path.join(tmp, "ws-default")) fail("no kv workspace keeps default");
  const savedWs = path.join(tmp, "ws-saved");
  setKv(wsDb, DESKTOP_WORKSPACE_KV, savedWs);
  applyDesktopWorkspace(wsDb, deskWsCfg);
  if (deskWsCfg.workspaceRoot !== savedWs) fail("kv workspace should override on desktop boot");
  setKv(wsDb, DESKTOP_WORKSPACE_KV, path.parse(process.cwd()).root);
  applyDesktopWorkspace(wsDb, deskWsCfg);
  if (deskWsCfg.workspaceRoot !== savedWs) fail("unsafe kv workspace must be ignored");
  const webWsCfg = { desktopMode: false, workspaceRoot: savedWs } as Parameters<typeof applyDesktopWorkspace>[1];
  setKv(wsDb, DESKTOP_WORKSPACE_KV, path.join(tmp, "ws-web"));
  applyDesktopWorkspace(wsDb, webWsCfg);
  if (webWsCfg.workspaceRoot !== savedWs) fail("web must ignore desktop workspace kv");

  // 订阅制价目表：三档 × 四周期 + 超管卡，不卖永久
  const planDb = openDb(path.join(tmp, "plans"));
  const seeded = listPlans(planDb);
  for (const id of ["basic_1m", "plus_1m", "pro_1m", "basic_12m", "pro_12m"]) {
    if (!seeded.find((p) => p.id === id)) fail(`seed 缺少套餐 ${id}`);
  }
  const basic1m = seeded.find((p) => p.id === "basic_1m") as NonNullable<(typeof seeded)[number]>;
  if (basic1m.price_cents !== 1800 || basic1m.duration_days !== 30) fail("基础月卡应为 ¥18 / 30 天");
  if (basic1m.chat_quota !== 1000 || basic1m.image_quota !== 300 || basic1m.video_quota !== 30) fail("基础月卡额度");
  if (!basic1m.allow_agent) fail("全档都应能用 Agent");
  {
    const claimDev = "d".repeat(64);
    const claimUser = registerUser(planDb, "claimuser", "password1");
    const [claimKey] = issueLicenses(planDb, { count: 1, planId: "basic_1m" });
    activateLicense(planDb, claimDev, claimKey.code);
    if (!attachDeviceLicense(planDb, claimUser.user.id, claimDev)) fail("登录应把这台设备的卡挂到账号");
    const owned = getEntitlementByUser(planDb, claimUser.user.id);
    if (owned?.plan !== "licensed" || owned.license_id !== claimKey.id) fail("账号应拿到这台设备已激活的卡");
    if (betaOffer(planDb, "9".repeat(64), claimUser.user.id).eligible) fail("已有授权的账号不应再显示可领公测月卡");
  }
  const basic12m = seeded.find((p) => p.id === "basic_12m") as NonNullable<(typeof seeded)[number]>;
  if (basic12m.chat_quota !== 12000 || basic12m.image_quota !== 3600) fail("年卡额度应按 12 倍放大");
  if (basic12m.price_cents >= basic1m.price_cents * 12) fail("年卡应比月付 12 个月便宜");
  if (seeded.some((p) => p.enabled && !p.is_super && p.duration_days === 0)) fail("不应再有在售的永久套餐");

  const superPlan = seeded.find((p) => p.is_super) as NonNullable<(typeof seeded)[number]>;
  if (superPlan.chat_quota !== 0 || superPlan.duration_days !== 0) fail("超管版必须不限额度且永久");
  if (superPlan.enabled) fail("超管版默认应停用，避免误发");

  const coerced = upsertPlan(planDb, {
    name: "超管强制",
    chatQuota: 5,
    imageQuota: 7,
    videoQuota: 9,
    durationDays: 30,
    priceYuan: 0,
    allowImage: false,
    allowVideo: false,
    allowAgent: false,
    isSuper: true,
  });
  if (coerced.chat_quota !== 0 || coerced.duration_days !== 0) fail("超管版入参必须被强制为不限/永久");
  if (coerced.image_quota !== 0 || coerced.video_quota !== 0) fail("超管版媒体额度必须不限");
  if (!coerced.allow_image || !coerced.allow_video || !coerced.allow_agent) fail("超管版必须全功能");

  const monthPlan = upsertPlan(planDb, {
    name: "测试月卡",
    chatQuota: 100,
    imageQuota: 10,
    videoQuota: 2,
    durationDays: 30,
    priceYuan: 18,
    allowImage: true,
    allowVideo: true,
    allowAgent: true,
  });

  const timedDev = "a1".repeat(32);
  const [monthKey] = issueLicenses(planDb, { count: 1, planId: monthPlan.id });
  const timed = activateLicense(planDb, timedDev, monthKey.code);
  if (timed.expires_at === null) fail("时长卡应写入到期时间");
  const firstExpiry = Number(timed.expires_at);
  if (Math.abs(firstExpiry - (Date.now() + 30 * DAY_MS)) > 60_000) fail("月卡到期应为 30 天后");
  if (publicEntitlement(timed, planDb).expired) fail("新激活的月卡不应算过期");

  if (timed.image_quota !== 10 || timed.video_quota !== 2) fail("激活应带上套餐的图/视频额度");

  // 付费档媒体额度：扣到 0 就拒绝，退还能回滚
  for (let i = 0; i < 10; i++) consumeMedia(planDb, timedDev, "image");
  if (Number(getEntitlement(planDb, timedDev)?.image_used) !== 10) fail("出图应按次累计");
  await expectReject("image quota exhausted", () => consumeMedia(planDb, timedDev, "image"));
  refundMedia(planDb, timedDev, "image");
  consumeMedia(planDb, timedDev, "image");
  if (publicEntitlement(getEntitlement(planDb, timedDev)!, planDb).imageRemaining !== 0) fail("出图剩余应为 0");
  consumeMedia(planDb, timedDev, "video");
  consumeMedia(planDb, timedDev, "video");
  await expectReject("video quota exhausted", () => consumeMedia(planDb, timedDev, "video"));

  // 续期叠加：再贴一张月卡 → 时间续加、对话与媒体额度都累加
  const [renewKey] = issueLicenses(planDb, { count: 1, planId: monthPlan.id });
  const renewed = activateLicense(planDb, timedDev, renewKey.code);
  if (Math.abs(Number(renewed.expires_at) - (firstExpiry + 30 * DAY_MS)) > 60_000) fail("续期应在原到期日上叠加");
  if (renewed.chat_quota !== 200) fail("续期应叠加对话次数");
  if (renewed.image_quota !== 20 || renewed.video_quota !== 4) fail("续期应叠加媒体额度");
  if (renewed.image_used !== 10) fail("续期不应清掉已用量");

  // 超管版：不限额度 + 永不过期，扣次与扣图都不消耗
  const superDev = "c3".repeat(32);
  upsertPlan(planDb, {
    id: superPlan.id,
    name: superPlan.name,
    chatQuota: 0,
    imageQuota: 0,
    videoQuota: 0,
    durationDays: 0,
    priceYuan: 0,
    allowImage: true,
    allowVideo: true,
    allowAgent: true,
    isSuper: true,
    enabled: true,
  });
  const [superKey] = issueLicenses(planDb, { count: 1, planId: superPlan.id });
  const superRow = activateLicense(planDb, superDev, superKey.code);
  if (!superRow.is_super || superRow.expires_at !== null || superRow.chat_quota !== 0) fail("超管版授权应无限且永久");
  const superPub = publicEntitlement(superRow, planDb);
  if (!superPub.isSuper || superPub.expired || superPub.remaining !== null) fail("超管版对外状态应为不限/未过期");
  if (!superPub.allowChat || !superPub.allowImage || !superPub.allowVideo || !superPub.allowAgent) fail("超管版应全开");
  for (let i = 0; i < 5; i++) consumeChat(planDb, superDev);
  for (let i = 0; i < 5; i++) consumeMedia(planDb, superDev, "image");
  const superAfter = getEntitlement(planDb, superDev);
  if (Number(superAfter?.chat_used) !== 0 || Number(superAfter?.image_used) !== 0) fail("超管版不应消耗额度");

  // 免费试用：可以体验对话 / Agent / 出图 / 出视频（用量由每日额度卡住）
  const freeDev = "d4".repeat(32);
  const freeRow = startTrial(planDb, freeDev);
  const freePub = publicEntitlement(freeRow, planDb);
  if (!freePub.allowChat || !freePub.allowAgent || !freePub.allowImage || !freePub.allowVideo) {
    fail("免费试用应能体验对话 / Agent / 出图 / 出视频");
  }
  // 本机 IP 也要按设备卡住每日额度，否则桌面免费版可以无限出图
  const localTake = takeQuota(planDb, "127.0.0.1", freeDev, "image", 2, 1);
  if (!localTake.ok) fail("首次出图应放行");
  takeQuota(planDb, "127.0.0.1", freeDev, "image", 2, 1);
  if (takeQuota(planDb, "127.0.0.1", freeDev, "image", 2, 1).ok) fail("本机也应按设备卡住每日额度");
  if (!takeQuota(planDb, "127.0.0.1", "", "image", 2, 1).ok) fail("没有设备码又是本机时不该计数");

  const betaDev = "e5".repeat(32);
  const granted = claimBetaMonth(planDb, betaDev, "203.0.113.10");
  if (granted.row.plan !== "licensed" || granted.row.chat_quota !== 1000) fail("公测月卡应立即按基础版开通");
  if (granted.row.image_quota !== 300 || granted.row.video_quota !== 30) fail("公测月卡应带上月卡的图和视频额度");
  if (Math.abs(Number(granted.row.expires_at) - (Date.now() + 30 * DAY_MS)) > 60_000) fail("公测月卡应为 30 天");
  if (!granted.notice.includes("反馈")) fail("领取说明应提到反馈加时");
  const grantedOffer = betaOffer(planDb, betaDev);
  if (!grantedOffer.claimed || grantedOffer.eligible) fail("领过的设备不应再显示可领");
  await expectReject("beta twice", () => claimBetaMonth(planDb, betaDev, "203.0.113.11"));
  await expectReject("beta same ip", () => claimBetaMonth(planDb, "e6".repeat(32), "203.0.113.10"));
  const trialUpgrade = "e7".repeat(32);
  startTrial(planDb, trialUpgrade);
  const upgraded = claimBetaMonth(planDb, trialUpgrade, "198.51.100.8");
  if (upgraded.row.plan !== "licensed" || upgraded.row.chat_quota !== 1000) fail("试用应能升级成公测月卡");
  await expectReject("licensed cannot claim beta", () => claimBetaMonth(planDb, timedDev, "198.51.100.9"));
  planDb.prepare("UPDATE plans SET enabled=0 WHERE id='basic_1m'").run();
  const whilePaused = claimBetaMonth(planDb, "e8".repeat(32), "198.51.100.20");
  if (whilePaused.row.plan !== "licensed") fail("套餐停售时公测月卡仍应能发");
  planDb.prepare("UPDATE plans SET enabled=1 WHERE id='basic_1m'").run();
  setKv(planDb, "beta_monthly_enabled", "0");
  if (betaOffer(planDb, "e9".repeat(32)).open) fail("关掉公测后不应再开放领取");
  await expectReject("beta closed", () => claimBetaMonth(planDb, "e9".repeat(32), "198.51.100.21"));
  setKv(planDb, "beta_monthly_enabled", "1");

  // 公测月卡：IPv6 按 /64 限领，登录账号也只能领一次
  claimBetaMonth(planDb, "f6".repeat(32), "2001:db8:10:20::1", "user-beta-1");
  await expectReject("beta same /64", () => claimBetaMonth(planDb, "f7".repeat(32), "2001:db8:10:20:abcd::9"));
  await expectReject("beta same account", () => claimBetaMonth(planDb, "f8".repeat(32), "198.51.100.77", "user-beta-1"));
  if (!betaOffer(planDb, "f9".repeat(32), "user-beta-1").claimed) fail("领过的账号换设备也应显示已领");
  const otherBlock = claimBetaMonth(planDb, "fa".repeat(32), "2001:db8:10:21::1", "user-beta-2");
  if (otherBlock.row.plan !== "licensed") fail("别的 /64 应能领");
  const lanA = claimBetaMonth(planDb, "fb".repeat(32), "192.168.1.5");
  const lanB = claimBetaMonth(planDb, "fc".repeat(32), "192.168.1.5");
  if (lanA.row.plan !== "licensed" || lanB.row.plan !== "licensed") fail("内网地址不按 IP 限领（桌面端走本机）");

  // 网络块：IPv6 取 /64，IPv4 用完整地址
  if (ipBlock("2001:db8:1:2:aaaa::1") !== "2001:db8:1:2::/64") fail(`IPv6 /64: ${ipBlock("2001:db8:1:2:aaaa::1")}`);
  if (ipBlock("2001:0db8:0001:0002:ffff:1:2:3") !== "2001:db8:1:2::/64") fail("IPv6 前导零应规整");
  if (ipBlock("2001:db8::5") !== "2001:db8:0:0::/64") fail(`IPv6 压缩写法: ${ipBlock("2001:db8::5")}`);
  if (ipBlock("203.0.113.5") !== "203.0.113.5" || ipBlock("::ffff:203.0.113.5") !== "203.0.113.5") fail("IPv4 用完整地址");

  // 新开试用按网络计数：同一 /64 合并，内网不计
  for (const [i, prefix] of ["7c", "8c", "9c"].entries()) {
    startTrial(planDb, prefix.repeat(32));
    markTrialIp(planDb, prefix.repeat(32), `2001:db8:9:9::${i + 1}`);
  }
  if (recentTrialsFromBlock(planDb, "2001:db8:9:9:ffff::7") !== 3) fail("同一 /64 新开的试用应合并计数");
  if (recentTrialsFromBlock(planDb, "2001:db8:9:a::1") !== 0) fail("别的 /64 不受影响");
  if (recentTrialsFromBlock(planDb, "2001:db8:9:9::1", Date.now() + 2 * DAY_MS) !== 0) fail("超过 24 小时不再计数");
  if (recentTrialsFromBlock(planDb, "127.0.0.1") !== 0) fail("本机地址不计数");

  // 额度退还单据：只退一次、只退给自己、中转用过的不退、过期不退
  {
    const qDev = "b1".repeat(32);
    startTrial(planDb, qDev);
    const usedOf = () => Number(getEntitlement(planDb, qDev)?.chat_used);
    consumeChat(planDb, qDev);
    const t1 = createQuotaTicket(planDb, { kind: "chat", billHash: qDev, deviceHash: qDev, chatTicket: "ct-1" });
    if (refundQuotaTicket(planDb, t1, "b2".repeat(32), "chat").ok) fail("别的设备不能拿这张单据退");
    if (refundQuotaTicket(planDb, t1, qDev, "image").ok) fail("单据类型要对上");
    if (!refundQuotaTicket(planDb, t1, qDev, "chat").ok || usedOf() !== 0) fail("上游失败应退回一次对话");
    if (refundQuotaTicket(planDb, t1, qDev, "chat").ok) fail("同一张单据只能退一次");
    if (!chatTicketRefunded(planDb, "ct-1") || chatTicketRefunded(planDb, "ct-x")) fail("退过的对话票据应被标记");
    consumeChat(planDb, qDev);
    const t2 = createQuotaTicket(planDb, { kind: "chat", billHash: qDev, deviceHash: qDev, chatTicket: "ct-2" });
    markChatTicketUsed(planDb, "ct-2");
    if (refundQuotaTicket(planDb, t2, qDev, "chat").ok || usedOf() !== 1) fail("中转已经用到模型的单据不能退");
    const t3 = createQuotaTicket(planDb, { kind: "chat", billHash: qDev, deviceHash: qDev });
    if (refundQuotaTicket(planDb, t3, qDev, "chat", Date.now() + QUOTA_TICKET_REFUND_MS + 1000).ok) fail("过期单据不能退");
    if (refundQuotaTicket(planDb, "qt_forged", qDev, "chat").ok) fail("伪造单据不能退");
  }

  // 到期：手工把到期时间调到过去，应拒绝继续用
  planDb.prepare("UPDATE entitlements SET expires_at=? WHERE device_hash=?").run(Date.now() - 1000, timedDev);
  const expiredRow = getEntitlement(planDb, timedDev) as NonNullable<ReturnType<typeof getEntitlement>>;
  const expiredPub = publicEntitlement(expiredRow, planDb);
  if (!expiredPub.expired || expiredPub.allowChat || expiredPub.allowImage) fail("到期后应停用对话与功能");
  await expectReject("expired consume", () => consumeChat(planDb, timedDev));
  await expectReject("expired feature", () => requireFeature(expiredRow, "chat"));

  // edit_file：LLM 最稳的编辑原语，唯一匹配才放行
  const editRoot = path.join(tmp, "editws");
  fs.mkdirSync(editRoot, { recursive: true });
  fs.writeFileSync(path.join(editRoot, "a.ts"), "const a = 1;\nconst b = 2;\nconst a2 = 1;\n");
  const ews = new Workspace(editRoot);
  const single = await ews.replaceInFile("a.ts", "const b = 2;", "const b = 3;");
  if (!single.ok || !single.content.includes("const b = 3;") || single.count !== 1) fail("唯一匹配应替换成功");
  const missing = await ews.replaceInFile("a.ts", "not here", "x");
  if (missing.ok || !missing.reason.includes("不存在")) fail("找不到原文应报错并提示 read_file");
  const ambiguous = await ews.replaceInFile("a.ts", "= 1;", "= 9;");
  if (ambiguous.ok || !ambiguous.reason.includes("2 次")) fail("多处匹配应拒绝并报次数");
  const all = await ews.replaceInFile("a.ts", "= 1;", "= 9;", true);
  if (!all.ok || all.count !== 2 || all.content.includes("= 1;")) fail("replace_all 应替换全部");
  const noop = await ews.replaceInFile("a.ts", "const b = 2;", "const b = 2;");
  if (noop.ok) fail("原文与新文相同应拒绝");
  const empty = await ews.replaceInFile("a.ts", "", "x");
  if (empty.ok) fail("空 old_string 应拒绝");
  // 特殊字符不能被当成正则或 $ 替换模式
  fs.writeFileSync(path.join(editRoot, "b.ts"), "price = $1.00 (a+b)*c\n");
  const special = await ews.replaceInFile("b.ts", "$1.00 (a+b)*c", "$2.00 (x)");
  if (!special.ok || special.content !== "price = $2.00 (x)\n") fail("特殊字符应按字面量处理");

  // read_file 分段 + 行号
  const big = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  fs.writeFileSync(path.join(editRoot, "big.txt"), big);
  const page = await ews.readFileLines("big.txt", 10, 5);
  if (!page.includes("(50 lines, showing 10-14)")) fail(`分段读头部不对: ${page.split("\n")[0]}`);
  if (!page.includes("10|line 10") || page.includes("15|line 15")) fail("分段读应精确到区间");
  if (!page.includes("offset=15")) fail("未读完应提示下一页 offset");
  const whole = await ews.readFileLines("big.txt");
  if (whole.includes("more lines")) fail("默认 limit 应能读完 50 行");
  const beyond = await ews.readFileLines("big.txt", 999, 5);
  if (!beyond.includes("showing 50-50")) fail("越界 offset 应收敛到最后一行");

  // @文件 提及：只展开工作区里真实存在的文本文件，沙箱照常生效
  fs.writeFileSync(path.join(editRoot, ".env"), "SECRET=1\n");
  const mentions = extractMentions("看下 @a.ts 和 @src/nope.ts，还有 @.env 以及邮箱 me@x.com");
  if (!mentions.includes("a.ts") || !mentions.includes("src/nope.ts") || !mentions.includes(".env")) {
    fail(`提及解析不对: ${mentions.join(",")}`);
  }
  if (mentions.includes("x.com")) fail("邮箱不该被当成 @文件");
  const expanded = await expandMentions(ews, "看下 @a.ts 和 @src/nope.ts 和 @.env");
  if (!expanded.attached.includes("a.ts")) fail("存在的文件应被展开");
  if (expanded.attached.includes("src/nope.ts")) fail("不存在的文件应跳过");
  if (expanded.attached.includes(".env") || expanded.content.includes("SECRET=1")) fail("@.env 不能绕过沙箱");
  if (!expanded.content.includes('<file path="a.ts">') || !expanded.content.startsWith("看下 @a.ts")) {
    fail("展开应保留原话并附文件块");
  }
  const plain = await expandMentions(ews, "没有提及");
  if (plain.content !== "没有提及" || plain.attached.length) fail("无提及应原样返回");

  // 项目速览：技术栈 / 目录树，且不会因为没有 git 而炸
  fs.writeFileSync(path.join(editRoot, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "x", build: "y" } }));
  const snapshot = await projectContext(editRoot);
  if (!snapshot.includes("Node.js") || !snapshot.includes("package.json: demo") || !snapshot.includes("scripts: test, build")) {
    fail(`项目速览应识别技术栈: ${snapshot.slice(0, 200)}`);
  }
  if (!snapshot.includes("a.ts") || snapshot.includes(".env")) fail("速览目录树应列文件但隐藏密钥");
  if (snapshot.includes("Git:")) fail("不是 git 仓库不该有 Git 段");
  if (!agentSystem(editRoot, snapshot).includes("Project snapshot")) fail("agent 提示应带项目速览");
  if (agentSystem(editRoot, "").includes("Project snapshot")) fail("没有速览时不该出现空段");
  if (!agentSystem(editRoot).includes("edit_file")) fail("agent 提示应引导 edit_file");

  const providerDb = openDb(path.join(tmp, "providers"));
  if (assertProviderUrl("https://gateway.example/v1/") !== "https://gateway.example/v1") fail("提供方地址应去掉末尾斜杠");
  if (assertProviderUrl("http://127.0.0.1:11434/v1") !== "http://127.0.0.1:11434/v1") fail("本机 http 可以做自定义模型");
  await expectReject("公网 http 不能做提供方", () => assertProviderUrl("http://example.com/v1"));
  const saved = upsertProvider(providerDb, {
    id: "acme",
    name: "Acme",
    baseUrl: "https://gateway.example/v1",
    protocol: "openai-completions",
    apiKey: "secret-key",
    models: ["gpt-4o"],
  });
  if (saved.hasKey !== true || JSON.stringify(saved).includes("secret-key")) fail("设置接口不能带回 API 密钥");
  if (loadProviders(providerDb)[0]?.apiKey !== "secret-key") fail("密钥应留在本机库");
  const customId = customModelId("acme", "gpt-4o");
  if (parseCustomModel(customId)?.model !== "gpt-4o") fail("自定义模型 ID 应能拆回");
  if (!listPublicProviders(providerDb)[0] || listPublicProviders(providerDb)[0].models[0] !== "gpt-4o") fail("模型目录应公开");
  const providerRaw = () => String((providerDb.prepare("SELECT value FROM kv WHERE key = ?").get(PROVIDERS_KV) as { value: string }).value);
  if (providerRaw().includes("secret-key")) fail("API 密钥不能明文落库");
  // 0.1.30 及更早的明文数据：照样能用，读到一次就改存成密文
  setKv(
    providerDb,
    PROVIDERS_KV,
    JSON.stringify([{ id: "old", name: "Old", baseUrl: "https://old.example/v1", protocol: "openai-completions", apiKey: "legacy-plain-key", models: ["m"] }]),
  );
  if (loadProviders(providerDb)[0]?.apiKey !== "legacy-plain-key") fail("旧明文密钥应还能用");
  if (providerRaw().includes("legacy-plain-key") || !providerRaw().includes("fk1:")) fail("旧明文密钥读到后应改存密文");
  const oldInput = { name: "Old", protocol: "openai-completions", models: ["m"] };
  await expectReject("换域名沿用旧密钥", () => upsertProvider(providerDb, { ...oldInput, baseUrl: "https://evil.example/v1" }, "old"));
  upsertProvider(providerDb, { ...oldInput, baseUrl: "https://old.example/v2" }, "old");
  if (findProvider(providerDb, "old")?.apiKey !== "legacy-plain-key") fail("同域名改路径应保留密钥");
  upsertProvider(providerDb, { ...oldInput, baseUrl: "https://new.example/v1", apiKey: "new-key" }, "old");
  if (findProvider(providerDb, "old")?.apiKey !== "new-key") fail("换域名并重填密钥应能保存");
  if (sameProviderOrigin("https://a.example/v1", "https://a.example:444/v1")) fail("端口不同算不同域名");
  if (assertProviderUrl("http://[::1]:11434/v1") !== "http://[::1]:11434/v1") fail("IPv6 本机也可以用 http");

  // 工具集：edit_file / update_plan 挂在 agent 模式，写权限关掉时 edit_file 一起消失
  const agentTools = selectTools("agent", { allowTerminal: true, allowWrites: true }).map((t) => t.function.name);
  if (!agentTools.includes("edit_file") || !agentTools.includes("update_plan")) fail("agent 应有 edit_file 与 update_plan");
  if (!agentTools.includes("ask_user") || !agentTools.includes("present_plan")) fail("agent 应能提问并交出方案");
  const chatTools = selectTools("chat", { allowTerminal: false, allowWrites: false }).map((t) => t.function.name);
  if (!chatTools.includes("ask_user") || chatTools.includes("present_plan")) fail("对话可以提问，但不能交方案");
  const planOn = parseComposerCommand("/plan 做登录页");
  if (!planOn || planOn.kind !== "plan" || !planOn.active || planOn.message !== "做登录页") fail("/plan 应打开计划模式并带上后文");
  const planOff = parseComposerCommand("/plan off 直接改");
  if (!planOff || planOff.kind !== "plan" || planOff.active || planOff.message !== "直接改") fail("/plan off 应关掉计划模式");
  if (parseComposerCommand("你好")) fail("普通文字不是斜杠命令");
  const unknown = parseComposerCommand("/other");
  if (!unknown || unknown.kind !== "error") fail("未知斜杠命令应返回 error，不发给模型");
  const help = parseComposerCommand("/help");
  if (!help || help.kind !== "help" || !help.text.includes("/compact")) fail("/help 应列出命令");
  const clear = parseComposerCommand("/clear");
  if (!clear || clear.kind !== "clear" || clear.scope !== "current") fail("/clear 应只作用于当前会话");
  const compact = parseComposerCommand("/compact");
  if (!compact || compact.kind !== "compact" || !compact.needsConfirm) fail("/compact 应要求确认");
  const readOnly = selectTools("agent", { allowTerminal: false, allowWrites: false }).map((t) => t.function.name);
  if (readOnly.includes("edit_file") || readOnly.includes("write_file")) fail("禁写时不该暴露编辑工具");
  if (!toolResultFailed("edit_file", "编辑失败：old_string 不存在")) fail("编辑失败应标红");
  if (!toolResultFailed("run_terminal", "exit 1\nboom")) fail("非零退出应标红");
  if (toolResultFailed("run_terminal", "exit 0\nok")) fail("退出 0 不该标红");
  if (toolResultFailed("read_file", "a.ts (3 lines, showing 1-3)")) fail("正常读取不该标红");

  // Skills：从工作区读，.agnes 优先于 .cursor，模型传的是技能名不是路径
  const skillRoot = path.join(tmp, "skillws");
  const mkSkill = (base: string, name: string, front: string, body = "正文") => {
    const dir = path.join(skillRoot, base, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${front}\n---\n\n${body}\n`);
    return dir;
  };
  mkSkill(".cursor", "shared", "name: 来自 cursor\ndescription: cursor 版本", "cursor 正文");
  mkSkill(".agnes", "shared", "name: 来自 agnes\ndescription: agnes 版本", "agnes 正文");
  const foldedDir = mkSkill(
    ".agnes",
    "folded",
    "name: 折叠描述\ndescription: >-\n  第一行\n  第二行",
    "折叠正文",
  );
  fs.writeFileSync(path.join(foldedDir, "extra.md"), "参考文件内容");
  fs.mkdirSync(path.join(skillRoot, ".agnes", "skills", "nofile"), { recursive: true });
  const skills = listSkills(skillRoot);
  if (skills.length !== 2) fail(`应扫到 2 个技能，实际 ${skills.length}`);
  const shared = skills.find((s) => s.name === "shared");
  if (shared?.title !== "来自 agnes") fail(".agnes 应覆盖同名的 .cursor 技能");
  const folded = skills.find((s) => s.name === "folded");
  if (folded?.description !== "第一行 第二行") fail("折叠式 description 应被拼成一行");
  if (!folded?.extras.includes("extra.md")) fail("同目录参考文件应被列出");
  if (!skillsPromptSection(skills).includes("read_skill")) fail("提示里应引导用 read_skill");
  if (skillsPromptSection([]) !== "") fail("没有技能时不该产出提示段落");
  if (!(await readSkill(skills, "folded")).includes("折叠正文")) fail("read_skill 应返回正文");
  if (!(await readSkill(skills, "folded", "extra.md")).includes("参考文件内容")) fail("应能读参考文件");
  if (!(await readSkill(skills, "不存在")).includes("没有这个技能")) fail("未知技能应给出可用清单");
  if (!(await readSkill(skills, "folded", "../../../etc/passwd")).includes("没有这个参考文件")) {
    fail("参考文件必须走白名单，不能拼路径");
  }
  if (listSkills(path.join(tmp, "no-such-dir")).length !== 0) fail("没有技能目录应返回空");
  if (parseFrontmatter("没有 frontmatter").name) fail("无 frontmatter 应返回空对象");
  if (!selectTools("chat", { allowTerminal: false, allowWrites: false, hasSkills: true }).some((t) => t.function.name === "read_skill")) {
    fail("对话模式有技能时也应挂 read_skill");
  }
  if (selectTools("agent", { allowTerminal: true, allowWrites: true }).some((t) => t.function.name === "read_skill")) {
    fail("没有技能时不该挂 read_skill");
  }

  // 多模态：只认 image 附件，脏数据要被丢掉
  if (parseAttachments(null).length !== 0) fail("空附件应解析为空数组");
  if (parseAttachments([{ type: "file", url: "x" }]).length !== 0) fail("非图片附件应被丢弃");
  if (parseAttachments([{ type: "image" }]).length !== 0) fail("没有来源的图片应被丢弃");
  const okPics = parseAttachments([
    { type: "image", mediaId: "m1", name: "a".repeat(300) },
    { type: "image", url: "https://x/y.png" },
  ]);
  if (okPics.length !== 2 || (okPics[0].name ?? "").length !== 120) fail("附件名应被截断");
  if (parseAttachments(Array.from({ length: 20 }, () => ({ type: "image", mediaId: "m" }))).length !== 6) {
    fail("附件数量应封顶 6 张");
  }
  const noData = parseAttachments([{ type: "image", mediaId: "m1", url: "data:image/png;base64,xxxx" }]);
  if (noData[0]?.url || noData[0]?.mediaId !== "m1") fail("data URL 不该写进附件，mediaId 要保留");
  if (mediaIdFromRef("https://api.example.com/api/media/media_abc") !== "media_abc") fail("应从绝对地址抽出 media id");
  if (mediaIdFromRef("/api/media/media_abc") !== "media_abc") fail("应从相对地址抽出 media id");
  if (mediaIdFromRef("https://cdn.example.com/foo.png")) fail("外链不该被当成自家媒体");

  // 卡密库存：明文入库可反复查看复制，但删除不能悄悄放掉已激活的卡
  const stockPlan = upsertPlan(planDb, {
    name: "库存测试卡",
    chatQuota: 10,
    imageQuota: 1,
    videoQuota: 1,
    durationDays: 30,
    priceYuan: 1,
    allowImage: true,
    allowVideo: true,
    allowAgent: true,
  });
  const stock = issueLicenses(planDb, { count: 3, planId: stockPlan.id });
  const listed = listLicenses(planDb, "", "unused");
  for (const key of stock) {
    const row = listed.find((r) => r.id === key.id);
    if (row?.code_plain !== key.code) fail("发出的卡密应能在列表里读到完整明文");
    if (getLicense(planDb, key.id)?.code_plain !== key.code) fail("详情应返回完整明文");
  }
  if (!listLicenses(planDb, stock[0].code).some((r) => r.id === stock[0].id)) fail("整串卡密应能搜到");
  const stockDev = "e5".repeat(32);
  activateLicense(planDb, stockDev, stock[0].code);
  const killed = deleteLicenses(planDb, [stock[0].id, stock[1].id]);
  if (killed.deleted !== 1 || killed.skipped !== 1) fail("批量删除应跳过已激活的卡");
  if (!getLicense(planDb, stock[0].id)) fail("已激活的卡不该被删掉");
  if (getLicense(planDb, stock[1].id)) fail("未使用的卡应被删掉");
  revokeLicense(planDb, stock[0].id);
  if (deleteLicenses(planDb, [stock[0].id]).deleted !== 1) fail("作废后应可删除");
  if (deleteLicenses(planDb, []).deleted !== 0) fail("空选择不该删任何东西");

  // 桌面端模型中转：令牌绑定单台设备，且必须先有授权才放行
  if (relayTokenFor("", deviceA)) fail("没有密钥时不该签出中转令牌");
  const relayA = relayTokenFor("relay-secret", deviceA);
  const relayB = relayTokenFor("relay-secret", deviceB);
  if (!relayA || relayA === relayB) fail("中转令牌必须绑定设备");
  if (!verifyRelayToken("relay-secret", deviceA, relayA)) fail("自己的令牌应校验通过");
  if (verifyRelayToken("relay-secret", deviceB, relayA)) fail("令牌不能跨设备复用");
  if (verifyRelayToken("other-secret", deviceA, relayA)) fail("换密钥后旧令牌应失效");
  if (verifyRelayToken("", deviceA, relayA)) fail("未开启中转时应一律拒绝");
  const ticket = issueChatTicket("relay-secret", deviceA, 1_000_000);
  if (!verifyChatTicket("relay-secret", deviceA, ticket.ticket, 1_000_000)) fail("刚签发的对话票据应有效");
  if (verifyChatTicket("relay-secret", deviceB, ticket.ticket, 1_000_000)) fail("对话票据不能跨设备");
  if (verifyChatTicket("relay-secret", deviceA, ticket.ticket, ticket.exp)) fail("过期瞬间票据应失效");
  if (verifyChatTicket("relay-secret", deviceA, chatTicketFor("other-secret", deviceA, ticket.exp), 1_000_000)) {
    fail("换密钥后旧票据应失效");
  }
  // 新版令牌：按天签发、30 天过期；旧版不过期令牌默认兼容，可以关；后台重置后之前的全部作废
  {
    const day = 20_000 * DAY_MS;
    const v2 = relayTokenFor("relay-secret", deviceA, day + 5_000);
    if (!v2.startsWith("r2.")) fail("新令牌应为 r2 格式");
    if (relayTokenFor("relay-secret", deviceA, day + 9_000) !== v2) fail("同一天内令牌应不变，客户端不必每次换");
    if (!verifyRelayToken("relay-secret", deviceA, v2, { now: day + 10 * DAY_MS })) fail("有效期内应通过");
    if (verifyRelayToken("relay-secret", deviceA, v2, { now: day + 31 * DAY_MS })) fail("过期令牌应拒绝");
    if (verifyRelayToken("relay-secret", deviceB, v2, { now: day + DAY_MS })) fail("r2 令牌不能跨设备");
    const forged = v2.replace(/^r2\.(\d+)\.(\d+)\./, (_m, iat: string, exp: string) => `r2.${Number(iat) + DAY_MS}.${Number(exp) + DAY_MS}.`);
    if (verifyRelayToken("relay-secret", deviceA, forged, { now: day + DAY_MS })) fail("改过时间的令牌应拒绝");
    const legacy = legacyRelayTokenFor("relay-secret", deviceA);
    if (!verifyRelayToken("relay-secret", deviceA, legacy)) fail("默认仍兼容已装好的老客户端令牌");
    if (verifyRelayToken("relay-secret", deviceA, legacy, { acceptLegacy: false })) fail("关掉兼容后旧令牌应拒绝");
    const resetAt = day + 2 * DAY_MS + 123;
    if (verifyRelayToken("relay-secret", deviceA, legacy, { notBefore: resetAt })) fail("重置过的设备不再认旧版令牌");
    if (verifyRelayToken("relay-secret", deviceA, v2, { notBefore: resetAt, now: resetAt + 1_000 })) fail("重置前签的令牌应作废");
    const fresh = relayTokenFor("relay-secret", deviceA, resetAt + 1_000, resetAt);
    if (!verifyRelayToken("relay-secret", deviceA, fresh, { notBefore: resetAt, now: resetAt + 1_000 })) fail("重置后新签的令牌应通过");
    resetRelayToken(planDb, deviceA, resetAt);
    if (relayNotBefore(planDb, deviceA) !== resetAt || relayNotBefore(planDb, deviceB) !== 0) fail("重置时间应按设备记");
  }
  resetRelayInflight();
  for (let i = 0; i < RELAY_MAX_INFLIGHT; i++) {
    if (!tryAcquireRelay(deviceA)) fail("并发上限内应能占用");
  }
  if (tryAcquireRelay(deviceA)) fail("超过每设备并发上限应拒绝");
  if (!tryAcquireRelay(deviceB)) fail("并发上限应按设备分开");
  releaseRelay(deviceA);
  if (!tryAcquireRelay(deviceA)) fail("释放后应能再占用");
  resetRelayInflight();
  const tooBig = await readBodyLimited(new Request("http://local/x", { method: "POST", body: "abcdef" }), 3);
  if (tooBig.ok) fail("超过体积上限的中继请求应拒绝");
  const small = await readBodyLimited(new Request("http://local/x", { method: "POST", body: "{\"a\":1}" }), 1000);
  if (!small.ok || small.text !== "{\"a\":1}") fail("正常体积的中继请求应读出正文");
  const relayNoDevice = await app.request("/api/relay/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${relayA}` },
    body: JSON.stringify({ model: "agnes-3.0-flash", messages: [] }),
  });
  if (relayNoDevice.status !== 400) fail("中转必须带设备码");
  const relayBadToken = await app.request("/api/relay/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agnes-device": deviceA, authorization: "Bearer nope" },
    body: JSON.stringify({ model: "agnes-3.0-flash", messages: [] }),
  });
  if (relayBadToken.status !== 401) fail("伪造的中转凭证应 401");
  const relayUnknownDevice = await app.request("/api/relay/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agnes-device": "9".repeat(64),
      authorization: `Bearer ${relayTokenFor(cfg.relaySecret, "9".repeat(64))}`,
    },
    body: JSON.stringify({ model: "agnes-3.0-flash", messages: [] }),
  });
  if (relayUnknownDevice.status !== 403) fail("没有授权的设备不该走中转");

  if (!shouldLogRequest("POST", "/api/conversations/abc/messages")) fail("log chat send");
  if (!shouldLogRequest("POST", "/api/images/generate")) fail("log image");
  if (!shouldLogRequest("POST", "/api/videos/generate")) fail("log video");
  if (!shouldLogRequest("POST", "/api/relay/videos")) fail("log relay video");
  if (!shouldLogRequest("POST", "/api/relay/images/generations")) fail("log relay image");
  if (!shouldLogRequest("POST", "/api/entitlements/trial")) fail("log trial");
  if (!shouldLogRequest("POST", "/api/entitlements/activate")) fail("log activate");
  if (!shouldLogRequest("POST", "/api/entitlements/beta-month")) fail("log beta claim");
  if (!shouldLogRequest("POST", "/api/feedbacks")) fail("log feedback");
  if (!shouldLogRequest("POST", "/api/auth")) fail("log auth");
  if (shouldLogRequest("GET", "/api/session")) fail("skip session poll");
  if (shouldLogRequest("GET", "/api/settings")) fail("skip settings fetch");
  if (shouldLogRequest("GET", "/api/conversations")) fail("skip conversation list");
  if (shouldLogRequest("GET", "/api/videos/abc")) fail("skip video poll");
  if (shouldLogRequest("GET", "/api/media")) fail("skip media list");
  if (shouldLogRequest("GET", "/api/updates/latest")) fail("skip update check");

  {
    const queue = new AgnesApiError(503, JSON.stringify({ error: { message: "busy", code: "video_queue_full" } }));
    if (!queue.message.includes("队列已满")) fail(`video_queue_full 应翻成中文: ${queue.message}`);
    if (publicError(queue, true) !== queue.message) fail("生产环境也应把上游队列满告诉用户，不能只写请求失败");
    if (publicError(new Error("secret"), true) !== "请求失败") fail("不相干的内部错误生产仍应藏住");
    const overflow = new AgnesApiError(400, JSON.stringify({ error: { message: "maximum context length exceeded" } }));
    if (!overflow.message.includes("上下文过长")) fail(`超长上下文应说明原因: ${overflow.message}`);
    if (isTransientNetworkError(overflow)) fail("上下文超长不应重试同一份正文");
    const busy = new AgnesApiError(503, "upstream unavailable");
    if (!busy.message.includes("暂时繁忙")) fail(`无详情的 503 仍应说繁忙: ${busy.message}`);
    if (!isTransientNetworkError(busy)) fail("对话流的 503 应重试");
    if (isTransientNetworkError(queue)) fail("视频队列满仍不能重试");
    const logged = upstreamErrorLog(new AgnesApiError(503, JSON.stringify({ error: { message: "overloaded", code: "busy" }, api_key: "sk-supersecretkey" })));
    if (!logged.includes("status=503") || !logged.includes("overloaded")) fail(`日志应留下上游原文: ${logged}`);
    if (logged.includes("supersecretkey")) fail("日志不能留下密钥");
  }

  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const handle of [db, dailyDb, refundDb, wsDb, planDb, providerDb]) {
    try {
      handle.close();
    } catch {
      /* 已经关过 */
    }
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.warn(`临时目录没删干净，请手动删除 ${tmp}: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("hardening checks passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
