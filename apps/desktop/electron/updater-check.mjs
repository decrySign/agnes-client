import {
  PENDING_NAME,
  canAutoUpdate,
  cmpVersion,
  decideUpdate,
  formatDownloadProgress,
  formatUpdateError,
  isTempLikePath,
  writeApplyScript,
} from "./updater.mjs";
import { readReleaseNotes } from "../../../scripts/changelog.mjs";

let failed = 0;
function check(name, ok) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

check("0.1.1 比 0.1.0 新", cmpVersion("0.1.1", "0.1.0") === 1);
check("0.1.0 不比 0.1.0 新", cmpVersion("0.1.0", "0.1.0") === 0);
check("0.1.0 比 0.2.0 旧", cmpVersion("0.1.0", "0.2.0") === -1);
check("非 semver 当作相等", cmpVersion("dev", "0.1.0") === 0);

check("Temp 路径不更新", isTempLikePath("C:\\Users\\a\\AppData\\Local\\Temp\\abc\\Agnes.exe") === true);
check("固定目录可以更新", isTempLikePath("D:\\Agnes\\Agnes.exe") === false);
check("AppData Roaming 不是 Temp", isTempLikePath("C:\\Users\\a\\AppData\\Roaming\\Agnes") === false);

check(
  "源码不更新",
  canAutoUpdate({ packaged: false, env: {}, execPath: "D:\\Agnes\\x.exe", resourcesPath: "D:\\Agnes\\resources" }).ok ===
    false,
);
check(
  "AGNES_UPDATE=0 关闭",
  canAutoUpdate({
    packaged: true,
    env: { AGNES_UPDATE: "0" },
    execPath: "D:\\Agnes\\x.exe",
    resourcesPath: "D:\\Agnes\\resources",
  }).reason === "AGNES_UPDATE=0",
);
check(
  "portable SFX 不更新",
  canAutoUpdate({
    packaged: true,
    env: { PORTABLE_EXECUTABLE_DIR: "C:\\Temp\\x" },
    execPath: "D:\\Agnes\\x.exe",
    resourcesPath: "D:\\Agnes\\resources",
  }).reason === "portable-sfx",
);
check(
  "文件夹便携允许更新",
  canAutoUpdate({
    packaged: true,
    env: {},
    execPath: "D:\\Agnes\\Agnes.exe",
    resourcesPath: "D:\\Agnes\\resources",
  }).ok === true,
);

const sha = "a".repeat(64);
const base = { version: "0.1.1", sha256: sha, size: 12, electron: "38.1.2" };
check("有新版本则下载", decideUpdate(base, { version: "0.1.0", electron: "38.1.2" }).action === "download");
check("同版本跳过", decideUpdate(base, { version: "0.1.1", electron: "38.1.2" }).reason === "current");
check(
  "空清单跳过",
  decideUpdate({ ok: true, version: "", sha256: "", size: 0, electron: "" }, { version: "0.1.0", electron: "38.1.2" })
    .reason === "none",
);
check(
  "Electron 对不上跳过",
  decideUpdate(base, { version: "0.1.0", electron: "38.0.0" }).reason === "electron-mismatch",
);
check("坏 sha 跳过", decideUpdate({ ...base, sha256: "zz" }, { version: "0.1.0", electron: "38.1.2" }).reason === "bad-hash");

check("pending 不以 .asar 结尾（避免 Electron 拦截校验）", !PENDING_NAME.toLowerCase().endsWith(".asar"));
check(
  "ENOENT 当校验失败",
  formatUpdateError({ message: "ENOENT, not found in C:\\\\x\\\\pending-app.asar" }).startsWith("下载后校验失败"),
);
check("超时文案", formatUpdateError({ name: "AbortError" }) === "检查超时，请稍后重试");
check("取消更新文案", formatUpdateError({ code: "AGNES_UPDATE_CANCELLED" }) === "已取消更新");
{
  const half = formatDownloadProgress(512 * 1024, 1024 * 1024);
  check("下载进度一半", half.percent === 50 && half.detail.includes("50%") && half.detail.includes("512 KB"));
  check("未知总大小只显示已下载", formatDownloadProgress(2048, 0).percent === null);

const sampleLog = "# 更新日志\n\n## 0.1.2\n\n第二句。\n接着一句。\n\n## 0.1.1\n\n第一句。\n";
check("读到对应版本", readReleaseNotes(sampleLog, "0.1.2") === "第二句。\n接着一句。");
check("旧版本也能读", readReleaseNotes(sampleLog, "0.1.1") === "第一句。");
check("没有这一节就是空", readReleaseNotes(sampleLog, "0.1.3") === "");
}

const script = writeApplyScript({
  pid: 1234,
  src: "D:\\tmp\\pending-app.bin",
  dest: "D:\\Agnes\\resources\\app.asar",
  exe: "D:\\Agnes\\Agnes.exe",
  logFile: "D:\\tmp\\apply.log",
});
check("替换脚本含 Copy-Item", /Copy-Item/.test(script) && /-ErrorAction Stop/.test(script));
check("替换脚本含 Wait-Process", /Wait-Process -Id 1234/.test(script));
check("进程不退时强制结束", /taskkill\.exe \/PID 1234/.test(script));
check("路径单引号包裹", script.includes("'D:\\Agnes\\resources\\app.asar'"));
check("替换脚本源是 .bin", script.includes("'D:\\tmp\\pending-app.bin'"));

if (failed) {
  console.error(`updater checks failed: ${failed}`);
  process.exit(1);
}
console.log("updater checks passed");
