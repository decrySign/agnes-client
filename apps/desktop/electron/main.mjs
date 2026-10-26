import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from "electron";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFileLog, logDir } from "./log.mjs";
import { buildMenu } from "./menu.mjs";
import * as updater from "./updater.mjs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const pkg = require("../package.json");

function bakedUpdateFeed() {
  // OSS build: no baked commercial update feed.
  return "";
}

function bakedLicenseServer() {
  // OSS build: always local authority; user supplies AGNES_API_KEY.
  return "";
}

function configPath() {
  return path.join(app.getPath("userData"), "agnes-config.json");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
}

function assertLocalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("桌面端启动地址无效");
  }
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("桌面端只允许打开本机地址，对话记录不会发到远程服务器");
  }
}

function readInstallId() {
  const file = path.join(app.getPath("userData"), "device.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed.installId && typeof parsed.installId === "string") return parsed.installId;
  } catch {
    /* first run */
  }
  const installId = randomUUID();
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ installId }, null, 2));
  return installId;
}

function readMachineGuid() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      });
      return out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1] || "";
    }
    if (process.platform === "darwin") {
      const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 3000 });
      return out.match(/IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || "";
    }
    return fs.readFileSync("/etc/machine-id", "utf8").trim();
  } catch {
    return "";
  }
}

function readCpuHint() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("wmic", ["cpu", "get", "ProcessorId", "/value"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      });
      return out.match(/ProcessorId=(\S+)/i)?.[1] || "";
    }
  } catch {
    return "";
  }
  return "";
}

function deviceHash() {
  const raw = `agnes-device:v1:${readInstallId()}:${readMachineGuid()}:${readCpuHint()}`;
  return createHash("sha256").update(raw).digest("hex");
}

function decryptKey(enc) {
  if (!enc || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return "";
  }
}

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

let serverChild = null;
let serverHandle = null;
const apiPort = process.env.PORT || "8787";

function applyDesktopEnv(apiKey, workspaceRoot) {
  const dataDir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DESKTOP_MODE = "1";
  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(apiPort);
  process.env.DATA_DIR = dataDir;
  process.env.WORKSPACE_ROOT = workspaceRoot || path.join(dataDir, "workspace");
  process.env.AGNES_SKIP_DOTENV = "1";
  if (apiKey) process.env.AGNES_API_KEY = apiKey;
  const license = bakedLicenseServer();
  if (license) process.env.LICENSE_SERVER_URL = license;
  const feed = bakedUpdateFeed();
  if (feed) process.env.AGNES_UPDATE_FEED = feed;
}

function startDevServer(apiKey, workspaceRoot) {
  applyDesktopEnv(apiKey, workspaceRoot);
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  serverChild = spawn(pnpm, ["--filter", "@agnes/server", "dev"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: true,
  });
}

async function startPackagedServer(apiKey, workspaceRoot) {
  applyDesktopEnv(apiKey, workspaceRoot);
  process.env.NODE_ENV = "production";
  process.env.WEB_DIST = path.join(app.getAppPath(), "bundle", "web");
  const serverPath = path.join(app.getAppPath(), "bundle", "server.mjs");
  // 服务跑在主进程里：把系统钥匙串（Windows DPAPI / macOS Keychain）借给它加密自定义模型的 API 密钥
  globalThis.agnesSecretBox = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (enc) => safeStorage.decryptString(Buffer.from(enc, "base64")),
  };
  const mod = await import(pathToFileURL(serverPath).href);
  serverHandle = mod.listenAgnes(app.getAppPath());
}

async function createWindow() {
  const cfg = readConfig();
  const apiKey = decryptKey(cfg.apiKeyEnc) || process.env.AGNES_API_KEY || "";
  const workspaceRoot = cfg.workspaceRoot || "";
  const startUrl = app.isPackaged
    ? `http://127.0.0.1:${apiPort}`
    : process.env.ELECTRON_START_URL || "http://127.0.0.1:5173";
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  assertLocalUrl(startUrl);
  assertLocalUrl(apiOrigin);

  if (!process.env.AGNES_SKIP_SPAWN_SERVER) {
    if (app.isPackaged) await startPackagedServer(apiKey, workspaceRoot);
    else startDevServer(apiKey, workspaceRoot);
  }
  try {
    await waitFor(`${apiOrigin}/api/health`);
  } catch (err) {
    if (app.isPackaged) {
      dialog.showErrorBox("Agnes", err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
  }
  if (!app.isPackaged && startUrl.includes("5173")) {
    await waitFor(startUrl).catch(() => {});
  }

  const iconPath = path.join(__dirname, "../build/icon.png");
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    title: "Agnes",
    backgroundColor: "#0c0d10",
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on("page-title-updated", (event) => {
    event.preventDefault();
  });
  Menu.setApplicationMenu(buildMenu());
  await win.loadURL(startUrl);
}

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

app.whenReady().then(async () => {
  installFileLog();
  ipcMain.handle("pick-folder", async (_evt, opts) => {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (res.canceled || !res.filePaths[0]) return null;
    // 给单个 Agent 对话挑目录时不要覆盖全局默认工作区
    if (opts?.remember !== false) writeConfig({ workspaceRoot: res.filePaths[0] });
    return res.filePaths[0];
  });
  ipcMain.handle("save-secret", async (_evt, apiKey) => {
    if (!apiKey) return;
    if (safeStorage.isEncryptionAvailable()) {
      writeConfig({ apiKeyEnc: safeStorage.encryptString(apiKey).toString("base64") });
    } else {
      writeConfig({ apiKeyEnc: Buffer.from(apiKey, "utf8").toString("base64") });
    }
  });
  ipcMain.handle("device-hash", async () => deviceHash());
  ipcMain.handle("app-version", async () => app.getVersion());
  ipcMain.handle("check-update", async () => updater.checkOnce());
  ipcMain.handle("open-logs", async () => {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  try {
    await createWindow();
  } catch (err) {
    // Without this the app would stay alive with no window and no visible reason.
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    console.error("[startup]", detail);
    dialog.showErrorBox("Agnes 启动失败", detail);
    app.exit(1);
    return;
  }
  updater.start();
});

app.on("before-quit", () => {
  updater.stop();
});

app.on("window-all-closed", () => {
  serverChild?.kill();
  void serverHandle?.close?.();
  if (process.platform !== "darwin") app.quit();
});
