import path from "node:path";

/**
 * 同一工作区目录的写入互斥。
 *
 * 多个 Agent 可以并行跑在同一个目录（Cursor / Codex 都允许），但「读原文 → 算替换 → 落盘 →
 * git add/commit」这一段必须一个一个来，否则：
 *  - B 基于旧内容算出来的整份文件会把 A 刚写进去的改动盖掉（丢更新，记录看起来就"串"了）
 *  - 两个 git 同时提交会撞 .git/index.lock
 *
 * 锁只在进程内（桌面端本机 Hono 就是唯一写入方），按规范化后的绝对路径分桶。
 * 等待用户审批那段时间不要持锁，否则另一个 Agent 的写入会跟着挂十分钟。
 */
const chains = new Map<string, Promise<void>>();

function keyOf(root: string): string {
  const abs = path.resolve(root);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export async function withWorkspaceLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = keyOf(root);
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => mine);
  chains.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === chained) chains.delete(key);
  }
}

/** 测试/诊断用：当前有多少个目录处于排队写入状态 */
export function lockedWorkspaceCount(): number {
  return chains.size;
}
