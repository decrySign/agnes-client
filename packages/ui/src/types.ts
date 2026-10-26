export type Conversation = {
  id: string;
  title: string;
  mode: "chat" | "agent";
  model: string;
  persona_id?: string | null;
  /** 所属工作区，Agent 对话必有 */
  workspace_id?: string | null;
  /** 1 = 计划模式，先出方案再改文件 */
  plan_mode?: number;
  /** 对话目标，空串 = 未设 */
  goal?: string;
  /** 「对话」页签里的自定义分组，空 = 未分组（按日期显示） */
  group_id?: string | null;
  created_at: number;
  updated_at: number;
};

/** 「对话」页签的自定义分组，按账号隔离 */
export type ConversationGroup = {
  id: string;
  name: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

/** 一个项目目录，下面挂多个 Agent 对话 */
export type Workspace = {
  id: string;
  name: string;
  root: string;
  agents: number;
  lastActive: number;
  exists: boolean;
  pinned: boolean;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

export type Persona = {
  id: string;
  name: string;
  body: string;
  greeting: string;
  created_at: number;
  updated_at: number;
};

export type Message = {
  id: string;
  conversation_id: string;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  attachments: string | null;
  created_at: number;
};

export type DiffRow = {
  id: string;
  conversation_id: string;
  path: string;
  original: string;
  proposed: string;
  unified: string;
  status: string;
  created_at: number;
};

export type FileNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
};

export type Settings = {
  hasApiKey?: boolean;
  /** 模型调用走授权服务器中转，用户不需要自备密钥 */
  /** @deprecated oss */ relayManaged?: boolean;
  baseUrl: string;
  workspaceRoot?: string;
  desktopMode: boolean;
  chatModel: string;
  imageModel: string;
  videoModel: string;
  autoApply: boolean;
  /** Codex 式审批策略：suggest / auto-edit / full-auto（仅桌面） */
  approvalMode?: ApprovalMode;
  /** 命令允许规则，一行一条。危险命令不在这里 */
  commandAllow?: string;
  /** 每种工具单独的超时（毫秒），仅桌面。键：web_search / web_fetch / mcp / run_terminal / mcp__服务__工具 */
  toolTimeouts?: Record<string, number>;
  authRequired: boolean;
  storage?: "local" | "server";
  dataDir?: string;
  licenseRemote?: boolean;
  desktopDownloadUrl?: string;
  allowTerminal?: boolean;
  allowWrites?: boolean;
  models: { chat: string[]; image: string[]; video: string[] };
  /** 桌面端本机保存的自定义模型提供方，不含密钥 */
  providers?: ModelProvider[];
  /** 每个可选对话模型最终用的能力（服务端合成：设置 > 官方文档表 > 保守默认） */
  modelCaps?: Record<string, ModelCapsView>;
  /** 内置模型在设置里改过的能力（桌面端） */
  builtinModelCaps?: Record<string, ModelCapsInput>;
};

export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** 设置里存的能力配置，没填的项不出现 */
export type ModelCapsInput = {
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
  thinking?: ThinkingLevel;
  /** 压缩阈值二选一：占窗口的比例（0.05–0.95）或 token 数 */
  compactRatio?: number;
  compactTokens?: number;
};

export type CapsOrigin = "config" | "docs" | "default";

export type ModelCapsView = {
  contextWindow: number;
  maxTokens: number;
  /** null = 没查到文档，也没人填 */
  supportsImages: boolean | null;
  thinkingLevels: ThinkingLevel[];
  thinkingStyle: string;
  thinking?: ThinkingLevel;
  /** 配了压缩阈值时，换算成的 token 数；没有 = 默认字数预算 */
  compactThreshold?: number;
  origin: { contextWindow: CapsOrigin; maxTokens: CapsOrigin; supportsImages: CapsOrigin };
  /** 不算设置里填的值时的窗口 / 输出（文档或保守默认） */
  fallback?: { contextWindow: number; maxTokens: number; origin: "docs" | "default" };
  source?: string;
};

export type ModelProvider = {
  id: string;
  name: string;
  baseUrl: string;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages";
  models: string[];
  hasKey: boolean;
  /** 首包超时（毫秒），没配则用默认 */
  timeoutMs?: number;
  /** 流空闲超时（毫秒），没配则用默认 */
  streamIdleTimeoutMs?: number;
  /** 按模型的能力配置，键是模型 ID */
  modelCaps?: Record<string, ModelCapsInput>;
};

export type Account = {
  id: string;
  name: string;
};

export type Entitlement = {
  plan: "trial" | "licensed";
  status: "active" | "exhausted" | "revoked";
  chatUsed: number;
  chatQuota: number;
  remaining: number | null;
  allowChat: boolean;
  allowAgent: boolean;
  allowImage: boolean;
  allowVideo: boolean;
  hasLead: boolean;
  trialQuota: number;
  leadBonus: number;
  /** null = 永不过期（超管版 / 试用） */
  expiresAt: number | null;
  expired: boolean;
  isSuper: boolean;
  imageUsed: number;
  imageQuota: number;
  imageRemaining: number | null;
  videoUsed: number;
  videoQuota: number;
  videoRemaining: number | null;
  pendingBonusDays?: number;
};

export type SessionInfo = {
  authRequired: boolean;
  appAuthed: boolean;
  account: Account | null;
  profiles: Account[];
  entitlement: Entitlement | null;
  cloudUser?: { username: string } | null;
  storage: "local" | "server";
  desktopMode: boolean;
  desktopDownloadUrl?: string;
  dataDir?: string;
  dailyChat?: { used: number; remaining: number | null; limit: number };
  dailyImage?: { used: number; remaining: number | null; limit: number };
  videoQuota?: { used: number; remaining: number | null; limit: number; windowDays: number };
  beta?: BetaOffer | null;
};

export type BetaOffer = {
  open: boolean;
  planName: string;
  durationDays: number;
  chatQuota: number;
  imageQuota: number;
  videoQuota: number;
  rewardDays: number;
  claimed: boolean;
  eligible: boolean;
};

export type MediaJob = {
  id: string;
  type: string;
  status: string;
  prompt: string;
  result_url: string | null;
  playUrl?: string | null;
  error: string | null;
  created_at: number;
};

export type PlanStep = { step: string; status: "pending" | "in_progress" | "completed" };
export type ApprovalMode = "suggest" | "auto-edit" | "full-auto";

export const APPROVAL_MODES: Array<{ id: ApprovalMode; label: string; hint: string }> = [
  { id: "suggest", label: "每次都问", hint: "改文件和跑命令都要你点确认" },
  { id: "auto-edit", label: "只问命令", hint: "改文件自动写入。允许规则里的命令直接跑，其余命令要确认" },
  { id: "full-auto", label: "全自动", hint: "改文件和普通命令自动执行。删除、联网、git push 仍会询问" },
];

export type FeedbackKind = "bug" | "ux" | "idea" | "other";
export const FEEDBACK_KINDS: Array<{ id: FeedbackKind; label: string }> = [
  { id: "bug", label: "系统缺陷" },
  { id: "ux", label: "体验优化" },
  { id: "idea", label: "想法建议" },
  { id: "other", label: "其他" },
];

export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "status"; phase: string; files?: string[] }
  | { type: "tool_start"; id: string; name: string; args: unknown; parent?: string }
  | { type: "tool_end"; id: string; name: string; result: string; ok?: boolean; parent?: string }
  | { type: "plan"; steps: PlanStep[]; explanation?: string }
  | { type: "plan_mode"; active: boolean }
  | { type: "plan_review"; id: string; callId?: string; plan: string }
  | { type: "question"; id: string; callId?: string; question: string; options: Array<{ label: string; description?: string }> }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: "command"; id: string; callId?: string; command: string; cwd: string }
  | {
      type: "git_setup";
      id: string;
      reason: string;
      installCommand: string;
      hint: string;
      canAutoInstall: boolean;
    }
  | {
      type: "diff";
      diff: { id: string; path: string; original: string; proposed: string; unified: string };
      status?: "pending" | "applied";
    }
  | { type: "terminal"; id: string; chunk: string }
  | { type: "media"; id: string; kind: "image" | "video"; url?: string; jobId?: string; status?: string }
  /** 模型通道网络波动，服务端正在自动重试 */
  | { type: "retry"; attempt: number; max: number; reason: string; delayMs: number }
  /** 主 Agent 开始第 index 步 */
  | { type: "step"; index: number; max: number }
  /** 旧工具输出已从模型上下文收掉，界面历史还在 */
  | { type: "context"; before: number; after: number; note: string }
  | { type: "error"; message: string }
  | { type: "finish"; reason: string }
  /** 本轮结束后的用量记录（服务端已落库，GET /api/usage 可查） */
  | ({ type: "turn_usage" } & TurnUsage)
  | { type: "done"; ok?: boolean };

export interface TurnUsage {
  id: string;
  conversationId: string;
  createdAt: number;
  model: string;
  provider: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  retries: number;
}

export interface TurnUsageTotal {
  turns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  retries: number;
}
