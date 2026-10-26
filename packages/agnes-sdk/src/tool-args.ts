import type { ChatMessage, ChatToolCall } from "./types.js";

/**
 * 上游要求 assistant.tool_calls[].function.arguments 必须是「能 JSON.parse 的字符串」。
 * 流式拼接经常在字符串中间被截断（尤其 edit_file 里大段 markdown），原样回放会 400。
 */
export function ensureToolCallArguments(raw: unknown): { json: string; valid: boolean } {
  if (raw && typeof raw === "object") {
    return { json: JSON.stringify(raw), valid: true };
  }
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { json: "{}", valid: true };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string") {
      try {
        JSON.parse(parsed);
        return { json: parsed, valid: true };
      } catch {
        return { json: JSON.stringify({ value: parsed }), valid: true };
      }
    }
    return { json: JSON.stringify(parsed), valid: true };
  } catch {
    const repaired = repairTruncatedJson(text);
    try {
      JSON.parse(repaired);
      return { json: repaired, valid: false };
    } catch {
      return { json: "{}", valid: false };
    }
  }
}

export function sanitizeToolCalls(calls: ChatToolCall[] | undefined | null): ChatToolCall[] | undefined {
  if (!calls?.length) return calls ?? undefined;
  return calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: {
      name: call.function?.name ?? "",
      arguments: ensureToolCallArguments(call.function?.arguments).json,
    },
  }));
}

export function sanitizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.tool_calls?.length) return message;
    return { ...message, tool_calls: sanitizeToolCalls(message.tool_calls) };
  });
}

/** 补上未闭合的引号 / 括号，去掉尾逗号。修不了就让调用方回退到 `{}`。 */
export function repairTruncatedJson(raw: string): string {
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (const ch of raw) {
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  let out = raw;
  if (escape) out = out.slice(0, -1);
  if (inString) out += '"';
  out = out.replace(/,\s*$/, "");
  while (stack.length) out += stack.pop();
  return out;
}
