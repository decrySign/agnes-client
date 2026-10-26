import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killTree } from "./proc.js";

const SCRIPT_NAMES = ["typecheck", "type-check", "tsc"] as const;

function packageManager(root: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

/**
 * 认出项目的类型检查命令。只认固定脚本名，不把 package.json 里的脚本正文拼进 shell。
 * 没有脚本时，本机已经装了 tsc 才跑 `tsc --noEmit`，不通过 npx 现装。
 */
export function typecheckCommand(root: string): { command: string; label: string } | null {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    scripts = {};
  }
  const scriptName = SCRIPT_NAMES.find((name) => typeof scripts[name] === "string");
  if (scriptName) {
    const pm = packageManager(root);
    const command = pm === "npm" || pm === "bun" ? `${pm} run ${scriptName}` : `${pm} ${scriptName}`;
    return { command, label: command };
  }
  if (!fs.existsSync(path.join(root, "tsconfig.json"))) return null;
  const bin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (!fs.existsSync(bin)) return null;
  return { command: `"${bin}" --noEmit --pretty false --incremental false`, label: "tsc --noEmit" };
}

/** 跑类型检查，只把输出尾部交回。超时或非 0 退出都算没过。 */
export function runTypecheck(
  root: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const tail = (out.length > 5000 ? out.slice(-5000) : out).trim();
      resolve({ ok, tail: tail || (ok ? "" : "无输出") });
    };
    try {
      child = spawn(command, {
        cwd: root,
        shell: true,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
    } catch (err) {
      resolve({ ok: false, tail: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      out += "\n[类型检查超时]";
      killTree(child.pid);
      finish(false);
    }, timeoutMs);
    const onAbort = () => {
      out += "\n[已停止]";
      killTree(child.pid);
      finish(false);
    };
    const append = (buf: Buffer) => {
      out += buf.toString("utf8");
      if (out.length > 80_000) out = out.slice(-80_000);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      out += err.message;
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
  });
}
