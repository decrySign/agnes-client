import type { Conversation, ConversationGroup, FeedbackKind, MediaJob, ModelCapsInput, Persona, Settings, StreamEvent, Workspace } from "./types.js";
import { currentDeviceHash } from "./device.js";

const API_BASE = String((import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE || "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** 网页下载 Windows 文件夹压缩包。服务端没配 DESKTOP_DOWNLOAD_URL 时用这个。 */
export function desktopZipUrl(): string {
  return apiUrl("/api/updates/desktop");
}

/** 接口报错：保留状态码和服务端多给的字段（比如出图失败时的 refunded） */
export class ApiError extends Error {
  readonly status: number;
  readonly refunded: boolean;
  readonly data: Record<string, unknown>;

  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.refunded = data.refunded === true;
  }
}

async function readError(res: Response): Promise<ApiError> {
  let data: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    /* 不是 JSON */
  }
  const message = typeof data.error === "string" && data.error ? data.error : res.statusText;
  return new ApiError(message, res.status, data);
}

async function parseError(res: Response): Promise<string> {
  return (await readError(res)).message;
}

/** 这次失败的额度是不是已经退回了（只有真的退了才显示「次数已退回」） */
export function errorRefunded(err: unknown): boolean {
  return err instanceof ApiError && err.refunded;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  } else if (!init?.body) {
    headers.set("Content-Type", headers.get("Content-Type") || "application/json");
  }
  const device = currentDeviceHash();
  if (device) headers.set("x-agnes-device", device);
  const res = await fetch(apiUrl(path), {
    ...init,
    credentials: "include",
    headers,
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export function getSettings() {
  return api<Settings>("/api/settings");
}

export type McpServerInfo = {
  name: string;
  status: "connected" | "disconnected" | "error";
  tools: number;
  error?: string;
};

export function getMcpStatus() {
  return api<{ servers: McpServerInfo[] }>("/api/mcp");
}

export function reloadMcp() {
  return api<{ ok: boolean; servers: McpServerInfo[] }>("/api/mcp/reload", { method: "POST", body: "{}" });
}

export function saveSettings(body: Record<string, unknown>) {
  return api<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(body) });
}

export function createProvider(body: Record<string, unknown>) {
  return api<Settings>("/api/providers", { method: "POST", body: JSON.stringify(body) });
}

export function updateProvider(id: string, body: Record<string, unknown>) {
  return api<Settings>(`/api/providers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });
}

export function removeProvider(id: string) {
  return api<Settings>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function probeProvider(body: { baseUrl: string; apiKey: string; protocol: string; providerId?: string }) {
  return api<{ models: string[]; meta?: Record<string, ModelCapsInput> }>("/api/providers/probe", { method: "POST", body: JSON.stringify(body) });
}

export function login(token: string) {
  return api<{ ok: boolean }>("/api/auth", { method: "POST", body: JSON.stringify({ token }) });
}

export function getSession() {
  return api<import("./types.js").SessionInfo>("/api/session");
}



export function registerCloud(username: string, password: string) {
  return api<{ ok: boolean; user: { username: string } }>("/api/users/register", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function loginCloud(username: string, password: string) {
  return api<{ ok: boolean; user: { username: string } }>("/api/users/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logoutCloud() {
  return api<{ ok: boolean }>("/api/users/logout", { method: "POST", body: "{}" });
}





export function listProfiles() {
  return api<import("./types.js").Account[]>("/api/accounts");
}

export function createProfile(name: string) {
  return api<{ ok: boolean; account: import("./types.js").Account }>("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function selectProfile(id: string) {
  return api<{ ok: boolean; account: import("./types.js").Account }>("/api/accounts/select", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function logoutAccount() {
  return api<{ ok: boolean }>("/api/accounts/logout", { method: "POST" });
}

export function listConversations() {
  return api<Conversation[]>("/api/conversations");
}

export function createConversation(body: {
  title?: string;
  mode?: "chat" | "agent";
  model?: string;
  persona_id?: string | null;
  workspaceId?: string;
  workspaceRoot?: string;
}) {
  return api<Conversation>("/api/conversations", { method: "POST", body: JSON.stringify(body) });
}

export function listConversationGroups() {
  return api<ConversationGroup[]>("/api/conversation-groups");
}

export function createConversationGroup(name: string) {
  return api<ConversationGroup>("/api/conversation-groups", { method: "POST", body: JSON.stringify({ name }) });
}

export function renameConversationGroup(id: string, name: string) {
  return api<ConversationGroup>(`/api/conversation-groups/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

/** 删分组不删对话：里面的对话回到未分组 */
export function deleteConversationGroup(id: string) {
  return api<{ ok: boolean; released: number }>(`/api/conversation-groups/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function moveConversationToGroup(conversationId: string, groupId: string | null) {
  return api<Conversation>(`/api/conversations/${encodeURIComponent(conversationId)}/group`, {
    method: "PUT",
    body: JSON.stringify({ groupId }),
  });
}

export function listWorkspaces() {
  return api<Workspace[]>("/api/workspaces");
}

export function createWorkspace(root: string, name?: string) {
  return api<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ root, name }) });
}

export function patchWorkspace(id: string, body: { name?: string; root?: string; pinned?: boolean }) {
  return api<Workspace>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function reorderWorkspaces(ids: string[]) {
  return api<Workspace[]>("/api/workspaces/reorder", { method: "POST", body: JSON.stringify({ ids }) });
}

export function deleteWorkspace(id: string, cascade = false) {
  return api<{ ok: boolean; removedAgents: number }>(`/api/workspaces/${id}${cascade ? "?cascade=1" : ""}`, { method: "DELETE" });
}

export type ImageAttachment = { type: "image"; mediaId: string; url: string; name?: string; preview?: string };

function mediaPathOf(src: string): string {
  if (src.startsWith("/")) return src.split("?")[0];
  try {
    return new URL(src).pathname;
  } catch {
    return "";
  }
}

export function isAppMediaUrl(src: string): boolean {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return false;
  return /^\/api\/(media\/[^/]+|feedbacks\/[^/]+\/files\/[^/]+)$/.test(mediaPathOf(src));
}

function queryOf(src: string): string {
  const at = src.indexOf("?");
  if (at < 0) return "";
  const hash = src.indexOf("#", at);
  return hash < 0 ? src.slice(at) : src.slice(at, hash);
}

/** 自家媒体统一走 API 子域（网页跨子域、桌面同源），保留 ?preview=1 / ?download=1 */
function mediaFetchUrl(src: string): string {
  const pathName = mediaPathOf(src);
  if (pathName.startsWith("/api/")) return apiUrl(`${pathName}${queryOf(src)}`);
  return src.startsWith("http") ? src : apiUrl(src);
}

function deviceHeaders(): Headers {
  const headers = new Headers();
  const device = currentDeviceHash();
  if (device) headers.set("x-agnes-device", device);
  return headers;
}

/** /api/media/:id 的预览图（长边 800 的 WebP）或下载地址；别的地址原样返回 */
export function mediaVariantUrl(src: string, variant: "preview" | "download"): string {
  if (!/^\/api\/media\/[^/]+$/.test(mediaPathOf(src))) return src;
  if (new RegExp(`[?&]${variant}=1`).test(src)) return src;
  return `${src}${src.includes("?") ? "&" : "?"}${variant}=1`;
}

export async function fetchMediaObjectUrl(src: string): Promise<string> {
  if (src.startsWith("data:") || src.startsWith("blob:")) return src;
  const res = await fetch(mediaFetchUrl(src), { credentials: "include", headers: deviceHeaders() });
  if (!res.ok) throw new Error("媒体加载失败");
  return URL.createObjectURL(await res.blob());
}

function filenameFromDisposition(header: string | null): string {
  if (!header) return "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* 落到 filename= */
    }
  }
  return /filename="?([^";]+)"?/i.exec(header)?.[1]?.trim() || "";
}

/** 把原图 / 原视频存到本地。自家媒体带凭证取 ?download=1；外链取不到就新窗口打开 */
export async function downloadMedia(src: string, fallbackName: string): Promise<void> {
  let blob: Blob;
  let name = fallbackName;
  if (src.startsWith("data:") || src.startsWith("blob:")) {
    blob = await (await fetch(src)).blob();
  } else if (isAppMediaUrl(src)) {
    const res = await fetch(mediaFetchUrl(mediaVariantUrl(src, "download")), { credentials: "include", headers: deviceHeaders() });
    if (!res.ok) throw new Error("下载失败");
    name = filenameFromDisposition(res.headers.get("content-disposition")) || fallbackName;
    blob = await res.blob();
  } else {
    try {
      const res = await fetch(src, { mode: "cors" });
      if (!res.ok) throw new Error("下载失败");
      blob = await res.blob();
    } catch {
      window.open(src, "_blank", "noopener");
      return;
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function mediaFileName(kind: "image" | "video", id = ""): string {
  const tail = id.replace(/[^A-Za-z0-9]/g, "").slice(-8) || String(Date.now());
  return `agnes-${kind}-${tail}.${kind === "video" ? "mp4" : "png"}`;
}

export function attachmentDisplaySrc(p: { url?: string; mediaId?: string; preview?: string }): string {
  if (p.preview) return p.preview;
  if (p.url && (p.url.startsWith("data:") || p.url.startsWith("blob:"))) return p.url;
  if (p.mediaId) return apiUrl(`/api/media/${p.mediaId}`);
  return p.url || "";
}

export function uploadImage(dataUrl: string, name: string, conversationId?: string) {
  return api<{ id: string; url: string }>("/api/uploads/image", {
    method: "POST",
    body: JSON.stringify({ dataUrl, name, conversationId }),
  });
}

export function getConversation(id: string) {
  return api<Conversation & { messages: unknown[]; diffs: unknown[] }>(`/api/conversations/${id}`);
}

export function undoLastRound(conversationId: string) {
  return api<{
    ok: boolean;
    messageId: string;
    text: string;
    attachments: unknown[];
    removedMessages: number;
    filesReverted: boolean;
    usage: import("./types.js").TurnUsageTotal;
  }>(`/api/conversations/${encodeURIComponent(conversationId)}/undo`, { method: "POST", body: "{}" });
}

export function getTurnUsage(conversationId: string, limit = 50) {
  return api<{ conversationId: string; items: import("./types.js").TurnUsage[]; total: import("./types.js").TurnUsageTotal }>(
    `/api/usage?conversationId=${encodeURIComponent(conversationId)}&limit=${limit}`,
  );
}

export function patchConversation(id: string, body: Record<string, unknown>) {
  return api<Conversation>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteConversation(id: string) {
  return api<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" });
}

export function compactConversation(id: string) {
  return api<{ before: number; after: number; note: string }>(`/api/conversations/${encodeURIComponent(id)}/compact`, {
    method: "POST",
    body: "{}",
  });
}

export function listPersonas() {
  return api<Persona[]>("/api/personas");
}

export function createPersona(body: { name: string; body: string; greeting?: string }) {
  return api<Persona>("/api/personas", { method: "POST", body: JSON.stringify(body) });
}

export function updatePersona(id: string, body: { name: string; body: string; greeting?: string }) {
  return api<Persona>(`/api/personas/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

export function deletePersona(id: string) {
  return api<{ ok: boolean }>(`/api/personas/${id}`, { method: "DELETE" });
}

export function stopConversation(id: string) {
  return api<{ ok: boolean }>(`/api/conversations/${id}/stop`, { method: "POST" });
}

/** 刷新 / 切回来时：这个对话是不是还在跑，还有哪些卡片在等用户 */
export function getPending(id: string) {
  return api<{ running: boolean; cards: StreamEvent[] }>(`/api/conversations/${id}/pending`);
}

export function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { name?: string }).name === "AbortError");
}

export async function sendMessage(
  id: string,
  content: string,
  onEvent: (ev: StreamEvent) => void,
  attachments: ImageAttachment[] = [],
  opts: { regenerate?: boolean; signal?: AbortSignal; planMode?: boolean } = {},
): Promise<void> {
  // 计划模式开关跟消息一起提交，避免「刚切完开关就发送」时服务端还按旧状态跑
  const planMode = typeof opts.planMode === "boolean" ? { planMode: opts.planMode } : {};
  const res = await fetch(apiUrl(`/api/conversations/${id}/messages`), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(currentDeviceHash() ? { "x-agnes-device": currentDeviceHash() } : {}) },
    body: JSON.stringify(opts.regenerate ? { regenerate: true, ...planMode } : { content, attachments, ...planMode }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(await parseError(res));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const raw = line.slice(5).trim();
        try {
          onEvent(JSON.parse(raw) as StreamEvent);
        } catch {
          onEvent({ type: eventName, ...(raw ? { raw } : {}) } as StreamEvent);
        }
        eventName = "message";
      }
    }
  }
  if (buffer.trim().startsWith("data:")) {
    const raw = buffer.trim().slice(5).trim();
    try {
      onEvent(JSON.parse(raw) as StreamEvent);
    } catch {
      /* ignore trailing fragment */
    }
  }
}

export type SkillInfo = { name: string; title: string; description: string; source: string };

export function searchSymbols(q: string, conversationId?: string) {
  const conv = conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : "";
  return api<{ hits: Array<{ name: string; path: string; line: number; kind: string }> }>(
    `/api/workspace/symbols?q=${encodeURIComponent(q)}${conv}`,
  );
}

export function getWorkspaceGuide(workspaceId: string) {
  return api<{ rules: { path: string; text: string } | null; skills: SkillInfo[] }>(`/api/workspaces/${workspaceId}/guide`);
}

export function getSkillBody(workspaceId: string, name: string) {
  return api<{ name: string; body: string }>(
    `/api/workspaces/${workspaceId}/skill?name=${encodeURIComponent(name)}`,
  );
}

export function restoreToMessage(conversationId: string, messageId: string) {
  return api<{ ok: boolean; reverted: number }>(`/api/conversations/${conversationId}/restore`, {
    method: "POST",
    body: JSON.stringify({ messageId }),
  });
}

export function getWorkspace(depth = 3, conversationId?: string) {
  const conv = conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : "";
  return api<{
    root: string;
    tree: import("./types.js").FileNode[];
    skills: string[];
    git: { branch: string; changed: number } | null;
  }>(`/api/workspace?depth=${depth}${conv}`);
}

export function getWorkspaceFile(filePath: string, conversationId?: string) {
  const conv = conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : "";
  return api<{ path: string; content: string }>(
    `/api/workspace/file?path=${encodeURIComponent(filePath)}${conv}`,
  );
}

export function applyDiff(id: string) {
  return api<{ ok: boolean }>(`/api/diffs/${id}/apply`, { method: "POST" });
}

export function revertDiff(id: string) {
  return api<{ ok: boolean }>(`/api/diffs/${id}/revert`, { method: "POST" });
}

export function approveCommand(id: string) {
  return api<{ ok: boolean }>(`/api/commands/${id}/approve`, { method: "POST" });
}

export function answerQuestion(id: string, text: string) {
  return api<{ ok: boolean }>(`/api/questions/${id}/answer`, { method: "POST", body: JSON.stringify({ text }) });
}

export function approvePlan(id: string) {
  return api<{ ok: boolean }>(`/api/plans/${id}/approve`, { method: "POST" });
}

export function revisePlan(id: string, note: string) {
  return api<{ ok: boolean }>(`/api/plans/${id}/revise`, { method: "POST", body: JSON.stringify({ note }) });
}

export function denyCommand(id: string) {
  return api<{ ok: boolean }>(`/api/commands/${id}/deny`, { method: "POST" });
}

export function resolveGitSetup(id: string, action: "install" | "skip" | "redetect") {
  return api<{ ok: boolean }>(`/api/git-setup/${id}/${action}`, { method: "POST" });
}

/** 删掉这条消息和它之后的所有消息（编辑并重发用） */
export function rewindTo(conversationId: string, messageId: string) {
  return api<{ ok: boolean }>(`/api/conversations/${conversationId}/messages/${messageId}/rewind`, { method: "POST" });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

export function rejectDiff(id: string) {
  return api<{ ok: boolean }>(`/api/diffs/${id}/reject`, { method: "POST" });
}

export type GeneratedImage = { id: string; url: string; mediaUrl?: string; local?: boolean };
export type GeneratedImageItem = GeneratedImage | { error: string; refunded?: boolean };

/** count 1–4：每张单独扣一次；多张时返回逐张结果，失败的那张带 refunded */
export function generateImage(body: Record<string, unknown>) {
  return api<Partial<GeneratedImage> & { items?: GeneratedImageItem[]; ok?: number; failed?: number }>("/api/images/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function generateVideo(body: Record<string, unknown>) {
  return api<{ id: string; videoId: string; status: string }>("/api/videos/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getVideoJob(id: string) {
  return api<MediaJob>(`/api/videos/${id}`);
}

export function listMedia(type?: string) {
  return api<MediaJob[]>(type ? `/api/media?type=${type}` : "/api/media");
}

export async function uploadWorkspaceFile(file: File, conversationId = "", dest = ""): Promise<{ path: string }> {
  const form = new FormData();
  form.set("file", file);
  if (dest) form.set("path", dest);
  const conv = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  const res = await fetch(apiUrl(`/api/workspace/upload${conv}`), {
    method: "POST",
    credentials: "include",
    headers: currentDeviceHash() ? { "x-agnes-device": currentDeviceHash() } : undefined,
    body: form,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { path: string };
}

export type FeedbackItem = {
  id: string;
  title: string;
  body: string;
  kind: FeedbackKind;
  images: Array<{ name: string; url: string }>;
  status: "open" | "adopted" | "rejected";
  rewardDays: number;
  rewardApplied: string;
  adminNote: string;
  contact: string;
  client: string;
  ticketNo?: string;
  createdAt: number;
  updatedAt: number;
  reviewedAt: number | null;
  /** 运营回复（Markdown，可带截图），和采纳 / 不采纳分开 */
  replies?: FeedbackReply[];
};

export type FeedbackReply = {
  id: string;
  author: string;
  body: string;
  images: Array<{ name: string; url: string }>;
  createdAt: number;
};

export function listMyFeedback() {
  return api<FeedbackItem[]>("/api/feedbacks");
}

export function submitFeedback(body: { title?: string; body: string; kind: FeedbackKind; images?: string[]; contact?: string }) {
  return api<FeedbackItem>("/api/feedbacks", { method: "POST", body: JSON.stringify(body) });
}
