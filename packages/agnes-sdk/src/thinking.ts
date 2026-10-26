import type { ChatCompletionParams } from "./types.js";

/**
 * params.thinking 是中性字段，不能原样发出去（DeepSeek 的 thinking 是对象，原样发字符串会 400）。
 * 各协议在发请求前把它翻成自己的字段，这里是 Chat Completions 的翻法：
 * - effort（OpenAI 等）：reasoning_effort，off 发 "none"
 * - agnes：chat_template_kwargs.enable_thinking，只有开 / 关
 * - deepseek：thinking.type 开关 + reasoning_effort
 */
export function completionsThinkingFields(thinking: ChatCompletionParams["thinking"]): Record<string, unknown> {
  if (!thinking) return {};
  const { level, style } = thinking;
  if (style === "agnes") return { chat_template_kwargs: { enable_thinking: level !== "off" } };
  if (style === "deepseek") return level === "off" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" }, reasoning_effort: level };
  return { reasoning_effort: level === "off" ? "none" : level };
}

/** 去掉中性的 thinking 字段，剩下的才能放进请求体 */
export function withoutThinking<T extends ChatCompletionParams>(params: T): Omit<T, "thinking"> {
  const { thinking: _thinking, ...rest } = params;
  return rest;
}
