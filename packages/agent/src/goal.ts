/** 每个对话可选的「目标」：持久化在 conversations.goal，每轮注入系统提示 */
export const GOAL_MAX = 500;

export function normalizeGoal(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, GOAL_MAX);
}

export const GOAL_HEADING = "# 本对话目标（用户设定）";

export function withGoal(system: string, goal?: string | null): string {
  const g = normalizeGoal(goal ?? "");
  if (!g) return system;
  return `${system}\n\n${GOAL_HEADING}\n每一轮都围绕这个目标推进；和用户最新的话冲突时，以最新的话为准。\n${g}`;
}
