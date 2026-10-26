import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { forceKillTree, killTree, reapOrphanTree, type OrphanRoot } from "./proc.js";

/** Soft cap for buffered terminal output (chars). */
export const OUTPUT_CAP_BYTES = 200_000;

/** Max concurrent running background jobs (process-wide). */
export const MAX_BACKGROUND_JOBS = 8;

/**
 * 硬上限：已 stop / 自动杀掉但进程还没真正退出的也算进去，防止杀不掉的进程越积越多。
 * 「还没退出」按输出管道算（close 事件）：shell 退了、但 `start /b` 之类留下的子进程还握着 stdout/stderr 的，也算
 */
export const MAX_BACKGROUND_PROCESSES = 12;

/** 发出杀进程信号后多久还没退出，就升级成强制杀整个进程树 */
export const KILL_ESCALATE_MS = 3_000;

/** 升级强杀后再等这么久仍没退出：状态先收尾成 done（进程仍计入硬上限，直到 exit 和 close 都到） */
const KILL_GIVEUP_MS = 2_000;

/** 升级强杀后 shell 还没 exit：按退避重试 taskkill /PID /T /F，最多这么多次（1s、2s、4s…封顶 30s，约 1 分钟） */
export const FORCE_KILL_MAX_RETRIES = 6;
const FORCE_KILL_RETRY_BASE_MS = 1_000;
const FORCE_KILL_RETRY_MAX_MS = 30_000;
/** 每次按树杀之后隔这么久 shell 还在，就对自己的 ChildProcess 句柄再杀一次（先按树杀，否则 /T 找不到它下面的子进程） */
const HANDLE_KILL_DELAY_MS = 500;
/** 升级强杀之后才 exit、但管道还没关：隔这么久还没 close 就走孤儿收尾 */
const ORPHAN_CHECK_MS = 1_000;

export type BgTerminalHubOptions = {
  /** 默认 KILL_ESCALATE_MS */
  escalateAfterMs?: number;
  /** 第一次杀（stop / 输出超限 / 销毁）。默认 killTree */
  kill?: (pid: number | undefined) => void;
  /** 升级强杀：默认 forceKillTree（Windows taskkill /PID <pid> /T /F） */
  forceKill?: (pid: number | undefined) => void;
  /** shell 已退出、子进程还握着管道时收尾：默认 reapOrphanTree（不用 shell 的 pid 直接杀，按父 pid + 创建时间认亲） */
  reapOrphans?: (root: OrphanRoot, done: (killed: number) => void) => void;
  /** 对自己的 ChildProcess 句柄杀（不经过 pid，不会误杀复用者）。默认 child.kill("SIGKILL") */
  killHandle?: (child: ChildProcess) => void;
  /** 升级强杀后的重试间隔起点，默认 1000ms（测试用） */
  retryBaseMs?: number;
};

export type BgTerminalHandle = {
  id: string;
  pid?: number;
  convId: string;
};

export type BgTerminalSnapshot = {
  id: string;
  output: string;
  next: number;
  done: boolean;
  exitCode: number | null;
  killed: boolean;
  convId: string;
};

export type BgTerminalListItem = {
  id: string;
  convId: string;
  command: string;
  done: boolean;
  exitCode: number | null;
  pid?: number;
  startedAt: number;
};

type Job = {
  id: string;
  convId: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  pid?: number;
  output: string;
  exitCode: number | null;
  done: boolean;
  killed: boolean;
  /** shell 真正退出了（exit 事件），和 done 不同：done 可能是兜底收尾。强杀只在它之前用 shell 的 pid（之后 pid 可能被复用） */
  exited: boolean;
  /** stdout/stderr 都关了（close 事件）：shell 和握着管道的子孙都没了。硬上限按它算 */
  closed: boolean;
  /** spawn 之前的时间、收到 exit 的时间：给孤儿收尾认亲用 */
  startedAt: number;
  exitedAt?: number;
  /** 孤儿收尾正在跑 / 跑的时候又被要求了一次 */
  reaping?: boolean;
  reapAgain?: boolean;
  /** 升级强杀后 exit 前的退避重试 */
  retryTimer?: ReturnType<typeof setTimeout>;
  /** 升级强杀的定时器 */
  escalation?: ReturnType<typeof setTimeout>;
  /** 已经升级强杀过（每个任务最多一次） */
  escalated?: boolean;
  /** 输出已经到上限：后面的输出丢掉，不再重复触发杀进程 */
  truncated?: boolean;
  emitter: EventEmitter;
  createdAt: number;
  onChunk?: (chunk: string) => void;
};

export type StartBgOptions = {
  id?: string;
  cwd?: string;
  onChunk?: (chunk: string) => void;
};

/**
 * Process-wide (or test-local) background terminal hub.
 * AbortSignal / stopAgent / stopConv MUST NOT kill jobs —
 * only stop() / disposeConversation() / disposeAll().
 */
export class BgTerminalHub {
  private jobs = new Map<string, Job>();
  private seq = 0;
  /** Per-handle read offset for incremental drain (cleared on dispose). */
  private readCursors = new Map<string, number>();
  /** 还没真正退出的子进程（包括已被 kill、已从 jobs 里删掉的），硬上限按它算 */
  private alive = new Set<Job>();
  private readonly escalateAfterMs: number;
  private readonly killFn: (pid: number | undefined) => void;
  private readonly forceKillFn: (pid: number | undefined) => void;
  private readonly reapFn: (root: OrphanRoot, done: (killed: number) => void) => void;
  private readonly killHandleFn: (child: ChildProcess) => void;
  private readonly retryBaseMs: number;

  constructor(opts: BgTerminalHubOptions = {}) {
    this.escalateAfterMs = opts.escalateAfterMs ?? KILL_ESCALATE_MS;
    this.killFn = opts.kill ?? killTree;
    this.forceKillFn = opts.forceKill ?? forceKillTree;
    this.reapFn = opts.reapOrphans ?? reapOrphanTree;
    this.killHandleFn = opts.killHandle ?? killChildHandle;
    this.retryBaseMs = opts.retryBaseMs ?? FORCE_KILL_RETRY_BASE_MS;
  }

  start(convId: string, command: string, opts: StartBgOptions = {}): BgTerminalHandle {
    // 已经 stop()（发了杀进程信号）但还没退出的不占名额：stop 不等进程退出就返回，
    // 否则负载高时 stop 完马上 start 会误报上限。它们退出时 exit 处理照常把 done / exitCode 收尾
    const running = [...this.jobs.values()].filter((j) => !j.done && !j.killed).length;
    if (running >= MAX_BACKGROUND_JOBS) {
      throw new Error(`background terminal limit reached (${MAX_BACKGROUND_JOBS})`);
    }
    // 硬上限：已 kill 但还没退出的也算
    if (this.alive.size >= MAX_BACKGROUND_PROCESSES) {
      const exiting = [...this.alive].filter((j) => j.killed).length;
      // shell 已正常退出、但留下的子进程还在跑（握着输出管道）的终端：只列本会话的 id，方便 stop_terminal
      const orphaned = [...this.alive].filter((j) => !j.killed && j.exited);
      const mine = orphaned.filter((j) => j.convId === convId && this.jobs.get(j.id) === j).map((j) => j.id);
      const orphanNote = orphaned.length
        ? `, ${orphaned.length} finished terminal(s) left child processes running` +
          (mine.length ? ` (stop_terminal ${mine.slice(0, 6).join(", ")}${mine.length > 6 ? ", …" : ""} to kill them)` : "")
        : "";
      throw new Error(
        `background terminal hard limit reached (${MAX_BACKGROUND_PROCESSES} processes): ${exiting} stopped terminal(s) are still exiting${orphanNote}, retry in a few seconds`,
      );
    }
    const id = opts.id || `bg_${Date.now().toString(36)}_${++this.seq}`;
    const cwd = opts.cwd || process.cwd();
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0" },
      detached: process.platform !== "win32",
    });
    const job: Job = {
      id,
      convId,
      command,
      cwd,
      child,
      pid: child.pid,
      output: "",
      exitCode: null,
      done: false,
      killed: false,
      exited: false,
      closed: false,
      startedAt,
      emitter: new EventEmitter(),
      createdAt: Date.now(),
      onChunk: opts.onChunk,
    };
    const append = (buf: Buffer) => {
      if (job.done || job.truncated) return;
      let text = buf.toString("utf8");
      if (job.output.length + text.length > OUTPUT_CAP_BYTES) {
        text = text.slice(0, Math.max(0, OUTPUT_CAP_BYTES - job.output.length));
        job.output += text + "\n…(truncated)";
        job.truncated = true;
        job.onChunk?.(text);
        job.emitter.emit("data", text);
        this.killJob(job);
        return;
      }
      job.output += text;
      job.onChunk?.(text);
      job.emitter.emit("data", text);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code) => {
      this.markExited(job);
      if (job.done && job.exitCode !== null) return;
      job.exitCode = code;
      job.done = true;
      job.emitter.emit("exit", code);
    });
    child.on("close", () => {
      if (!job.exited) this.markExited(job);
      this.markClosed(job);
    });
    child.on("error", (err) => {
      // 没拿到 pid = 根本没起来；有 pid 的 error（比如 kill 失败）进程可能还活着，等 exit / close 再算退出
      if (!child.pid) {
        this.markExited(job);
        this.markClosed(job);
      }
      job.output += `\nspawn error: ${err.message}`;
      job.exitCode = -1;
      job.done = true;
      job.emitter.emit("exit", -1);
    });
    this.jobs.set(id, job);
    if (!job.closed) this.alive.add(job);
    return { id, pid: child.pid, convId };
  }

  read(id: string, opts: { since?: number } = {}): BgTerminalSnapshot {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown handle ${id}`);
    const since = typeof opts.since === "number" ? opts.since : 0;
    const chunk = job.output.slice(since);
    return {
      id,
      output: chunk,
      next: since + chunk.length,
      done: job.done,
      exitCode: job.exitCode,
      killed: job.killed,
      convId: job.convId,
    };
  }

  /** Block until exit or timeoutMs. AbortSignal cancels the wait only — does NOT kill the process. */
  await(
    id: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ id: string; exitCode: number | null; output: string; timedOut: boolean; done?: boolean }> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new Error(`unknown handle ${id}`));
    const timeoutMs = opts.timeoutMs ?? 30_000;
    if (job.done) {
      return Promise.resolve({ id, exitCode: job.exitCode, output: job.output, timedOut: false, done: true });
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ id, exitCode: job.exitCode, output: job.output, timedOut: true, done: job.done });
      }, timeoutMs);
      const onExit = () => {
        cleanup();
        resolve({ id, exitCode: job.exitCode, output: job.output, timedOut: false, done: true });
      };
      const cleanup = () => {
        clearTimeout(timer);
        job.emitter.off("exit", onExit);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      job.emitter.on("exit", onExit);
      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  stop(id: string): { id: string; killed: boolean } {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown handle ${id}`);
    // shell 已退出（done）但子进程还握着管道的，也要能 stop 掉
    if (!job.closed) {
      job.killed = true;
      this.killJob(job);
    }
    return { id, killed: true };
  }

  /** Strict session filter: empty/undefined convId yields []. Never lists all. */
  list(convId?: string): BgTerminalListItem[] {
    if (!convId) return [];
    return [...this.jobs.values()]
      .filter((j) => j.convId === convId)
      .map((j) => ({
        id: j.id,
        convId: j.convId,
        command: j.command,
        done: j.done,
        exitCode: j.exitCode,
        pid: j.pid,
        startedAt: j.createdAt,
      }));
  }

  /** Kill + drop jobs for one conversation. Clears read cursors for deleted ids. */
  disposeConversation(convId: string): void {
    if (!convId) return;
    for (const job of this.jobs.values()) {
      if (job.convId === convId && !job.closed) this.killJob(job);
    }
    const deleted: string[] = [];
    for (const [id, job] of [...this.jobs.entries()]) {
      if (job.convId === convId) {
        deleted.push(id);
        this.jobs.delete(id);
      }
    }
    this.clearReadCursors(deleted);
  }

  /** Simulate stopConv: abort agent only — must NOT kill bg jobs. */
  stopAgent(_convId: string): void {
    /* intentionally empty */
  }

  /** 还没真正退出的终端数（含已 kill 正在退出的、shell 退了但子进程还握着管道的），硬上限按这个算 */
  liveProcessCount(): number {
    return this.alive.size;
  }

  aliveCount(convId?: string): number {
    return [...this.jobs.values()].filter((j) => (!convId || j.convId === convId) && !j.done).length;
  }

  /** Kill every job (server shutdown). */
  disposeAll(): void {
    for (const job of this.jobs.values()) {
      if (!job.closed) this.killJob(job);
    }
    this.jobs.clear();
    this.readCursors.clear();
  }

  getReadCursor(id: string): number {
    return this.readCursors.get(id) || 0;
  }

  setReadCursor(id: string, offset: number): void {
    this.readCursors.set(id, offset);
  }

  clearReadCursors(ids: string[]): void {
    for (const id of ids) this.readCursors.delete(id);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  private markExited(job: Job): void {
    job.exited = true;
    job.exitedAt = Date.now();
    // exit 到了：shell 的 pid 从此不归我们，按 pid 的重试立即停
    if (job.retryTimer) clearTimeout(job.retryTimer);
    job.retryTimer = undefined;
    // 升级强杀之后才退出、管道还开着：说明有子孙握着管道，稍等还没 close 就按孤儿收尾（升级前退出的交给升级定时器）
    if (job.killed && job.escalated) {
      const t = setTimeout(() => this.reapJob(job), ORPHAN_CHECK_MS);
      t.unref?.();
    }
  }

  private markClosed(job: Job): void {
    job.closed = true;
    this.alive.delete(job);
    if (job.escalation) clearTimeout(job.escalation);
    job.escalation = undefined;
    if (job.retryTimer) clearTimeout(job.retryTimer);
    job.retryTimer = undefined;
  }

  /**
   * 升级强杀（shell 还没 exit 时才会进来）：taskkill /PID /T /F 按树杀；隔一会儿 shell 还在，再对自己的 ChildProcess 句柄杀一次；
   * 仍没 exit 就按退避重试，最多 FORCE_KILL_MAX_RETRIES 次。exit 一到立即停（markExited 清掉定时器）。
   * 重试用完还没 exit：不再动它，但照样计入硬上限（只有 exit + close 都到才放名额）
   */
  private forceKillAttempt(job: Job, attempt: number): void {
    if (job.exited || job.closed) return;
    this.forceKillFn(job.pid || job.child?.pid);
    const viaHandle = setTimeout(() => {
      if (!job.exited) this.killHandleFn(job.child);
    }, HANDLE_KILL_DELAY_MS);
    viaHandle.unref?.();
    if (attempt >= FORCE_KILL_MAX_RETRIES) {
      console.warn(`[bg-terminal] ${job.id} 强杀 ${attempt + 1} 次后 shell 仍未退出（pid ${job.pid}），继续计入硬上限`);
      return;
    }
    const delay = Math.min(this.retryBaseMs * 2 ** attempt, FORCE_KILL_RETRY_MAX_MS);
    const t = setTimeout(() => {
      job.retryTimer = undefined;
      this.forceKillAttempt(job, attempt + 1);
    }, delay);
    t.unref?.();
    job.retryTimer = t;
  }

  /** shell 已退出、管道还没关：按父 pid + 创建时间找它留下的进程来杀，不碰 shell 的 pid 本身 */
  private reapJob(job: Job): void {
    if (job.closed || !job.exited) return;
    if (job.reaping) {
      job.reapAgain = true;
      return;
    }
    job.reaping = true;
    job.reapAgain = false;
    this.reapFn({ pid: job.pid || job.child?.pid, startedAt: job.startedAt, exitedAt: job.exitedAt ?? Date.now() }, () => {
      job.reaping = false;
      if (job.reapAgain && !job.closed) this.reapJob(job);
    });
  }

  /**
   * stop / 输出超限 / 销毁都走这里：标记 killed，发一次杀进程信号就返回（不阻塞）。
   * escalateAfterMs 后还没退出就升级成强制杀整个进程树；再等 KILL_GIVEUP_MS 仍没退出，状态先收尾成 done。
   * 「退出」按管道关闭（closed）算；shell 已退出时不再用它的 pid，改走 reapJob。
   */
  private killJob(job: Job): void {
    job.killed = true;
    if (job.closed) return;
    // shell 还没退出时 libuv 握着它的进程句柄，pid 不会被复用，可以按 pid 杀树；退出之后只能走孤儿收尾
    if (job.exited) this.reapJob(job);
    else this.killFn(job.pid || job.child?.pid);
    if (job.escalation || job.escalated) return;
    const t = setTimeout(() => {
      job.escalation = undefined;
      if (job.closed) return;
      job.escalated = true;
      // 只用按进程树杀：先单独杀 shell 的话，Windows 上 taskkill /T 找不到它下面的子进程
      if (job.exited) this.reapJob(job);
      else this.forceKillAttempt(job, 0);
      // 放弃等待：只把状态收尾成 done（await 能返回），名额照旧占着，直到 exit 和 close 都到
      const giveUp = setTimeout(() => {
        if (!job.done) {
          job.done = true;
          if (job.exitCode === null) job.exitCode = -1;
          job.emitter.emit("exit", job.exitCode);
        }
      }, KILL_GIVEUP_MS);
      giveUp.unref?.();
    }, this.escalateAfterMs);
    t.unref?.();
    job.escalation = t;
  }
}

/** 按自己的 ChildProcess 句柄杀：exit 之后 Node 已放掉句柄，kill 直接返回 false，不会落到别人的进程上 */
function killChildHandle(child: ChildProcess): void {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

export function createBgTerminalHub(opts?: BgTerminalHubOptions): BgTerminalHub {
  return new BgTerminalHub(opts);
}

let shared: BgTerminalHub | null = null;

export function getSharedBgTerminalHub(): BgTerminalHub {
  if (!shared) shared = new BgTerminalHub();
  return shared;
}

export function disposeSharedBgTerminalHub(): void {
  if (shared) {
    shared.disposeAll();
    shared = null;
  }
}

/** Kill bg jobs for one conversation (conversation DELETE). Does not run on chat Stop. */
export function disposeBgTerminalsForConv(convId: string): void {
  getSharedBgTerminalHub().disposeConversation(convId);
}

/** Format a short preamble of running terminals for the next agent turn. */
export function formatBgTerminalPreamble(convId: string): string {
  const items = getSharedBgTerminalHub().list(convId).filter((j) => !j.done);
  if (!items.length) return "";
  const lines = items.map((j) => `- ${j.id}  running  ${j.command.slice(0, 120)}`);
  return (
    "Background terminals still running for this conversation (chat Stop does not kill them; use await_terminal / read_terminal / stop_terminal):\n" +
    lines.join("\n")
  );
}
