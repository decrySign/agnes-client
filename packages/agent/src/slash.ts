/** 输入框里的斜杠命令。本地处理或改协作状态，不把命令原文发给模型。 */

export type SlashCommandInfo = {
  cmd: string;
  /** 点选后写入输入框的文本 */
  insert: string;
  hint: string;
};

export type ComposerCommand =
  | { kind: "plan"; active: boolean; message: string }
  | { kind: "help"; text: string }
  | { kind: "mcp"; text: string }
  | { kind: "status"; text: string }
  | { kind: "clear"; scope: "current" }
  | { kind: "new"; scope: "current" }
  | { kind: "model"; action: "list" }
  | { kind: "model"; action: "set"; id: string }
  | { kind: "undo"; scope: "current" }
  | { kind: "goal"; action: "set"; text: string }
  | { kind: "goal"; action: "clear" }
  | {
      kind: "compact";
      scope: "current";
      /** true：会改模型侧上下文缓存，需确认 */
      destructive?: boolean;
      needsConfirm?: boolean;
      confirm?: boolean;
      text?: string;
    }
  | { kind: "error"; text: string }
  | { kind: "local"; text: string; consume: true };

export type SlashDispatchContext = {
  conversationId?: string;
  model?: string;
  workspaceRoot?: string;
  running?: boolean;
  mode?: "chat" | "agent";
  planMode?: boolean;
  getMcpStatus?: () => {
    servers: Array<{ name: string; status: string; tools?: number; error?: string }>;
  };
  /** 若提供，dispatch(/clear) 会用提交时的 conversationId 调用，避免切会话后清错 */
  clear?: (conversationId: string) => void;
  /** /new：新开同模式对话并保留当前会话 */
  newConversation?: (conversationId: string) => void;
  /** /model 列表与切换 */
  models?: Array<{ id: string; label: string }>;
  setModel?: (modelId: string) => void;
  otherIds?: string[];
};

const SLASH_COMMANDS: SlashCommandInfo[] = [
  { cmd: "/help", insert: "/help", hint: "列出全部斜杠命令" },
  { cmd: "/plan", insert: "/plan ", hint: "先出方案，你点头后再改文件" },
  { cmd: "/plan off", insert: "/plan off", hint: "退出计划模式，直接做" },
  { cmd: "/mcp", insert: "/mcp", hint: "查看 MCP 服务器连接状态" },
  { cmd: "/status", insert: "/status", hint: "当前模式、计划、忙闲、工作区、模型" },
  { cmd: "/clear", insert: "/clear", hint: "新开同模式对话并删除刚清空的那条" },
  { cmd: "/new", insert: "/new", hint: "新开同模式对话，保留当前这条" },
  { cmd: "/model", insert: "/model ", hint: "查看或切换当前对话模型" },
  { cmd: "/compact", insert: "/compact", hint: "压缩发给模型的上下文（需确认）" },
  { cmd: "/compact confirm", insert: "/compact confirm", hint: "确认执行上下文压缩" },
  { cmd: "/undo", insert: "/undo", hint: "撤销上一轮：删掉最后一条提问及之后的回复，原话放回输入框（文件改动不撤销）" },
  { cmd: "/goal", insert: "/goal ", hint: "设定本对话目标；/goal 或 /goal clear 清除" },
];

export function listSlashCommands(): SlashCommandInfo[] {
  return SLASH_COMMANDS.slice();
}

function formatHelpText(): string {
  const lines = ["可用斜杠命令：", ...SLASH_COMMANDS.map((item) => `${item.cmd}  —  ${item.hint}`)];
  return lines.join("\n");
}

/** 首词是否像斜杠命令（`/help`），路径 `/Users/foo` 不算 */
export function looksLikeSlashCommand(raw: string): boolean {
  const first = raw.trim().split(/\s+/)[0] ?? "";
  return /^\/[A-Za-z][\w-]*$/.test(first);
}

/**
 * 解析斜杠命令。普通文字返回 null（发给模型）。
 * 未知的 `/foo` 返回 kind:"error"，不要当用户消息发出。
 * 与 packages/ui/src/ChatPane.tsx 保持一致（界面包不引用 agent）。
 */
export function parseComposerCommand(raw: string): ComposerCommand | null {
  const text = raw.trim();
  if (!text.startsWith("/")) return null;
  const parts = text.split(/\s+/);
  const head = (parts[0] ?? "").toLowerCase();

  if (head === "/help") {
    if (parts.length > 1) return { kind: "error", text: "用法：/help" };
    return { kind: "help", text: formatHelpText() };
  }
  if (head === "/mcp") {
    if (parts.length > 1) return { kind: "error", text: "用法：/mcp" };
    return { kind: "mcp", text: "MCP 状态（界面将拉取最新连接信息）" };
  }
  if (head === "/status") {
    if (parts.length > 1) return { kind: "error", text: "用法：/status" };
    return { kind: "status", text: "当前对话状态（界面将填入模式 / 模型 / 工作区）" };
  }
  if (head === "/clear") {
    if (parts.length > 1) return { kind: "error", text: "用法：/clear" };
    return { kind: "clear", scope: "current" };
  }
  if (head === "/new") {
    if (parts.length > 1) return { kind: "error", text: "用法：/new" };
    return { kind: "new", scope: "current" };
  }
  if (head === "/model") {
    if (parts.length === 1) return { kind: "model", action: "list" };
    if (parts.length >= 2) return { kind: "model", action: "set", id: parts.slice(1).join(" ") };
    return { kind: "error", text: "用法：/model 或 /model <模型id>" };
  }
  if (head === "/compact") {
    if (parts.length === 1) {
      return {
        kind: "compact",
        scope: "current",
        destructive: true,
        needsConfirm: true,
        confirm: false,
        text: "将压缩当前对话发给模型的上下文（界面记录保留）。输入 /compact confirm 确认执行。",
      };
    }
    if (parts.length === 2 && parts[1]!.toLowerCase() === "confirm") {
      return {
        kind: "compact",
        scope: "current",
        destructive: true,
        needsConfirm: false,
        confirm: true,
        text: "正在压缩当前对话上下文…",
      };
    }
    return { kind: "error", text: "用法：/compact 或 /compact confirm" };
  }
  if (head === "/undo") {
    if (parts.length > 1) return { kind: "error", text: "用法：/undo" };
    return { kind: "undo", scope: "current" };
  }
  if (head === "/goal") {
    const rest = text.slice(parts[0]!.length).trim();
    if (!rest || rest.toLowerCase() === "clear") return { kind: "goal", action: "clear" };
    // 按合并空白后的长度判断，和服务端 normalizeGoal 一致
    if (rest.replace(/\s+/g, " ").trim().length > 500) return { kind: "error", text: "目标太长了，最多 500 字。" };
    return { kind: "goal", action: "set", text: rest };
  }
  if (head === "/plan") {
    if (parts[1]?.toLowerCase() === "off") {
      return { kind: "plan", active: false, message: parts.slice(2).join(" ").trim() };
    }
    return { kind: "plan", active: true, message: parts.slice(1).join(" ").trim() };
  }

  if (looksLikeSlashCommand(text)) {
    return {
      kind: "error",
      text: `未知命令「${parts[0]}」。输入 /help 查看可用命令。`,
    };
  }
  return null;
}

function formatMcpText(servers: Array<{ name: string; status: string; tools?: number; error?: string }>): string {
  if (!servers.length) return "尚未配置 MCP 服务器（mcp.json 为空或未加载）。";
  return servers
    .map((s) => {
      const tools = typeof s.tools === "number" ? `，工具 ${s.tools} 个` : "";
      const err = s.error ? `（${s.error}）` : "";
      return `· ${s.name}：${s.status}${tools}${err}`;
    })
    .join("\n");
}

function formatStatusText(ctx: SlashDispatchContext): string {
  const mode = ctx.mode === "agent" ? "Agent" : ctx.mode === "chat" ? "对话" : "未知";
  const plan = ctx.planMode ? "开" : "关";
  const busy = ctx.running ? "进行中（running）" : "空闲";
  const model = ctx.model?.trim() || "未设置";
  const ws = ctx.workspaceRoot?.trim() || "无工作区";
  return [
    `模式：${mode}`,
    `计划模式：${plan}`,
    `状态：${busy}`,
    `模型：${model}`,
    `工作区：${ws}`,
  ].join("\n");
}

/**
 * 带上下文的斜杠分发：补全 /mcp /status 文案，/clear 时调用 ctx.clear(conversationId)。
 * UI 提交时务必传入当时的 conversationId，不要在 await 后再读 currentId。
 */
export async function dispatchSlashCommand(
  raw: string,
  ctx: SlashDispatchContext = {},
): Promise<ComposerCommand> {
  const parsed = parseComposerCommand(raw);
  if (!parsed) {
    return { kind: "error", text: "不是斜杠命令" };
  }
  if (parsed.kind === "mcp") {
    const st = ctx.getMcpStatus?.() ?? { servers: [] };
    return { kind: "mcp", text: formatMcpText(st.servers) };
  }
  if (parsed.kind === "status") {
    return { kind: "status", text: formatStatusText(ctx) };
  }
  if (parsed.kind === "clear") {
    if (ctx.conversationId && ctx.clear) ctx.clear(ctx.conversationId);
    return { kind: "clear", scope: "current" };
  }
  if (parsed.kind === "new") {
    if (ctx.conversationId && ctx.newConversation) ctx.newConversation(ctx.conversationId);
    return { kind: "new", scope: "current" };
  }
  if (parsed.kind === "model") {
    if (parsed.action === "list") {
      const cur = ctx.model?.trim() || "";
      const lines = ["当前模型：" + (cur || "未设置")];
      if (ctx.models?.length) {
        lines.push("可用模型：");
        for (const m of ctx.models) {
          const mark = m.id === cur ? "*" : "-";
          lines.push(`${mark} ${m.id}${m.label && m.label !== m.id ? `  ${m.label}` : ""}`);
        }
        lines.push("切换：/model <模型id>");
      } else {
        lines.push("（暂无可用模型列表）");
      }
      return { kind: "local", text: lines.join("\n"), consume: true };
    }
    const want = parsed.id.trim();
    const hit = ctx.models?.find((m) => m.id === want || m.label === want);
    if (!hit) {
      return { kind: "error", text: `未知模型「${want}」。输入 /model 查看可用列表。` };
    }
    ctx.setModel?.(hit.id);
    return { kind: "local", text: `已切换到模型 ${hit.label || hit.id}`, consume: true };
  }
  if (parsed.kind === "help") return parsed;
  if (parsed.kind === "compact") return parsed;
  if (parsed.kind === "plan") return parsed;
  if (parsed.kind === "error" || parsed.kind === "local") return parsed;
  return parsed;
}
