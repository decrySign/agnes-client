import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

/** 每轮 Agent 回复的用量/结束原因记录（一次发送 = 一条） */
export interface TurnUsage {
  id: string;
  conversationId: string;
  createdAt: number;
  model: string;
  provider: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  retries: number;
}

export interface TurnUsageTotal {
  turns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  retries: number;
}

const ready = new WeakSet<object>();
function ensure(db: DatabaseSync) {
  if (ready.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_usage (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      finish_reason TEXT NOT NULL DEFAULT '',
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      retries INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_turn_usage_conv ON turn_usage(conversation_id, created_at);
  `);
  ready.add(db);
}

const int = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** 累计一轮里的 usage/retry 事件，finish 时落库 */
export function createTurnTracker(start = Date.now()) {
  const s = { prompt: 0, completion: 0, total: 0, retries: 0, recorded: false, start };
  return {
    state: s,
    onEvent(ev: { type: string; [k: string]: unknown }) {
      if (ev.type === "usage") {
        const p = int(ev.promptTokens);
        const c = int(ev.completionTokens);
        s.prompt += p;
        s.completion += c;
        s.total += int(ev.totalTokens) || p + c;
      } else if (ev.type === "retry") s.retries += 1;
    },
    /** 只记一次；已记过返回 null */
    finish(db: DatabaseSync, info: { conversationId: string; model: string; provider: string; finishReason: string }, end = Date.now()): TurnUsage | null {
      if (s.recorded) return null;
      s.recorded = true;
      return recordTurnUsage(db, {
        conversationId: info.conversationId,
        model: info.model,
        provider: info.provider,
        finishReason: info.finishReason || "stop",
        promptTokens: s.prompt,
        completionTokens: s.completion,
        totalTokens: s.total,
        durationMs: Math.max(0, end - s.start),
        retries: s.retries,
      });
    },
  };
}

export function recordTurnUsage(db: DatabaseSync, row: Omit<TurnUsage, "id" | "createdAt"> & { createdAt?: number }): TurnUsage {
  ensure(db);
  const rec: TurnUsage = {
    id: `tu_${randomUUID()}`,
    createdAt: row.createdAt ?? Date.now(),
    conversationId: row.conversationId,
    model: String(row.model || "").slice(0, 200),
    provider: String(row.provider || "").slice(0, 100),
    finishReason: String(row.finishReason || "").slice(0, 40),
    promptTokens: int(row.promptTokens),
    completionTokens: int(row.completionTokens),
    totalTokens: int(row.totalTokens),
    durationMs: int(row.durationMs),
    retries: int(row.retries),
  };
  db.prepare(
    "INSERT INTO turn_usage (id, conversation_id, created_at, model, provider, finish_reason, prompt_tokens, completion_tokens, total_tokens, duration_ms, retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(rec.id, rec.conversationId, rec.createdAt, rec.model, rec.provider, rec.finishReason, rec.promptTokens, rec.completionTokens, rec.totalTokens, rec.durationMs, rec.retries);
  return rec;
}

interface Row {
  id: string;
  conversation_id: string;
  created_at: number;
  model: string;
  provider: string;
  finish_reason: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  duration_ms: number;
  retries: number;
}

/** 最新在前；total 统计整个会话（不受 limit 影响） */
export function listTurnUsage(db: DatabaseSync, conversationId: string, limit = 50): { items: TurnUsage[]; total: TurnUsageTotal } {
  ensure(db);
  const cap = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
  const rows = db
    .prepare("SELECT * FROM turn_usage WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(conversationId, cap) as unknown as Row[];
  const t = db
    .prepare(
      "SELECT COUNT(*) AS turns, COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c, COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(duration_ms),0) AS d, COALESCE(SUM(retries),0) AS r FROM turn_usage WHERE conversation_id = ?",
    )
    .get(conversationId) as { turns: number; p: number; c: number; t: number; d: number; r: number };
  return {
    items: rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      createdAt: r.created_at,
      model: r.model,
      provider: r.provider,
      finishReason: r.finish_reason,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      totalTokens: r.total_tokens,
      durationMs: r.duration_ms,
      retries: r.retries,
    })),
    total: { turns: Number(t.turns), promptTokens: Number(t.p), completionTokens: Number(t.c), totalTokens: Number(t.t), durationMs: Number(t.d), retries: Number(t.r) },
  };
}

/** 撤销/回退：删掉某时刻之后（含）产生的用量记录 */
export function deleteTurnUsageSince(db: DatabaseSync, conversationId: string, since: number) {
  ensure(db);
  db.prepare("DELETE FROM turn_usage WHERE conversation_id = ? AND created_at >= ?").run(conversationId, since);
}

export function deleteTurnUsage(db: DatabaseSync, conversationId: string) {
  ensure(db);
  db.prepare("DELETE FROM turn_usage WHERE conversation_id = ?").run(conversationId);
}
