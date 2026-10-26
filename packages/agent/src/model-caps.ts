import type { ChatContentPart, ChatMessage, ChatToolDefinition, ThinkingLevel, ThinkingStyle } from "@agnes/sdk";

/**
 * 按模型区分的能力：上下文窗口、单次输出上限、能不能看图、思考档位。
 * 数值优先级：用户在设置里填的 > 渠道 /models 返回的（获取模型时预填进设置）> 下面这张官方文档表 > 保守默认。
 * 表里每一行都抄自厂商官方文档，source 是出处；查不到的模型不进表，走 DEFAULT_MODEL_CAPS。
 */

export const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

export type ModelCapsInput = {
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
  /** 选用的思考档位；不填 = 不发思考参数，沿用上游默认 */
  thinking?: ThinkingLevel;
  /**
   * 压缩阈值，二选一：占上下文窗口的比例（0.05–0.95，界面写成百分比），或 token 数。
   * 不填 = 沿用默认（按字数 3.6 万字 / 48 条压缩，和以前一样）。
   * 官方文档和渠道 /models 都不给这个值，所以只来自设置；比例乘的窗口仍按 设置 > /models 预填 > 文档 > 默认 取。
   */
  compactRatio?: number;
  compactTokens?: number;
};

type KnownModel = {
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  /** 文档里写明可用的档位，设置页只给这些选项 */
  thinkingLevels: ThinkingLevel[];
  thinkingStyle: ThinkingStyle;
  /** OpenAI 官方推理模型在 Chat Completions 里要用 max_completion_tokens */
  completionTokensParam?: boolean;
  source: string;
};

export type CapsOrigin = "config" | "docs" | "default";

export type ModelCaps = {
  contextWindow: number;
  maxTokens: number;
  /** null = 文档和设置里都没写，按支持处理但界面会提示 */
  supportsImages: boolean | null;
  thinkingLevels: ThinkingLevel[];
  thinkingStyle: ThinkingStyle;
  thinking?: ThinkingLevel;
  completionTokensParam?: boolean;
  /** 发给模型的上下文估到这么多 token 就压缩。只在设置里配了压缩阈值时出现；没有 = 默认字数预算 */
  compactThreshold?: number;
  origin: { contextWindow: CapsOrigin; maxTokens: CapsOrigin; supportsImages: CapsOrigin };
  /** 不算设置里填的值时的窗口 / 输出（官方文档表或保守默认）。设置页据此在保存前检查最大输出 */
  fallback: { contextWindow: number; maxTokens: number; origin: "docs" | "default" };
  /** 命中的官方文档地址 */
  source?: string;
};

/** 查不到的模型：窗口 128K、输出 8192（与原来 anthropic-messages 不填时的默认一致），图片未知 */
export const DEFAULT_MODEL_CAPS = { contextWindow: 128_000, maxTokens: 8_192 } as const;
/** 输出上限 = min(maxTokens, 窗口 − 估算输入 − 预留)，预留给估算误差和工具定义 */
export const OUTPUT_RESERVE_TOKENS = 4_096;
/** 输出上限的下限：输入快塞满窗口时也至少给这么多（不超过模型自己的 maxTokens） */
export const MIN_OUTPUT_TOKENS = 1_024;
/** 每张图按 Anthropic 高分辨率档的上限估：https://platform.claude.com/docs/en/build-with-claude/vision */
export const IMAGE_TOKEN_ESTIMATE = 4_784;

export const CAPS_LIMITS = {
  contextWindow: { min: 1_024, max: 10_000_000 },
  maxTokens: { min: 256, max: 2_000_000 },
  compactRatio: { min: 0.05, max: 0.95 },
  compactTokens: { min: 4_096, max: 10_000_000 },
} as const;

function okRatio(value: unknown): number | undefined {
  const lim = CAPS_LIMITS.compactRatio;
  return typeof value === "number" && Number.isFinite(value) && value >= lim.min && value <= lim.max ? value : undefined;
}

/**
 * 压缩阈值换成 token：填了 token 数直接用，填了比例就乘窗口。
 * 上限 = 窗口 − 最少输出 − 估算预留（和 outputTokenLimit 用同两个常量），保证压完以后请求本身放得下。
 */
export function compactThresholdTokens(contextWindow: number, input: Pick<ModelCapsInput, "compactRatio" | "compactTokens">): number | undefined {
  const raw = input.compactTokens ?? (input.compactRatio ? Math.floor(contextWindow * input.compactRatio) : undefined);
  if (!raw) return undefined;
  const ceiling = contextWindow - MIN_OUTPUT_TOKENS - OUTPUT_RESERVE_TOKENS;
  const value = Math.min(raw, ceiling);
  return value > 0 ? value : Math.floor(contextWindow / 2);
}

const AGNES = (slug: string) => `https://wiki.agnes-ai.com/en/docs/${slug}`;
const OPENAI_MODELS = "https://developers.openai.com/api/docs/models";
const CLAUDE_MODELS = "https://platform.claude.com/docs/en/models/overview";
const CLAUDE_WINDOWS = "https://platform.claude.com/docs/en/build-with-claude/context-windows";
const DEEPSEEK = "https://api-docs.deepseek.com/quick_start/pricing/";

const KNOWN: Record<string, KnownModel> = {
  // Agnes 官方渠道：文档写 512K / 1M，取文档字面的十进制值（偏保守）；思考开关是 chat_template_kwargs.enable_thinking
  "agnes-3.0-flash": { contextWindow: 512_000, maxTokens: 65_536, supportsImages: true, thinkingLevels: ["off", "high"], thinkingStyle: "agnes", source: AGNES("agnes-30-flash") },
  "agnes-2.5-flash": { contextWindow: 512_000, maxTokens: 65_500, supportsImages: true, thinkingLevels: ["off", "high"], thinkingStyle: "agnes", source: AGNES("agnes-25-flash") },
  // 2.5 Pro 文档只写了 Reasoning: Yes，没写 OpenAI 格式怎么开关，所以不给档位
  "agnes-2.5-pro": { contextWindow: 1_000_000, maxTokens: 65_536, supportsImages: true, thinkingLevels: [], thinkingStyle: "agnes", source: AGNES("agnes-25-pro") },
  // OpenAI
  "gpt-6-astra": { contextWindow: 1_050_000, maxTokens: 128_000, supportsImages: true, thinkingLevels: ["low", "medium", "high"], thinkingStyle: "effort", completionTokensParam: true, source: OPENAI_MODELS },
  "gpt-6.1-sol": { contextWindow: 1_050_000, maxTokens: 128_000, supportsImages: true, thinkingLevels: ["low", "medium", "high"], thinkingStyle: "effort", completionTokensParam: true, source: OPENAI_MODELS },
  "gpt-6-luna": { contextWindow: 1_050_000, maxTokens: 128_000, supportsImages: true, thinkingLevels: ["off", "low", "medium", "high"], thinkingStyle: "effort", completionTokensParam: true, source: `${OPENAI_MODELS}/gpt-6-luna` },
  "gpt-5": { contextWindow: 400_000, maxTokens: 128_000, supportsImages: true, thinkingLevels: ["low", "medium", "high"], thinkingStyle: "effort", completionTokensParam: true, source: `${OPENAI_MODELS}/gpt-5` },
  // Anthropic：当前四款都是自适应思考，用 output_config.effort 调；Opus 5.5 / Fable 5.1 关不掉思考
  "claude-fable-5-1": { contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, thinkingLevels: ["low", "medium", "high"], thinkingStyle: "effort", source: CLAUDE_MODELS },
  "claude-opus-5-5": { contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, thinkingLevels: ["low", "medium", "high"], thinkingStyle: "effort", source: CLAUDE_MODELS },
  "claude-sonnet-5-5": { contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, thinkingLevels: ["low", "medium", "high"], thinkingStyle: "effort", source: CLAUDE_MODELS },
  "claude-haiku-5-5": { contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, thinkingLevels: ["off", "low", "medium", "high"], thinkingStyle: "effort", source: CLAUDE_MODELS },
  "claude-opus-5": { contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, thinkingLevels: ["low", "medium", "high"], thinkingStyle: "effort", source: CLAUDE_WINDOWS },
  "claude-sonnet-5": { contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, thinkingLevels: ["low", "medium", "high"], thinkingStyle: "effort", source: CLAUDE_WINDOWS },
  // Haiku 4.5 只有手动 budget_tokens 的扩展思考，不支持 effort，所以不给档位
  "claude-haiku-4-5": { contextWindow: 200_000, maxTokens: 64_000, supportsImages: true, thinkingLevels: [], thinkingStyle: "effort", source: "https://docs.anthropic.com/en/docs/about-claude/models/all-models" },
  // DeepSeek：思考默认开，档位 low / high / max（medium 会被映射成 high）；关思考用 thinking.type=disabled
  "deepseek-flash": { contextWindow: 1_000_000, maxTokens: 384_000, supportsImages: true, thinkingLevels: ["off", "low", "high"], thinkingStyle: "deepseek", source: DEEPSEEK },
  "deepseek-v4-flash": { contextWindow: 1_000_000, maxTokens: 384_000, supportsImages: true, thinkingLevels: ["off", "low", "high"], thinkingStyle: "deepseek", source: DEEPSEEK },
  "deepseek-v4-pro": { contextWindow: 1_000_000, maxTokens: 384_000, supportsImages: false, thinkingLevels: ["off", "low", "high"], thinkingStyle: "deepseek", source: DEEPSEEK },
};

/** 网关常给模型名加前缀 / 后缀：openai/gpt-5、anthropic.claude-opus-5-5、xxx:fast、带日期的快照 */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);
  id = id.replace(/^(anthropic|openai|deepseek|agnes)\./, "");
  id = id.replace(/:.*$/, "");
  return id;
}

export function lookupKnownModel(model: string): KnownModel | null {
  const id = normalizeModelId(model);
  if (KNOWN[id]) return KNOWN[id];
  const undated = id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  return undated !== id && KNOWN[undated] ? KNOWN[undated] : null;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (ALL_THINKING_LEVELS as string[]).includes(value);
}

/** 不算设置时生效的窗口：官方文档表里的，查不到用保守默认 */
export function fallbackContextWindow(model: string): { contextWindow: number; origin: "docs" | "default" } {
  const known = lookupKnownModel(model);
  return known ? { contextWindow: known.contextWindow, origin: "docs" } : { contextWindow: DEFAULT_MODEL_CAPS.contextWindow, origin: "default" };
}

/** 空值：undefined、null、0、空串和全是空白的字符串都当没填 */
function blankCaps(v: unknown): boolean {
  return v === undefined || v === null || v === 0 || (typeof v === "string" && (v.trim() === "" || v.trim() === "0"));
}

function okInt(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/**
 * 库里 / 渠道里读到的能力配置：不合法的字段直接丢掉，不报错（老配置、脏数据都能读）。
 * 传了 model 时，maxTokens 大于生效窗口（填的窗口，没填就是文档或默认）的也丢掉，不截断。
 */
export function cleanCapsInput(raw: unknown, model?: string): ModelCapsInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const row = raw as Record<string, unknown>;
  const out: ModelCapsInput = {};
  const cw = okInt(row.contextWindow, CAPS_LIMITS.contextWindow.min, CAPS_LIMITS.contextWindow.max);
  const mt = okInt(row.maxTokens, CAPS_LIMITS.maxTokens.min, CAPS_LIMITS.maxTokens.max);
  if (cw) out.contextWindow = cw;
  const win = cw ?? (model ? fallbackContextWindow(model).contextWindow : undefined);
  if (mt && (!win || mt <= win)) out.maxTokens = mt;
  if (typeof row.supportsImages === "boolean") out.supportsImages = row.supportsImages;
  if (isThinkingLevel(row.thinking)) out.thinking = row.thinking;
  const ratio = okRatio(row.compactRatio);
  const ctok = okInt(row.compactTokens, CAPS_LIMITS.compactTokens.min, CAPS_LIMITS.compactTokens.max);
  // 两种都有是脏数据，两个都不要；token 数不小于窗口的也丢掉
  if (ratio !== undefined && ctok === undefined) out.compactRatio = ratio;
  if (ctok !== undefined && ratio === undefined && (!win || ctok < win)) out.compactTokens = ctok;
  return out;
}

/**
 * 表单传进来的能力配置：空值 = 不填；填了但不合法就报错，告诉用户哪一项。
 * 传了 model 时，只填最大输出也要和生效窗口（文档或保守默认）比，超了报错，不悄悄截断。
 */
export function parseCapsInput(raw: unknown, label: string, model?: string): ModelCapsInput {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label}：能力配置格式不对`);
  const row = raw as Record<string, unknown>;
  const num = (v: unknown, name: string, lim: { min: number; max: number }): number | undefined => {
    if (blankCaps(v)) return undefined;
    // 和设置页一致：字符串只认纯数字（"1e5"、"0x10"、"+5"、"4096.5" 都不算），number 必须本身是整数
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isInteger(n) || n < lim.min || n > lim.max) throw new Error(`${label}：${name}要是 ${lim.min} 到 ${lim.max} 之间的整数，留空用默认`);
    return n;
  };
  const out: ModelCapsInput = {};
  const cw = num(row.contextWindow, "上下文窗口", CAPS_LIMITS.contextWindow);
  const mt = num(row.maxTokens, "最大输出", CAPS_LIMITS.maxTokens);
  if (cw && mt && mt > cw) throw new Error(`${label}：最大输出 ${fmtInt(mt)} 不能大于上下文窗口 ${fmtInt(cw)}`);
  if (!cw && mt && model) {
    const base = fallbackContextWindow(model);
    if (mt > base.contextWindow) {
      throw new Error(
        `${label}：最大输出 ${fmtInt(mt)} 大于生效的上下文窗口 ${fmtInt(base.contextWindow)}（${base.origin === "docs" ? "官方文档值" : "没查到文档，保守默认值"}），请调小最大输出，或同时填一个更大的上下文窗口`,
      );
    }
  }
  if (cw) out.contextWindow = cw;
  if (mt) out.maxTokens = mt;
  if (!blankCaps(row.supportsImages) || row.supportsImages === 0) {
    if (typeof row.supportsImages !== "boolean") throw new Error(`${label}：是否支持图片只能是是或否`);
    out.supportsImages = row.supportsImages;
  }
  if (!blankCaps(row.thinking)) {
    if (!isThinkingLevel(row.thinking)) throw new Error(`${label}：思考档位只能是 off、low、medium、high`);
    out.thinking = row.thinking;
  }
  let ratio: number | undefined;
  if (!blankCaps(row.compactRatio)) {
    const v = row.compactRatio;
    const r = typeof v === "number" ? v : typeof v === "string" && /^\d*\.?\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    ratio = okRatio(r);
    if (ratio === undefined) throw new Error(`${label}：压缩阈值的百分比要在 5% 到 95% 之间，留空用默认`);
  }
  const ctok = num(row.compactTokens, "压缩阈值（token 数）", CAPS_LIMITS.compactTokens);
  if (ratio !== undefined && ctok) throw new Error(`${label}：压缩阈值只能填百分比或 token 数中的一种`);
  if (ctok) {
    const win = cw ?? (model ? fallbackContextWindow(model).contextWindow : undefined);
    if (win && ctok >= win) throw new Error(`${label}：压缩阈值 ${fmtInt(ctok)} 要小于上下文窗口 ${fmtInt(win)}`);
    out.compactTokens = ctok;
  }
  if (ratio !== undefined) out.compactRatio = ratio;
  return out;
}

/** 合成一个模型最终用的能力。override 是设置里（或渠道预填）存下的值 */
export function resolveModelCaps(model: string, override?: ModelCapsInput | null): ModelCaps {
  const known = lookupKnownModel(model);
  const o = override ?? {};
  const contextWindow = o.contextWindow ?? known?.contextWindow ?? DEFAULT_MODEL_CAPS.contextWindow;
  // 不再截断：保存时已经拦住；万一有超的（直接传进来的 override），请求时公式里的窗口余量也会压住
  const maxTokens = o.maxTokens ?? known?.maxTokens ?? DEFAULT_MODEL_CAPS.maxTokens;
  const thinkingLevels = known ? known.thinkingLevels : ALL_THINKING_LEVELS;
  const thinking = o.thinking && thinkingLevels.includes(o.thinking) ? o.thinking : undefined;
  const compactThreshold = compactThresholdTokens(contextWindow, o);
  return {
    contextWindow,
    maxTokens,
    supportsImages: o.supportsImages ?? known?.supportsImages ?? null,
    thinkingLevels,
    thinkingStyle: known?.thinkingStyle ?? "effort",
    ...(thinking ? { thinking } : {}),
    ...(known?.completionTokensParam ? { completionTokensParam: true } : {}),
    ...(compactThreshold ? { compactThreshold } : {}),
    origin: {
      contextWindow: o.contextWindow ? "config" : known ? "docs" : "default",
      maxTokens: o.maxTokens ? "config" : known ? "docs" : "default",
      supportsImages: o.supportsImages !== undefined ? "config" : known ? "docs" : "default",
    },
    fallback: {
      contextWindow: known?.contextWindow ?? DEFAULT_MODEL_CAPS.contextWindow,
      maxTokens: known?.maxTokens ?? DEFAULT_MODEL_CAPS.maxTokens,
      origin: known ? "docs" : "default",
    },
    ...(known ? { source: known.source } : {}),
  };
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/** 粗估 token：CJK 一字一个，其余按 3 个字符一个（比常见的 4 偏多，宁可估大）；图片按固定值 */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 0x2e80) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 3);
}

function contentTokens(content: ChatMessage["content"]): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content as ChatContentPart[]) {
    if (part.type === "text") n += estimateTextTokens(part.text);
    else if (part.type === "image_url") n += IMAGE_TOKEN_ESTIMATE;
  }
  return n;
}

export function estimateInputTokens(messages: ChatMessage[], tools?: ChatToolDefinition[]): number {
  let n = 0;
  for (const message of messages) {
    n += 4 + contentTokens(message.content);
    for (const call of message.tool_calls ?? []) n += estimateTextTokens((call.function?.name ?? "") + (call.function?.arguments ?? ""));
  }
  if (tools?.length) n += estimateTextTokens(JSON.stringify(tools));
  return n;
}

/** 输出上限 = min(maxTokens, 窗口 − 估算输入 − 预留)，下限 min(maxTokens, 1024) */
export function outputTokenLimit(caps: Pick<ModelCaps, "contextWindow" | "maxTokens">, inputTokens: number): number {
  const room = caps.contextWindow - inputTokens - OUTPUT_RESERVE_TOKENS;
  const floor = Math.min(caps.maxTokens, MIN_OUTPUT_TOKENS);
  return Math.max(floor, Math.min(caps.maxTokens, Math.floor(room)));
}

export const IMAGE_DROPPED_NOTE = "[图片已省略：当前模型不支持图片输入]";

/** 不支持图片的模型：历史里的图换成一行说明，避免整轮被上游 400 */
export function stripImagesForModel(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content) || !message.content.some((part) => part.type === "image_url")) return message;
    const parts: ChatContentPart[] = message.content.map((part) => (part.type === "image_url" ? { type: "text" as const, text: IMAGE_DROPPED_NOTE } : part));
    return { ...message, content: parts };
  });
}

/**
 * 一次请求要带的输出上限和思考字段。
 * maxTokens 只是保守默认（没查到文档、也没人填）时不带上限，保持以前的行为：
 * openai 两种协议交给上游默认，anthropic-messages 由渠道层自己补 8192。
 */
export function requestLimits(
  caps: ModelCaps | undefined,
  messages: ChatMessage[],
  tools?: ChatToolDefinition[],
): { max_tokens?: number; max_completion_tokens?: number; thinking?: { level: ThinkingLevel; style: ThinkingStyle } } {
  if (!caps) return {};
  const out: { max_tokens?: number; max_completion_tokens?: number; thinking?: { level: ThinkingLevel; style: ThinkingStyle } } = {};
  if (caps.origin.maxTokens !== "default") {
    const limit = outputTokenLimit(caps, estimateInputTokens(messages, tools));
    if (caps.completionTokensParam) out.max_completion_tokens = limit;
    else out.max_tokens = limit;
  }
  if (caps.thinking) out.thinking = { level: caps.thinking, style: caps.thinkingStyle };
  return out;
}
