import type { Entitlement } from "./types.js";

function left(remaining: number | null, unit: string): string {
  return remaining === null ? `${unit}不限` : `${unit}${remaining}`;
}

/** 桌面端授权摘要：区分超管版 / 订阅档 / 已到期 */
export function licenseSummary(ent: Entitlement): string {
  if (ent.expired) return "授权已到期，请续期";
  if (ent.isSuper) return "超级管理员版 · 额度不限 · 永不过期";
  const chat = ent.remaining === null ? "对话不限" : `对话剩 ${ent.remaining}`;
  const media = `${left(ent.imageRemaining, "图剩 ")} · ${left(ent.videoRemaining, "视频剩 ")}`;
  const until = ent.expiresAt === null ? "长期有效" : `至 ${new Date(ent.expiresAt).toLocaleDateString("zh-CN")}`;
  return `${chat} · ${media} · ${until}`;
}
