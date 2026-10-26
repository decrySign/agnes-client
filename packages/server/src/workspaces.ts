import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertSafeWorkspaceRoot } from "@agnes/agent";
import { id, now, type WorkspaceRow } from "./db.js";
import { deleteTurnUsage } from "./turn-usage.js";

/**
 * 工作区 = 一个项目目录，下面挂多个 Agent 对话（Codex 的 project → threads）。
 * 按账号隔离：桌面端每个本机档案各有自己的一组。
 */

export type WorkspacePublic = Omit<WorkspaceRow, "pinned"> & {
  pinned: boolean;
  /** 该工作区下的 Agent 对话数 */
  agents: number;
  /** 最近一次对话活动，没有对话就是工作区自己的 updated_at */
  lastActive: number;
  /** 目录当前是否还存在（被挪走/删掉时前端标灰） */
  exists: boolean;
};

/** 工作区目录不合法或建不出来：文案是给人看的中文，各接口一律按 400 返回 */
export class WorkspaceRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRootError";
  }
}

export const UNSAFE_WORKSPACE_ROOT = "工作区不能是系统目录或磁盘根目录";

/** 解析并校验工作区目录（不建目录）；不安全就抛 WorkspaceRootError。返回值就是要保存、要建的那个路径 */
export function normalizeRoot(raw: string): string {
  const resolved = path.resolve(String(raw || "").trim());
  try {
    return assertSafeWorkspaceRoot(resolved);
  } catch (err) {
    // 段末尾带点或空格、Windows 保留设备名：原样说哪一段不行；其余一律用原来那句
    if (err instanceof Error && err.name === "WorkspacePathFormatError") throw new WorkspaceRootError(err.message);
    throw new WorkspaceRootError(UNSAFE_WORKSPACE_ROOT);
  }
}

function mkdirReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "找不到这个盘符或上级目录";
  if (code === "EACCES" || code === "EPERM") return "没有写入权限";
  if (code === "EEXIST" || code === "ENOTDIR") return "路径上已有同名文件，不是文件夹";
  if (code === "EROFS") return "磁盘是只读的";
  return code || (err instanceof Error ? err.message : String(err));
}

/** 建工作区目录；失败抛 WorkspaceRootError「无法创建工作区目录：…」 */
export function makeWorkspaceDir(root: string): void {
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    throw new WorkspaceRootError(`无法创建工作区目录：${root}（${mkdirReason(err)}）`);
  }
}

function decorate(db: DatabaseSync, row: WorkspaceRow): WorkspacePublic {
  const stat = db
    .prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM conversations WHERE workspace_id = ?")
    .get(row.id) as { n: number; last: number | null };
  return {
    ...row,
    pinned: Boolean(row.pinned),
    sort_order: Number(row.sort_order ?? 0),
    agents: Number(stat.n ?? 0),
    lastActive: Number(stat.last ?? row.updated_at),
    exists: fs.existsSync(row.root),
  };
}

export function listWorkspaces(db: DatabaseSync, accountId: string): WorkspacePublic[] {
  const rows = db
    .prepare("SELECT * FROM workspaces WHERE account_id = ? ORDER BY pinned DESC, sort_order ASC, updated_at DESC")
    .all(accountId) as WorkspaceRow[];
  return rows.map((r) => decorate(db, r)).sort((a, b) => {
    if (Number(a.pinned) !== Number(b.pinned)) return Number(b.pinned) - Number(a.pinned);
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return b.lastActive - a.lastActive;
  });
}

export function getWorkspace(db: DatabaseSync, wsId: string, accountId: string): WorkspaceRow | undefined {
  return db.prepare("SELECT * FROM workspaces WHERE id = ? AND account_id = ?").get(wsId, accountId) as
    | WorkspaceRow
    | undefined;
}

/** 同一账号同一目录只有一个工作区；已存在就直接返回，不会重复建 */
export function ensureWorkspace(db: DatabaseSync, accountId: string, rawRoot: string, name = ""): WorkspaceRow {
  const root = normalizeRoot(rawRoot);
  makeWorkspaceDir(root);
  const existing = db.prepare("SELECT * FROM workspaces WHERE account_id = ? AND root = ?").get(accountId, root) as
    | WorkspaceRow
    | undefined;
  if (existing) return existing;
  const ts = now();
  const row: WorkspaceRow = {
    id: id("ws"),
    account_id: accountId,
    name: name.trim().slice(0, 60) || path.basename(root) || root,
    root,
    pinned: 0,
    sort_order: 0,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    "INSERT INTO workspaces (id, account_id, name, root, pinned, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)",
  ).run(row.id, row.account_id, row.name, row.root, row.created_at, row.updated_at);
  return row;
}

export function updateWorkspace(
  db: DatabaseSync,
  wsId: string,
  accountId: string,
  patch: { name?: string; root?: string; pinned?: boolean },
): WorkspaceRow {
  const row = getWorkspace(db, wsId, accountId);
  if (!row) throw new Error("工作区不存在");
  const name = patch.name !== undefined ? patch.name.trim().slice(0, 60) || row.name : row.name;
  let root = row.root;
  if (patch.root !== undefined && patch.root.trim()) {
    root = normalizeRoot(patch.root);
    makeWorkspaceDir(root);
    const clash = db
      .prepare("SELECT id FROM workspaces WHERE account_id = ? AND root = ? AND id != ?")
      .get(accountId, root, wsId) as { id: string } | undefined;
    if (clash) throw new Error("这个目录已经是另一个工作区");
  }
  const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : row.pinned;
  db.prepare("UPDATE workspaces SET name = ?, root = ?, pinned = ?, updated_at = ? WHERE id = ?").run(
    name,
    root,
    pinned,
    now(),
    wsId,
  );
  return getWorkspace(db, wsId, accountId) as WorkspaceRow;
}

/** 按传入顺序重写 sort_order；只动这一批，另一组（置顶/未置顶）的序号保持不动 */
export function reorderWorkspaces(db: DatabaseSync, accountId: string, ids: string[]): WorkspacePublic[] {
  const unique = [...new Set(ids.map((s) => String(s || "").trim()).filter(Boolean))];
  if (!unique.length) throw new Error("缺少工作区");
  const owned = new Set(
    (db.prepare("SELECT id FROM workspaces WHERE account_id = ?").all(accountId) as Array<{ id: string }>).map((r) => r.id),
  );
  for (const wsId of unique) {
    if (!owned.has(wsId)) throw new Error("工作区不存在");
  }
  const ts = now();
  const stmt = db.prepare("UPDATE workspaces SET sort_order = ?, updated_at = ? WHERE id = ? AND account_id = ?");
  unique.forEach((wsId, i) => stmt.run(i, ts, wsId, accountId));
  return listWorkspaces(db, accountId);
}

/**
 * 删工作区。默认拒绝删还有 Agent 的；cascade 才连同下面的对话、消息、diff 一起删。
 * 不碰磁盘上的目录——那是用户的项目。
 */
export function deleteWorkspace(db: DatabaseSync, wsId: string, accountId: string, cascade = false): { removedAgents: number } {
  const row = getWorkspace(db, wsId, accountId);
  if (!row) throw new Error("工作区不存在");
  const convs = db.prepare("SELECT id FROM conversations WHERE workspace_id = ?").all(wsId) as Array<{ id: string }>;
  if (convs.length && !cascade) throw new Error(`工作区下还有 ${convs.length} 个 Agent，先删掉它们或选择连同删除`);
  for (const c of convs) {
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(c.id);
    db.prepare("DELETE FROM diffs WHERE conversation_id = ?").run(c.id);
    deleteTurnUsage(db, c.id);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(c.id);
  }
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(wsId);
  return { removedAgents: convs.length };
}

export function touchWorkspace(db: DatabaseSync, wsId: string): void {
  db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(now(), wsId);
}
