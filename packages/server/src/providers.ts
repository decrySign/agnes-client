import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AgnesClient,
  isTransientNetworkError,
  type ChatCompletionParams,
  type ChatContentPart,
  type ChatMessage,
  type ChatStreamEvent,
  type ChatToolDefinition,
} from "@agnes/sdk";
import type { DatabaseSync } from "node:sqlite";
import { cleanCapsInput, parseCapsInput, resolveModelCaps, type ModelCaps, type ModelCapsInput } from "@agnes/agent";
import { getKv, setKv } from "./db.js";

export const PROVIDERS_KV = "desktop.modelProviders";

export const PROVIDER_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

/** 内存里的形态：apiKey 已解密。落库时只存 apiKeyEnc。 */
export type StoredProvider = {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  apiKey: string;
  models: string[];
  /** 首包（响应头）超时，毫秒；不填用默认 */
  timeoutMs?: number;
  /** 出字后两段数据之间的最长间隔，毫秒；不填用默认 */
  streamIdleTimeoutMs?: number;
  /** 按模型的能力配置（窗口 / 输出上限 / 图片 / 思考档位），键是模型 ID；没填的项按官方文档表或保守默认 */
  modelCaps?: Record<string, ModelCapsInput>;
};

/** 库里的形态。apiKey 只在 0.1.30 及更早的明文数据里出现，读到就改存成密文。 */
type ProviderRecord = Omit<StoredProvider, "apiKey"> & { apiKey?: string; apiKeyEnc?: string };

export type PublicProvider = {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  models: string[];
  hasKey: boolean;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  modelCaps?: Record<string, ModelCapsInput>;
};

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

// ---- 密钥加密 ----
// 打包后的桌面端在主进程里加载服务，main.mjs 会挂上 Electron safeStorage（Windows 上是 DPAPI）。
// 开发模式或没有 safeStorage 时退回数据目录里的一把随机钥匙：库文件单独被拷走时密钥不会跟着泄露。

type SecretBox = { available: () => boolean; encrypt: (plain: string) => string; decrypt: (enc: string) => string };

let secretDir = "";

/** createApp 调一次，告诉加密层钥匙文件放哪。 */
export function configureProviderSecrets(dataDir: string): void {
  secretDir = dataDir;
}

function systemBox(): SecretBox | null {
  const box = (globalThis as { agnesSecretBox?: SecretBox }).agnesSecretBox;
  try {
    return box && box.available() ? box : null;
  } catch {
    return null;
  }
}

function fileKey(): Buffer | null {
  const dir = secretDir || process.env.DATA_DIR || "";
  if (!dir) return null;
  const file = path.join(dir, ".provider-key");
  try {
    const hex = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  } catch {
    /* 第一次用，下面生成 */
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString("hex"), { mode: 0o600 });
    return key;
  } catch {
    return null;
  }
}

export function encryptProviderKey(plain: string): string {
  if (!plain) return "";
  const box = systemBox();
  if (box) return `ss1:${box.encrypt(plain)}`;
  const key = fileKey();
  if (!key) throw new Error("本机无法加密保存 API 密钥");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `fk1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

/** 解不开（换了电脑、系统钥匙变了）就当没有密钥，界面会提示重新填写。 */
export function decryptProviderKey(enc: string): string {
  if (!enc) return "";
  try {
    if (enc.startsWith("ss1:")) {
      const box = systemBox();
      return box ? box.decrypt(enc.slice(4)) : "";
    }
    if (enc.startsWith("fk1:")) {
      const key = fileKey();
      if (!key) return "";
      const raw = Buffer.from(enc.slice(4), "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    }
  } catch {
    return "";
  }
  return "";
}

export function customModelId(providerId: string, model: string): string {
  return `custom|${providerId}|${model}`;
}

export function parseCustomModel(value: string): { providerId: string; model: string } | null {
  if (!value.startsWith("custom|")) return null;
  const rest = value.slice("custom|".length);
  const cut = rest.indexOf("|");
  if (cut <= 0) return null;
  const providerId = rest.slice(0, cut);
  const model = rest.slice(cut + 1).trim();
  if (!ID_RE.test(providerId) || !model) return null;
  return { providerId, model };
}

export function publicProvider(row: StoredProvider): PublicProvider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    protocol: row.protocol,
    models: row.models,
    hasKey: Boolean(row.apiKey),
    ...(row.timeoutMs ? { timeoutMs: row.timeoutMs } : {}),
    ...(row.streamIdleTimeoutMs ? { streamIdleTimeoutMs: row.streamIdleTimeoutMs } : {}),
    ...(row.modelCaps && Object.keys(row.modelCaps).length ? { modelCaps: row.modelCaps } : {}),
  };
}

export function loadProviders(db: DatabaseSync): StoredProvider[] {
  const raw = getKv(db, PROVIDERS_KV);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const records = parsed.filter(isProviderRecord);
  let legacy = false;
  const rows = records.map((record) => {
    if (record.apiKey && !record.apiKeyEnc) legacy = true;
    return {
      id: record.id,
      name: String(record.name || record.id),
      baseUrl: record.baseUrl,
      protocol: (PROVIDER_PROTOCOLS as readonly string[]).includes(record.protocol) ? record.protocol : "openai-completions",
      apiKey: record.apiKeyEnc ? decryptProviderKey(record.apiKeyEnc) : String(record.apiKey || ""),
      models: Array.isArray(record.models) ? record.models.map(String) : [],
      ...storedTimeouts(record),
      ...storedModelCaps(record.modelCaps, Array.isArray(record.models) ? record.models.map(String) : []),
    } satisfies StoredProvider;
  });
  // 旧版明文：读到一次就改存成密文
  if (legacy) {
    try {
      saveProviders(db, rows);
    } catch {
      /* 加密不可用时保持原样，下次保存再试 */
    }
  }
  return rows;
}

export function listPublicProviders(db: DatabaseSync): PublicProvider[] {
  return loadProviders(db).map(publicProvider);
}

function saveProviders(db: DatabaseSync, rows: StoredProvider[]): void {
  const records: ProviderRecord[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    protocol: row.protocol,
    models: row.models,
    ...(row.timeoutMs ? { timeoutMs: row.timeoutMs } : {}),
    ...(row.streamIdleTimeoutMs ? { streamIdleTimeoutMs: row.streamIdleTimeoutMs } : {}),
    ...storedModelCaps(row.modelCaps, row.models),
    apiKey: "",
    apiKeyEnc: encryptProviderKey(row.apiKey),
  }));
  setKv(db, PROVIDERS_KV, JSON.stringify(records));
}

export const PROVIDER_TIMEOUT_MIN_MS = 5_000;
export const PROVIDER_TIMEOUT_MAX_MS = 30 * 60 * 1000;

function okTimeout(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= PROVIDER_TIMEOUT_MIN_MS && n <= PROVIDER_TIMEOUT_MAX_MS ? Math.round(n) : undefined;
}

/** 库里读出来的超时：不合法就当没配，用默认 */
function storedTimeouts(record: { timeoutMs?: unknown; streamIdleTimeoutMs?: unknown }): Pick<StoredProvider, "timeoutMs" | "streamIdleTimeoutMs"> {
  const timeoutMs = okTimeout(record.timeoutMs);
  const streamIdleTimeoutMs = okTimeout(record.streamIdleTimeoutMs);
  return { ...(timeoutMs ? { timeoutMs } : {}), ...(streamIdleTimeoutMs ? { streamIdleTimeoutMs } : {}) };
}

/** 表单传进来的超时：空 / 0 = 用默认；其他必须在 5 秒到 30 分钟之间 */
export function parseProviderTimeout(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null || raw === 0) return undefined;
  if (typeof raw === "string" && (raw.trim() === "" || raw.trim() === "0")) return undefined;
  // 只认数字或数字字符串；数组、对象一律算非法（[6000] 之类不能被 Number() 偷偷转过去）
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n < PROVIDER_TIMEOUT_MIN_MS || n > PROVIDER_TIMEOUT_MAX_MS) {
    throw new Error(`${label}要在 5 秒到 30 分钟之间，留空用默认`);
  }
  return Math.round(n);
}

/**
 * 库里读出来 / 要存进去的能力配置：老数据没有这一项；不合法的字段丢掉，不报错。
 * 传了 models 时只留还在列表里的模型（删掉的模型，它的配置也不再存、不再返回）
 */
function storedModelCaps(raw: unknown, models?: string[]): Pick<StoredProvider, "modelCaps"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ModelCapsInput> = {};
  for (const [model, caps] of Object.entries(raw as Record<string, unknown>)) {
    if (models && !models.includes(model)) continue;
    const clean = cleanCapsInput(caps, model);
    if (Object.keys(clean).length) out[model] = clean;
  }
  return Object.keys(out).length ? { modelCaps: out } : {};
}

/** 表单传进来的能力配置：只留目录里有的模型；填了不合法的值就报错 */
export function parseModelCapsMap(raw: unknown, models: string[]): Record<string, ModelCapsInput> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("模型能力配置格式不对");
  const out: Record<string, ModelCapsInput> = {};
  for (const [model, caps] of Object.entries(raw as Record<string, unknown>)) {
    if (!models.includes(model)) continue;
    const parsed = parseCapsInput(caps, model, model);
    if (Object.keys(parsed).length) out[model] = parsed;
  }
  return out;
}

/** 内置（Agnes 官方渠道）模型的能力覆盖，桌面端本机保存 */
export const BUILTIN_CAPS_KV = "desktop.builtinModelCaps";

/** models：只返回还在内置模型列表里的；不传就全返回 */
export function loadBuiltinCaps(db: DatabaseSync, models?: string[]): Record<string, ModelCapsInput> {
  const raw = getKv(db, BUILTIN_CAPS_KV);
  if (!raw) return {};
  try {
    return storedModelCaps(JSON.parse(raw), models).modelCaps ?? {};
  } catch {
    return {};
  }
}

export function saveBuiltinCaps(db: DatabaseSync, raw: unknown, models: string[]): Record<string, ModelCapsInput> {
  const next = parseModelCapsMap(raw, models);
  setKv(db, BUILTIN_CAPS_KV, JSON.stringify(next));
  return next;
}

/** 一个对话模型（内置 ID 或 custom|provider|model）最终用的能力 */
export function capsForModel(db: DatabaseSync, modelId: string): ModelCaps {
  const custom = parseCustomModel(modelId);
  if (custom) return resolveModelCaps(custom.model, findProvider(db, custom.providerId)?.modelCaps?.[custom.model]);
  return resolveModelCaps(modelId, loadBuiltinCaps(db)[modelId]);
}

/** 设置页 / 输入框用：每个可选模型的能力。providers 传已经读好的列表，免得每个模型再解一次密钥 */
export function modelCapsMap(db: DatabaseSync, modelIds: string[], providers: PublicProvider[]): Record<string, ModelCaps> {
  const builtin = loadBuiltinCaps(db);
  const out: Record<string, ModelCaps> = {};
  for (const id of modelIds) {
    const custom = parseCustomModel(id);
    out[id] = custom
      ? resolveModelCaps(custom.model, providers.find((p) => p.id === custom.providerId)?.modelCaps?.[custom.model])
      : resolveModelCaps(id, builtin[id]);
  }
  return out;
}

function isProviderRecord(value: unknown): value is ProviderRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as ProviderRecord;
  return ID_RE.test(String(row.id || "")) && typeof row.baseUrl === "string" && (typeof row.apiKey === "string" || typeof row.apiKeyEnc === "string");
}

function isLoopbackHost(hostname: string): boolean {
  // URL 里的 IPv6 主机名带方括号：new URL("http://[::1]/").hostname === "[::1]"
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function assertProviderUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("API 地址不是合法网址");
  }
  if (parsed.username || parsed.password) throw new Error("API 地址不能带账号口令");
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
    return parsed.origin + parsed.pathname.replace(/\/$/, "");
  }
  if (parsed.protocol !== "https:") throw new Error("API 地址必须是 https，本机除外");
  return parsed.origin + parsed.pathname.replace(/\/$/, "");
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export const KEY_FOR_NEW_ORIGIN = "API 地址换了域名，请重新填写 API 密钥";

/** 改了地址却没重填密钥：旧密钥不能发到新的域名去。 */
export function sameProviderOrigin(a: string, b: string): boolean {
  return originOf(a) === originOf(b);
}

export function parseProtocol(raw: unknown): ProviderProtocol {
  const value = String(raw || "").trim();
  if ((PROVIDER_PROTOCOLS as readonly string[]).includes(value)) return value as ProviderProtocol;
  throw new Error("API 协议只能是 openai-completions、openai-responses 或 anthropic-messages");
}

function parseModels(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const item of list) {
    const model = String(item || "").trim();
    if (!model || model.includes("|") || model.length > 80) continue;
    if (!out.includes(model)) out.push(model);
    if (out.length >= 40) break;
  }
  return out;
}

export function upsertProvider(
  db: DatabaseSync,
  input: {
    id?: string;
    name?: string;
    baseUrl?: string;
    protocol?: string;
    apiKey?: string;
    models?: unknown;
    timeoutMs?: unknown;
    streamIdleTimeoutMs?: unknown;
    modelCaps?: unknown;
  },
  existingId?: string,
): PublicProvider {
  const id = String(existingId || input.id || "").trim();
  if (!ID_RE.test(id)) throw new Error("Provider ID 要以小写字母开头，只能含小写字母、数字和连字符");
  const name = String(input.name || "").trim().slice(0, 40);
  if (!name) throw new Error("请填写显示名称");
  const baseUrl = assertProviderUrl(String(input.baseUrl || ""));
  const protocol = parseProtocol(input.protocol);
  const models = parseModels(input.models);
  const timeoutMs = parseProviderTimeout(input.timeoutMs, "首包超时");
  const streamIdleTimeoutMs = parseProviderTimeout(input.streamIdleTimeoutMs, "流空闲超时");
  const rows = loadProviders(db);
  const prev = rows.find((row) => row.id === id);
  if (!existingId && prev) throw new Error("这个 Provider ID 已经有了");
  if (existingId && !prev) throw new Error("找不到这个提供方");
  const typed = String(input.apiKey || "").trim();
  if (!typed && prev?.apiKey && !sameProviderOrigin(prev.baseUrl, baseUrl)) throw new Error(KEY_FOR_NEW_ORIGIN);
  const apiKey = typed || prev?.apiKey || "";
  if (!apiKey) throw new Error("请填写 API 密钥");
  // 旧客户端不发 modelCaps：保留原来存的（只留还在目录里的模型）
  const modelCaps =
    input.modelCaps === undefined
      ? Object.fromEntries(Object.entries(prev?.modelCaps ?? {}).filter(([model]) => models.includes(model)))
      : parseModelCapsMap(input.modelCaps, models);
  const next: StoredProvider = {
    id,
    name,
    baseUrl,
    protocol,
    apiKey,
    models,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(streamIdleTimeoutMs ? { streamIdleTimeoutMs } : {}),
    ...(Object.keys(modelCaps).length ? { modelCaps } : {}),
  };
  saveProviders(db, prev ? rows.map((row) => (row.id === id ? next : row)) : [...rows, next]);
  return publicProvider(next);
}

export function deleteProvider(db: DatabaseSync, id: string): void {
  const rows = loadProviders(db);
  if (!rows.some((row) => row.id === id)) throw new Error("找不到这个提供方");
  saveProviders(
    db,
    rows.filter((row) => row.id !== id),
  );
}

export function findProvider(db: DatabaseSync, id: string): StoredProvider | undefined {
  return loadProviders(db).find((row) => row.id === id);
}

type StreamOpts = {
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; max: number; reason: string; delayMs: number }) => void | Promise<void>;
};

export type ChatStreamer = {
  chatCompletionsStream: (params: ChatCompletionParams, opts?: StreamOpts) => AsyncGenerator<ChatStreamEvent>;
};

/** 自定义网关一律不跟随重定向：Authorization / x-api-key 不该被带到别的主机。 */
const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });

export function clientForProvider(provider: StoredProvider, model: string): { client: ChatStreamer; model: string } {
  if (provider.protocol === "openai-completions") {
    const inner = new AgnesClient({ apiKey: provider.apiKey, baseUrl: provider.baseUrl, headers: {}, fetch: noRedirectFetch });
    return {
      model,
      client: {
        // 渠道自己的超时优先，没配就走 SDK 默认
        chatCompletionsStream: async function* (params, opts) {
          const run = (withUsage: boolean, noRetry = false) =>
            inner.chatCompletionsStream(
              // 流式请求带上 include_usage，网关才会在末尾回 token 用量（用量记录要用）
              withUsage ? ({ ...params, stream_options: { include_usage: true } } as typeof params) : params,
              {
                ...(opts ?? {}),
                ...(noRetry ? { retries: 0 } : {}),
                ...(provider.timeoutMs ? { firstByteTimeoutMs: provider.timeoutMs } : {}),
                ...(provider.streamIdleTimeoutMs ? { streamIdleTimeoutMs: provider.streamIdleTimeoutMs } : {}),
              },
            );
          const key = usageOptKey(provider);
          if (NO_STREAM_OPTIONS.has(key)) {
            yield* run(false);
            return;
          }
          let yielded = false;
          try {
            for await (const event of run(true)) {
              yielded = true;
              yield event;
            }
          } catch (err) {
            if (yielded || opts?.signal?.aborted || !rejectsStreamOptions(err)) throw err;
            // 可能是严格网关不认 stream_options：立刻不带它重发一次（不再额外重试）。
            // 只有这次成功才记住该渠道；也失败了说明是别的原因（模型名错等），报第一次的原话
            let recovered = false;
            try {
              for await (const event of run(false, true)) {
                if (!recovered) {
                  recovered = true;
                  if (!NO_STREAM_OPTIONS.has(key)) {
                    NO_STREAM_OPTIONS.add(key);
                    console.warn(`[provider] ${provider.id} 不支持 stream_options，之后不再发送`);
                  }
                }
                yield event;
              }
            } catch (err2) {
              if (recovered || opts?.signal?.aborted) throw err2;
              throw err;
            }
          }
        },
      },
    };
  }
  return {
    model,
    client: {
      chatCompletionsStream: (params, opts) => streamForeign(provider, params, opts ?? {}),
    },
  };
}

export function resolveCustomChat(db: DatabaseSync, modelName: string): { client: ChatStreamer; model: string } | null {
  const parsed = parseCustomModel(modelName);
  if (!parsed) return null;
  const provider = findProvider(db, parsed.providerId);
  if (!provider?.apiKey) return null;
  return clientForProvider(provider, parsed.model);
}

/**
 * 渠道 /models 里顺带给的模型元数据。Anthropic 官方给 max_input_tokens / max_tokens / capabilities.image_input，
 * OpenRouter 一类网关给 context_length / top_provider.max_completion_tokens / architecture.input_modalities。
 * OpenAI 官方 /models 只有 id，拿不到就算了。
 */
export function probeMeta(row: Record<string, unknown>): ModelCapsInput {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const top = obj(row.top_provider);
  const arch = obj(row.architecture);
  const imageCap = obj(obj(row.capabilities).image_input).supported;
  const modalities = Array.isArray(arch.input_modalities) ? arch.input_modalities : Array.isArray(row.input_modalities) ? row.input_modalities : null;
  return cleanCapsInput({
    contextWindow: num(row.max_input_tokens) ?? num(row.context_length) ?? num(row.context_window) ?? num(top.context_length),
    maxTokens: num(row.max_tokens) ?? num(row.max_output_tokens) ?? num(top.max_completion_tokens) ?? num(row.max_completion_tokens),
    supportsImages: typeof imageCap === "boolean" ? imageCap : modalities ? modalities.map(String).includes("image") : undefined,
  });
}

export async function probeModels(
  baseUrl: string,
  apiKey: string,
  protocol: ProviderProtocol,
): Promise<{ models: string[]; meta: Record<string, ModelCapsInput> }> {
  const root = assertProviderUrl(baseUrl);
  if (!apiKey.trim()) throw new Error("请先填写 API 密钥");
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey.trim()}` };
  if (protocol === "anthropic-messages") {
    headers["x-api-key"] = apiKey.trim();
    headers["anthropic-version"] = "2023-06-01";
  }
  const res = await fetch(`${root}/models`, { headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`拉取模型目录失败（${res.status}）`);
  const body = (await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> };
  const rows = (Array.isArray(body.data) ? body.data : []).filter((row) => row && typeof row === "object");
  const ids = rows.map((row) => String(row.id || "").trim()).filter((id) => id && !id.includes("|"));
  if (!ids.length) throw new Error("目录里没有模型，可以自己添加模型 ID");
  const models = ids.slice(0, 40);
  const meta: Record<string, ModelCapsInput> = {};
  for (const row of rows) {
    const id = String(row.id || "").trim();
    if (!models.includes(id)) continue;
    const found = probeMeta(row);
    if (Object.keys(found).length) meta[id] = found;
  }
  return { models, meta };
}

/** 自定义网关的失败。带状态码，重试判断和界面提示都用它。 */
export class ProviderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

/** 不认 stream_options 的渠道（进程内记忆，键为渠道 id + baseUrl） */
const NO_STREAM_OPTIONS = new Set<string>();
function usageOptKey(p: Pick<StoredProvider, "id" | "baseUrl">): string {
  return `${p.id}|${p.baseUrl}`;
}
export function rejectsStreamOptions(err: unknown): boolean {
  const e = err as { status?: unknown; body?: unknown; message?: unknown } | null;
  const status = typeof e?.status === "number" ? e.status : 0;
  if (status === 400) return true;
  if (status < 400 || status >= 500) return false;
  const text = `${typeof e?.body === "string" ? e.body : ""} ${typeof e?.message === "string" ? e.message : ""}`;
  return /stream_options|include_usage|unknown|unrecognized|unsupported parameter|extra (fields|inputs)/i.test(text);
}
/** 仅测试用 */
export function resetStreamOptionsMemory(): void {
  NO_STREAM_OPTIONS.clear();
}

function retryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504;
  return isTransientNetworkError(err);
}

const FOREIGN_RETRIES = 2;
const HEADERS_TIMEOUT_MS = 2 * 60 * 1000;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;

async function* streamForeign(provider: StoredProvider, params: ChatCompletionParams, opts: StreamOpts): AsyncGenerator<ChatStreamEvent> {
  for (let attempt = 0; ; attempt++) {
    let yielded = false;
    try {
      const inner = provider.protocol === "openai-responses" ? streamResponses(provider, params, opts.signal) : streamAnthropic(provider, params, opts.signal);
      for await (const event of inner) {
        yielded = true;
        yield event;
      }
      return;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (yielded || attempt >= FOREIGN_RETRIES || !retryable(err)) throw err;
      const delayMs = 1000 * 2 ** attempt;
      await Promise.resolve(
        opts.onRetry?.({ attempt: attempt + 1, max: FOREIGN_RETRIES, reason: err instanceof Error ? err.message : String(err), delayMs }),
      );
      await abortableSleep(delayMs, opts.signal);
    }
  }
}

/** 重试间隔里用户点停止要马上停，不能干等完整个间隔 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 等响应头默认最多 2 分钟，之后每段数据之间默认最多停 3 分钟；渠道可单独配置。用户点停止照常中断。 */
function watchdog(signal: AbortSignal | undefined, provider: Pick<StoredProvider, "timeoutMs" | "streamIdleTimeoutMs">) {
  const headersMs = provider.timeoutMs ?? HEADERS_TIMEOUT_MS;
  const idleMs = provider.streamIdleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new ProviderError(504, `自定义模型 ${Math.round(ms / 1000)} 秒没有响应`)), ms);
  };
  arm(headersMs);
  return {
    signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
    bump: () => arm(idleMs),
    stop: () => clearTimeout(timer),
  };
}

async function* readSse(res: Response, bump: () => void): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      bump();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          /* 心跳或半行 */
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已经关了 */
    }
  }
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function imagesOf(content: ChatMessage["content"]): string[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is Extract<ChatContentPart, { type: "image_url" }> => part.type === "image_url").map((part) => part.image_url.url);
}

function upstreamMessage(event: Record<string, unknown>): string {
  const err = (event.error || (event.response as { error?: unknown } | undefined)?.error || {}) as { message?: string; code?: string };
  return String(err.message || event.message || err.code || "自定义模型返回错误").slice(0, 300);
}

async function failure(res: Response): Promise<ProviderError> {
  const body = await res.text().catch(() => "");
  let message = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message || parsed.message || "";
  } catch {
    message = body;
  }
  const text = message.replace(/\s+/g, " ").trim().slice(0, 300);
  return new ProviderError(res.status, `自定义模型返回 ${res.status}${text ? `：${text}` : ""}`);
}

function responsesInput(messages: ChatMessage[]): { instructions: string; input: Array<Record<string, unknown>> } {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .filter(Boolean)
    .join("\n\n");
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id || "", output: textOf(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text) input.push({ role: "assistant", content: text });
      for (const call of message.tool_calls ?? []) {
        input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" });
      }
      continue;
    }
    const images = imagesOf(message.content);
    const text = textOf(message.content);
    if (!images.length) {
      input.push({ role: "user", content: text });
      continue;
    }
    input.push({
      role: "user",
      content: [...(text ? [{ type: "input_text", text }] : []), ...images.map((url) => ({ type: "input_image", image_url: url }))],
    });
  }
  return { instructions, input };
}

async function* streamResponses(provider: StoredProvider, params: ChatCompletionParams, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
  const mapped = responsesInput(params.messages);
  const tools = params.tools?.length
    ? params.tools.map((tool) => ({ type: "function", name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }))
    : undefined;
  const dog = watchdog(signal, provider);
  try {
    const res = await fetch(`${provider.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        model: params.model,
        input: mapped.input,
        ...(mapped.instructions ? { instructions: mapped.instructions } : {}),
        ...(tools ? { tools, tool_choice: "auto" } : {}),
        ...(params.max_tokens || params.max_completion_tokens ? { max_output_tokens: params.max_tokens || params.max_completion_tokens } : {}),
        ...responsesThinking(params.thinking),
        stream: true,
      }),
      redirect: "error",
      signal: dog.signal,
    });
    dog.bump();
    if (!res.ok) throw await failure(res);
    // output_index → 工具序号。同一轮可能先出文字再出几个函数调用
    const toolIndex = new Map<number, number>();
    const argsSeen = new Set<number>();
    let finished = false;
    for await (const event of readSse(res, dog.bump)) {
      const type = String(event.type || "");
      if (type === "error" || type === "response.failed") throw new ProviderError(502, `自定义模型出错：${upstreamMessage(event)}`);
      if (type === "response.output_text.delta" && typeof event.delta === "string") yield { type: "content", text: event.delta };
      if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && typeof event.delta === "string") {
        yield { type: "thinking", text: event.delta };
      }
      if (type === "response.output_item.added") {
        const item = (event.item || {}) as { type?: string; call_id?: string; id?: string; name?: string };
        if (item.type === "function_call") {
          const index = toolIndex.size;
          toolIndex.set(Number(event.output_index ?? index), index);
          yield { type: "tool_call_delta", index, id: item.call_id || item.id, name: item.name, arguments: "" };
        }
      }
      if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
        const index = toolIndex.get(Number(event.output_index));
        if (index !== undefined) {
          argsSeen.add(index);
          yield { type: "tool_call_delta", index, arguments: event.delta };
        }
      }
      if (type === "response.function_call_arguments.done" && typeof event.arguments === "string") {
        // 有的网关不发 delta，只在 done 里给完整参数
        const index = toolIndex.get(Number(event.output_index));
        if (index !== undefined && !argsSeen.has(index)) yield { type: "tool_call_delta", index, arguments: event.arguments };
      }
      if (type === "response.completed" || type === "response.incomplete") {
        const usage = ((event.response || {}) as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }).usage;
        if (usage) {
          yield {
            type: "usage",
            promptTokens: usage.input_tokens ?? 0,
            completionTokens: usage.output_tokens ?? 0,
            totalTokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          };
        }
        finished = true;
        yield { type: "finish", reason: type === "response.incomplete" ? "length" : toolIndex.size ? "tool_calls" : "stop" };
      }
    }
    if (!finished) yield { type: "finish", reason: toolIndex.size ? "tool_calls" : "stop" };
  } finally {
    dog.stop();
  }
}

/** Responses 的思考字段：reasoning.effort，off 发 none。Agnes 的 Responses 文档没写思考参数，不发 */
function responsesThinking(thinking: ChatCompletionParams["thinking"]): Record<string, unknown> {
  if (!thinking || thinking.style === "agnes") return {};
  return { reasoning: { effort: thinking.level === "off" ? "none" : thinking.level } };
}

/**
 * Messages 的思考字段。
 * - effort / deepseek：output_config.effort；off 发 thinking.type=disabled
 * - agnes：文档只给了 thinking.type=enabled + budget_tokens（示例 2048）。这种手动预算模式下，
 *   接在工具结果后面的请求要回传上一轮的 thinking 块，我们没存，所以这种轮次不开
 */
function anthropicThinking(thinking: ChatCompletionParams["thinking"], maxTokens: number, messages: ChatMessage[]): Record<string, unknown> {
  if (!thinking) return {};
  if (thinking.style === "agnes") {
    if (thinking.level === "off" || messages[messages.length - 1]?.role === "tool") return {};
    const budget = Math.min(2048, maxTokens - 1);
    return budget >= 1024 ? { thinking: { type: "enabled", budget_tokens: budget } } : {};
  }
  if (thinking.level === "off") return { thinking: { type: "disabled" } };
  return { output_config: { effort: thinking.level } };
}

function dataImage(url: string): Record<string, unknown> | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1].toLowerCase(), data: m[2] } };
  if (/^https:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

function anthropicMessages(messages: ChatMessage[]): { system: string; messages: Array<Record<string, unknown>> } {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .filter(Boolean)
    .join("\n\n");
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.tool_call_id || "", content: textOf(message.content) || "(空)" };
      // 一轮里的多个工具结果要放在同一条 user 消息里
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && (last.content as Array<{ type?: string }>).every((b) => b.type === "tool_result")) {
        (last.content as Array<Record<string, unknown>>).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (message.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      const text = textOf(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of message.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      // Anthropic 不收空的 assistant 消息
      if (blocks.length) out.push({ role: "assistant", content: blocks });
      continue;
    }
    const images = imagesOf(message.content).map(dataImage).filter((b): b is Record<string, unknown> => Boolean(b));
    const text = textOf(message.content);
    if (!images.length) {
      out.push({ role: "user", content: text || "(空)" });
      continue;
    }
    out.push({ role: "user", content: [...images, ...(text ? [{ type: "text", text }] : [])] });
  }
  return { system, messages: out };
}

function anthropicTools(tools: ChatToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

async function* streamAnthropic(provider: StoredProvider, params: ChatCompletionParams, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
  const mapped = anthropicMessages(params.messages);
  const maxTokens = params.max_tokens || params.max_completion_tokens || 8192;
  const dog = watchdog(signal, provider);
  try {
    const res = await fetch(`${provider.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: maxTokens,
        system: mapped.system || undefined,
        messages: mapped.messages,
        tools: anthropicTools(params.tools),
        ...anthropicThinking(params.thinking, maxTokens, params.messages),
        stream: true,
      }),
      redirect: "error",
      signal: dog.signal,
    });
    dog.bump();
    if (!res.ok) throw await failure(res);
    let toolIndex = -1;
    let promptTokens = 0;
    let completionTokens = 0;
    let finish = "";
    for await (const event of readSse(res, dog.bump)) {
      const type = String(event.type || "");
      if (type === "error") throw new ProviderError(502, `自定义模型出错：${upstreamMessage(event)}`);
      if (type === "message_start") {
        const usage = ((event.message || {}) as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        promptTokens = usage?.input_tokens ?? 0;
        completionTokens = usage?.output_tokens ?? 0;
      }
      if (type === "content_block_start") {
        const block = (event.content_block || {}) as { type?: string; id?: string; name?: string };
        if (block.type === "tool_use") {
          toolIndex += 1;
          yield { type: "tool_call_delta", index: toolIndex, id: block.id, name: block.name, arguments: "" };
        }
      }
      if (type === "content_block_delta") {
        const delta = (event.delta || {}) as { type?: string; text?: string; thinking?: string; partial_json?: string };
        if (delta.type === "text_delta" && delta.text) yield { type: "content", text: delta.text };
        if (delta.type === "thinking_delta" && delta.thinking) yield { type: "thinking", text: delta.thinking };
        if (delta.type === "input_json_delta" && delta.partial_json && toolIndex >= 0) {
          yield { type: "tool_call_delta", index: toolIndex, arguments: delta.partial_json };
        }
      }
      if (type === "message_delta") {
        const usage = (event.usage || {}) as { output_tokens?: number };
        if (typeof usage.output_tokens === "number") completionTokens = usage.output_tokens;
        const stop = String(((event.delta || {}) as { stop_reason?: string }).stop_reason || "");
        if (stop) finish = stop === "tool_use" ? "tool_calls" : stop === "max_tokens" ? "length" : "stop";
      }
      if (type === "message_stop") break;
    }
    if (promptTokens || completionTokens) {
      yield { type: "usage", promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
    }
    yield { type: "finish", reason: finish || (toolIndex >= 0 ? "tool_calls" : "stop") };
  } finally {
    dog.stop();
  }
}