import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const desktopRoot = path.join(root, "apps", "desktop");
const profile = path.join(os.tmpdir(), "agnes-make-icon-profile");

if (!process.versions.electron) {
  fs.mkdirSync(profile, { recursive: true });
  const require = createRequire(path.join(desktopRoot, "package.json"));
  const electronBin = require("electron");
  const child = spawn(
    electronBin,
    ["--disable-gpu", "--force-device-scale-factor=1", `--user-data-dir=${profile}`, __filename],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env },
    },
  );
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
} else {
  const require = createRequire(import.meta.url);
  const { app, BrowserWindow } = require("electron");
  const watchdog = setTimeout(() => {
    console.error("[make-icon] timed out");
    app.exit(1);
  }, 25_000);
  app
    .whenReady()
    .then(() => paintIcons(app, BrowserWindow, watchdog))
    .catch((err) => {
      console.error(err);
      app.exit(1);
    });
}

async function paintIcons(app, BrowserWindow, watchdog) {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; width: 512px; height: 512px; overflow: hidden; background: transparent; }
  svg { display: block; width: 512px; height: 512px; }
</style>
</head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112.64" ry="112.64" fill="#7c6af7"/>
  <path fill="#ffffff" fill-rule="evenodd" d="M256 88L444 424H348L308 328H204L164 424H68Z M256 168L298 272H214Z"/>
</svg>
</body>
</html>`;

  const win = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    useContentSize: true,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  let image = await win.webContents.capturePage();
  const size = image.getSize();
  if (size.width !== 512 || size.height !== 512) {
    image = image.resize({ width: 512, height: 512 });
  }

  const iconDir = path.join(desktopRoot, "build");
  const faviconDir = path.join(root, "apps", "web", "public");
  fs.mkdirSync(iconDir, { recursive: true });
  fs.mkdirSync(faviconDir, { recursive: true });

  const iconPath = path.join(iconDir, "icon.png");
  const faviconPath = path.join(faviconDir, "favicon.png");
  fs.writeFileSync(iconPath, image.toPNG());
  fs.writeFileSync(faviconPath, image.resize({ width: 256, height: 256 }).toPNG());

  console.log(`wrote ${iconPath} (${fs.statSync(iconPath).size} bytes)`);
  console.log(`wrote ${faviconPath} (${fs.statSync(faviconPath).size} bytes)`);
  clearTimeout(watchdog);
  win.destroy();
  app.exit(0);
}
