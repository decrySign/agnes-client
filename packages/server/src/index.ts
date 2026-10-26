import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { listenAgnes } from "./listen.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const envFiles = [
  path.join(repoRoot, ".env"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../../.env"),
];
const pinKeys = [
  "DATA_DIR",
  "HOST",
  "DESKTOP_MODE",
  "WORKSPACE_ROOT",
  "PORT",
  "LICENSE_SERVER_URL",
  "ALLOWED_IPS",
  "TRUST_PROXY",
  "TRUSTED_PROXIES",
  "ADMIN_HOST",
] as const;
const pinned = Object.fromEntries(pinKeys.map((key) => [key, process.env[key]]).filter(([, value]) => value !== undefined));
if (!process.env.AGNES_SKIP_DOTENV) {
  for (const file of envFiles) {
    if (fs.existsSync(file)) {
      loadEnv({ path: file, override: true });
      Object.assign(process.env, pinned);
      console.log(`loaded env ${file}`);
      break;
    }
  }
}

try {
  listenAgnes(repoRoot);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
