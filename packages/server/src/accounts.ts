import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { id, now, seedPersonas } from "./db.js";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export type AccountRow = {
  id: string;
  name: string;
  password_hash: string;
  device_hash: string | null;
  created_at: number;
};

export type SessionRow = {
  id: string;
  account_id: string;
  token_hash: string;
  expires_at: number;
};

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function cookieValue(header: string | undefined, name: string): string {
  if (!header) return "";
  const part = header
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

export function countAccounts(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM accounts").get() as { c: number };
  return Number(row.c);
}

export function listAccounts(db: DatabaseSync): Array<{ id: string; name: string; created_at: number }> {
  return db.prepare("SELECT id, name, created_at FROM accounts ORDER BY created_at ASC").all() as Array<{
    id: string;
    name: string;
    created_at: number;
  }>;
}

export function createProfile(db: DatabaseSync, name: string): AccountRow {
  const ts = now();
  const accountId = id("u");
  const first = countAccounts(db) === 0;
  try {
    db.prepare("INSERT INTO accounts (id, name, password_hash, created_at) VALUES (?, ?, '', ?)").run(accountId, name, ts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) throw new Error("档案名已被使用");
    throw err;
  }
  if (first) {
    db.prepare("UPDATE conversations SET account_id=? WHERE account_id IS NULL").run(accountId);
    db.prepare("UPDATE personas SET account_id=? WHERE account_id IS NULL").run(accountId);
    db.prepare("UPDATE media_jobs SET account_id=? WHERE account_id IS NULL").run(accountId);
  }
  seedPersonas(db, accountId);
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as AccountRow;
}

export function ensureDefaultProfile(db: DatabaseSync): AccountRow {
  const first = db.prepare("SELECT * FROM accounts ORDER BY created_at ASC LIMIT 1").get() as AccountRow | undefined;
  if (first) {
    seedPersonas(db, first.id);
    return first;
  }
  return createProfile(db, "默认");
}

export function ensureProfileForDevice(db: DatabaseSync, deviceHash: string): AccountRow {
  const existing = db.prepare("SELECT * FROM accounts WHERE device_hash = ?").get(deviceHash) as AccountRow | undefined;
  if (existing) {
    seedPersonas(db, existing.id);
    return existing;
  }
  const ts = now();
  const accountId = id("u");
  const name = `web_${deviceHash.slice(0, 12)}`;
  try {
    db.prepare("INSERT INTO accounts (id, name, password_hash, device_hash, created_at) VALUES (?, ?, '', ?, ?)").run(
      accountId,
      name,
      deviceHash,
      ts,
    );
  } catch {
    const raced = db.prepare("SELECT * FROM accounts WHERE device_hash = ?").get(deviceHash) as AccountRow | undefined;
    if (raced) {
      seedPersonas(db, raced.id);
      return raced;
    }
    throw new Error("无法为该设备打开对话空间");
  }
  seedPersonas(db, accountId);
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as AccountRow;
}

export function publicAccount(row: AccountRow, desktopMode: boolean): { id: string; name: string } {
  return { id: row.id, name: desktopMode ? row.name : "当前设备" };
}

export function createSession(db: DatabaseSync, accountId: string): { token: string; expiresAt: number } {
  const token = newSessionToken();
  const expiresAt = Date.now() + SESSION_MS;
  db.prepare("INSERT INTO sessions (id, account_id, token_hash, expires_at) VALUES (?, ?, ?, ?)").run(
    id("s"),
    accountId,
    hashToken(token),
    expiresAt,
  );
  return { token, expiresAt };
}

export function accountFromSession(db: DatabaseSync, token: string): AccountRow | undefined {
  if (!token) return undefined;
  const row = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashToken(token)) as SessionRow | undefined;
  if (!row || row.expires_at < Date.now()) {
    if (row) db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
    return undefined;
  }
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(row.account_id) as AccountRow | undefined;
}

export function deleteSession(db: DatabaseSync, token: string): void {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function sessionCookie(token: string, production: boolean, maxAgeSec: number): string {
  return [
    `agnes_sid=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    production ? "Secure" : "",
    `Max-Age=${maxAgeSec}`,
  ]
    .filter(Boolean)
    .join("; ");
}
