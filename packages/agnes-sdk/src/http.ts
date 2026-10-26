export type UpstreamErrorBits = { code?: string; message?: string };

export function parseUpstreamError(body: string): UpstreamErrorBits {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string } | string;
      code?: string;
      message?: string;
    };
    const errObj = parsed.error && typeof parsed.error === "object" ? parsed.error : undefined;
    const code = errObj?.code || parsed.code;
    const message =
      (typeof parsed.error === "string" ? parsed.error : undefined) || errObj?.message || parsed.message;
    return {
      ...(code ? { code: String(code) } : {}),
      ...(message ? { message: String(message) } : {}),
    };
  } catch {
    return {};
  }
}

/** 给界面看的中文，不要把上游 JSON 原样甩给用户 */
export function agnesUserMessage(status: number, body: string, code?: string): string {
  const bits = parseUpstreamError(body);
  const c = (code || bits.code || "").toLowerCase();
  const raw = `${c} ${bits.message || ""} ${body}`.toLowerCase();
  if (status === 402) return "Agnes 额度不足或 Token Plan 配额已用尽";
  if (c === "video_queue_full" || /video[_ ]queue|queue[_ ]full/.test(raw)) {
    return "视频生成队列已满，官方接口正在排队，请过一两分钟再试";
  }
  // 走到界面这一步时 Agent 已经自动压缩重试过（或压不动），这里不再许诺「会自动重试」
  if (looksLikeContextOverflow(raw)) return "上下文过长，模型通道拒绝了。对话记录还在";
  if (status === 429) return "请求过于频繁，请稍后再试";
  if (status === 503) return "生成服务暂时繁忙，请稍后再试";
  if (bits.message && !/[{}"]/.test(bits.message) && bits.message.length < 180) return bits.message;
  if (c) return `上游错误（${c}）`;
  return `Agnes API ${status}: ${body.slice(0, 200)}`;
}

/**
 * 上游超时。first-byte = 一个字节都没回就到点；stream-idle = 出过字后中途停住。
 * 文案和以前的普通 Error 一样，只是多了类型，上层据此决定要不要压缩后重试。
 */
export class UpstreamTimeoutError extends Error {
  readonly phase: "first-byte" | "stream-idle";

  constructor(phase: "first-byte" | "stream-idle", message: string) {
    super(message);
    this.name = "UpstreamTimeoutError";
    this.phase = phase;
  }
}

export class AgnesApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly code?: string;

  constructor(status: number, body: string, code?: string) {
    const bits = parseUpstreamError(body);
    const resolved = code || bits.code;
    super(agnesUserMessage(status, body, resolved));
    this.name = "AgnesApiError";
    this.status = status;
    this.body = body;
    this.code = resolved;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * undici 把连接层错误一律包成 `TypeError: fetch failed`，真正原因（ECONNRESET、
 * Connect Timeout、ENOTFOUND…）在 `cause` 里。这里把它翻出来，给日志和界面看。
 */
export function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const c = cause && typeof cause === "object" ? (cause as { code?: string; message?: string; name?: string }) : null;
  const detail = c ? [c.code, c.message || c.name].filter(Boolean).join(" ") : "";
  if (err.message === "fetch failed" || err.name === "TypeError") {
    return detail ? `连接模型通道失败：${detail}` : `连接模型通道失败：${err.message}`;
  }
  return detail ? `${err.message}（${detail}）` : err.message;
}

/** 上游用这句话拒绝超长 prompt。重试同一份正文没有意义 */
export function looksLikeContextOverflow(raw: string): boolean {
  return /context[_ ]length|maximum context|too many tokens|token limit|prompt is too long|max(?:imum)? tokens|上下文过长|超出.{0,8}长度|请求过长/i.test(
    raw,
  );
}

/*
 * 「上下文窗口超了」的严格判定，只用来决定要不要压缩后重试。
 * 前五条正则照抄 dsh（dsh-llm/lib/types/error.js 的 isContextWindowExceededError）；
 * 另加 Anthropic 的 "prompt is too long" 和 looksLikeContextOverflow 原有的「上下文过长」。
 * looksLikeContextOverflow 更宽（max tokens / token limit 也算），只用于提示文案和「不原样重试」。
 */
const STRUCTURED_CONTEXT_OVERFLOW =
  /(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])/i;
const MAX_CONTEXT_LENGTH = /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i;
const TOO_LARGE_FOR_CONTEXT =
  /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context(?:\s+window)?\b/i;
const TOO_LONG_FOR_MODEL = /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i;
const EXCEEDS_MODEL_CONTEXT =
  /\b(?:input|prompt|request|messages?)\b.{0,40}\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b/i;
const EXTRA_CONTEXT_OVERFLOW = /prompt is too long|上下文过长/i;

export function contextOverflowText(raw: string): boolean {
  return (
    STRUCTURED_CONTEXT_OVERFLOW.test(raw) ||
    MAX_CONTEXT_LENGTH.test(raw) ||
    TOO_LARGE_FOR_CONTEXT.test(raw) ||
    TOO_LONG_FOR_MODEL.test(raw) ||
    EXCEEDS_MODEL_CONTEXT.test(raw) ||
    EXTRA_CONTEXT_OVERFLOW.test(raw)
  );
}

/** 上游明确说上下文窗口超了。AgnesApiError 看错误码和原始正文（message 已经是翻译过的中文） */
export function isContextOverflowError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string; code?: string };
  if (e.name === "AbortError") return false;
  const text = err instanceof AgnesApiError ? `${err.code ?? ""} ${err.body}` : `${e.code ?? ""} ${e.message ?? ""}`;
  return contextOverflowText(text);
}

/**
 * 还没开始回复就超时：SDK 的首包超时、自定义渠道看门狗的 504（ProviderError）、上游网关 504 / 408。
 * 出过字后中途停住的不算：那时再压缩重试会让界面重复出字。
 */
export function isUpstreamTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; status?: number; phase?: string };
  if (e.name === "UpstreamTimeoutError") return e.phase === "first-byte";
  if (e.name === "ProviderError" || err instanceof AgnesApiError) return e.status === 504 || e.status === 408;
  return false;
}

function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer [redacted]")
    .replace(/("(?:api[_-]?key|token|authorization)"\s*:\s*")[^"]+/gi, "$1[redacted]");
}

/**
 * 写进 agnes.log 的上游失败。只留状态码、错误码和一小段正文，密钥打码。
 * 界面仍用 AgnesApiError.message，不把原始 JSON 甩给用户。
 */
export function upstreamErrorLog(err: unknown): string {
  if (!(err instanceof AgnesApiError)) return describeNetworkError(err);
  const bits = parseUpstreamError(err.body);
  const snippet = redactSecrets(err.body).replace(/\s+/g, " ").slice(0, 400);
  const upstream = redactSecrets(bits.message || "").replace(/\s+/g, " ").slice(0, 200);
  return `status=${err.status} code=${err.code || bits.code || "-"} upstream=${upstream || "-"} body=${snippet || "-"}`;
}

/** 连接被重置 / 超时 / DNS 失败这类瞬时网络错误，可以原样重试；业务 4xx 不算。只给对话流用，出图出视频另走 shouldRetryApi */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof AgnesApiError) {
    // 视频队列满是业务繁忙，再打只会把队列打得更满。上下文超长重试同一份正文也没用
    if (err.code === "video_queue_full") return false;
    if (looksLikeContextOverflow(`${err.code || ""} ${err.message} ${err.body}`)) return false;
    if (err.status === 503 || err.status === 429 || err.status === 502 || err.status === 504) return true;
    return false;
  }
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  if (err.message === "fetch failed" || err.message === "terminated") return true;
  const cause = (err as { cause?: { code?: string; name?: string } }).cause;
  const code = String(cause?.code || cause?.name || "");
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_(CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT)|ConnectTimeoutError|SocketError/i.test(
    code,
  );
}

function shouldRetryApi(err: unknown, attempt: number, retries: number): boolean {
  if (attempt >= retries - 1) return false;
  if (err instanceof AgnesApiError) {
    if (err.code === "video_queue_full" || err.status === 503) return false;
    if (err.status === 429) return true;
    if (err.status >= 500) return true;
    return false;
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, retries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!shouldRetryApi(err, i, retries)) throw err;
      const status = err instanceof AgnesApiError ? err.status : 500;
      await sleep((status === 429 ? 800 : 600) * 2 ** i);
    }
  }
  throw last;
}
