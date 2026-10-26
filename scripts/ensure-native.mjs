import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findInstall(pkg) {
  const pnpmDir = path.join(root, "node_modules/.pnpm");
  if (!fs.existsSync(pnpmDir)) return null;
  for (const entry of fs.readdirSync(pnpmDir)) {
    if (!entry.startsWith(`${pkg}@`)) continue;
    const installJs = path.join(pnpmDir, entry, "node_modules", pkg, "install.js");
    if (fs.existsSync(installJs)) return installJs;
  }
  return null;
}

function runInstall(pkg) {
  const installJs = findInstall(pkg);
  if (!installJs) {
    console.warn(`skip ${pkg}: install.js not found`);
    return;
  }
  console.log(`running ${pkg} install.js`);
  const result = spawnSync(process.execPath, [installJs], {
    stdio: "inherit",
    cwd: path.dirname(installJs),
  });
  if (result.status !== 0) {
    console.warn(`${pkg} install exited ${result.status}`);
  }
}

runInstall("esbuild");
runInstall("electron");
