import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertInside } from "@agnes/agent";
import { disallowedReason } from "@agnes/agent";
import { getQuotaSettings } from "./catalog.js";
import { id, now } from "./db.js";
import { grantLicenseDays } from "./entitlements.js";

export const FEEDBACK_STATUSES = ["open", "adopted", "rejected"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_KINDS = ["bug", "ux", "idea", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  bug: "系统缺陷",
  ux: "体验优化",
  idea: "想法建议",
  other: "其他",
};

export function parseFeedbackKind(raw: unknown): FeedbackKind | null {
  const v = String(raw ?? "").trim();
  return FEEDBACK_KINDS.includes(v as FeedbackKind) ? (v as FeedbackKind) : null;
}

export type FeedbackImage = { name: string; mime: string };

export type FeedbackRow = {
  id: string;
  device_hash: string;
  title: string;
  body: string;
  kind: FeedbackKind;
  images: string;
  status: FeedbackStatus;
  reward_days: number;
  reward_applied: string;
  admin_note: string;
  contact: string;
  client: string;
  ticket_seq: number;
  ticket_no: string;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
};

export type FeedbackReplyRow = {
  id: string;
  feedback_id: string;
  author: string;
  body: string;
  images: string;
  created_at: number;
};

export type FeedbackReplyPublic = {
  id: string;
  author: string;
  /** Markdown；内嵌截图已经换成 /api/feedbacks/:id/files/:name */
  body: string;
  images: Array<{ name: string; url: string }>;
  createdAt: number;
};

export type FeedbackPublic = {
  id: string;
  title: string;
  body: string;
  kind: FeedbackKind;
  images: Array<{ name: string; url: string }>;
  status: FeedbackStatus;
  rewardDays: number;
  rewardApplied: string;
  adminNote: string;
  /** 运营回复（和采纳 / 不采纳分开，可多条），旧数据为空数组 */
  replies: FeedbackReplyPublic[];
  contact: string;
  client: string;
  ticketNo: string;
  createdAt: number;
  updatedAt: number;
  reviewedAt: number | null;
  deviceHash?: string;
};

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_BODY = 4000;
const MAX_TITLE = 80;
const MAX_CONTACT = 64;
const MAX_REPLY_BODY = 8000;
const DAILY_LIMIT = 5;

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export function feedbackDir(dataDir: string): string {
  return path.join(dataDir, "feedback");
}

function parseImages(raw: string): FeedbackImage[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row): row is FeedbackImage => Boolean(row) && typeof row === "object" && typeof (row as FeedbackImage).name === "string")
      .slice(0, MAX_IMAGES);
  } catch {
    return [];
  }
}

function fileUrl(feedbackId: string, name: string, admin: boolean): string {
  return admin ? `/api/feedbacks/${feedbackId}/files/${name}` : `/api/feedbacks/${feedbackId}/files/${encodeURIComponent(name)}`;
}

function publicReply(row: FeedbackReplyRow, admin: boolean): FeedbackReplyPublic {
  return {
    id: row.id,
    author: row.author || "运营",
    body: row.body,
    images: parseImages(row.images).map((img) => ({ name: img.name, url: fileUrl(row.feedback_id, img.name, admin) })),
    createdAt: row.created_at,
  };
}

/** 一次取出多条反馈的回复，按时间正序 */
export function repliesFor(db: DatabaseSync, feedbackIds: string[]): Map<string, FeedbackReplyRow[]> {
  const out = new Map<string, FeedbackReplyRow[]>();
  if (!feedbackIds.length) return out;
  const marks = feedbackIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM feedback_replies WHERE feedback_id IN (${marks}) ORDER BY created_at ASC`)
    .all(...feedbackIds) as FeedbackReplyRow[];
  for (const row of rows) out.set(row.feedback_id, [...(out.get(row.feedback_id) ?? []), row]);
  return out;
}

export function publicFeedback(
  row: FeedbackRow,
  opts: { admin?: boolean; replies?: FeedbackReplyRow[] } = {},
): FeedbackPublic {
  const images = parseImages(row.images).map((img) => ({
    name: img.name,
    url: fileUrl(row.id, img.name, Boolean(opts.admin)),
  }));
  const out: FeedbackPublic = {
    id: row.id,
    title: row.title,
    body: row.body,
    kind: parseFeedbackKind(row.kind) ?? "other",
    images,
    status: row.status,
    rewardDays: row.reward_days,
    rewardApplied: row.reward_applied,
    adminNote: row.admin_note,
    replies: (opts.replies ?? []).map((reply) => publicReply(reply, Boolean(opts.admin))),
    contact: row.contact,
    client: row.client,
    ticketNo: row.ticket_no || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
  };
  if (opts.admin) out.deviceHash = row.device_hash;
  return out;
}

function getRow(db: DatabaseSync, feedbackId: string): FeedbackRow | undefined {
  return db.prepare("SELECT * FROM feedbacks WHERE id = ?").get(feedbackId) as FeedbackRow | undefined;
}

export function listMine(db: DatabaseSync, deviceHash: string): FeedbackPublic[] {
  const rows = db
    .prepare("SELECT * FROM feedbacks WHERE device_hash = ? ORDER BY created_at DESC LIMIT 50")
    .all(deviceHash) as FeedbackRow[];
  const replies = repliesFor(db, rows.map((row) => row.id));
  return rows.map((row) => publicFeedback(row, { replies: replies.get(row.id) }));
}

export function getFeedbackForAdmin(db: DatabaseSync, feedbackId: string): FeedbackPublic {
  const row = getRow(db, feedbackId);
  if (!row) throw new Error("反馈不存在");
  return publicFeedback(row, { admin: true, replies: repliesFor(db, [row.id]).get(row.id) });
}

export function listFeedbacks(
  db: DatabaseSync,
  query: { q?: string; status?: string; kind?: string; page?: number; pageSize?: number },
): { items: FeedbackPublic[]; total: number; open: number } {
  const pageSize = Math.min(50, Math.max(1, Number(query.pageSize || 20)));
  const page = Math.max(1, Number(query.page || 1));
  const status = FEEDBACK_STATUSES.includes(query.status as FeedbackStatus) ? query.status : "";
  const kind = parseFeedbackKind(query.kind);
  const q = (query.q || "").trim();
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  if (kind) {
    where.push("kind = ?");
    args.push(kind);
  }
  if (q) {
    where.push("(title LIKE ? OR body LIKE ? OR device_hash LIKE ? OR contact LIKE ? OR ticket_no LIKE ?)");
    const like = `%${q}%`;
    args.push(like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM feedbacks ${clause}`).get(...args) as { c: number }).c;
  const open = (db.prepare("SELECT COUNT(*) AS c FROM feedbacks WHERE status = 'open'").get() as { c: number }).c;
  const items = db
    .prepare(`SELECT * FROM feedbacks ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as FeedbackRow[];
  const replies = repliesFor(db, items.map((row) => row.id));
  return {
    items: items.map((row) => publicFeedback(row, { admin: true, replies: replies.get(row.id) })),
    total: Number(total),
    open: Number(open),
  };
}

function decodeDataUrl(raw: string): { mime: string; buf: Buffer } {
  const m = /^data:(image\/(png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(raw || "").trim());
  if (!m) throw new Error("只支持 png / jpg / webp / gif 图片");
  const mime = m[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const buf = Buffer.from(m[3].replace(/\s/g, ""), "base64");
  if (!buf.length) throw new Error("图片是空的");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 2MB");
  return { mime, buf };
}

export async function createFeedback(
  db: DatabaseSync,
  dataDir: string,
  input: {
    deviceHash: string;
    title?: string;
    body?: string;
    kind?: string;
    images?: string[];
    contact?: string;
    client?: string;
  },
): Promise<FeedbackPublic> {
  const deviceHash = input.deviceHash;
  if (!deviceHash) throw new Error("缺少设备码");
  const kind = parseFeedbackKind(input.kind);
  if (!kind) throw new Error("请选择反馈类型");
  const body = String(input.body || "").trim();
  if (body.length < 8) throw new Error("请至少写 8 个字，方便我们看懂需求");
  if (body.length > MAX_BODY) throw new Error(`描述不能超过 ${MAX_BODY} 字`);
  if (disallowedReason(body, "chat")) throw new Error("这段描述不能提交");
  const title = String(input.title || "").trim().slice(0, MAX_TITLE);
  const contact = String(input.contact || "").trim().slice(0, MAX_CONTACT);
  const client = input.client === "desktop" ? "desktop" : "web";
  const rawImages = Array.isArray(input.images) ? input.images.slice(0, MAX_IMAGES) : [];
  // const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  // const recent = (db.prepare("SELECT COUNT(*) AS c FROM feedbacks WHERE device_hash = ? AND created_at >= ?").get(deviceHash, dayAgo) as { c: number }).c;
  // TEMP 2026-10-10: daily feedback limit disabled to observe; restore if spam appears.
  // if (Number(recent) >= DAILY_LIMIT) throw new Error("今天提交已经够多了，明天再来");

  const feedbackId = id("fb");
  const dir = path.join(feedbackDir(dataDir), feedbackId);
  fs.mkdirSync(dir, { recursive: true });
  const stored: FeedbackImage[] = [];
  try {
    for (let i = 0; i < rawImages.length; i++) {
      const { mime, buf } = decodeDataUrl(rawImages[i]);
      const ext = MIME_EXT[mime] || ".jpg";
      const name = `${String(i + 1).padStart(2, "0")}${ext}`;
      const abs = path.join(dir, name);
      assertInside(dir, abs);
      await fsPromises.writeFile(abs, buf);
      stored.push({ name, mime });
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  const ts = now();
  const seq =
    Number(
      (db.prepare("SELECT COALESCE(MAX(CASE WHEN ticket_seq > 0 THEN ticket_seq END), 1000) AS n FROM feedbacks").get() as { n: number }).n,
    ) + 1;
  const ticketNo = `FB-${seq}`;
  db.prepare(
    `INSERT INTO feedbacks (id, device_hash, title, body, kind, images, status, reward_days, reward_applied, admin_note, contact, client, ticket_seq, ticket_no, created_at, updated_at, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', 0, '', '', ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(feedbackId, deviceHash, title, body, kind, JSON.stringify(stored), contact, client, seq, ticketNo, ts, ts);
  return publicFeedback(getRow(db, feedbackId) as FeedbackRow);
}

export function adoptFeedback(
  db: DatabaseSync,
  feedbackId: string,
  days?: number,
  note?: string,
): FeedbackPublic {
  const row = getRow(db, feedbackId);
  if (!row) throw new Error("反馈不存在");
  if (row.status !== "open") throw new Error("这条已经处理过了");
  const fallback = getQuotaSettings(db).feedbackRewardDays;
  const rewardDays = Math.max(1, Math.min(365, Math.floor(Number(days ?? fallback) || fallback)));
  const linked = db.prepare(
    `SELECT e.device_hash AS device_hash FROM entitlements e
     WHERE e.plan = 'licensed' AND e.user_id IS NOT NULL AND e.user_id = (
       SELECT redeemed_user_id FROM license_keys
       WHERE redeemed_device_hash = ? AND redeemed_user_id IS NOT NULL
       ORDER BY redeemed_at DESC LIMIT 1
     )`,
  ).get(row.device_hash) as { device_hash: string } | undefined;
  const granted = grantLicenseDays(db, linked?.device_hash || row.device_hash, rewardDays);
  const ts = now();
  db.prepare(
    "UPDATE feedbacks SET status='adopted', reward_days=?, reward_applied=?, admin_note=?, reviewed_at=?, updated_at=? WHERE id=?",
  ).run(rewardDays, granted.applied, String(note || granted.message).slice(0, 400), ts, ts, row.id);
  return getFeedbackForAdmin(db, feedbackId);
}

export function rejectFeedback(db: DatabaseSync, feedbackId: string, note?: string): FeedbackPublic {
  const row = getRow(db, feedbackId);
  if (!row) throw new Error("反馈不存在");
  if (row.status !== "open") throw new Error("这条已经处理过了");
  const ts = now();
  db.prepare("UPDATE feedbacks SET status='rejected', admin_note=?, reviewed_at=?, updated_at=? WHERE id=?").run(
    String(note || "").trim().slice(0, 400),
    ts,
    ts,
    row.id,
  );
  return getFeedbackForAdmin(db, feedbackId);
}

/**
 * 运营回复：Markdown 正文 + 最多 3 张截图（和用户提交同样的格式 / 2MB 限制），存进同一个反馈目录。
 * 正文里的 ![](reply-image:N) 换成第 N 张截图的地址；不改工单状态。
 */
export async function addFeedbackReply(
  db: DatabaseSync,
  dataDir: string,
  feedbackId: string,
  input: { body?: string; images?: string[]; author?: string },
): Promise<FeedbackPublic> {
  const row = getRow(db, feedbackId);
  if (!row) throw new Error("反馈不存在");
  let body = String(input.body || "").replace(/\r\n/g, "\n").trim();
  const rawImages = Array.isArray(input.images) ? input.images : [];
  if (rawImages.length > MAX_IMAGES) throw new Error(`一次最多 ${MAX_IMAGES} 张截图`);
  if (!body && !rawImages.length) throw new Error("回复内容不能为空");
  if (body.length > MAX_REPLY_BODY) throw new Error(`回复不能超过 ${MAX_REPLY_BODY} 字`);
  const dir = path.join(feedbackDir(dataDir), feedbackId);
  fs.mkdirSync(dir, { recursive: true });
  // 序号取已用过的最大值 + 1（库里的回复 + 目录里的文件），删过回复也不会覆盖别的回复的截图
  const usedSeq = [
    ...(db.prepare("SELECT images FROM feedback_replies WHERE feedback_id = ?").all(feedbackId) as Array<{ images: string }>).flatMap((r) =>
      parseImages(r.images).map((img) => img.name),
    ),
    ...fs.readdirSync(dir),
  ].map((name) => Number(/^r(\d+)-/i.exec(name)?.[1] || 0));
  const seq = Math.max(0, ...usedSeq) + 1;
  const stored: FeedbackImage[] = [];
  const written: string[] = [];
  try {
    for (let i = 0; i < rawImages.length; i++) {
      const { mime, buf } = decodeDataUrl(rawImages[i]);
      const ext = MIME_EXT[mime] || ".jpg";
      const name = `r${seq}-${String(i + 1).padStart(2, "0")}${ext}`;
      const abs = path.join(dir, name);
      assertInside(dir, abs);
      await fsPromises.writeFile(abs, buf);
      written.push(abs);
      stored.push({ name, mime });
    }
  } catch (err) {
    for (const abs of written) fs.rmSync(abs, { force: true });
    throw err;
  }
  body = body.replace(/\(reply-image:(\d+)\)/g, (whole, n: string) => {
    const img = stored[Number(n) - 1];
    return img ? `(${fileUrl(feedbackId, img.name, false)})` : whole;
  });
  const ts = now();
  db.prepare("INSERT INTO feedback_replies (id, feedback_id, author, body, images, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id("fbr"),
    feedbackId,
    String(input.author || "运营").slice(0, 40),
    body,
    JSON.stringify(stored),
    ts,
  );
  db.prepare("UPDATE feedbacks SET updated_at = ? WHERE id = ?").run(ts, feedbackId);
  return getFeedbackForAdmin(db, feedbackId);
}

export function deleteFeedbackReply(db: DatabaseSync, dataDir: string, feedbackId: string, replyId: string): FeedbackPublic {
  const reply = db.prepare("SELECT * FROM feedback_replies WHERE id = ? AND feedback_id = ?").get(replyId, feedbackId) as
    | FeedbackReplyRow
    | undefined;
  if (!reply) throw new Error("回复不存在");
  const dir = path.join(feedbackDir(dataDir), feedbackId);
  for (const img of parseImages(reply.images)) {
    const abs = path.join(dir, img.name);
    try {
      assertInside(dir, abs);
      fs.rmSync(abs, { force: true });
    } catch {
      /* 文件名不合法就不删 */
    }
  }
  db.prepare("DELETE FROM feedback_replies WHERE id = ?").run(replyId);
  return getFeedbackForAdmin(db, feedbackId);
}

const FILE_NAME = /^(\d{2}|r\d{1,4}-\d{2})\.(png|jpe?g|webp|gif)$/i;

export async function readFeedbackFile(
  db: DatabaseSync,
  dataDir: string,
  feedbackId: string,
  name: string,
  deviceHash?: string,
): Promise<{ buf: Buffer; mime: string }> {
  if (!FILE_NAME.test(name)) throw new Error("文件不存在");
  const row = getRow(db, feedbackId);
  if (!row) throw new Error("反馈不存在");
  if (deviceHash && row.device_hash !== deviceHash) throw new Error("反馈不存在");
  let meta = parseImages(row.images).find((img) => img.name === name);
  if (!meta && name.startsWith("r")) {
    const replies = repliesFor(db, [feedbackId]).get(feedbackId) ?? [];
    for (const reply of replies) {
      meta = parseImages(reply.images).find((img) => img.name === name);
      if (meta) break;
    }
  }
  if (!meta) throw new Error("文件不存在");
  const dir = path.join(feedbackDir(dataDir), feedbackId);
  const abs = path.join(dir, name);
  assertInside(dir, abs);
  const buf = await fsPromises.readFile(abs);
  return { buf, mime: meta.mime || "image/jpeg" };
}
