import { app, Menu, dialog, shell, clipboard } from "electron";
import fs from "node:fs";
import * as updater from "./updater.mjs";
import { logDir } from "./log.mjs";

function updateMessage(result) {
  if (result?.status === "current") {
    return `已是最新版本 ${result.version || app.getVersion()}`;
  }
  if (result?.status === "downloading") {
    return "发现新版本，正在重启安装";
  }
  return result?.message || "检查更新失败";
}

async function checkForUpdates() {
  try {
    const result = await updater.checkOnce();
    if (result?.handled) return;
    await dialog.showMessageBox({
      type: result?.status === "error" ? "error" : "info",
      title: "检查更新",
      message: updateMessage(result),
      buttons: ["确定"],
      defaultId: 0,
      noLink: true,
    });
  } catch (err) {
    await dialog.showMessageBox({
      type: "error",
      title: "检查更新",
      message: err instanceof Error ? err.message : String(err),
      buttons: ["确定"],
      defaultId: 0,
      noLink: true,
    });
  }
}

function openDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
}

function aboutText() {
  return [
    "Agnes",
    `版本 ${app.getVersion()}`,
    `Electron ${process.versions.electron}`,
    `Node ${process.versions.node}`,
    "Agnes 桌面客户端 · 本机对话与 Agent 工作区",
  ].join("\n");
}

async function showAbout() {
  const text = aboutText();
  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "关于 Agnes",
    message: "Agnes",
    detail: [
      `版本 ${app.getVersion()}`,
      `Electron ${process.versions.electron}`,
      `Node ${process.versions.node}`,
      "",
      "Agnes 桌面客户端 · 本机对话与 Agent 工作区",
    ].join("\n"),
    buttons: ["确定", "复制信息"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response === 1) clipboard.writeText(text);
}

export function buildMenu() {
  const template = [];

  if (process.platform === "darwin") {
    template.push({ role: "appMenu" });
  }

  template.push({
    label: "编辑",
    submenu: [
      { label: "撤销", role: "undo" },
      { label: "重做", role: "redo" },
      { type: "separator" },
      { label: "剪切", role: "cut" },
      { label: "复制", role: "copy" },
      { label: "粘贴", role: "paste" },
      { label: "全选", role: "selectAll" },
    ],
  });

  const windowSubmenu = [
    { label: "最小化", role: "minimize" },
    { label: "缩放", role: "zoom" },
    { label: "关闭", role: "close" },
    { type: "separator" },
    { label: "重新加载", role: "reload" },
  ];
  if (!app.isPackaged) {
    windowSubmenu.push({ label: "开发者工具", role: "toggleDevTools" });
  }

  template.push({
    label: "窗口",
    submenu: windowSubmenu,
  });

  template.push({
    label: "帮助",
    submenu: [
      { label: "检查更新…", click: () => void checkForUpdates() },
      { label: "打开日志目录", click: () => void openDir(logDir()) },
      { label: "打开数据目录", click: () => void openDir(app.getPath("userData")) },
      { type: "separator" },
      { label: "官网", click: () => void shell.openExternal("https://www.agnes-ai.com") },
      { type: "separator" },
      { label: "关于 Agnes", click: () => void showAbout() },
    ],
  });

  return Menu.buildFromTemplate(template);
}
