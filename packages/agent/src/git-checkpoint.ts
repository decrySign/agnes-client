import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolRuntime } from "./types.js";
import { killTree } from "./proc.js";

const COMMIT_NAME = "Agnes";
const COMMIT_EMAIL = "agnes-agent@local";
const VERSION_MS = 2500;
const COMMIT_MS = 20_000;
const INSTALL_MS = 12 * 60_000;

let cachedBin: string | null | undefined;

export function resetGitBinCache(): void {
  cachedBin = undefined;
}

export function gitInstallPlan(): { command: string; hint: string; canAutoInstall: boolean } {
  if (process.platform === "win32") {
    return {
      command: "winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements",
      hint: "会调用 Windows 的 winget 安装官方 Git。安装过程可能弹出系统权限确认。装好后 Agent 每次改文件都会在本机提交一条记录，方便你用 git log / git revert 回退。",
      canAutoInstall: true,
    };
  }
  if (process.platform === "darwin") {
    return {
      command: "brew install git",
      hint: "会用 Homebrew 安装 Git。装好后 Agent 每次改文件都会提交，方便回退。",
      canAutoInstall: true,
    };
  }
  return {
    command: "sudo apt-get install -y git",
    hint: "Linux 安装 Git 需要管理员权限，请自己执行（Debian/Ubuntu: sudo apt-get install git）。Agent 不会代你跑 sudo。装好后点「我已装好」。",
    canAutoInstall: false,
  };
}

function gitCandidates(): string[] {
  const extra =
    process.platform === "win32"
      ? [
          "git.exe",
          "C:\\Program Files\\Git\\cmd\\git.exe",
          "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
          path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "cmd", "git.exe"),
        ]
      : ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"];
  return [...new Set([process.env.GIT_BIN, "git", ...extra].filter((x): x is string => Boolean(x)))];
}

function runGit(bin: string, cwd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      });
    } catch (err) {
      resolve({ code: -1, out: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    const append = (buf: Buffer) => {
      out += buf.toString("utf8");
      if (out.length > 80_000) {
        out = `${out.slice(0, 80_000)}\n…(truncated)`;
        child.kill();
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.trim() });
    });
  });
}

async function gitWorks(bin: string): Promise<boolean> {
  const r = await runGit(bin, os.tmpdir(), ["--version"], VERSION_MS);
  return r.code === 0 && /git version/i.test(r.out);
}

export async function findGitBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  for (const bin of gitCandidates()) {
    if (bin.includes("\\") || bin.includes("/")) {
      if (!fs.existsSync(bin)) continue;
    }
    if (await gitWorks(bin)) {
      cachedBin = bin;
      return bin;
    }
  }
  cachedBin = null;
  return null;
}

function note(runtime: ToolRuntime, id: string, args: Record<string, unknown>, result: string, ok = true): void {
  runtime.emit({ type: "tool_start", id, name: "git_checkpoint", args });
  runtime.emit({ type: "tool_end", id, name: "git_checkpoint", result, ok });
}

function runShell(command: string, cwd: string, onChunk: (s: string) => void, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0" } });
    } catch (err) {
      resolve({ code: -1, out: err instanceof Error ? err.message : String(err) });
      return;
    }
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out });
    };
    const append = (buf: Buffer) => {
      if (settled) return;
      const text = buf.toString("utf8");
      out += text;
      onChunk(text);
      if (out.length > 200_000) {
        out = `${out.slice(0, 200_000)}\n…(truncated)`;
        killTree(child.pid);
      }
    };
    // winget 这类安装器会拉起子进程握着管道，杀 shell 后 close 不一定来，所以按进程树杀并限时收尾
    const timer = setTimeout(() => {
      killTree(child.pid);
      onChunk(`\n[timeout ${timeoutMs}ms]\n`);
      setTimeout(() => finish(-1), 1500);
    }, timeoutMs);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      out += err.message;
      finish(-1);
    });
    child.on("exit", (code) => {
      setTimeout(() => finish(code ?? -1), 1500);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** Agent 开工前：本机没有 Git 就先说明原因，等用户选择安装 / 已装好 / 本轮不提交 */
export async function ensureGitReady(runtime: ToolRuntime): Promise<void> {
  if (runtime.gitCheckpoints === false) return;
  let bin = await findGitBin();
  if (bin) {
    runtime.gitBin = bin;
    return;
  }
  if (!runtime.waitForGitSetup) {
    runtime.gitCheckpoints = false;
    return;
  }
  const plan = gitInstallPlan();
  const setupId = `gitsetup_${Date.now().toString(36)}`;
  await Promise.resolve(
    runtime.emit({
      type: "git_setup",
      id: setupId,
      reason:
        "Agent 改文件还在探索阶段，每次写入后会在本机 git commit，方便你随时回退。当前没检测到 Git。",
      installCommand: plan.command,
      hint: plan.hint,
      canAutoInstall: plan.canAutoInstall,
    }),
  );
  const decision = await runtime.waitForGitSetup(setupId);
  if (decision === "skip") {
    runtime.gitCheckpoints = false;
    note(runtime, setupId, { action: "skip" }, "本轮不自动提交 git。装好 Git 后重新发送就会启用。");
    return;
  }
  if (decision === "install") {
    if (!plan.canAutoInstall) {
      note(runtime, setupId, { action: "install" }, `${plan.hint} 本轮暂不自动提交。`, false);
      runtime.gitCheckpoints = false;
      return;
    }
    const termId = `gitinstall_${Date.now().toString(36)}`;
    await Promise.resolve(runtime.emit({ type: "terminal", id: termId, chunk: `$ ${plan.command}\n` }));
    const installed = await runShell(
      plan.command,
      runtime.workspaceRoot,
      (chunk) => {
        void runtime.emit({ type: "terminal", id: termId, chunk });
      },
      INSTALL_MS,
    );
    await Promise.resolve(
      runtime.emit({ type: "terminal", id: termId, chunk: `\nexit ${installed.code}\n` }),
    );
  }
  resetGitBinCache();
  bin = await findGitBin();
  if (!bin) {
    runtime.gitCheckpoints = false;
    note(
      runtime,
      `${setupId}_miss`,
      { action: "missing" },
      "仍未检测到 Git，本轮不会自动提交。若刚装完，关掉客户端再开一次，或把 Git 加进 PATH。",
      false,
    );
    return;
  }
  runtime.gitBin = bin;
  note(runtime, `${setupId}_ok`, { action: "ready" }, `已找到 Git：${bin}`);
}

async function ensureRepo(bin: string, root: string, runtime: ToolRuntime): Promise<void> {
  if (fs.existsSync(path.join(root, ".git"))) return;
  const init = await runGit(bin, root, ["init"], COMMIT_MS);
  if (init.code !== 0) throw new Error(init.out || "git init 失败");
  note(runtime, `gitinit_${Date.now().toString(36)}`, { action: "init" }, "工作区还不是 git 仓库，已 git init。之后每次改文件会提交，方便回退。");
}

/** 某次写入已经落盘后调用：只 add 这一个文件，不 git add -A，失败不影响写入本身 */
export async function checkpointWrite(runtime: ToolRuntime, rel: string): Promise<void> {
  if (runtime.gitCheckpoints === false) return;
  const bin = runtime.gitBin || (await findGitBin());
  if (!bin) return;
  runtime.gitBin = bin;
  const root = runtime.workspaceRoot;
  const posix = rel.replace(/\\/g, "/");
  try {
    await ensureRepo(bin, root, runtime);
    const add = await runGit(bin, root, ["add", "--", posix], COMMIT_MS);
    if (add.code !== 0) {
      note(runtime, `gitadd_${Date.now().toString(36)}`, { path: posix }, add.out || "git add 失败", false);
      return;
    }
    const commit = await runGit(
      bin,
      root,
      [
        "-c",
        `user.name=${COMMIT_NAME}`,
        "-c",
        `user.email=${COMMIT_EMAIL}`,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--no-verify",
        "-m",
        runtime.conversationId
          ? `agnes: ${runtime.conversationId.replace(/[\s\r\n]/g, "")} ${posix}`
          : `agnes: ${posix}`,
        "--",
        posix,
      ],
      COMMIT_MS,
    );
    if (commit.code !== 0) {
      const empty = /nothing to commit|no changes added/i.test(commit.out);
      if (!empty) note(runtime, `gitcommit_${Date.now().toString(36)}`, { path: posix }, commit.out || "git commit 失败", false);
      return;
    }
    note(runtime, `gitcommit_${Date.now().toString(36)}`, { path: posix }, `已提交 git · ${posix}`);
  } catch (err) {
    note(runtime, `giterr_${Date.now().toString(36)}`, { path: posix }, err instanceof Error ? err.message : String(err), false);
  }
}

export type RestoreResult = { ok: true; reverted: number } | { ok: false; error: string };

type LoggedCommit = { sha: string; sec: number; email: string; subject: string; body: string };

function parseGitLog(raw: string): LoggedCommit[] {
  const out: LoggedCommit[] = [];
  for (const chunk of raw.split("\x1e")) {
    const text = chunk.trim();
    if (!text) continue;
    const [sha, sec, email, subject, ...rest] = text.split("\x1f");
    if (!sha || sha.length < 7) continue;
    out.push({
      sha,
      sec: Number(sec) || 0,
      email: email || "",
      subject: subject || "",
      body: rest.join("\x1f"),
    });
  }
  return out;
}

/**
 * 把某个对话在某条用户消息之后的 Agnes 自动提交 revert 掉。
 * 只认 `agnes: <对话 id> <路径>`，别的对话和用户自己的提交不动。
 * 工作区有未提交改动时拒绝，避免 reset 把用户的改动清掉。
 */
export async function revertConversationCommits(root: string, conversationId: string, sinceMs: number): Promise<RestoreResult> {
  const conv = conversationId.replace(/[\s\r\n]/g, "");
  if (!conv) return { ok: false, error: "这个对话没有提交标记" };
  const bin = await findGitBin();
  if (!bin) return { ok: false, error: "本机没有 Git，没法按提交回退" };
  if (!fs.existsSync(path.join(root, ".git"))) return { ok: false, error: "这个工作区还不是 git 仓库" };
  const status = await runGit(bin, root, ["status", "--porcelain"], COMMIT_MS);
  if (status.code !== 0) return { ok: false, error: status.out || "git status 失败" };
  if (status.out.trim()) return { ok: false, error: "工作区还有未提交的改动，先处理完再回退" };

  const log = await runGit(bin, root, ["log", "-n", "400", "--format=%H%x1f%ct%x1f%ae%x1f%s%x1f%b%x1e"], COMMIT_MS);
  if (log.code !== 0) return { ok: false, error: log.out || "git log 失败" };
  const commits = parseGitLog(log.out);
  const undone = new Set<string>();
  for (const commit of commits) {
    const match = /Undoes:\s*([0-9a-f\s]+)/i.exec(`${commit.subject}\n${commit.body}`);
    if (!match) continue;
    for (const sha of match[1].split(/\s+/)) {
      if (sha) undone.add(sha);
    }
  }
  const prefix = `agnes: ${conv} `;
  const sinceSec = Math.floor(sinceMs / 1000);
  const mine = commits.filter(
    (commit) =>
      commit.email === COMMIT_EMAIL &&
      commit.subject.startsWith(prefix) &&
      commit.sec >= sinceSec &&
      ![...undone].some((sha) => commit.sha.startsWith(sha) || sha.startsWith(commit.sha)),
  );
  if (!mine.length) return { ok: false, error: "这条消息之后没有可回退的自动提交。只有这个对话里的 Agnes 提交能回退。" };

  for (const commit of mine) {
    const reverted = await runGit(bin, root, ["revert", "--no-edit", "--no-commit", commit.sha], COMMIT_MS);
    if (reverted.code !== 0) {
      await runGit(bin, root, ["revert", "--abort"], COMMIT_MS);
      await runGit(bin, root, ["reset", "--hard", "HEAD"], COMMIT_MS);
      const detail = (reverted.out || "冲突").slice(0, 400);
      return { ok: false, error: `回退 ${commit.sha.slice(0, 7)} 时冲突，已取消。${detail}` };
    }
  }
  const after = await runGit(bin, root, ["status", "--porcelain"], COMMIT_MS);
  if (!after.out.trim()) return { ok: true, reverted: 0 };
  const committed = await runGit(
    bin,
    root,
    [
      "-c",
      `user.name=${COMMIT_NAME}`,
      "-c",
      `user.email=${COMMIT_EMAIL}`,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-verify",
      "-m",
      `agnes-restore: ${conv}`,
      "-m",
      `Undoes: ${mine.map((commit) => commit.sha).join(" ")}`,
    ],
    COMMIT_MS,
  );
  if (committed.code !== 0) {
    await runGit(bin, root, ["reset", "--hard", "HEAD"], COMMIT_MS);
    return { ok: false, error: committed.out || "回退提交失败" };
  }
  return { ok: true, reverted: mine.length };
}
