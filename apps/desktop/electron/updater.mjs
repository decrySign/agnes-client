import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";

const require = createRequire(import.meta.url);

export const FIRST_CHECK_MS = 20 * 1000;
export const EVERY_CHECK_MS = 6 * 60 * 60 * 1000;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** Electron 会把 *.asar 当压缩包拦截；pending 文件名不能以 .asar 结尾。 */
export const PENDING_NAME = "pending-app.bin";

let timer = null;
let inFlight = false;
let applying = false;

function log() {
  return {
    debug: (...args) => console.debug("[update]", ...args),
    info: (...args) => console.info("[update]", ...args),
    warn: (...args) => console.warn("[update]", ...args),
    error: (...args) => console.error("[update]", ...args),
  };
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function parseVer(raw) {
  const m = String(raw || "")
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function cmpVersion(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function isTempLikePath(p) {
  const n = String(p || "")
    .replace(/\//g, "\\")
    .toLowerCase();
  if (!n) return true;
  if (n.includes("\\appdata\\local\\temp\\")) return true;
  if (n.includes("\\windows\\temp\\")) return true;
  if (/\\temp\\/.test(n) || /\\tmp\\/.test(n)) return true;
  if (n.includes("\\nsm") || n.includes("\\nsis")) return true;
  return false;
}

export function isPortableSfx(env = process.env) {
  return Boolean(env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR);
}

export function canAutoUpdate({ packaged, env = process.env, execPath, resourcesPath } = {}) {
  if (String(env.AGNES_UPDATE || "") === "0") return { ok: false, reason: "AGNES_UPDATE=0" };
  if (!packaged) return { ok: false, reason: "unpackaged" };
  if (isPortableSfx(env)) return { ok: false, reason: "portable-sfx" };
  if (isTempLikePath(execPath) || isTempLikePath(resourcesPath)) return { ok: false, reason: "temp-install" };
  return { ok: true, reason: "" };
}

export function decideUpdate(manifest, { version, electron } = {}) {
  if (!manifest || !String(manifest.version || "").trim()) return { action: "skip", reason: "none" };
  const sha = String(manifest.sha256 || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) return { action: "skip", reason: "bad-hash" };
  if (!Number(manifest.size)) return { action: "skip", reason: "none" };
  const wantElectron = String(manifest.electron || "").trim();
  const haveElectron = String(electron || "").trim();
  if (!wantElectron || (haveElectron && wantElectron !== haveElectron)) {
    return { action: "skip", reason: "electron-mismatch" };
  }
  if (cmpVersion(manifest.version, version) <= 0) return { action: "skip", reason: "current" };
  return { action: "download", reason: "" };
}

export function writeApplyScript({ pid, src, dest, exe, logFile }) {
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    `function Log($m) { Add-Content -LiteralPath ${psQuote(logFile)} -Value ((Get-Date -Format o) + ' ' + $m) }`,
    `Log 'wait pid ${Number(pid)}'`,
    `try { Wait-Process -Id ${Number(pid)} -Timeout 20 -ErrorAction SilentlyContinue } catch {}`,
    `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) {`,
    "  Log 'still alive, taskkill'",
    `  & taskkill.exe /PID ${Number(pid)} /T /F | Out-Null`,
    "  Start-Sleep -Seconds 1",
    "}",
    "$ok = $false",
    "for ($i = 0; $i -lt 40; $i++) {",
    "  try {",
    `    Copy-Item -LiteralPath ${psQuote(src)} -Destination ${psQuote(dest)} -Force -ErrorAction Stop`,
    `    $srcLen = (Get-Item -LiteralPath ${psQuote(src)}).Length`,
    `    $dstLen = (Get-Item -LiteralPath ${psQuote(dest)}).Length`,
    "    if ($srcLen -ne $dstLen) { throw \"size $dstLen != $srcLen\" }",
    "    $ok = $true",
    "    break",
    "  } catch {",
    "    Log $_.Exception.Message",
    "    Start-Sleep -Milliseconds 500",
    "  }",
    "}",
    "if (-not $ok) { Log 'copy failed'; exit 1 }",
    "Log 'copied'",
    `Start-Process -FilePath ${psQuote(exe)}`,
    `Remove-Item -LiteralPath ${psQuote(src)} -Force -ErrorAction SilentlyContinue`,
    "Log 'relaunched'",
  ];
  return `${lines.join("\n")}\n`;
}

function spawnApply(scriptPath) {
  // 直接 spawn powershell 会留在 Electron 的 Windows Job 里，主进程一退出脚本就被杀掉，
  // app.asar 来不及换。cmd start 会把 powershell 拉出这个 Job。
  const child = spawn(
    "cmd.exe",
    [
      "/d",
      "/c",
      "start",
      "",
      "/min",
      "powershell.exe",
      "-NoProfile",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.on("error", (err) => log().error(`启动替换脚本失败: ${err.message}`));
  if (!child.pid) throw new Error("没有启动替换脚本");
  child.unref();
  log().info(`替换脚本已启动 pid ${child.pid}`);
}

/** 进度窗一旦 setClosable(false)，Windows 上 app.quit() 关不掉它，整个退出会被取消，窗口就停在「即将重启」。 */
function forceQuitForUpdate() {
  const { app, BrowserWindow } = require("electron");
  cancelAllowed = false;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.setClosable(true);
    } catch {
      /* ignore */
    }
  }
  const hardExit = setTimeout(() => {
    try {
      app.exit(0);
    } catch {
      /* ignore */
    }
  }, 1500);
  if (typeof hardExit.unref === "function") hardExit.unref();
  try {
    app.quit();
  } catch (err) {
    log().warn(`退出失败: ${err.message}`);
    try {
      app.exit(0);
    } catch {
      /* ignore */
    }
  }
}

function diskFs() {
  try {
    return require("original-fs");
  } catch {
    return fs;
  }
}

function sha256File(file) {
  const io = diskFs();
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = io.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function unlinkQuiet(file) {
  const io = diskFs();
  try {
    if (io.existsSync(file)) io.unlinkSync(file);
  } catch {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

export function formatUpdateError(err) {
  if (err && err.code === "AGNES_UPDATE_CANCELLED") return "已取消更新";
  if (err && err.name === "AbortError") return "检查超时，请稍后重试";
  const msg = String(err?.message || err);
  if (/ENOENT|not found in/i.test(msg)) return `下载后校验失败：${msg}`;
  return `检查失败：${msg}`;
}

export function formatBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** 给进度窗和任务栏用。total 未知时 percent 为 null，只显示已下载大小。 */
export function formatDownloadProgress(received, total) {
  const got = formatBytes(received);
  const size = Number(total) || 0;
  if (size <= 0) return { percent: null, detail: `已下载 ${got}` };
  const percent = Math.max(0, Math.min(100, Math.round((Number(received) / size) * 100)));
  return { percent, detail: `${got} / ${formatBytes(size)} · ${percent}%` };
}

const PROGRESS_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Agnes 更新</title>
<style>
  html,body { margin:0; background:#16161c; color:#f4f4f5; font-family:"Segoe UI",system-ui,sans-serif; }
  main { padding:22px 24px 18px; }
  h1 { margin:0; font-size:15px; font-weight:650; }
  #notes { margin:10px 0 0; font-size:13px; line-height:1.45; color:#e4e4e7; white-space:pre-wrap; }
  #notes[hidden] { display:none; }
  p { margin:8px 0 0; min-height:18px; font-size:13px; color:#a1a1aa; }
  .track { margin-top:16px; height:8px; border-radius:99px; background:#2a2933; overflow:hidden; }
  .bar { height:100%; width:0%; background:#7c6af7; transition:width .15s linear; }
  .bar.indeterminate { width:40%; animation:slide 1.1s ease-in-out infinite; }
  @keyframes slide { 0% { transform:translateX(-120%); } 100% { transform:translateX(280%); } }
</style></head>
<body><main>
  <h1 id="title">正在准备更新</h1>
  <p id="notes" hidden></p>
  <p id="detail">请稍候，下载完成前不会关闭 Agnes</p>
  <div class="track"><div id="bar" class="bar"></div></div>
</main>
<script>
  window.__agnesProgress = (state) => {
    document.getElementById("title").textContent = state.title || "";
    const notes = document.getElementById("notes");
    if (state.notes) {
      notes.textContent = state.notes;
      notes.hidden = false;
    }
    document.getElementById("detail").textContent = state.detail || "";
    const bar = document.getElementById("bar");
    if (typeof state.percent === "number") {
      bar.classList.remove("indeterminate");
      bar.style.width = Math.max(0, Math.min(100, state.percent)) + "%";
    } else {
      bar.classList.add("indeterminate");
      bar.style.width = "40%";
    }
  };
</script></body></html>`;

let progressWin = null;
let progressReady = null;
let progressNotes = "";
let downloadAbort = null;
let cancelAllowed = false;
let cancelledByUser = false;

function taskbarProgress(percent) {
  const { BrowserWindow } = require("electron");
  for (const win of BrowserWindow.getAllWindows()) {
    if (progressWin && win === progressWin) continue;
    try {
      if (percent == null) win.setProgressBar(0, { mode: "indeterminate" });
      else if (percent < 0) win.setProgressBar(-1, { mode: "none" });
      else win.setProgressBar(Math.min(1, Math.max(0, percent / 100)), { mode: "normal" });
    } catch {
      /* 旧内核没有 mode 参数时退回数字 */
      try {
        win.setProgressBar(percent == null ? 0 : percent < 0 ? -1 : Math.min(1, Math.max(0, percent / 100)));
      } catch {
        /* ignore */
      }
    }
  }
}

function openProgressWindow() {
  const { BrowserWindow } = require("electron");
  if (progressWin && !progressWin.isDestroyed()) {
    progressWin.show();
    return progressWin;
  }
  cancelAllowed = true;
  progressWin = new BrowserWindow({
    width: 440,
    height: 176,
    title: "Agnes 更新",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: "#16161c",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  progressWin.setMenuBarVisibility(false);
  progressReady = new Promise((resolve) => {
    progressWin.webContents.once("did-finish-load", () => resolve());
  });
  progressWin.on("closed", () => {
    progressWin = null;
    progressReady = null;
    if (!cancelAllowed) return;
    cancelledByUser = true;
    try {
      downloadAbort?.();
    } catch {
      /* ignore */
    }
  });
  void progressWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PROGRESS_HTML)}`);
  progressWin.once("ready-to-show", () => {
    if (!progressWin || progressWin.isDestroyed()) return;
    if (progressNotes) progressWin.setContentSize(440, 252);
    progressWin.show();
  });
  return progressWin;
}

async function paintProgress(state) {
  const win = openProgressWindow();
  if (progressReady) await progressReady;
  if (!win || win.isDestroyed()) return;
  taskbarProgress(typeof state.percent === "number" ? state.percent : null);
  const payload = JSON.stringify({
    title: String(state.title || ""),
    detail: String(state.detail || ""),
    notes: progressNotes,
    percent: typeof state.percent === "number" ? state.percent : null,
  });
  await win.webContents.executeJavaScript(`window.__agnesProgress(${payload})`);
}

function lockProgressWindow() {
  cancelAllowed = false;
}

async function writeResponseFile(res, destPath, onProgress) {
  const tmp = `${destPath}.part`;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  const headerTotal = Number(res.headers.get("content-length")) || 0;
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let lastPaint = 0;
  const pump = async (chunk) => {
    received += chunk.length;
    if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    const now = Date.now();
    if (onProgress && now - lastPaint >= 150) {
      lastPaint = now;
      await onProgress(received, headerTotal);
    }
  };
  try {
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await pump(Buffer.from(value));
      }
    } else if (res.body && typeof Readable.fromWeb === "function") {
      for await (const chunk of Readable.fromWeb(res.body)) {
        await pump(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } else {
      await pump(Buffer.from(await res.arrayBuffer()));
    }
    if (onProgress) await onProgress(received, headerTotal);
    await new Promise((resolve, reject) => {
      out.once("error", reject);
      out.end(() => resolve());
    });
  } catch (err) {
    out.destroy();
    unlinkQuiet(tmp);
    throw err;
  }
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  fs.renameSync(tmp, destPath);
}

async function fetchJson(url, timeoutMs) {
  const { net } = require("electron");
  const controller = new AbortController();
  const clock = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { method: "GET", signal: controller.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`响应不是 JSON（HTTP ${res.status}）`);
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(clock);
  }
}

async function fetchFile(url, destPath, timeoutMs, onProgress) {
  const { net } = require("electron");
  const controller = new AbortController();
  downloadAbort = () => {
    const err = new Error("已取消更新");
    err.code = "AGNES_UPDATE_CANCELLED";
    err.name = "AbortError";
    controller.abort(err);
  };
  const clock = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { method: "GET", signal: controller.signal });
    if (res.status === 404) {
      const err = new Error("没有更新包");
      err.code = "AGNES_UPDATE_NONE";
      throw err;
    }
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    await writeResponseFile(res, destPath, onProgress);
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason && controller.signal.reason.code === "AGNES_UPDATE_CANCELLED") {
      throw controller.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(clock);
    downloadAbort = null;
  }
}

export function readFeedUrl() {
  try {
    const pkg = require("../package.json");
    const baked = "".trim().replace(/\/+$/, "");
    if (baked) return baked;
  } catch {
    /* unpackaged tests */
  }
  return String(process.env.AGNES_UPDATE_FEED || process.env.LICENSE_SERVER_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

const GATE_MSG = {
  "AGNES_UPDATE=0": "已用 AGNES_UPDATE=0 关闭更新",
  unpackaged: "开发模式不会在线更新，请用解压后的 zip 客户端",
  "portable-sfx": "自解压包不能在线更新，请改用文件夹 zip",
  "temp-install": "装在临时目录里，不会在线更新",
};

async function checkOnce() {
  if (inFlight || applying) {
    return { status: "busy", message: applying ? "正在安装更新并重启" : "正在检查或下载更新" };
  }
  const { app } = require("electron");
  const gate = canAutoUpdate({
    packaged: app.isPackaged,
    env: process.env,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
  });
  if (!gate.ok) {
    return { status: "disabled", message: GATE_MSG[gate.reason] || `当前不能自动更新（${gate.reason}）` };
  }

  const base = readFeedUrl();
  if (!base || /^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/i.test(base)) {
    log().debug("未配置更新源，跳过");
    return { status: "disabled", message: "没有配置更新源（打包时应写入 AGNES_UPDATE_FEED）" };
  }

  inFlight = true;
  cancelledByUser = false;
  progressNotes = "";
  try {
    const { status, body } = await fetchJson(`${base}/api/updates/latest`, 15_000);
    if (status !== 200 || !body) {
      log().warn(`更新检查失败 HTTP ${status}`);
      return { status: "error", message: `检查失败 HTTP ${status}` };
    }
    const verdict = decideUpdate(body, {
      version: app.getVersion(),
      electron: process.versions.electron,
    });
    if (verdict.action !== "download") {
      if (verdict.reason === "electron-mismatch") {
        log().warn(
          `有新版本 ${body.version} 但 Electron 是 ${body.electron}（本机 ${process.versions.electron}），需要整份 zip，不换 asar`,
        );
        return {
          status: "mismatch",
          message: `有新版本 ${body.version}，但 Electron 内核变了，需要重新下载整份 zip，不能只换程序包`,
          version: body.version,
        };
      }
      if (verdict.reason === "current") {
        log().debug("无需更新 (current)");
        return { status: "current", message: `已是最新版本 ${app.getVersion()}`, version: app.getVersion() };
      }
      if (verdict.reason === "none") {
        log().debug("无需更新 (none)");
        return { status: "none", message: "服务器上还没有发布更新包。运营侧需 pack 后 publish-update，并把 latest.json / app.asar 放到生产 /data/updates。" };
      }
      log().info(`跳过更新: ${verdict.reason}`);
      return { status: "skip", message: `暂不更新（${verdict.reason}）` };
    }

    const pendingDir = path.join(app.getPath("userData"), "update");
    const pending = path.join(pendingDir, PENDING_NAME);
    unlinkQuiet(path.join(pendingDir, "pending-app.asar"));
    unlinkQuiet(pending);
    const expected = Number(body.size) || 0;
    progressNotes = String(body.notes || "")
      .replace(/\r/g, "")
      .trim()
      .slice(0, 500);
    log().info(`发现 ${body.version}，开始下载 asar (${body.size} bytes)`);
    await paintProgress({
      title: `发现新版本 ${body.version}`,
      detail: expected ? `准备下载 ${formatBytes(expected)}` : "准备下载更新包",
      percent: 0,
    });
    if (cancelledByUser) {
      taskbarProgress(-1);
      return { status: "cancelled", message: "已取消更新", handled: true };
    }
    await fetchFile(`${base}/api/updates/package`, pending, DOWNLOAD_TIMEOUT_MS, async (received, headerTotal) => {
      const view = formatDownloadProgress(received, headerTotal || expected);
      await paintProgress({
        title: `正在下载 ${body.version}`,
        detail: view.detail,
        percent: view.percent ?? 0,
      });
    });
    await paintProgress({
      title: `正在校验 ${body.version}`,
      detail: "下载完成，校验通过后才会重启",
      percent: 100,
    });
    const got = await sha256File(pending);
    if (got !== String(body.sha256).toLowerCase()) {
      unlinkQuiet(pending);
      log().error("更新包校验失败，已丢弃");
      taskbarProgress(-1);
      await paintProgress({
        title: "更新失败",
        detail: "更新包校验失败，已丢弃。可以关掉这个窗口，稍后再试。",
        percent: 0,
      });
      return { status: "error", message: "更新包校验失败，已丢弃，请稍后重试", handled: true };
    }

    if (process.platform !== "win32") {
      log().warn("当前系统不支持自动替换 asar");
      taskbarProgress(-1);
      await paintProgress({
        title: "更新失败",
        detail: "当前系统不支持自动替换程序包。可以关掉这个窗口。",
        percent: 0,
      });
      return { status: "error", message: "当前系统不支持自动替换程序包", handled: true };
    }

    const dest = path.join(process.resourcesPath, "app.asar");
    const scriptPath = path.join(pendingDir, "apply.ps1");
    const logFile = path.join(pendingDir, "apply.log");
    fs.writeFileSync(
      scriptPath,
      writeApplyScript({
        pid: process.pid,
        src: pending,
        dest,
        exe: process.execPath,
        logFile,
      }),
      "utf8",
    );
    applying = true;
    lockProgressWindow();
    await paintProgress({
      title: `即将重启安装 ${body.version}`,
      detail: "更新包已校验通过。窗口会关掉几秒，然后自动打开新版本。",
      percent: 100,
    });
    spawnApply(scriptPath);
    log().info(`asar 已就绪，即将退出并换成 ${body.version}`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    forceQuitForUpdate();
    return { status: "downloading", message: `发现 ${body.version}，正在重启安装`, version: body.version, handled: true };
  } catch (err) {
    if (cancelledByUser || (err && err.code === "AGNES_UPDATE_CANCELLED")) {
      log().info("用户关掉了更新窗口，已取消下载");
      taskbarProgress(-1);
      return { status: "cancelled", message: "已取消更新", handled: true };
    }
    taskbarProgress(-1);
    if (progressWin && !progressWin.isDestroyed()) {
      await paintProgress({
        title: "更新失败",
        detail: `${formatUpdateError(err)}。可以关掉这个窗口。`,
        percent: 0,
      }).catch(() => {});
    }
    if (err && err.name === "AbortError") log().warn("更新检查超时");
    else log().warn(`更新检查失败: ${err.message}`);
    return {
      status: "error",
      message: formatUpdateError(err),
      handled: Boolean(progressWin && !progressWin.isDestroyed()),
    };
  } finally {
    inFlight = false;
  }
}

function schedule(delayMs) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    checkOnce()
      .catch(() => {})
      .finally(() => {
        if (!applying) schedule(EVERY_CHECK_MS);
      });
  }, delayMs);
  if (timer && typeof timer.unref === "function") timer.unref();
}

export function start() {
  const { app } = require("electron");
  const gate = canAutoUpdate({
    packaged: app.isPackaged,
    env: process.env,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
  });
  if (!gate.ok) {
    log().info(`自动更新关闭（${gate.reason}）`);
    return;
  }
  if (!readFeedUrl()) {
    log().info("自动更新关闭（无更新源）");
    return;
  }
  log().info("自动更新已开启，约 20 秒后首次检查");
  schedule(FIRST_CHECK_MS);
}

export function stop() {
  clearTimeout(timer);
  timer = null;
}

export { checkOnce };
