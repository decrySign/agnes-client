import type { Entitlement } from "./types.js";

/** OSS: local BYOK operator — no card-key summary. */
export function licenseSummary(ent: Entitlement): string {
  if (ent.isSuper || ent.plan === "licensed") return "本机密钥已就绪";
  if (ent.remaining == null) return "对话额度不限";
  return `试用剩余 ${ent.remaining} 次对话`;
}
