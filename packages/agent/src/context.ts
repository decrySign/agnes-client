import type { ChatContentPart, ChatMessage, ChatToolCall } from "@agnes/sdk";
import { estimateInputTokens } from "./model-caps.js";

/**
 * 发给模型的字符预算。界面和数据库里的历史不删、不改。
 * 中文大约一字一 token，7 万字对 128k 窗口留得出生成和本轮工具的余量。
 */
export const MODEL_CHAR_BUDGET = 36_000;

/** 最后一条用户消息之前，仍保留全文的工具结果条数（再往前的收成一行） */
const HOT_TOOLS = 6;
const HOT_TOOL_CAP = 6_000;
/** 至少逐字保留最近这么多次用户发言。条数太多时再往下收到 3、1 */
const KEEP_USER_TURNS = 6;
/**
 * 条数本身也会把首 token 拖过 3 分钟。字符没超预算也要摘录，
 * 否则 200 多条工具消息会让模型一直不开口，最后被空闲超时掐掉。
 */
const MAX_MODEL_MESSAGES = 48;
const SUMMARY_CAP = 8_000;
const STUB_MARK = "[较早的工具结果已省略";

const COMPACT_HINT =
  "\n\n较早的工具输出可能被收成一行。那只影响发给你的上下文，用户界面里的完整记录还在。需要文件内容就重新 read_file / grep，不要根据省略行编造。较早的工具调用里，长参数会显示成「…[已截断，原长 N 字]」，那只是摘录：你自己调用工具时必须写完整的 path 和完整内容，不要照抄截断的参数。";

export type CompactStats = {
  before: number;
  after: number;
  stubbedTools: number;
  droppedImages: number;
  summarizedTurns: number;
  changed: boolean;
};

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!content || !Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : part.type === "image_url" ? part.image_url.url : ""))
    .join("");
}

export function messageChars(message: ChatMessage): number {
  let n = textOf(message.content).length;
  for (const call of message.tool_calls ?? []) {
    n += (call.function?.name?.length ?? 0) + (call.function?.arguments?.length ?? 0);
  }
  return n;
}

function totalChars(messages: ChatMessage[]): number {
  let n = 0;
  for (const message of messages) n += messageChars(message);
  return n;
}

function stubTool(content: string): string {
  if (content.startsWith(STUB_MARK)) return content;
  const head = content.replace(/\s+/g, " ").trim().slice(0, 180);
  return `${STUB_MARK}，共 ${content.length} 字。开头：${head}。需要原文请重新调用工具。]`;
}

function capString(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(较早的输出已截断，共 ${text.length} 字，需要全文请重新读取)`;
}

/** 较早工具调用里每个字符串参数保留的开头字数 */
const ARG_HEAD = 120;

/**
 * 截断标记。tools.ts 里写文件 / 跑命令的参数带着它就拒绝执行，
 * 防止模型照抄上下文里被截短的旧参数。
 */
export const CLIPPED_ARG_RE = /…\[已截断，原长 \d+ 字\]/;

function clipArgValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > ARG_HEAD ? `${value.slice(0, ARG_HEAD)}…[已截断，原长 ${value.length} 字]` : value;
  }
  if (Array.isArray(value)) return value.map(clipArgValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, clipArgValue(v)]));
  }
  return value;
}

/**
 * 较早的大参数工具调用只缩短字符串值，键和结构原样保留（path / old_string / new_string …）。
 * 以前整份换成 `{ omitted: true, preview }`，长对话里模型会照着这个形状发调用，
 * 结果 edit_file / apply_patch 拿不到 path，报 EISDIR、「old_string 不能为空」（FB-1005）。
 */
export function clipToolArgs(calls: ChatToolCall[]): ChatToolCall[] {
  return calls.map((call) => {
    const args = call.function?.arguments ?? "";
    if (args.length <= 500) return call;
    let clipped: string;
    try {
      clipped = JSON.stringify(clipArgValue(JSON.parse(args)));
    } catch {
      // 不是合法 JSON：退成截短的 JSON 字符串，仍然不造出假的参数键
      clipped = JSON.stringify(clipArgValue(args));
    }
    return {
      ...call,
      function: {
        name: call.function?.name ?? "",
        arguments: clipped,
      },
    };
  });
}

function stripOldImages(content: ChatContentPart[]): { parts: ChatContentPart[]; dropped: number } {
  let dropped = 0;
  const parts = content.map((part) => {
    if (part.type === "image_url" && part.image_url.url.startsWith("data:") && part.image_url.url.length > 256) {
      dropped += 1;
      return { type: "text" as const, text: "[较早的图片已从模型上下文省略]" };
    }
    return part;
  });
  return { parts, dropped };
}

function buildSummary(prefix: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of prefix) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOf(message.content).replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(`${message.role === "user" ? "用户" : "助手"}：${text.slice(0, 500)}`);
  }
  let body = lines.join("\n");
  if (body.length > SUMMARY_CAP) body = `…(更早的摘录已截断)\n${body.slice(body.length - SUMMARY_CAP)}`;
  return body;
}

function withHint(messages: ChatMessage[]): ChatMessage[] {
  const idx = messages.findIndex((message) => message.role === "system" && typeof message.content === "string");
  if (idx < 0) return messages;
  const system = messages[idx];
  const content = typeof system.content === "string" ? system.content : "";
  if (content.includes("较早的工具输出可能被收成一行")) return messages;
  const copy = messages.slice();
  copy[idx] = { ...system, content: content + COMPACT_HINT };
  return copy;
}

/**
 * 只缩短「发给模型的那一份」。最近一轮用户发言之后的工具结果尽量留全文，
 * 更早的大段 read_file / 终端输出收成一行，好让模型接着干而不是把整段对话清掉。
 */
export type SummaryCache = { count: number; text: string };

export function parseSummaryCache(raw: string | undefined | null): SummaryCache | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { count?: unknown; text?: unknown };
    if (typeof value.count !== "number" || typeof value.text !== "string" || !value.text.trim()) return null;
    return { count: value.count, text: value.text.slice(0, SUMMARY_CAP) };
  } catch {
    return null;
  }
}

/** 交给模型归纳的原文最多这么多字；超了保留开头（通常是最初的需求）和最近的部分，中间省略 */
const SUMMARY_SOURCE_CAP = 12_000;
const SUMMARY_HEAD_KEEP = 2_000;
/** 兜底：还压不下去时，除最后一条用户消息外，单条用户 / 助手正文截到这么多字（从最旧的开始） */
const LAST_RESORT_CAP = 8_000;
/** 按 token 压缩时预算的下限，防止阈值减去工具定义后变成负数 */
const MIN_TOKEN_BUDGET = 2_048;

/** 发给模型那一份怎么量、最多几条。不传 = 老规矩：按字数量，最多 48 条 */
export type CompactOptions = {
  measure?: (messages: ChatMessage[]) => number;
  maxMessages?: number;
};

export type CompactBudget = { budget: number; options: CompactOptions; unit: "chars" | "tokens" };

/**
 * 这个模型这一轮的压缩预算。
 * 设置里配了压缩阈值（百分比或 token 数）：按 estimateInputTokens 估 token，阈值扣掉工具定义占的部分，不再按条数压。
 * 没配：和以前完全一样，3.6 万字 / 48 条。
 */
export function compactBudget(caps?: { compactThreshold?: number } | null, toolTokens = 0): CompactBudget {
  if (!caps?.compactThreshold) return { budget: MODEL_CHAR_BUDGET, options: {}, unit: "chars" };
  return {
    budget: Math.max(MIN_TOKEN_BUDGET, caps.compactThreshold - toolTokens),
    options: { measure: (messages) => estimateInputTokens(messages), maxMessages: Number.POSITIVE_INFINITY },
    unit: "tokens",
  };
}

export type SummaryPlanOptions = CompactOptions & {
  /** 上一次的模型摘录。还对得上就只把它之后新增的对话交给模型，和旧摘录合并（滚动摘要） */
  previous?: SummaryCache | null;
  /** 交给模型的原文上限（字），小窗口模型可以调小 */
  maxPromptChars?: number;
};

function summaryLines(prefix: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of prefix) {
    if (message.role === "tool") {
      const toolText = textOf(message.content).replace(/\s+/g, " ").trim().slice(0, 160);
      if (toolText) lines.push(`工具：${toolText}`);
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOf(message.content).replace(/\s+/g, " ").trim().slice(0, 800);
    if (!text) continue;
    lines.push(`${message.role === "user" ? "用户" : "助手"}：${text}`);
  }
  return lines.join("\n");
}

/**
 * 机械压缩会丢掉整段时，算出要交给模型归纳的原文。
 * count 是被摘掉的消息条数，用来判断缓存还能不能用；sourceChars 是被摘掉部分的原长，摘录不比它短就不用。
 * 历史再长，交给模型的原文也不超过 maxPromptChars（+ 旧摘录），所以摘录这一步本身不会超窗口。
 */
export function planModelSummary(
  messages: ChatMessage[],
  budget = MODEL_CHAR_BUDGET,
  options: SummaryPlanOptions = {},
): { count: number; prompt: string; sourceChars: number } | null {
  const size = options.measure ?? totalChars;
  const maxMessages = options.maxMessages ?? MAX_MODEL_MESSAGES;
  if (size(messages) <= budget && messages.length <= maxMessages) return null;
  const userIdx = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  let cut = -1;
  for (const keep of [KEEP_USER_TURNS, 3, 1]) {
    if (userIdx.length > keep) {
      cut = userIdx[userIdx.length - keep];
      break;
    }
  }
  if (cut <= 1) return null;
  const prefix = messages.slice(0, cut).filter((message) => message.role !== "system");
  if (prefix.length < 2) return null;
  const prev = options.previous;
  let previous = prev && prev.count > 0 && prev.count < prefix.length && prev.text.trim() ? prev : null;
  let body = previous ? summaryLines(prefix.slice(previous.count)) : "";
  if (!body.trim()) {
    previous = null;
    body = summaryLines(prefix);
  }
  if (!body.trim()) return null;
  const cap = Math.max(2_000, options.maxPromptChars ?? SUMMARY_SOURCE_CAP);
  if (body.length > cap) {
    const head = Math.min(SUMMARY_HEAD_KEEP, Math.floor(cap / 6));
    const tail = cap - head;
    body = `${body.slice(0, head)}\n…（中间 ${body.length - cap} 字较早的对话省略）…\n${body.slice(body.length - tail)}`;
  }
  const sourceChars = totalChars(prefix);
  if (previous) {
    return {
      count: prefix.length,
      sourceChars,
      prompt: `下面是一份已有的较早对话摘录，和它之后新增的对话。把两者合并成一份新的摘录，给继续干活的助手看。只写四块：用户要做什么；已经改过的文件；关键决定；还没做完的事。不要复述工具原文，不要编造没出现的文件。800字以内。\n\n【已有摘录】\n${previous.text.slice(0, SUMMARY_CAP)}\n\n【新增对话】\n${body}`,
    };
  }
  return {
    count: prefix.length,
    sourceChars,
    prompt: `把下面较早的编程对话收成摘录，给继续干活的助手看。只写四块：用户要做什么；已经改过的文件；关键决定；还没做完的事。不要复述工具原文，不要编造没出现的文件。800字以内。\n\n${body}`,
  };
}

/**
 * options 不传时和以前逐字一样（按字数、48 条）。传了 measure 就按它量（比如估 token），
 * maxMessages 传 Infinity 就不按条数压。stats.before / after 始终是字数，给界面看。
 */
export function compactForModel(
  messages: ChatMessage[],
  budget = MODEL_CHAR_BUDGET,
  modelDigest?: string | null,
  options: CompactOptions = {},
): { messages: ChatMessage[]; stats: CompactStats } {
  const size = options.measure ?? totalChars;
  const maxMessages = options.maxMessages ?? MAX_MODEL_MESSAGES;
  const before = totalChars(messages);
  const stats: CompactStats = {
    before,
    after: before,
    stubbedTools: 0,
    droppedImages: 0,
    summarizedTurns: 0,
    changed: false,
  };
  if (size(messages) <= budget && messages.length <= maxMessages) return { messages, stats };

  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUser = index;
      break;
    }
  }
  let next = messages.map((message) => ({ ...message }));

  const toolBefore = next.flatMap((message, index) => (message.role === "tool" && index < lastUser ? [index] : []));
  const coldCount = Math.max(0, toolBefore.length - HOT_TOOLS);
  for (let n = 0; n < toolBefore.length; n++) {
    const index = toolBefore[n];
    const raw = typeof next[index].content === "string" ? next[index].content : "";
    if (!raw) continue;
    if (n < coldCount) {
      next[index] = { ...next[index], content: stubTool(raw) };
      stats.stubbedTools += 1;
    } else if (raw.length > HOT_TOOL_CAP) {
      next[index] = { ...next[index], content: capString(raw, HOT_TOOL_CAP) };
      stats.stubbedTools += 1;
    }
  }

  for (let index = 0; index < lastUser; index++) {
    const message = next[index];
    if (message.role === "assistant" && message.tool_calls?.some((call) => (call.function?.arguments?.length ?? 0) > 500)) {
      next[index] = { ...message, tool_calls: clipToolArgs(message.tool_calls) };
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      const stripped = stripOldImages(message.content);
      if (stripped.dropped) {
        stats.droppedImages += stripped.dropped;
        next[index] = { ...message, content: stripped.parts };
      }
    }
  }

  let digestUsed = false;
  for (const keepTurns of [KEEP_USER_TURNS, 3, 1]) {
    if (size(next) <= budget && next.length <= maxMessages) break;
    const userIdx = next.flatMap((message, index) => (message.role === "user" ? [index] : []));
    const cut = userIdx.length > keepTurns ? userIdx[userIdx.length - keepTurns] : -1;
    // 用户轮次不够这一档（比如只有 6 轮时保留 6 轮）就试下一档（3 轮、1 轮），和 planModelSummary 一样；
    // 以前这里 break，短对话（≤6 轮）怎么都压不动，上游报超长后的重试和手动 /compact 都没效果
    if (cut <= 0) continue;
    const prefix = next.slice(0, cut).filter((message) => message.role !== "system");
    const systems = next.slice(0, cut).filter((message) => message.role === "system");
    const modelText = !digestUsed && modelDigest?.trim() ? modelDigest.trim().slice(0, SUMMARY_CAP) : "";
    if (modelText) digestUsed = true;
    const summary = modelText || buildSummary(prefix);
    stats.summarizedTurns += prefix.filter((message) => message.role === "user").length;
    const digest: ChatMessage[] = summary
      ? [
          {
            role: "system",
            content: modelText
              ? `更早对话摘录（模型归纳。缺细节请重新读文件，不要编造）。\n${summary}`
              : `更早对话摘录（保留用户原话和助手结论，工具输出已省略）。缺细节请重新读文件，不要编造。\n${summary}`,
          },
        ]
      : [];
    next = [...systems, ...digest, ...next.slice(cut)];
  }

  if (size(next) > budget) {
    const toolIdx = next.flatMap((message, index) => (message.role === "tool" ? [index] : []));
    const shrinkable = toolIdx.slice(0, Math.max(0, toolIdx.length - 2));
    for (const index of shrinkable) {
      if (size(next) <= budget) break;
      const raw = typeof next[index].content === "string" ? next[index].content : "";
      if (raw.length <= 400 || raw.startsWith(STUB_MARK)) continue;
      next[index] = { ...next[index], content: stubTool(raw) };
      stats.stubbedTools += 1;
    }
  }

  if (size(next) > budget) {
    const toolIdx = next.flatMap((message, index) => (message.role === "tool" ? [index] : []));
    for (const index of toolIdx) {
      if (size(next) <= budget) break;
      const raw = typeof next[index].content === "string" ? next[index].content : "";
      if (raw.length <= 4_000) continue;
      next[index] = { ...next[index], content: capString(raw, 4_000) };
      stats.stubbedTools += 1;
    }
  }

  // 兜底：还超（单条超长的用户 / 助手正文、本轮的大参数调用），从最旧的开始截；最后一条用户消息不动
  if (size(next) > budget) {
    let lastUserNow = -1;
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (next[index].role === "user") {
        lastUserNow = index;
        break;
      }
    }
    for (let index = 0; index < next.length; index++) {
      if (size(next) <= budget) break;
      const message = next[index];
      if (index === lastUserNow || message.role === "system" || message.role === "tool") continue;
      if (message.role === "assistant" && message.tool_calls?.some((call) => (call.function?.arguments?.length ?? 0) > 500)) {
        next[index] = { ...message, tool_calls: clipToolArgs(message.tool_calls) };
      }
      const current = next[index];
      if (typeof current.content === "string" && current.content.length > LAST_RESORT_CAP) {
        next[index] = { ...current, content: capString(current.content, LAST_RESORT_CAP) };
      }
    }
  }

  next = withHint(next);
  stats.after = totalChars(next);
  stats.changed = true;
  return { messages: next, stats };
}

export const CANCELLED_TOOL_RESULT = "已取消：用户停止了这一轮，这个工具没有执行。";

/**
 * 发给上游前把 tool_calls 和 tool 结果配平：缺结果的补一条占位，找不到对应调用的 tool 消息丢掉。
 * 旧版本停止时会留下半截工具批次，这种历史发给 OpenAI 兼容接口会直接 400，整条对话就卡死了。
 */
export function repairToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.tool_calls?.length) {
      out.push(message);
      const wanted = new Set(message.tool_calls.map((call) => call.id));
      const answered = new Set<string>();
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === "tool") {
        const tool = messages[j]!;
        const id = tool.tool_call_id ?? "";
        if (wanted.has(id) && !answered.has(id)) {
          answered.add(id);
          out.push(tool);
        }
        j++;
      }
      for (const call of message.tool_calls) {
        if (!answered.has(call.id)) out.push({ role: "tool", tool_call_id: call.id, content: CANCELLED_TOOL_RESULT });
      }
      i = j;
      continue;
    }
    if (message.role !== "tool") out.push(message);
    i++;
  }
  return out;
}
