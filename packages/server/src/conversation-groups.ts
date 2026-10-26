import type { DatabaseSync } from "node:sqlite";
import { id, now } from "./db.js";

/**
 * 「对话」页签的自定义分组：每个账号（本机档案 / 网页访客）各自一套。
 * 删分组只把里面的对话放回「未分组」，对话本身不动。
 */
export type ConversationGroupRow = {
  id: string;
  account_id: string;
  name: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

export const MAX_GROUPS = 50;
const MAX_NAME = 40;

export function cleanGroupName(raw: unknown): string {
  const name = String(raw ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
  if (!name) throw new Error("分组名不能为空");
  return name;
}

export function listGroups(db: DatabaseSync, accountId: string): ConversationGroupRow[] {
  return db
    .prepare("SELECT * FROM conversation_groups WHERE account_id = ? ORDER BY sort_order ASC, created_at ASC")
    .all(accountId) as ConversationGroupRow[];
}

export function ownGroup(db: DatabaseSync, groupId: string, accountId: string): ConversationGroupRow | undefined {
  return db.prepare("SELECT * FROM conversation_groups WHERE id = ? AND account_id = ?").get(groupId, accountId) as
    | ConversationGroupRow
    | undefined;
}

export function createGroup(db: DatabaseSync, accountId: string, rawName: unknown): ConversationGroupRow {
  const name = cleanGroupName(rawName);
  const count = Number((db.prepare("SELECT COUNT(*) AS c FROM conversation_groups WHERE account_id = ?").get(accountId) as { c: number }).c);
  if (count >= MAX_GROUPS) throw new Error(`最多 ${MAX_GROUPS} 个分组`);
  const next =
    Number(
      (db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS n FROM conversation_groups WHERE account_id = ?").get(accountId) as { n: number }).n,
    ) + 1;
  const groupId = id("grp");
  const ts = now();
  db.prepare(
    "INSERT INTO conversation_groups (id, account_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(groupId, accountId, name, next, ts, ts);
  return ownGroup(db, groupId, accountId) as ConversationGroupRow;
}

export function renameGroup(db: DatabaseSync, accountId: string, groupId: string, rawName: unknown): ConversationGroupRow {
  const row = ownGroup(db, groupId, accountId);
  if (!row) throw new Error("分组不存在");
  const name = cleanGroupName(rawName);
  db.prepare("UPDATE conversation_groups SET name = ?, updated_at = ? WHERE id = ? AND account_id = ?").run(name, now(), groupId, accountId);
  return ownGroup(db, groupId, accountId) as ConversationGroupRow;
}

export function reorderGroups(db: DatabaseSync, accountId: string, ids: unknown): ConversationGroupRow[] {
  const list = Array.isArray(ids) ? ids.map(String) : [];
  const update = db.prepare("UPDATE conversation_groups SET sort_order = ? WHERE id = ? AND account_id = ?");
  list.forEach((groupId, index) => update.run(index + 1, groupId, accountId));
  return listGroups(db, accountId);
}

/** 删除分组：里面的对话回到未分组（按日期显示），返回放回去的条数 */
export function deleteGroup(db: DatabaseSync, accountId: string, groupId: string): number {
  const row = ownGroup(db, groupId, accountId);
  if (!row) throw new Error("分组不存在");
  const released = db.prepare("UPDATE conversations SET group_id = NULL WHERE group_id = ? AND account_id = ?").run(groupId, accountId);
  db.prepare("DELETE FROM conversation_groups WHERE id = ? AND account_id = ?").run(groupId, accountId);
  return Number(released.changes || 0);
}

/** 移入 / 移出分组；不改 updated_at，避免对话在日期分组里跳位置 */
export function moveConversationToGroup(db: DatabaseSync, accountId: string, conversationId: string, groupId: string | null): void {
  if (groupId && !ownGroup(db, groupId, accountId)) throw new Error("分组不存在");
  db.prepare("UPDATE conversations SET group_id = ? WHERE id = ? AND account_id = ?").run(groupId, conversationId, accountId);
}
