export type FileNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
};

export type DiffProposal = {
  id: string;
  path: string;
  original: string;
  proposed: string;
  unified: string;
};

export type PlanStep = { step: string; status: "pending" | "in_progress" | "completed" };

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string; args: unknown; parent?: string }
  | { type: "tool_end"; id: string; name: string; result: string; ok?: boolean; parent?: string }
  | { type: "diff"; diff: DiffProposal; status?: "pending" | "applied" }
  | { type: "terminal"; id: string; chunk: string }
  | { type: "media"; id: string; kind: "image" | "video"; url?: string; jobId?: string; status?: string }
  /** 模型用 update_plan 维护的任务清单，UI 当进度条画 */
  | { type: "plan"; steps: PlanStep[]; explanation?: string }
  /** 计划模式开关。批准方案后关掉，输入框上的标记跟着变 */
  | { type: "plan_mode"; active: boolean }
  /** 模型用 present_plan 交出一份方案，等用户批准或退回 */
  /** id 是本机生成的等待键；callId 是对应的工具调用，tool_end 用它收卡片 */
  | { type: "plan_review"; id: string; callId?: string; plan: string }
  /** 模型用 ask_user 问一个选择题 */
  | { type: "question"; id: string; callId?: string; question: string; options: Array<{ label: string; description?: string }> }
  /** 每轮模型调用的 token 用量，累计给 UI 显示 */
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
  /** Codex 式命令审批：suggest / auto-edit 模式下终端命令先问用户 */
  | { type: "command"; id: string; callId?: string; command: string; cwd: string }
  /** 本机没有 Git 时先说明原因，等用户选择安装 / 跳过 */
  | {
      type: "git_setup";
      id: string;
      reason: string;
      installCommand: string;
      hint: string;
      canAutoInstall: boolean;
    }
  /** 模型通道网络波动，正在自动重试（Cursor 的 "Connection failed, retrying"） */
  | { type: "retry"; attempt: number; max: number; reason: string; delayMs: number }
  /** 主 Agent 开始第 index 步（1 起），max 为步数上限 */
  | { type: "step"; index: number; max: number }
  /** 发给模型的上下文被收短了。数据库和界面里的历史不动 */
  | { type: "context"; before: number; after: number; note: string }
  | { type: "error"; message: string }
  | { type: "finish"; reason: string };

/**
 * Codex 的三档审批策略：
 * - suggest：写文件、跑命令都要用户点确认
 * - auto-edit：写文件自动落盘，跑命令要确认
 * - full-auto：全自动
 */
export type ApprovalMode = "suggest" | "auto-edit" | "full-auto";

export type SavedMedia = {
  id: string;
  publicUrl: string;
  localPath?: string;
};

export type PlanVerdict = { action: "approve" } | { action: "revise"; note: string } | { action: "cancel"; note: string };

/** Minimal MCP surface on the runtime (avoids circular import with mcp.ts). */
export type McpRuntime = {
  toolDefinitions: () => import("@agnes/sdk").ChatToolDefinition[];
  callQualified: (name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>;
  status?: () => Array<{ name: string; status: string; tools: number; error?: string }>;
};

export type ToolRuntime = {
  workspaceRoot: string;
  autoApply: boolean;
  allowTerminal: boolean;
  allowWrites: boolean;
  allowImage?: boolean;
  allowVideo?: boolean;
  /** 为 true 时 run_terminal 先 emit command 事件并等 waitForCommand。有 approvalMode 时以规则为准 */
  confirmCommands?: boolean;
  /** 三档审批。危险命令在 full-auto 下也会问 */
  approvalMode?: ApprovalMode;
  /** 命令允许规则，一行一条。空则用默认清单 */
  commandAllow?: string;
  /** 写入的 git 提交打上对话 id，才能按一条消息回退 */
  conversationId?: string;
  /** 默认 true：每次成功写入后宿主 git commit。设 false 则跳过 */
  gitCheckpoints?: boolean;
  gitBin?: string;
  emit: (event: AgentEvent) => void | Promise<void>;
  /** stale：等审批期间文件被别的任务改过，宿主拒绝落盘，让模型重新读 */
  waitForApply: (diff: DiffProposal) => Promise<"applied" | "rejected" | "stale">;
  waitForCommand?: (id: string, command: string) => Promise<"approved" | "denied">;
  waitForGitSetup?: (id: string) => Promise<"install" | "skip" | "redetect">;
  /** 计划模式：只读探索，方案经 present_plan 批准后才改文件 */
  planMode?: boolean;
  onPlanModeChange?: (active: boolean) => void;
  /** cancel：停止、超时或断开，模型不该开工也不该当成「要改」 */
  waitForPlan?: (id: string, plan: string) => Promise<PlanVerdict>;
  waitForQuestion?: (id: string, question: string) => Promise<string>;
  saveImage: (input: { prompt: string; url?: string; b64?: string }) => Promise<SavedMedia>;
  saveVideo: (input: { prompt: string; url: string; videoId: string }) => Promise<SavedMedia>;
  signal?: AbortSignal;
  /** Process-wide or per-session MCP hub. Sub-agents inherit it. */
  mcp?: McpRuntime;
  /** 每种工具单独的超时（毫秒），见 tool-timeout.ts。没设的工具保持原来的行为 */
  toolTimeouts?: Record<string, number>;
};
