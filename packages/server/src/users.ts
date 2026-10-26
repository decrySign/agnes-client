import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { id, now } from "./db.js";

export type CloudUser = { id: string; username: string; created_at: number };

const SESSION_MS = 30 * 24 * 3600 * 1000;

export function normalizeUsername(raw: string): string {
  const name = String(raw || "").trim().toLowerCase();
  if (!/^[\p{L}\p{N}_-]{2,20}$/u.test(name)) {
    throw new Error("账号需要 2–20 位，可用字母、数字、中文或下划线");
  }
  return name;
}

export function checkPassword(raw: string): string {
  const password = String(raw || "");
  if (password.length < 8 || password.length > 64) throw new Error("密码需要 8–64 位");
  return password;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [kind, salt, hex] = stored.split(":");
  if (kind !== "scrypt" || !salt || !hex) return false;
  const got = scryptSync(password, salt, 32);
  const exp = Buffer.from(hex, "hex");
  if (got.length !== exp.length) return false;
  return timingSafeEqual(got, exp);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function registerUser(db: DatabaseSync, username: string, password: string): { user: CloudUser; token: string } {
  const name = normalizeUsername(username);
  const secret = checkPassword(password);
  const existing = db.prepare("SELECT id FROM cloud_users WHERE username = ?").get(name);
  if (existing) throw new Error("这个账号已经有人用了");
  const userId = id("cu");
  const ts = now();
  db.prepare("INSERT INTO cloud_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
    userId,
    name,
    hashPassword(secret),
    ts,
  );
  const user = db.prepare("SELECT id, username, created_at FROM cloud_users WHERE id = ?").get(userId) as CloudUser;
  return { user, token: issueSession(db, user.id) };
}

export function loginUser(db: DatabaseSync, username: string, password: string): { user: CloudUser; token: string } {
  let name = "";
  try {
    name = normalizeUsername(username);
  } catch {
    throw new Error("账号或密码不正确");
  }
  const secret = String(password || "");
  const row = db.prepare("SELECT id, username, password_hash, created_at FROM cloud_users WHERE username = ?").get(name) as
    | (CloudUser & { password_hash: string })
    | undefined;
  if (!row || !verifyPassword(secret, row.password_hash)) throw new Error("账号或密码不正确");
  return { user: { id: row.id, username: row.username, created_at: row.created_at }, token: issueSession(db, row.id) };
}

function issueSession(db: DatabaseSync, userId: string): string {
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO cloud_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    hashToken(token),
    userId,
    now() + SESSION_MS,
  );
  return token;
}

export function userFromToken(db: DatabaseSync, token: string): CloudUser | undefined {
  const raw = String(token || "").trim();
  if (!raw) return undefined;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.created_at FROM cloud_sessions s
       JOIN cloud_users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(raw), now()) as CloudUser | undefined;
  return row;
}

export function logoutUser(db: DatabaseSync, token: string): void {
  const raw = String(token || "").trim();
  if (!raw) return;
  db.prepare("DELETE FROM cloud_sessions WHERE token_hash = ?").run(hashToken(raw));
}

export function userCookie(token: string, production: boolean, clear = false): string {
  return [
    `agnes_user=${clear ? "" : encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    production && token ? "Secure" : "",
    clear ? "Max-Age=0" : "Max-Age=2592000",
  ]
    .filter(Boolean)
    .join("; ");
}
