import path from "node:path";

/**
 * 同文件并发写感知（进程内）。
 * 工作区锁保证串行落盘，但 write_file 仍可能基于过期认知整文件覆盖；
 * 这里按「会话上次读到的 snap」和「上次写入方」给出拒绝或提示。
 */

/** ctimeMs / ino 可选：参照 dsh fs-local 的版本 token（设备、inode、大小、mtime、ctime），两边都带才比 */
export type FileSnap = { mtimeMs: number; size: number; ctimeMs?: number; ino?: number };

type ReadRec = { snap: FileSnap; at: number };
type WriteRec = { convId: string; snap: FileSnap; at: number };

const reads = new Map<string, ReadRec>();
const writes = new Map<string, WriteRec>();

function rootKey(root: string): string {
  const abs = path.resolve(root);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function fileKey(root: string, rel: string): string {
  // ./a.txt、a.txt、a\b 和 a/b 都算同一个文件；Windows 不分大小写
  let norm = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (process.platform === "win32") norm = norm.toLowerCase();
  return rootKey(root) + "\0" + norm;
}

function readKey(convId: string, root: string, rel: string): string {
  return (convId || "") + "\0" + fileKey(root, rel);
}

function snapEq(a: FileSnap, b: FileSnap): boolean {
  if (a.mtimeMs !== b.mtimeMs || a.size !== b.size) return false;
  // 只传 mtime / size 的旧调用方（含 checker 的用例）照旧；两边都带 ctime / inode 时多比一层，
  // 抓得到「保留了 mtime 的改写」和临时文件替换
  if (a.ctimeMs !== undefined && b.ctimeMs !== undefined && a.ctimeMs !== b.ctimeMs) return false;
  if (a.ino !== undefined && b.ino !== undefined && a.ino !== b.ino) return false;
  return true;
}

/** 读文件成功后记录，供后续写入做冲突判断。 */
export function noteFileRead(root: string, rel: string, convId: string, snap: FileSnap): void {
  if (!rel || !snap) return;
  reads.set(readKey(convId, root, rel), { snap, at: Date.now() });
}

/** 写入成功后记录。 */
export function noteFileWrite(root: string, rel: string, convId: string, snap: FileSnap): void {
  if (!rel || !snap) return;
  const at = Date.now();
  writes.set(fileKey(root, rel), { convId: convId || "", snap, at });
  // 写入方视为已读到最新
  if (convId) reads.set(readKey(convId, root, rel), { snap, at });
}

export type WriteConflict =
  | { kind: "ok" }
  | { kind: "block"; message: string }
  | { kind: "tip"; message: string };

/**
 * 在持有工作区锁、已读到当前原文之后、落盘之前调用。
 * - 本会话读过且 snap 已变 → 拒绝（避免整文件覆盖丢更新）
 * - 未读过/读过仍新，但最近是其他会话写的 → 落盘并附提示
 */
export function inspectWriteConflict(
  root: string,
  rel: string,
  convId: string,
  current: FileSnap | null,
): WriteConflict {
  if (!rel || !current) return { kind: "ok" };
  const mine = convId || "";
  const read = reads.get(readKey(mine, root, rel));
  const prev = writes.get(fileKey(root, rel));
  const otherWrote = Boolean(prev && prev.convId && prev.convId !== mine);

  if (read && !snapEq(read.snap, current)) {
    return {
      kind: "block",
      message:
        `写入失败：同文件冲突——${rel} 自你上次读取后内容已变` +
        (otherWrote ? "（其他会话已写入）" : "") +
        "。请重新 read_file 后再改，避免覆盖。",
    };
  }

  if (otherWrote && (!read || read.at < prev!.at)) {
    return {
      kind: "tip",
      message:
        `同文件冲突提示：${rel} 近期被其他会话写过。本次已写入；若未基于最新内容，请 read_file 核对。`,
    };
  }

  return { kind: "ok" };
}

/**
 * 本会话读过（或自己写过）这个文件没有。参照 dsh fs-observation-policy：
 * 没观察过的已有文件不许整文件覆盖（FS_NOT_OBSERVED）。记录只在进程内，重启后要重新读。
 */
export function hasObservedFile(root: string, rel: string, convId: string): boolean {
  return reads.has(readKey(convId || "", root, rel));
}

export function blindOverwriteMessage(rel: string): string {
  return `写入失败：${rel} 已存在，但本会话还没读过它，不能直接整文件覆盖（可能冲掉别人刚写的内容）。先 read_file 看当前内容再写；只改局部请用 edit_file。`;
}

/** 测试用：清空进程内记录 */
export function resetFileTouches(): void {
  reads.clear();
  writes.clear();
}