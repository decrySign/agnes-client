import { DEFAULT_BASE_URL, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, VIDEO_POLL_PATH } from "./constants.js";
import { AgnesApiError, UpstreamTimeoutError, describeNetworkError, isTransientNetworkError, parseUpstreamError, sleep, withRetry } from "./http.js";
import { sanitizeChatMessages } from "./tool-args.js";
import { completionsThinkingFields, withoutThinking } from "./thinking.js";
import type {
  AgnesClientOptions,
  ChatCompletionParams,
  ChatStreamEvent,
  ImageGenerateParams,
  ImageGenerateResult,
  VideoCreateParams,
  VideoTask,
} from "./types.js";

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function abortError(): Error {
  const err = new Error("已停止");
  err.name = "AbortError";
  return err;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).join("");
  const rec = asRecord(value);
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.content === "string") return rec.content;
  return "";
}

function parseStreamChunk(json: Record<string, unknown>): ChatStreamEvent[] {
  const out: ChatStreamEvent[] = [];
  const usage = asRecord(json.usage);
  if (Object.keys(usage).length > 0) {
    out.push({
      type: "usage",
      promptTokens: Number(usage.prompt_tokens ?? 0) || undefined,
      completionTokens: Number(usage.completion_tokens ?? 0) || undefined,
      totalTokens: Number(usage.total_tokens ?? 0) || undefined,
    });
  }
  const choices = Array.isArray(json.choices) ? json.choices : [];
  for (const choice of choices) {
    const rec = asRecord(choice);
    const delta = asRecord(rec.delta);
    const content = collectText(delta.content) || collectText(delta.text);
    const thinking =
      collectText(delta.reasoning_content) || collectText(delta.reasoning) || collectText(delta.thought);
    if (thinking) out.push({ type: "thinking", text: thinking });
    if (content) out.push({ type: "content", text: content });
    if (!content && !thinking && rec.message) {
      const full = collectText(asRecord(rec.message).content);
      if (full) out.push({ type: "content", text: full });
    }
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const call of toolCalls) {
      const item = asRecord(call);
      const fn = asRecord(item.function);
      out.push({
        type: "tool_call_delta",
        index: Number(item.index ?? 0),
        id: typeof item.id === "string" ? item.id : undefined,
        name: typeof fn.name === "string" ? fn.name : undefined,
        arguments:
          typeof fn.arguments === "string"
            ? fn.arguments
            : fn.arguments != null
              ? JSON.stringify(fn.arguments)
              : undefined,
      });
    }
    if (typeof rec.finish_reason === "string") {
      out.push({ type: "finish", reason: rec.finish_reason });
    }
  }
  return out;
}

export class AgnesClient {
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private extraHeaders: Record<string, string>;
  private videoPollUrl: string;

  constructor(options: AgnesClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetch ?? fetch;
    this.extraHeaders = { ...(options.headers ?? {}) };
    this.videoPollUrl = options.videoPollUrl ?? VIDEO_POLL_PATH;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  setHeaders(headers: Record<string, string>): void {
    this.extraHeaders = { ...headers };
  }

  setVideoPollUrl(url: string): void {
    this.videoPollUrl = url || VIDEO_POLL_PATH;
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(json = true): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.extraHeaders,
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  private async parseError(res: Response): Promise<AgnesApiError> {
    const body = await res.text().catch(() => "");
    const bits = parseUpstreamError(body);
    return new AgnesApiError(res.status, body, bits.code);
  }

  async requestJson<T>(method: string, url: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
    if (!this.apiKey) {
      throw new AgnesApiError(401, "缺少 AGNES_API_KEY");
    }
    return withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: this.headers(body !== undefined),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) throw await this.parseError(res);
        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /**
   * 流式对话。网络层瞬时失败（连接被重置、连接超时、DNS、5xx/429）在**还没收到任何内容**时
   * 自动重试，最多 `retries` 次，间隔 1s/2s/4s；每次重试先回调 `onRetry` 让上层告诉用户。
   * 已经开始出字之后再断，就原样抛错——上层会保住已出的内容。
   */
  async *chatCompletionsStream(
    params: ChatCompletionParams,
    opts: {
      signal?: AbortSignal;
      idleTimeoutMs?: number;
      /** 首包超时，覆盖 idleTimeoutMs；按渠道配置 */
      firstByteTimeoutMs?: number;
      /** 出字后两段数据之间的最长间隔，覆盖 idleTimeoutMs；按渠道配置 */
      streamIdleTimeoutMs?: number;
      retries?: number;
      onRetry?: (info: { attempt: number; max: number; reason: string; delayMs: number }) => void | Promise<void>;
    } = {},
  ): AsyncGenerator<ChatStreamEvent> {
    if (!this.apiKey) {
      throw new AgnesApiError(401, "缺少 AGNES_API_KEY");
    }
    const maxRetries = Math.max(0, opts.retries ?? 3);
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw abortError();
      let yielded = false;
      try {
        for await (const event of this.streamOnce(params, opts)) {
          yielded = true;
          yield event;
        }
        return;
      } catch (err) {
        if (opts.signal?.aborted) throw abortError();
        if (yielded || attempt >= maxRetries || !isTransientNetworkError(err)) {
          if (err instanceof Error && err.message === "fetch failed") throw new Error(describeNetworkError(err), { cause: err });
          throw err;
        }
        const delayMs = 1000 * 2 ** attempt;
        const reason = describeNetworkError(err);
        await Promise.resolve(opts.onRetry?.({ attempt: attempt + 1, max: maxRetries, reason, delayMs }));
        await sleep(delayMs);
      }
    }
  }

  private async *streamOnce(
    params: ChatCompletionParams,
    opts: { signal?: AbortSignal; idleTimeoutMs?: number; firstByteTimeoutMs?: number; streamIdleTimeoutMs?: number },
  ): AsyncGenerator<ChatStreamEvent> {
    if (opts.signal?.aborted) throw abortError();
    // 首包要等模型把长上下文预填完，3 分钟经常不够；一旦开始出字，再安静 3 分钟才算卡住
    const firstByteTimeoutMs = opts.firstByteTimeoutMs ?? opts.idleTimeoutMs ?? 8 * 60 * 1000;
    const streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? opts.idleTimeoutMs ?? 180_000;
    const idle = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let gotChunk = false;
    const bumpIdle = () => {
      const wait = gotChunk ? streamIdleTimeoutMs : firstByteTimeoutMs;
      if (wait <= 0) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), wait);
    };
    bumpIdle();
    const signal =
      opts.signal && (firstByteTimeoutMs > 0 || streamIdleTimeoutMs > 0)
        ? AbortSignal.any([opts.signal, idle.signal])
        : opts.signal ?? (firstByteTimeoutMs > 0 ? idle.signal : undefined);
    const url = joinUrl(this.baseUrl, "chat/completions");
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          ...this.headers(),
          Accept: "text/event-stream",
          "Accept-Encoding": "identity",
        },
        body: JSON.stringify({
          ...withoutThinking(params),
          ...completionsThinkingFields(params.thinking),
          messages: sanitizeChatMessages(params.messages),
          stream: true,
        }),
        signal,
      });
      if (!res.ok) throw await this.parseError(res);
      if (!res.body) throw new AgnesApiError(500, "empty stream body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let ended = false;

      const consume = function* (chunk: string): Generator<ChatStreamEvent> {
        const lines = chunk.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") {
            if (data === "[DONE]") {
              // [DONE] 就是协议上的结束。有的网关发完不马上关连接，继续 read 会一直等到 3 分钟
              // 空闲超时，界面就成了"字都出完了还在转圈"——这里直接收尾
              ended = true;
              yield { type: "finish", reason: "stop" };
              return;
            }
            continue;
          }
          try {
            yield* parseStreamChunk(JSON.parse(data) as Record<string, unknown>);
          } catch {
            /* incomplete JSON is skipped until the next line */
          }
        }
      };

      try {
        while (!ended) {
          const { done, value } = await reader.read();
          if (value && value.byteLength) gotChunk = true;
          bumpIdle();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) yield* consume(buffer);
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          yield* consume(lines.join("\n"));
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) throw abortError();
      if (idle.signal.aborted) {
        throw new UpstreamTimeoutError(
          gotChunk ? "stream-idle" : "first-byte",
          gotChunk ? `模型中途停住了（${fmtWait(streamIdleTimeoutMs)}没有新内容），已停止` : `模型超过 ${fmtWait(firstByteTimeoutMs)}还没有开始回复，已停止`,
        );
      }
      throw err;
    } finally {
      clearTimeout(idleTimer);
    }
  }

  async generateImage(params: ImageGenerateParams): Promise<ImageGenerateResult> {
    const extraBody: Record<string, unknown> = {};
    if (params.responseFormat) extraBody.response_format = params.responseFormat;
    if (params.image?.length) extraBody.image = params.image;

    const payload: Record<string, unknown> = {
      model: params.model ?? DEFAULT_IMAGE_MODEL,
      prompt: params.prompt,
      size: params.size ?? "2K",
    };
    if (params.ratio) payload.ratio = params.ratio;
    if (params.returnBase64) payload.return_base64 = true;
    if (Object.keys(extraBody).length > 0) payload.extra_body = extraBody;

    const json = await this.requestJson<{
      created?: number;
      data?: Array<{ url?: string | null; b64_json?: string | null; revised_prompt?: string | null }>;
    }>("POST", joinUrl(this.baseUrl, "images/generations"), payload, 360_000);

    const first = json.data?.[0] ?? {};
    return {
      created: json.created ?? Date.now(),
      url: first.url ?? undefined,
      b64Json: first.b64_json ?? undefined,
      revisedPrompt: first.revised_prompt ?? null,
    };
  }

  async createVideo(params: VideoCreateParams): Promise<VideoTask> {
    const model = params.model ?? DEFAULT_VIDEO_MODEL;
    const mode = params.mode ?? "text";
    const payload: Record<string, unknown> = {
      model,
      prompt: params.prompt,
      mode,
      seconds: params.seconds ?? "5",
      size: params.size ?? "720P",
      aspect_ratio: params.aspectRatio ?? "16:9",
    };
    if (params.seed !== undefined) payload.seed = params.seed;
    if (mode === "keyframe") {
      if (params.firstFrame) payload.first_frame = params.firstFrame;
      if (params.lastFrame) payload.last_frame = params.lastFrame;
    }
    if (mode === "reference") {
      if (params.images?.length) payload.images = params.images;
      if (params.audios?.length) payload.audios = params.audios;
    }

    const json = await this.requestJson<Record<string, unknown>>(
      "POST",
      joinUrl(this.baseUrl, "videos"),
      payload,
      120_000,
    );
    const videoId = pickString(json, ["video_id", "id"]) ?? "";
    if (!videoId) {
      throw new AgnesApiError(500, `Video response missing video_id: ${JSON.stringify(json)}`);
    }
    return {
      videoId,
      id: pickString(json, ["id"]),
      taskId: pickString(json, ["task_id"]),
      status: pickString(json, ["status"]) ?? "queued",
      raw: json,
    };
  }

  async getVideo(videoId: string, modelName = DEFAULT_VIDEO_MODEL): Promise<VideoTask> {
    const url = new URL(this.videoPollUrl);
    url.searchParams.set("video_id", videoId);
    url.searchParams.set("model_name", modelName);
    const json = await this.requestJson<Record<string, unknown>>("GET", url.toString(), undefined, 60_000);
    const metadata = asRecord(json.metadata);
    const status = (pickString(json, ["status"]) ?? "unknown").toLowerCase();
    const urlOut =
      pickString(metadata, ["url"]) ??
      pickString(json, ["url", "video_url", "output_url"]);
    const error =
      pickString(json, ["error", "message", "detail"]) ??
      pickString(asRecord(json.error), ["message"]);
    return {
      videoId,
      id: pickString(json, ["id"]),
      taskId: pickString(json, ["task_id"]),
      status,
      url: urlOut,
      error,
      raw: json,
    };
  }

  async waitForVideo(
    videoId: string,
    options?: { intervalMs?: number; timeoutMs?: number; modelName?: string },
  ): Promise<VideoTask> {
    const interval = options?.intervalMs ?? 1500;
    const timeout = options?.timeoutMs ?? 15 * 60_000;
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const task = await this.getVideo(videoId, options?.modelName);
      if (["succeeded", "success", "completed", "done"].includes(task.status)) {
        return { ...task, status: "completed" };
      }
      if (["failed", "error", "cancelled", "canceled"].includes(task.status)) {
        throw new AgnesApiError(500, task.error ?? `video task ${task.status}`);
      }
      await sleep(interval);
    }
    throw new AgnesApiError(408, `Timed out waiting for video_id=${videoId}`);
  }
}

/** 把超时毫秒数写成「N 秒」或「N 分钟」 */
function fmtWait(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
}
