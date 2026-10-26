import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const desktop = path.join(root, "apps", "desktop");
const bundle = path.join(desktop, "bundle");
const defaultFeed = "";

function envVal(file, key) {
  if (!fs.existsSync(file)) return "";
  const m = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? String(m[1] || "").trim().replace(/\r$/, "").replace(/^["']|["']$/g, "") : "";
}

function publicUrl(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function run(cmd, args, cwd = root, extraEnv = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const dirOnly = process.argv.includes("--dir");
// --out <目录>：换输出目录（相对 apps/desktop）。发在线更新时用它避开正在运行的 release/win-unpacked
const outIdx = process.argv.indexOf("--out");
const outDir = outIdx >= 0 ? String(process.argv[outIdx + 1] || "").trim() : "";
const feed =
  publicUrl(process.env.AGNES_UPDATE_FEED) ||
  publicUrl(process.env.LICENSE_SERVER_URL) ||
  publicUrl(envVal(path.join(root, ".env"), "LICENSE_SERVER_URL")) ||
  publicUrl(envVal(path.join(root, ".env"), "PUBLIC_API_ORIGIN")) ||
  defaultFeed;
const license = publicUrl(process.env.LICENSE_SERVER_URL) || publicUrl(envVal(path.join(root, ".env"), "LICENSE_SERVER_URL")) || feed;

console.log(`update feed ${feed}`);
fs.rmSync(bundle, { recursive: true, force: true });
fs.mkdirSync(bundle, { recursive: true });

run("pnpm", ["--filter", "@agnes/web", "build"], root, { VITE_API_BASE: "" });
fs.cpSync(path.join(root, "apps", "web", "dist"), path.join(bundle, "web"), { recursive: true });

// esbuild leaves `require("os")` style calls in bundled CJS deps (fast-glob et al.) and its
// ESM shim throws on them, so hand it a real require plus the CJS path globals.
const cjsInteropBanner = [
  `import { createRequire as __agnesCreateRequire } from "node:module";`,
  `import { dirname as __agnesDirname } from "node:path";`,
  `import { fileURLToPath as __agnesFileURLToPath } from "node:url";`,
  `const require = __agnesCreateRequire(import.meta.url);`,
  `const __filename = __agnesFileURLToPath(import.meta.url);`,
  `const __dirname = __agnesDirname(__filename);`,
].join("\n");

await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(root, "packages", "server", "src", "listen.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(bundle, "server.mjs"),
  packages: "bundle",
  // sharp 是原生模块，asar 在线更新带不上它的二进制；桌面端预览图回落原图
  external: ["sharp"],
  legalComments: "none",
  sourcemap: false,
  banner: { js: cjsInteropBanner },
});

const builderArgs = [
  "exec",
  "electron-builder",
  "--win",
  "--x64",
];
if (feed) builderArgs.push(`-c.extraMetadata.agnesUpdateFeed=${feed}`);
if (license) builderArgs.push(`-c.extraMetadata.agnesLicenseServer=${license}`);
if (dirOnly) builderArgs.push("--dir");
if (outDir) builderArgs.push(`-c.directories.output=${outDir}`);
run("pnpm", builderArgs, desktop, { CSC_IDENTITY_AUTO_DISCOVERY: "false" });
const shown = `apps/desktop/${outDir || "release"}`;
console.log(dirOnly ? `unpacked at ${shown}/win-unpacked` : `zip + win-unpacked at ${shown}`);
