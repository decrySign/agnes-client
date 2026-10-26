export type AgnesClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Extra headers on every call. The desktop relay uses it to carry the device hash. */
  headers?: Record<string, string>;
  /** Video polling is a separate upstream host, so a relay has to override it explicitly. */
  videoPollUrl?: string;
};

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
};

export type ChatToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatCompletionParams = {
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  /** OpenAI 官方推理模型在 Chat Completions 里只认这个，不认 max_tokens */
  max_completion_tokens?: number;
  stream?: boolean;
  /** 思考档位（中性字段，不直接上发），各协议发请求前翻成自己的字段 */
  thinking?: { level: ThinkingLevel; style: ThinkingStyle };
};

/** 思考档位。off = 关；不填 = 不发任何思考参数，沿用上游默认 */
export type ThinkingLevel = "off" | "low" | "medium" | "high";
/** 档位怎么翻：effort = reasoning_effort / reasoning.effort / output_config.effort；agnes = chat_template_kwargs.enable_thinking；deepseek = thinking.type + reasoning_effort */
export type ThinkingStyle = "effort" | "agnes" | "deepseek";

export type ChatStreamEvent =
  | { type: "content"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "usage"; promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | { type: "finish"; reason: string | null };

export type ImageGenerateParams = {
  model?: string;
  prompt: string;
  size?: string;
  ratio?: string;
  image?: string[];
  returnBase64?: boolean;
  responseFormat?: "url" | "b64_json";
};

export type ImageGenerateResult = {
  created: number;
  url?: string;
  b64Json?: string;
  revisedPrompt?: string | null;
};

export type VideoCreateParams = {
  model?: string;
  prompt: string;
  mode?: "text" | "keyframe" | "reference";
  seconds?: string;
  size?: string;
  aspectRatio?: string;
  seed?: number;
  firstFrame?: string;
  lastFrame?: string;
  images?: string[];
  audios?: string[];
};

export type VideoTask = {
  id?: string;
  taskId?: string;
  videoId: string;
  status: string;
  url?: string;
  error?: string;
  raw: Record<string, unknown>;
};
