// 设置页「工具超时」的草稿 ↔ 接口格式转换（纯函数，单独放出来便于自测）

/** 设置里能单独改超时的工具。界面上按秒填，存毫秒；留空 = 内置默认。上限与 agent 的 TOOL_TIMEOUT_LIMITS 一致 */
export const TOOL_TIMEOUT_FIELDS = [
  { key: "web_search", label: "联网搜索", def: 15, max: 120 },
  { key: "web_fetch", label: "读取网页", def: 15, max: 120 },
  { key: "mcp", label: "MCP 工具（全部）", def: 60, max: 600 },
  { key: "run_terminal", label: "前台命令（模型没给 timeout_ms 时）", def: 60, max: 300 },
] as const;

export function timeoutDraft(map?: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of TOOL_TIMEOUT_FIELDS) {
    const v = map?.[f.key];
    out[f.key] = typeof v === "number" && v > 0 ? String(v / 1000) : "";
  }
  return out;
}

/**
 * 草稿转回毫秒，提交完整的表：这 4 项每项都带上，留空的传 null（服务端按项合并，null = 删掉这项、恢复默认）；
 * 通过接口单独设的 mcp__服务__工具 原样带上
 */
export function timeoutsFromDraft(draft: Record<string, string>, prev?: Record<string, number>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(prev ?? {})) {
    if (!TOOL_TIMEOUT_FIELDS.some((f) => f.key === k)) out[k] = v;
  }
  for (const f of TOOL_TIMEOUT_FIELDS) {
    const raw = (draft[f.key] ?? "").trim();
    if (!raw) {
      out[f.key] = null;
      continue;
    }
    const sec = Number(raw);
    if (!Number.isFinite(sec) || sec < 1 || sec > f.max) throw new Error(`「${f.label}」的超时要填 1–${f.max} 之间的秒数`);
    out[f.key] = Math.round(sec * 1000);
  }
  return out;
}
