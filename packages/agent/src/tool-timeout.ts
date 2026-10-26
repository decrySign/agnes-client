/**
 * 每种工具单独的超时预算（参照 dsh tool-call-timeout-policy，协作式）：
 * 计时器到点只 abort 派生出来的 signal，然后等工具自己收尾；只有自己的计时器先到，
 * 才把结果换成一句超时失败（以「工具失败」开头，UI 标红、模型能看懂）。
 * 用户点停止（外层 signal）不算超时：工具因此抛错时换成「已停止：用户取消了这次…」（不标红，和超时文案分开）；
 * 工具自己正常返回的结果原样给。
 *
 * 只管认 signal 的工具：联网搜索 / 读取网页 / MCP。前台命令走它自己的 timeout_ms，
 * 这里只改「模型没给 timeout_ms 时」的默认值。读写文件、提问、计划、子 Agent 故意不设，
 * 避免写到一半被停（dsh 的 read / write / edit 同样没有超时）。
 */

export type ToolTimeouts = Record<string, number>;

export const TOOL_TIMEOUT_LIMITS: Record<string, { min: number; max: number; label: string; fallbackMs: number }> = {
  web_search: { min: 1000, max: 120_000, label: "联网搜索", fallbackMs: 15_000 },
  web_fetch: { min: 1000, max: 120_000, label: "读取网页", fallbackMs: 15_000 },
  mcp: { min: 1000, max: 600_000, label: "MCP 工具（全部）", fallbackMs: 60_000 },
  run_terminal: { min: 1000, max: 300_000, label: "前台命令默认超时", fallbackMs: 60_000 },
};

const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/;

const MAX_TIMEOUT_ENTRIES = 64;

function limitFor(key: string): { min: number; max: number } {
  // 用 hasOwn：防止 "constructor"、"__proto__" 这类键命中原型上的东西
  const lim = Object.prototype.hasOwnProperty.call(TOOL_TIMEOUT_LIMITS, key)
    ? TOOL_TIMEOUT_LIMITS[key]
    : key.length <= 128 && MCP_TOOL_RE.test(key)
      ? TOOL_TIMEOUT_LIMITS.mcp
      : undefined;
  if (!lim) {
    throw new Error(`toolTimeouts 不支持「${key.slice(0, 64)}」：只能设 ${Object.keys(TOOL_TIMEOUT_LIMITS).join("、")} 或 mcp__服务__工具`);
  }
  return lim;
}

/** null、空字符串、0：这一项删掉、恢复内置默认 */
const isUnset = (v: unknown) => v === null || v === "" || v === 0;

function checkValue(key: string, v: unknown, lim: { min: number; max: number }): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`toolTimeouts.${key} 必须是整数毫秒`);
  if (v < lim.min || v > lim.max) throw new Error(`toolTimeouts.${key} 超出范围：${lim.min}–${lim.max} 毫秒`);
  return v;
}

function entriesOf(raw: unknown): Array<[string, unknown]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('toolTimeouts 必须是对象，例如 {"web_fetch": 30000}');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_TIMEOUT_ENTRIES) throw new Error(`toolTimeouts 最多 ${MAX_TIMEOUT_ENTRIES} 项`);
  return entries;
}

/** 校验整张超时表（读库时用）。不合法就抛中文错误。null / "" / 0 表示用内置默认，不写进结果 */
export function parseToolTimeouts(raw: unknown): ToolTimeouts {
  if (raw === null) return {};
  const out: ToolTimeouts = {};
  for (const [key, v] of entriesOf(raw)) {
    const lim = limitFor(key);
    if (isUnset(v)) continue;
    out[key] = checkValue(key, v, lim);
  }
  return out;
}

/** PUT /api/settings 带来的改动：set 要设的、remove 要删的（值是 null / "" / 0）；整个传 null = 全部恢复默认 */
export type ToolTimeoutsPatch = { set: ToolTimeouts; remove: string[]; clearAll: boolean };

/** 只校验不合并：任何一项不合法就整体抛错（服务端回 400，什么都不写） */
export function parseToolTimeoutsPatch(raw: unknown): ToolTimeoutsPatch {
  if (raw === null) return { set: {}, remove: [], clearAll: true };
  const patch: ToolTimeoutsPatch = { set: {}, remove: [], clearAll: false };
  for (const [key, v] of entriesOf(raw)) {
    const lim = limitFor(key);
    if (isUnset(v)) patch.remove.push(key);
    else patch.set[key] = checkValue(key, v, lim);
  }
  return patch;
}

/** 按项合并到现有表：只带一项时其他项不动 */
export function mergeToolTimeouts(prev: ToolTimeouts | undefined, patch: ToolTimeoutsPatch): ToolTimeouts {
  const out: ToolTimeouts = {};
  if (!patch.clearAll) {
    for (const [k, v] of Object.entries(prev ?? {})) {
      if (typeof v === "number" && v > 0) out[k] = v;
    }
  }
  for (const k of patch.remove) delete out[k];
  Object.assign(out, patch.set);
  if (Object.keys(out).length > MAX_TIMEOUT_ENTRIES) throw new Error(`toolTimeouts 最多 ${MAX_TIMEOUT_ENTRIES} 项`);
  return out;
}

/** 这次调用的超时预算；undefined = 没单独设，走工具原来的行为 */
export function toolTimeoutFor(name: string, map?: ToolTimeouts): number | undefined {
  if (!map) return undefined;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (name === "web_search" || name === "web_fetch") return ok(map[name]) ? map[name] : undefined;
  if (name.startsWith("mcp__")) {
    if (ok(map[name])) return map[name];
    return ok(map.mcp) ? map.mcp : undefined;
  }
  return undefined;
}

/** run_terminal 前台命令在模型没给 timeout_ms 时用的默认值 */
export function terminalDefaultTimeout(map?: ToolTimeouts): number {
  const v = map?.run_terminal;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : TOOL_TIMEOUT_LIMITS.run_terminal!.fallbackMs;
}

function fmtMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} 秒` : `${ms} 毫秒`;
}

export function toolTimeoutText(name: string, ms: number): string {
  return `工具失败：${name} 超过 ${fmtMs(ms)} 没有完成，已按超时设置停止。可以缩小范围后重试，或在设置里调大这个工具的超时。`;
}

const STOP_WHAT: Record<string, string> = { web_search: "联网搜索", web_fetch: "读取网页" };

/** 用户点了停止：不是失败（不标红），和超时文案分开 */
export function toolStoppedText(name: string): string {
  const what = Object.prototype.hasOwnProperty.call(STOP_WHAT, name)
    ? STOP_WHAT[name]
    : name.startsWith("mcp__")
      ? `MCP 工具调用（${name}）`
      : `${name} 调用`;
  return `已停止：用户取消了这次${what}。`;
}

/** fetch 自带的 AbortSignal.timeout 到点：DOMException TimeoutError */
function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; cause?: { name?: string } } | null;
  return e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError";
}

/** 没单独设超时时工具内置的超时（联网工具 15 秒），只用来写超时文案 */
function builtinTimeoutMs(name: string): number {
  return Object.prototype.hasOwnProperty.call(TOOL_TIMEOUT_LIMITS, name) ? TOOL_TIMEOUT_LIMITS[name]!.fallbackMs : TOOL_TIMEOUT_LIMITS.mcp!.fallbackMs;
}

/**
 * 协作式超时：run 拿到合并后的 signal（外层停止 + 本次超时）。
 * 不 race、不丢弃迟到结果之外的东西：一直等 run 自己返回，再看是不是自己的计时器先到。
 */
export async function withToolTimeout(
  name: string,
  ms: number | undefined,
  outer: AbortSignal | undefined,
  run: (signal: AbortSignal | undefined) => Promise<string>,
): Promise<string> {
  if (!ms || ms <= 0) {
    try {
      return await run(outer);
    } catch (err) {
      if (outer?.aborted) return toolStoppedText(name);
      if (isTimeoutError(err)) return toolTimeoutText(name, builtinTimeoutMs(name));
      throw err;
    }
  }
  const ac = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    ac.abort(new Error("TOOL_TIMEOUT"));
  }, ms);
  const signal = outer ? AbortSignal.any([outer, ac.signal]) : ac.signal;
  try {
    const out = await run(signal);
    return fired && !outer?.aborted ? toolTimeoutText(name, ms) : out;
  } catch (err) {
    if (outer?.aborted) return toolStoppedText(name);
    if (fired || isTimeoutError(err)) return toolTimeoutText(name, ms);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
