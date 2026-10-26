import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Pencil,
  Plus,
  RefreshCw,
  Square,
  Terminal,
  Undo2,
  X,
} from "lucide-react";
import { DesktopPromo } from "./DesktopPromo.js";
import type { DiffRow, FileNode, Message, PlanStep, StreamEvent, TurnUsage, TurnUsageTotal } from "./types.js";
import { MarkdownBody } from "./MarkdownBody.js";
import { DiffView } from "./DiffView.js";
import { groupTranscript, PlanCard, ToolGroup, type StepTool } from "./AgentSteps.js";
import { mergeStepRuns } from "./step-groups.js";
import {
  answerQuestion,
  apiUrl,
  applyDiff,
  approveCommand,
  approvePlan,
  attachmentDisplaySrc,
  denyCommand,
  mediaFileName,
  rejectDiff,
  resolveGitSetup,
  revisePlan,
  revertDiff,
  searchSymbols,
  uploadImage,
  getMcpStatus,
  type ImageAttachment,
} from "./api.js";
import { DownloadButton, MediaThumb, MediaVideo } from "./MediaSrc.js";
import { CopyAct } from "./CopyButton.js";
import { useAutoGrow } from "./autogrow.js";
import { splitScratch, thoughtLabel } from "./thinking.js";

type LiveTool = StepTool;
type LiveMedia = { kind: "image" | "video"; url?: string; jobId?: string };

/** 出图工具存好的图优先走自家 /api/media/:id（有预览图和下载文件名），外链做兜底 */
function liveMediaSrc(m: LiveMedia): { src: string; fallbacks: string[]; name: string } {
  const own = m.jobId && /^media_/.test(m.jobId) ? apiUrl(`/api/media/${m.jobId}`) : "";
  const src = own || m.url || "";
  return { src, fallbacks: own && m.url ? [m.url] : [], name: mediaFileName(m.kind, m.jobId || "") };
}
type PlanState = { steps: PlanStep[]; explanation?: string };
/** id 是服务端的等待键；callId 是对应的工具调用，tool_end 按它收卡片（旧服务端两者相同） */
type PendingCommand = { id: string; callId?: string; command: string; cwd: string };
type PendingQuestion = { id: string; callId?: string; question: string; options: Array<{ label: string; description?: string }> };
type PendingPlan = { id: string; callId?: string; plan: string };

/** 与 packages/agent/src/slash.ts 保持一致。界面包不引用 agent，避免把 Node 代码打进网页。 */
type SlashCommandInfo = { cmd: string; insert: string; hint: string };
type ComposerCommand =
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
      destructive?: boolean;
      needsConfirm?: boolean;
      confirm?: boolean;
      text?: string;
    }
  | { kind: "error"; text: string }
  | { kind: "local"; text: string; consume: true };

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

function formatSlashHelpText(): string {
  return ["可用斜杠命令：", ...SLASH_COMMANDS.map((item) => `${item.cmd}  —  ${item.hint}`)].join("\n");
}

function looksLikeSlashCommand(raw: string): boolean {
  const first = raw.trim().split(/\s+/)[0] ?? "";
  return /^\/[A-Za-z][\w-]*$/.test(first);
}

function parseComposerCommand(raw: string): ComposerCommand | null {
  const text = raw.trim();
  if (!text.startsWith("/")) return null;
  const parts = text.split(/\s+/);
  const head = (parts[0] ?? "").toLowerCase();

  if (head === "/help") {
    if (parts.length > 1) return { kind: "error", text: "用法：/help" };
    return { kind: "help", text: formatSlashHelpText() };
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
    return { kind: "error", text: `未知命令「${parts[0]}」。输入 /help 查看可用命令。` };
  }
  return null;
}
type GitSetup = {
  id: string;
  reason: string;
  installCommand: string;
  hint: string;
  canAutoInstall: boolean;
};

function commandCanRemember(command: string): boolean {
  const segment = command.split(/(?:&&|\|\||[;&|\n])/)[0]?.trim() ?? "";
  if (!segment || /^(format|mkfs|shutdown|reboot)\b/i.test(segment)) return false;
  return !/\b(rm|rmdir|del|erase|curl|wget|sudo|chmod|chown|winget)\b|\bRemove-Item\b|\bgit\s+(push|reset|clean|config)\b|\bbrew\s+install\b|\$\(|`/i.test(
    segment,
  );
}

function flattenFiles(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === "file") out.push(n.path);
    if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

const CHAT_TIME_GAP_MS = 5 * 60 * 1000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 微信式：上午 9:00 / 昨天 下午 3:21 / 9月20日 晚上 8:05 */
export function formatChatTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const h = d.getHours();
  const hour = h === 0 ? 0 : h <= 12 ? h : h - 12;
  const hm = `${hour}:${pad2(d.getMinutes())}`;
  const period = h < 6 ? "凌晨" : h < 12 ? "上午" : h === 12 ? "中午" : h < 18 ? "下午" : "晚上";
  const clock = `${period} ${hm}`;
  const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startToday - startThat) / 86_400_000);
  if (dayDiff === 0) return clock;
  if (dayDiff === 1) return `昨天 ${clock}`;
  if (dayDiff > 1 && dayDiff < 7) {
    const weeks = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    return `${weeks[d.getDay()]} ${clock}`;
  }
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
}

export function shouldShowChatTime(prev: number | null, next: number): boolean {
  if (!next) return false;
  if (prev == null) return true;
  if (next - prev >= CHAT_TIME_GAP_MS) return true;
  const a = new Date(prev);
  const b = new Date(next);
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}

function blockTime(b: { kind: string; message?: Message; at?: number }): number {
  return b.kind === "message" ? (b.message?.created_at ?? 0) : (b.at ?? 0);
}

/** attachments 在库里是 JSON 字符串，本地乐观插入时是数组 */
function messagePics(m: Message): ImageAttachment[] {
  const raw = m.attachments;
  if (!raw) return [];
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (x): x is ImageAttachment =>
        Boolean(x) && x.type === "image" && (typeof x.url === "string" || typeof x.mediaId === "string"),
    );
  } catch {
    return [];
  }
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="msg-act" title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}


/**
 * ChatGPT 式消息：用户在右侧灰色气泡，助手无气泡纯文本；悬停出操作条。
 * 没有 "你 / Agnes" 角色标签——位置和样式已经说明了谁在说话。
 */
function ThoughtBlock({ text, live, secs }: { text: string; live?: boolean; secs?: number }) {
  const [open, setOpen] = useState(Boolean(live));
  const folded = useRef(false);
  useEffect(() => {
    if (!live && !folded.current) {
      folded.current = true;
      setOpen(false);
    }
  }, [live]);
  return (
    <div className="thought">
      <button type="button" className="thought-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {!live && secs ? `思考了 ${secs} 秒` : thoughtLabel(text, Boolean(live))}
      </button>
      {open ? <div className="thought-body">{text}</div> : null}
    </div>
  );
}

function AssistantBody({ text, extraThinking, live, thinkSecs }: { text: string; extraThinking?: string; live?: boolean; thinkSecs?: number }) {
  const split = splitScratch(text);
  const thinking = [extraThinking?.trim(), split.thinking].filter(Boolean).join("\n\n");
  const answer = split.answer;
  const stillThinking = Boolean(live) && !answer;
  return (
    <>
      {thinking ? <ThoughtBlock text={thinking} live={stillThinking} secs={thinkSecs} /> : null}
      {answer ? <MarkdownBody text={live ? `${answer}▍` : answer} /> : null}
      {live && !answer && !thinking ? <span className="typing">正在思考</span> : null}
    </>
  );
}

function MessageBubble({
  m,
  canRegenerate,
  onRegenerate,
  onEdit,
  onRestore,
  thinkSecs,
}: {
  m: Message;
  /** 刚结束这一轮的思考耗时（只给最新那条助手消息） */
  thinkSecs?: number;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  onEdit?: (m: Message) => void;
  onRestore?: (m: Message) => void;
}) {
  if (m.role === "notice") {
    return (
      <div className="msg notice">
        <div className="msg-body notice">
          <pre className="notice-text">{m.content || ""}</pre>
        </div>
      </div>
    );
  }
  const pics = messagePics(m);
  const user = m.role === "user";
  const visible = user ? m.content || "" : splitScratch(m.content || "").answer;
  return (
    <div className={`msg ${user ? "user" : "assistant"}`}>
      <div className={`msg-body ${user ? "user" : "assistant"}`}>
        {pics.length ? (
          <div className="bubble-pics">
            {pics.map((p) => {
              const src = attachmentDisplaySrc(p);
              return src ? (
                <MediaThumb key={p.mediaId || p.url} src={src} name={p.name || mediaFileName("image", p.mediaId || "")} alt={p.name || ""} />
              ) : null;
            })}
          </div>
        ) : null}
        {user ? <MarkdownBody text={m.content || ""} /> : <AssistantBody text={m.content || ""} thinkSecs={thinkSecs} />}
      </div>
      <div className="msg-actions">
        <CopyAct text={visible} />
        {user && onEdit ? (
          <IconBtn title="编辑" onClick={() => onEdit(m)}>
            <Pencil size={14} />
          </IconBtn>
        ) : null}
        {user && onRestore ? (
          <IconBtn title="回退到这里" onClick={() => onRestore(m)}>
            <Undo2 size={14} />
          </IconBtn>
        ) : null}
        {!user && canRegenerate && onRegenerate ? (
          <IconBtn title="重新生成" onClick={onRegenerate}>
            <RefreshCw size={14} />
          </IconBtn>
        ) : null}
      </div>
    </div>
  );
}

/** Codex 的命令审批卡：suggest / auto-edit 模式下终端命令先问一声 */
function CommandCard({
  cmd,
  onDone,
  onAlwaysAllow,
}: {
  cmd: PendingCommand;
  onDone: () => void;
  onAlwaysAllow?: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="cmd-card">
      <div className="cmd-head">
        <Terminal size={13} />
        <span>Agent 想执行命令</span>
        <span className="cmd-cwd" title={cmd.cwd}>
          {cmd.cwd}
        </span>
      </div>
      <pre className="cmd-body">{cmd.command}</pre>
      <div className="cmd-actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => void act(() => approveCommand(cmd.id))}>
          运行
        </button>
        {commandCanRemember(cmd.command) && onAlwaysAllow ? (
          <button
            className="btn"
            disabled={busy}
            title="记入允许规则。之后在「只问命令」里同类命令直接跑"
            onClick={() => {
              void (async () => {
                setBusy(true);
                try {
                  await onAlwaysAllow();
                  await approveCommand(cmd.id);
                  onDone();
                } catch {
                  /* 记不住时留下这张卡，错误由上层提示 */
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            记住这条
          </button>
        ) : null}
        <button className="btn" disabled={busy} onClick={() => void act(() => denyCommand(cmd.id))}>
          拒绝
        </button>
        <span className="hint">「记住这条」只放行这一类命令。删除、联网、git push 不能记，全自动下也会问</span>
      </div>
    </div>
  );
}

function QuestionCard({
  item,
  onDone,
}: {
  item: PendingQuestion;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");
  const [failed, setFailed] = useState("");
  const act = async (text: string) => {
    const answer = text.trim();
    if (!answer) return;
    setBusy(true);
    setFailed("");
    try {
      await answerQuestion(item.id, answer);
      onDone();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 本轮已经停了 / 超时：这张卡没用了，收掉
      if (message.includes("不在等")) onDone();
      else setFailed(message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cmd-card ask-card">
      <div className="cmd-head">
        <span>需要你定一下</span>
      </div>
      <p className="ask-q">{item.question}</p>
      <div className="ask-options">
        {item.options.map((opt, i) => (
          <button key={`${i}:${opt.label}`} type="button" className="ask-option" disabled={busy} onClick={() => void act(opt.label)}>
            <b>
              {opt.label}
              {i === 0 ? <em>推荐</em> : null}
            </b>
            {opt.description ? <span>{opt.description}</span> : null}
          </button>
        ))}
      </div>
      <form
        className="ask-custom"
        onSubmit={(e) => {
          e.preventDefault();
          void act(custom);
        }}
      >
        <input className="field" value={custom} placeholder="或者自己写一句" disabled={busy} onChange={(e) => setCustom(e.target.value)} />
        <button className="btn" type="submit" disabled={busy || !custom.trim()}>
          发送
        </button>
      </form>
      {failed ? <p className="card-error">没发出去：{failed}</p> : null}
    </div>
  );
}

function PlanReviewCard({
  item,
  onDone,
}: {
  item: PendingPlan;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [revising, setRevising] = useState(false);
  const [failed, setFailed] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setFailed("");
    try {
      await fn();
      onDone();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("不在等")) onDone();
      else setFailed(message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cmd-card plan-review">
      <div className="cmd-head">
        <span>方案待确认</span>
      </div>
      <div className="plan-review-body">
        <MarkdownBody text={item.plan} />
      </div>
      {revising ? (
        <form
          className="ask-custom"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => revisePlan(item.id, note));
          }}
        >
          <input className="field" value={note} placeholder="哪里要改" disabled={busy} onChange={(e) => setNote(e.target.value)} />
          <button className="btn" type="submit" disabled={busy}>
            退回修改
          </button>
        </form>
      ) : (
        <div className="cmd-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => void act(() => approvePlan(item.id))}>
            按这个做
          </button>
          <button className="btn" disabled={busy} onClick={() => setRevising(true)}>
            还要改
          </button>
        </div>
      )}
      {failed ? <p className="card-error">没发出去：{failed}</p> : null}
    </div>
  );
}

function GitSetupCard({
  setup,
  onDone,
}: {
  setup: GitSetup;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (action: "install" | "skip" | "redetect") => {
    setBusy(true);
    try {
      await resolveGitSetup(setup.id, action);
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="cmd-card git-setup-card">
      <div className="cmd-head">
        <GitBranch size={13} />
        <span>需要 Git，才能安全回退 Agent 的改动</span>
      </div>
      <p className="cmd-why">{setup.reason}</p>
      <p className="hint">{setup.hint}</p>
      {setup.canAutoInstall ? <pre className="cmd-body">{setup.installCommand}</pre> : null}
      <div className="cmd-actions">
        {setup.canAutoInstall ? (
          <button className="btn btn-primary" disabled={busy} onClick={() => void act("install")}>
            安装 Git
          </button>
        ) : null}
        <button className="btn" disabled={busy} onClick={() => void act("redetect")}>
          我已装好
        </button>
        <button className="btn" disabled={busy} onClick={() => void act("skip")}>
          本轮不提交，先干活
        </button>
      </div>
    </div>
  );
}

const CHAT_PROMPTS = ["帮我写一段周报开头", "解释一下这个概念", "把这段话改得更简洁", "给我三个方案对比"];
const AGENT_PROMPTS = ["看看这个项目的结构，告诉我入口在哪", "找到所有 TODO 并列出来", "给 @README.md 补一段快速开始", "跑一下测试看哪里挂了"];

/** 空态下输入框下方的建议提示（ChatGPT 的 suggestion chips） */
const FINISH_LABEL: Record<string, string> = {
  stop: "正常结束",
  tool_calls: "等待工具",
  length: "达到输出上限",
  abort: "已中断",
  error: "出错",
  policy: "被安全策略拦下",
  max_turns: "达到步数上限",
};

export function formatTurnUsage(u: TurnUsage): string {
  const parts: string[] = [];
  parts.push(u.totalTokens ? `本轮 ${u.totalTokens.toLocaleString()} tokens` : "本轮用量未返回");
  parts.push(u.durationMs >= 60_000 ? `${Math.floor(u.durationMs / 60_000)} 分 ${Math.round((u.durationMs % 60_000) / 1000)} 秒` : `${(u.durationMs / 1000).toFixed(1)} 秒`);
  parts.push(FINISH_LABEL[u.finishReason] || u.finishReason || "结束");
  if (u.retries) parts.push(`重试 ${u.retries} 次`);
  return parts.join(" · ");
}

function turnUsageTitle(u: TurnUsage): string {
  return `模型 ${u.model}（${u.provider}）\n输入 ${u.promptTokens} · 输出 ${u.completionTokens} · 合计 ${u.totalTokens} tokens`;
}

/** 一轮运行的步数 / 用时 / 思考耗时，界面内存态 */
export type RunMeta = {
  startedAt: number;
  endedAt?: number;
  step: number;
  maxSteps?: number;
  /** 已结束的思考段累计毫秒 */
  thinkMs: number;
  /** 正在思考的那段从何时开始 */
  thinkingSince?: number;
};

/** 纯函数：按流事件推进 RunMeta；没变化时原样返回 prev（避免每个 token 都重渲染） */
export function nextRunMeta(prev: RunMeta | undefined, ev: StreamEvent, now: number): RunMeta | undefined {
  if (ev.type === "status" && ev.phase === "start") return { startedAt: now, step: 0, thinkMs: 0 };
  const active = ev.type === "step" || ev.type === "thinking" || ev.type === "token" || ev.type === "tool_start";
  let m = prev;
  if (!m || m.endedAt !== undefined) {
    if (!active) return prev;
    m = { startedAt: now, step: 0, thinkMs: 0 };
  }
  const closeThinking = (x: RunMeta): RunMeta =>
    x.thinkingSince !== undefined ? { ...x, thinkMs: x.thinkMs + Math.max(0, now - x.thinkingSince), thinkingSince: undefined } : x;
  if (ev.type === "step") return { ...m, step: ev.index, maxSteps: ev.max };
  if (ev.type === "thinking") return m.thinkingSince !== undefined ? m : { ...m, thinkingSince: now };
  if (ev.type === "token" || ev.type === "tool_start") return closeThinking(m);
  if (ev.type === "finish" || ev.type === "done") return { ...closeThinking(m), endedAt: now };
  return m;
}

export function formatSecs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export function runMetaText(meta: RunMeta, busy: boolean, now: number): string {
  const parts: string[] = [];
  if (busy && meta.endedAt === undefined) {
    if (meta.step > 0) parts.push(`第 ${meta.step} 步`);
    parts.push(`已用时 ${formatSecs(now - meta.startedAt)}`);
    if (meta.thinkingSince !== undefined) parts.push(`思考中 ${formatSecs(meta.thinkMs + now - meta.thinkingSince)}`);
    else if (meta.thinkMs >= 1000) parts.push(`已思考 ${formatSecs(meta.thinkMs)}`);
  } else {
    if (meta.step > 0) parts.push(`共 ${meta.step} 步`);
    parts.push(`用时 ${formatSecs((meta.endedAt ?? now) - meta.startedAt)}`);
    if (meta.thinkMs >= 1000) parts.push(`思考了 ${formatSecs(meta.thinkMs)}`);
  }
  return parts.join(" · ");
}

function RunMetaLine({ meta, busy }: { meta: RunMeta; busy: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = busy && meta.endedAt === undefined;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return (
    <div className={`run-meta${ticking ? " live" : ""}`} role="status">
      {runMetaText(meta, busy, ticking ? now : (meta.endedAt ?? now))}
    </div>
  );
}

export function PromptChips({
  agentMode,
  desktopMode,
  downloadUrl,
  onPick,
}: {
  agentMode?: boolean;
  desktopMode?: boolean;
  downloadUrl?: string;
  onPick: (text: string) => void;
}) {
  const prompts = agentMode ? AGENT_PROMPTS : CHAT_PROMPTS;
  return (
    <div className="hero-chips-wrap">
      <div className="hero-chips">
        {prompts.map((p) => (
          <button key={p} type="button" className="chip" onClick={() => onPick(p)}>
            {p}
          </button>
        ))}
      </div>
      {!desktopMode ? <DesktopPromo downloadUrl={downloadUrl} /> : null}
    </div>
  );
}

export function ChatTranscript({
  desktopMode = false,
  agentMode = false,
  downloadUrl,
  workspaceName,
  messages,
  streaming,
  thinking,
  busy = false,
  tools,
  plan,
  usage,
  turnUsage,
  usageTotal,
  runMeta,
  onUndoLast,
  media,
  diffs,
  pendingCommands,
  pendingQuestions,
  pendingPlans,
  gitSetup,
  onCommandDone,
  onQuestionDone,
  onPlanDone,
  onGitSetupDone,
  onAlwaysAllowCommands,
  onRefreshDiffs,
  onRegenerate,
  onEditMessage,
  onRestoreMessage,
  onError,
}: {
  desktopMode?: boolean;
  agentMode?: boolean;
  downloadUrl?: string;
  workspaceName?: string;
  messages: Message[];
  streaming: string;
  thinking?: string;
  busy?: boolean;
  tools: LiveTool[];
  plan?: PlanState | null;
  usage?: number;
  /** 本会话最近一轮的用量记录 */
  turnUsage?: TurnUsage | null;
  /** 本会话累计 */
  usageTotal?: TurnUsageTotal | null;
  /** 本会话最近一轮的步数 / 用时 / 思考耗时（内存，不入库） */
  runMeta?: RunMeta | null;
  /** 撤销上一轮；不传就不显示按钮 */
  onUndoLast?: () => void;
  media: LiveMedia[];
  diffs: DiffRow[];
  pendingCommands?: PendingCommand[];
  pendingQuestions?: PendingQuestion[];
  pendingPlans?: PendingPlan[];
  gitSetup?: GitSetup | null;
  onCommandDone?: (id: string) => void;
  onQuestionDone?: (id: string) => void;
  onPlanDone?: (id: string) => void;
  onGitSetupDone?: () => void;
  onAlwaysAllowCommands?: (command: string) => Promise<void> | void;
  onRefreshDiffs?: () => void;
  onRegenerate?: () => void;
  onEditMessage?: (m: Message) => void;
  onRestoreMessage?: (m: Message) => void;
  onError?: (message: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [showApplied, setShowApplied] = useState(false);
  const [working, setWorking] = useState(false);

  // 用户往上翻时不要强行拽回底部，ChatGPT 也是这样：只在贴底时跟随
  useEffect(() => {
    if (atBottom && endRef.current?.offsetParent) endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming, thinking, busy, tools, media, diffs, plan, atBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  // 连续几轮工具调用（中间没有文字）并成一组，见 ToolGroup
  const blocks = useMemo(() => mergeStepRuns(groupTranscript(messages)), [messages]);
  const hasContent = blocks.length > 0 || Boolean(streaming) || busy;
  const pending = diffs.filter((d) => d.status === "pending");
  const applied = diffs.filter((d) => d.status === "applied");
  const lastAssistantId = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const b = blocks[i];
      if (b.kind === "message" && b.message.role === "assistant") return b.message.id;
    }
    return null;
  }, [blocks]);

  const act = async (fn: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await fn();
      onRefreshDiffs?.();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  if (!hasContent) {
    // ChatGPT / Codex 的空态：居中问候；输入框和建议提示由 App 按「标题 → 输入框 → 提示」顺序摆
    return (
      <div className="hero">
        <h1 className="hero-title">{agentMode ? "今天想改点什么？" : "有什么可以帮忙的？"}</h1>
        {agentMode && workspaceName ? (
          <p className="hero-sub">
            工作区 <b>{workspaceName}</b> · 会先读代码再动手
          </p>
        ) : !desktopMode ? (
          <p className="hero-sub">网页免费对话。Agent、读写本地文件在付费桌面版。</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      <div className="transcript-inner">
        {blocks.map((b, i) => {
          const ts = blockTime(b);
          const prev = i === 0 ? null : blockTime(blocks[i - 1]);
          const time = shouldShowChatTime(prev, ts) ? formatChatTime(ts) : null;
          const body =
            b.kind === "message" ? (
              <MessageBubble
                m={b.message}
                canRegenerate={!busy && b.message.id === lastAssistantId}
                onRegenerate={onRegenerate}
                onEdit={!busy ? onEditMessage : undefined}
                onRestore={agentMode && !busy ? onRestoreMessage : undefined}
                thinkSecs={!busy && b.message.id === lastAssistantId && runMeta?.endedAt !== undefined && runMeta.thinkMs >= 1000 ? Math.round(runMeta.thinkMs / 1000) : undefined}
              />
            ) : (
              <ToolGroup tools={b.tools} plan={b.plan} />
            );
          return (
            <Fragment key={b.kind === "message" ? b.message.id : b.id}>
              {time ? <div className="chat-time">{time}</div> : null}
              {body}
            </Fragment>
          );
        })}
        {plan ? <PlanCard steps={plan.steps} explanation={plan.explanation} /> : null}
        {tools.length ? <ToolGroup tools={tools} live /> : null}
        {(pendingCommands ?? []).map((cmd) => (
          <CommandCard
            key={cmd.id}
            cmd={cmd}
            onDone={() => onCommandDone?.(cmd.id)}
            onAlwaysAllow={onAlwaysAllowCommands ? () => onAlwaysAllowCommands(cmd.command) : undefined}
          />
        ))}
        {(pendingQuestions ?? []).map((item) => (
          <QuestionCard key={item.id} item={item} onDone={() => onQuestionDone?.(item.id)} />
        ))}
        {(pendingPlans ?? []).map((item) => (
          <PlanReviewCard key={item.id} item={item} onDone={() => onPlanDone?.(item.id)} />
        ))}
        {gitSetup ? <GitSetupCard setup={gitSetup} onDone={() => onGitSetupDone?.()} /> : null}
        {pending.length ? (
          <div className="diff-batch">
            <div className="diff-batch-head">
              <span>
                待确认的改动 <b>{pending.length}</b> 处
              </span>
              {pending.length > 1 ? (
                <span style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    disabled={working}
                    onClick={() =>
                      void act(async () => {
                        for (const d of pending) await applyDiff(d.id);
                      })
                    }
                  >
                    全部应用
                  </button>
                  <button
                    className="btn"
                    disabled={working}
                    onClick={() =>
                      void act(async () => {
                        for (const d of pending) await rejectDiff(d.id);
                      })
                    }
                  >
                    全部拒绝
                  </button>
                </span>
              ) : null}
            </div>
            {pending.map((d) => (
              <div key={d.id} className="diff-card">
                <div className="diff-head">
                  <span className="path">{d.path}</span>
                  <span style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-primary" disabled={working} onClick={() => void act(() => applyDiff(d.id))}>
                      应用
                    </button>
                    <button className="btn" disabled={working} onClick={() => void act(() => rejectDiff(d.id))}>
                      拒绝
                    </button>
                  </span>
                </div>
                <DiffView unified={d.unified} />
              </div>
            ))}
          </div>
        ) : null}
        {applied.length && desktopMode ? (
          <div className="diff-applied">
            <button type="button" className="diff-applied-toggle" onClick={() => setShowApplied((v) => !v)}>
              {showApplied ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              已应用 {applied.length} 处改动
            </button>
            {showApplied ? (
              <ul>
                {applied.map((d) => (
                  <li key={d.id}>
                    <span className="path">{d.path}</span>
                    <button className="btn" style={{ fontSize: 12 }} disabled={working} onClick={() => void act(() => revertDiff(d.id))}>
                      <Undo2 size={12} /> 撤销
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {media.map((m, i) => {
          const { src, fallbacks, name } = liveMediaSrc(m);
          if (!src) return null;
          return (
            <div key={i} className="chat-media-box">
              {m.kind === "image" ? (
                <MediaThumb src={src} fallbacks={fallbacks} name={name} className="chat-media" />
              ) : (
                <MediaVideo src={src} className="chat-media" style={{ width: "100%" }} />
              )}
              <div className="chat-media-acts">
                <DownloadButton src={src} name={name} />
              </div>
            </div>
          );
        })}
        {streaming || thinking || (busy && !tools.some((t) => t.result === undefined)) ? (
          <div className="msg assistant">
            <div className="msg-body assistant">
              <AssistantBody text={streaming} extraThinking={thinking} live />
            </div>
          </div>
        ) : null}
        {!busy && turnUsage ? (
          <div className="usage" title={turnUsageTitle(turnUsage)}>
            {formatTurnUsage(turnUsage)}
            {usageTotal && usageTotal.turns > 1 ? ` ｜ 本对话 ${usageTotal.turns} 轮共 ${usageTotal.totalTokens.toLocaleString()} tokens` : ""}
          </div>
        ) : !busy && usage ? (
          <div className="usage">本轮约 {usage.toLocaleString()} tokens</div>
        ) : null}
        {runMeta && (busy || runMeta.endedAt !== undefined) ? <RunMetaLine meta={runMeta} busy={busy} /> : null}
        {onUndoLast && messages.some((m) => m.role === "user") ? (
          <div className="round-actions">
            <button
              type="button"
              className="undo-round"
              disabled={busy}
              onClick={onUndoLast}
              title="删掉最后一条提问和之后的回复，原话放回输入框"
            >
              撤销上一轮
            </button>
            <span className="undo-note">文件改动不会撤销</span>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      {!atBottom ? (
        <button
          type="button"
          className="to-bottom"
          aria-label="回到底部"
          onClick={() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })}
        >
          <ArrowDown size={16} />
        </button>
      ) : null}
    </div>
  );
}

const MAX_PICS = 4;
const MAX_PIC_BYTES = 8 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

export type QueuedMessage = {
  id: string;
  text: string;
  attachments: ImageAttachment[];
};

function queuePreview(item: QueuedMessage): string {
  const text = item.text.trim();
  const n = item.attachments.length;
  if (text) return text;
  if (n === 1) return "1 张图片";
  if (n > 1) return `${n} 张图片`;
  return "（空消息）";
}

export function Composer({
  disabled,
  busy,
  placeholder,
  conversationId,
  files,
  draft,
  queued = [],
  agentMode = false,
  planMode = false,
  onPlanMode,
  models,
  model,
  onModel,
  workspaceRoot,
  onDraftConsumed,
  onSend,
  onQueue,
  onUnqueue,
  onParallel,
  onStop,
  onError,
  onLocalNotice,
  onClearConversation,
  onNewConversation,
  onModelForConversation,
  onCompactConversation,
  onUndoConversation,
  onGoalForConversation,
  truncated,
  interrupted,
  onContinue,
  imageSupport,
}: {
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  conversationId?: string;
  /** 工作区文件树，给 @ 补全用；不传就没有补全 */
  files?: FileNode[];
  /** 外部塞进来的草稿（编辑消息 / 点建议提示） */
  draft?: string;
  /** 当前对话还在生成时排上的后续消息 */
  queued?: QueuedMessage[];
  agentMode?: boolean;
  planMode?: boolean;
  onPlanMode?: (active: boolean) => void;
  /** 当前对话可换的模型；不传或只有一个就不显示选择器 */
  models?: Array<{ id: string; label: string }>;
  model?: string;
  onModel?: (id: string) => void;
  workspaceRoot?: string;
  onDraftConsumed?: () => void;
  onSend: (text: string, attachments: ImageAttachment[]) => void;
  onQueue?: (text: string, attachments: ImageAttachment[]) => void;
  onUnqueue?: (id: string) => void;
  onParallel?: () => void;
  onStop: () => void;
  onError?: (message: string) => void;
  /** 斜杠命令本地提示（不入库）；须带提交时的会话 id */
  onLocalNotice?: (conversationId: string, text: string) => void;
  /** /clear：按提交时的会话 id 新开同模式对话并删除旧的 */
  onClearConversation?: (conversationId: string) => void | Promise<void>;
  /** /new：新开同模式对话，保留当前这条 */
  onNewConversation?: (conversationId: string) => void | Promise<void>;
  /** /model set：按提交时的会话 id 切换模型（避免切会话后改错） */
  onModelForConversation?: (conversationId: string, modelId: string) => void | Promise<void>;
  /** /compact confirm：压缩提交时的会话 */
  onCompactConversation?: (conversationId: string) => void | Promise<void>;
  /** /undo：撤销提交时会话的上一轮 */
  onUndoConversation?: (conversationId: string) => void | Promise<void>;
  /** /goal：设定（空串 = 清除）提交时会话的目标 */
  onGoalForConversation?: (conversationId: string, goal: string) => void | Promise<void>;
  /** 上一轮回复因输出上限（finish=length）被截断 */
  truncated?: boolean;
  /** 上一轮被用户中断（finish=abort） */
  interrupted?: boolean;
  /** 点「继续」：让模型接着写 */
  onContinue?: () => void;
  /** 当前模型能不能看图：false = 不支持（拦下发送），null = 没查到 */
  imageSupport?: boolean | null;
}) {
  const [text, setText] = useState("");
  const [pics, setPics] = useState<ImageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [symbolHits, setSymbolHits] = useState<Array<{ name: string; path: string; line: number }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const allFiles = useMemo(() => (files ? flattenFiles(files) : []), [files]);

  useEffect(() => {
    if (draft === undefined) return;
    setText(draft);
    onDraftConsumed?.();
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(draft.length, draft.length);
    });
  }, [draft]);

  // 切会话时清空输入与斜杠弹层状态，避免命令 UI 串台
  useEffect(() => {
    setText("");
    setPics([]);
  }, [conversationId]);

  // 输入框一行起步，编辑时随内容长高到 5 行后内部滚动；失焦收回一行，内容不丢
  const grow = useAutoGrow(areaRef, text);

  type MentionHit = { key: string; insert: string; name: string; detail: string };

  const mentionToken = useMemo(() => {
    const el = areaRef.current;
    const cursor = el ? el.selectionStart : text.length;
    const before = text.slice(0, cursor);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (!m || !allFiles.length) return null;
    return { q: m[1], start: cursor - m[1].length - 1, end: cursor };
  }, [text, allFiles.length]);

  useEffect(() => {
    const q = mentionToken?.q ?? "";
    if (!mentionToken || !q || q.includes("/") || q.includes("\\")) {
      setSymbolHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void searchSymbols(q, conversationId)
        .then((res) => setSymbolHits(res.hits))
        .catch(() => setSymbolHits([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [mentionToken?.q, conversationId, mentionToken]);

  // 光标前最近的一个 "@xxx"（不含空格）就是正在补全的 token
  const mention = useMemo(() => {
    if (!mentionToken) return null;
    const q = mentionToken.q.toLowerCase();
    const fileHits: MentionHit[] = allFiles
      .filter((p) => !q || p.toLowerCase().includes(q))
      .sort((a, b) => {
        const an = a.split("/").pop()!.toLowerCase().startsWith(q) ? 0 : 1;
        const bn = b.split("/").pop()!.toLowerCase().startsWith(q) ? 0 : 1;
        return an - bn || a.length - b.length;
      })
      .slice(0, 8)
      .map((p) => ({ key: `f:${p}`, insert: p, name: p.split("/").pop() || p, detail: p }));
    const symbols: MentionHit[] =
      q && !q.includes("/")
        ? symbolHits.slice(0, 6).map((s) => ({
            key: `s:${s.path}:${s.line}:${s.name}`,
            insert: `${s.path}#${s.name}`,
            name: s.name,
            detail: `${s.path}:${s.line}`,
          }))
        : [];
    const hits = (q && !q.includes("/") ? [...symbols, ...fileHits] : fileHits).slice(0, 8);
    if (!hits.length) return null;
    return { start: mentionToken.start, end: mentionToken.end, hits };
  }, [mentionToken, allFiles, symbolHits]);

  useEffect(() => {
    setMentionIdx(0);
  }, [mention?.hits.map((hit) => hit.key).join("|")]);

  function pickMention(insert: string) {
    if (!mention) return;
    const next = `${text.slice(0, mention.start)}@${insert} ${text.slice(mention.end)}`;
    setText(next);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      const pos = mention.start + insert.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  async function addFiles(list: File[]) {
    const images = list.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    if (imageSupport === false) {
      onError?.("当前模型不支持图片输入，换一个支持图片的模型再加图");
      return;
    }
    const room = MAX_PICS - pics.length;
    if (room <= 0) {
      onError?.(`最多带 ${MAX_PICS} 张图`);
      return;
    }
    setUploading(true);
    try {
      for (const file of images.slice(0, room)) {
        if (file.size > MAX_PIC_BYTES) {
          onError?.(`${file.name || "图片"} 超过 8MB`);
          continue;
        }
        const dataUrl = await readAsDataUrl(file);
        const saved = await uploadImage(dataUrl, file.name || "粘贴的图片", conversationId);
        setPics((cur) => [
          ...cur,
          { type: "image", mediaId: saved.id, url: saved.url, name: file.name, preview: dataUrl },
        ]);
      }
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  const hasPayload = (text.trim().length > 0 || pics.length > 0) && !disabled && !uploading;
  const canSendNow = hasPayload && !busy;
  const canQueue = hasPayload && Boolean(busy) && Boolean(onQueue);
  const shownPlaceholder = busy && !disabled ? "接着说，这一轮结束后自动发出" : (placeholder ?? "给 Agnes 发消息");

  function takePayload(): { text: string; attachments: ImageAttachment[] } | null {
    const payload = text.trim();
    const attachments = pics.map(({ preview: _preview, ...rest }) => rest);
    if (!payload && !attachments.length) return null;
    return { text: payload, attachments };
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled || uploading) return;
        const payload = takePayload();
        if (!payload) return;
        // 提交瞬间锁定会话 id，避免 await 期间切走后命令作用到别的对话
        const submitConvId = conversationId || "";
        const slash = parseComposerCommand(payload.text);
        if (slash) {
          if (slash.kind === "plan") {
            if (!agentMode) {
              onLocalNotice?.(submitConvId, "计划模式仅在 Agent 对话中可用。");
              setText("");
              setPics([]);
              return;
            }
            onPlanMode?.(slash.active);
            if (!slash.message) {
              setText("");
              setPics([]);
              return;
            }
            payload.text = slash.message;
          } else if (slash.kind === "help" || slash.kind === "error" || slash.kind === "local") {
            onLocalNotice?.(submitConvId, slash.text);
            setText("");
            setPics([]);
            return;
          } else if (slash.kind === "mcp") {
            void (async () => {
              try {
                const st = await getMcpStatus();
                if (!st.servers.length) {
                  onLocalNotice?.(submitConvId, "尚未配置 MCP 服务器（mcp.json 为空或未加载）。");
                  return;
                }
                onLocalNotice?.(submitConvId, 
                  st.servers
                    .map((s) => {
                      const tools = typeof s.tools === "number" ? `，工具 ${s.tools} 个` : "";
                      const err = s.error ? `（${s.error}）` : "";
                      return `· ${s.name}：${s.status}${tools}${err}`;
                    })
                    .join("\n"),
                );
              } catch (err) {
                onLocalNotice?.(submitConvId, err instanceof Error ? err.message : String(err));
              }
            })();
            setText("");
            setPics([]);
            return;
          } else if (slash.kind === "status") {
            const modeLabel = agentMode ? "Agent" : "对话";
            const planLabel = planMode ? "开" : "关";
            const busyLabel = busy ? "进行中（running）" : "空闲";
            const modelLabel = (model || "").trim() || "未设置";
            const wsLabel = (workspaceRoot || "").trim() || "无工作区";
            onLocalNotice?.(submitConvId, 
              [`模式：${modeLabel}`, `计划模式：${planLabel}`, `状态：${busyLabel}`, `模型：${modelLabel}`, `工作区：${wsLabel}`].join(
                "\n",
              ),
            );
            setText("");
            setPics([]);
            return;
          } else if (slash.kind === "clear") {
            if (!submitConvId) {
              onLocalNotice?.(submitConvId, "没有当前对话可清空。");
              setText("");
              setPics([]);
              return;
            }
            void onClearConversation?.(submitConvId);
            setText("");
            setPics([]);
            return;
          } else if (slash.kind === "new") {
            if (!submitConvId) {
              onLocalNotice?.(submitConvId, "没有当前对话可新开。");
              setText("");
              setPics([]);
              return;
            }
            void onNewConversation?.(submitConvId);
            setText("");
            setPics([]);
            return;
          } else if (slash.kind === "model") {
            if (slash.action === "list") {
              const cur = (model || "").trim() || "未设置";
              const lines = ["当前模型：" + cur];
              if (models?.length) {
                lines.push("可用模型：");
                for (const m of models) {
                  const mark = m.id === (model || "").trim() ? "*" : "-";
                  lines.push(`${mark} ${m.id}${m.label && m.label !== m.id ? `  ${m.label}` : ""}`);
                }
                lines.push("切换：/model <模型id>");
              } else {
                lines.push("（暂无可用模型列表）");
              }
              onLocalNotice?.(submitConvId, lines.join("\n"));
              setText("");
              setPics([]);
              return;
            }
            if (busy) {
              onLocalNotice?.(submitConvId, "正在生成，先停止后再切换模型。");
              setText("");
              setPics([]);
              return;
            }
            if (!submitConvId) {
              onLocalNotice?.(submitConvId, "没有当前对话可切换模型。");
              setText("");
              setPics([]);
              return;
            }
            const want = slash.id.trim();
            const hit = models?.find((m) => m.id === want || m.label === want);
            if (!hit) {
              onLocalNotice?.(submitConvId, `未知模型「${want}」。输入 /model 查看可用列表。`);
              setText("");
              setPics([]);
              return;
            }
            void (onModelForConversation?.(submitConvId, hit.id) ?? onModel?.(hit.id));
            onLocalNotice?.(submitConvId, `已切换到模型 ${hit.label || hit.id}`);
            setText("");
            setPics([]);
            return;
          } else if (slash.kind === "undo") {
            setText("");
            setPics([]);
            if (busy) {
              onLocalNotice?.(submitConvId, "正在生成，先停止后再撤销。");
              return;
            }
            if (!submitConvId) {
              onLocalNotice?.(submitConvId, "没有当前对话可撤销。");
              return;
            }
            void onUndoConversation?.(submitConvId);
            return;
          } else if (slash.kind === "goal") {
            setText("");
            setPics([]);
            if (!submitConvId) {
              onLocalNotice?.(submitConvId, "没有当前对话可设定目标。");
              return;
            }
            void onGoalForConversation?.(submitConvId, slash.action === "set" ? slash.text : "");
            return;
          } else if (slash.kind === "compact") {
            if (busy) {
              onLocalNotice?.(submitConvId, "正在生成，先停止后再压缩上下文。");
              setText("");
              setPics([]);
              return;
            }
            if (!submitConvId) {
              onLocalNotice?.(submitConvId, "没有当前对话可压缩。");
              setText("");
              setPics([]);
              return;
            }
            if (slash.needsConfirm || !slash.confirm) {
              onLocalNotice?.(submitConvId, slash.text || "输入 /compact confirm 确认压缩。");
              setText("");
              setPics([]);
              return;
            }
            void onCompactConversation?.(submitConvId);
            setText("");
            setPics([]);
            return;
          }
        }
        // 模型不支持图片：拦下，不清空输入，让用户去掉图片或换模型
        if (payload.attachments.length && imageSupport === false) {
          onError?.("当前模型不支持图片输入，这条消息没有发出。请点「去掉图片」后再发，或换一个支持图片的模型。");
          return;
        }
        if (busy && onQueue) onQueue(payload.text, payload.attachments);
        else if (!busy) onSend(payload.text, payload.attachments);
        else return;
        setText("");
        setPics([]);
      }}
    >
      {(truncated || interrupted) && !busy && onContinue ? (
        <div className={truncated ? "truncate-card" : "interrupt-card"} role="status">
          <span>{truncated ? "回复达到模型单次输出上限，被截断了。" : "已中断。可以点继续接着做。"}</span>
          <button type="button" className={truncated ? "truncate-continue" : "interrupt-continue"} onClick={onContinue}>
            继续
          </button>
        </div>
      ) : null}
      {queued.length ? (
        <div className="queue-card">
          <div className="queue-head">
            <span>{queued.length} 条排队消息</span>
            <span className="queue-actions">
              {onParallel ? (
                <button type="button" className="queue-parallel" onClick={onParallel}>
                  并行处理
                </button>
              ) : null}
              {queued.length === 1 ? (
                <button
                  type="button"
                  className="queue-dismiss"
                  aria-label="移出队列"
                  onClick={() => onUnqueue?.(queued[0].id)}
                >
                  <X size={14} />
                </button>
              ) : null}
            </span>
          </div>
          {queued.map((item) => (
            <div key={item.id} className="queue-line">
              <span className="queue-text" title={queuePreview(item)}>
                {queuePreview(item)}
              </span>
              {queued.length > 1 ? (
                <button type="button" className="queue-dismiss" aria-label="移出队列" onClick={() => onUnqueue?.(item.id)}>
                  <X size={14} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="composer-box">
        {agentMode && planMode ? (
          <button type="button" className="plan-pill" onClick={() => onPlanMode?.(false)}>
            计划模式 · 点此退出
          </button>
        ) : null}
        {text.trim().startsWith("/") && !text.includes("\n") && SLASH_COMMANDS.some((item) => item.cmd.startsWith(text.trim()) || text.trim() === "/") ? (
          <ul className="slash-pop">
            {SLASH_COMMANDS.filter((item) => item.cmd.startsWith(text.trim()) || text.trim() === "/").map((item) => (
              <li key={item.cmd}>
                <button
                  type="button"
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    setText(item.insert);
                  }}
                >
                  <span className="mention-name">{item.cmd}</span>
                  <span className="mention-path">{item.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {mention ? (
          <ul className="mention-pop">
            {mention.hits.map((hit, i) => (
              <li key={hit.key}>
                <button
                  type="button"
                  className={i === mentionIdx ? "active" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(hit.insert);
                  }}
                >
                  <span className="mention-name">{hit.name}</span>
                  <span className="mention-path">{hit.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {pics.length && imageSupport === false ? (
          <div
            className="image-cap-card"
            role="alert"
            style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, padding: "6px 10px", marginBottom: 6, borderRadius: 8, background: "rgba(220, 38, 38, 0.08)", color: "#b91c1c" }}
          >
            <span>当前模型不支持图片输入，带图的消息发不出去。</span>
            <button type="button" className="btn image-cap-drop" onClick={() => setPics([])}>
              去掉图片
            </button>
          </div>
        ) : pics.length && imageSupport === null ? (
          <div className="hint image-cap-hint" style={{ fontSize: 12, marginBottom: 6 }}>
            没查到这个模型是否支持图片；发送失败的话，请去掉图片，或在设置里标注。
          </div>
        ) : null}
        {pics.length ? (
          <div className="composer-pics">
            {pics.map((p) => (
              <span key={p.mediaId} className="composer-pic">
                <img src={p.preview || p.url} alt={p.name || ""} />
                <button type="button" aria-label="移除" onClick={() => setPics((cur) => cur.filter((x) => x.mediaId !== p.mediaId))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="composer-row">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="icon-btn ghost"
            title={imageSupport === false ? "当前模型不支持图片输入" : "添加图片"}
            disabled={disabled || uploading || pics.length >= MAX_PICS || imageSupport === false}
            onClick={() => fileRef.current?.click()}
          >
            <Plus size={18} />
          </button>
          <textarea
            ref={areaRef}
            rows={1}
            placeholder={shownPlaceholder}
            value={text}
            disabled={disabled}
            onFocus={grow.onFocus}
            onBlur={grow.onBlur}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const list = [...e.clipboardData.files];
              if (list.some((f) => f.type.startsWith("image/"))) {
                e.preventDefault();
                void addFiles(list);
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const list = [...e.dataTransfer.files];
              if (list.some((f) => f.type.startsWith("image/"))) {
                e.preventDefault();
                void addFiles(list);
              }
            }}
            onKeyDown={(e) => {
              if (mention) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIdx((i) => (i + 1) % mention.hits.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIdx((i) => (i - 1 + mention.hits.length) % mention.hits.length);
                  return;
                }
                if (e.key === "Tab" || e.key === "Enter") {
                  e.preventDefault();
                  pickMention((mention.hits[mentionIdx] ?? mention.hits[0]).insert);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setText((t) => `${t} `);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {canQueue ? (
            <button type="submit" className="icon-btn send" title="排队，本轮结束后发送">
              <ArrowUp size={18} />
            </button>
          ) : null}
          {busy ? (
            <button type="button" className="icon-btn send stop" title="停止生成" onClick={onStop}>
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" disabled={!canSendNow} className="icon-btn send" title="发送（Enter）">
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-foot">
        {agentMode ? (
          <button type="button" className={`plan-toggle${planMode ? " is-on" : ""}`} onClick={() => onPlanMode?.(!planMode)}>
            {planMode ? "计划模式" : "计划"}
          </button>
        ) : (
          <span />
        )}
        {models && onModel && (models.length > 1 || (model && !models.some((m) => m.id === model))) ? (
          <select
            className="model-pick"
            aria-label="这个对话用的模型"
            title={busy ? "生成结束后才能换模型" : "这个对话用的模型"}
            value={model}
            disabled={busy}
            onChange={(e) => onModel(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        ) : null}
        <span>
          {agentMode ? "输入 /help 查看命令，/plan 先看方案。" : "输入 /help 查看命令。"}
          Agnes 也可能出错，重要信息请自行核实。
        </span>
      </div>
    </form>
  );
}

export function consumeStreamEvent(
  ev: StreamEvent,
  setStreaming: (fn: (s: string) => string) => void,
  setTools: (fn: (t: LiveTool[]) => LiveTool[]) => void,
  setMedia: (fn: (m: LiveMedia[]) => LiveMedia[]) => void,
  setTerminal: (fn: (s: string) => string) => void,
  setDiffs: (fn: (d: DiffRow[]) => DiffRow[]) => void,
  setThinking?: (fn: (s: string) => string) => void,
  setPlan?: (fn: (p: PlanState | null) => PlanState | null) => void,
  setUsage?: (fn: (n: number) => number) => void,
  setCommands?: (fn: (c: PendingCommand[]) => PendingCommand[]) => void,
  setGitSetup?: (g: GitSetup | null) => void,
  setQuestions?: (fn: (q: PendingQuestion[]) => PendingQuestion[]) => void,
  setPlanReviews?: (fn: (p: PendingPlan[]) => PendingPlan[]) => void,
) {
  if (ev.type === "token") setStreaming((s) => s + ev.text);
  if (ev.type === "thinking") setThinking?.((s) => s + ev.text);
  if (ev.type === "tool_start") {
    // update_plan 单独画成计划卡，不占一行步骤
    if (ev.name !== "update_plan" && ev.name !== "ask_user" && ev.name !== "present_plan") {
      setTools((list) => [...list, { id: ev.id, name: ev.name, args: ev.args, ...(ev.parent ? { parent: ev.parent } : {}) }]);
    }
  }
  if (ev.type === "tool_end") {
    setTools((list) => list.map((t) => (t.id === ev.id ? { ...t, result: ev.result, ok: ev.ok ?? true } : t)));
    // 命令跑完（或被拒）之后审批卡就该消失
    setCommands?.((list) => list.filter((c) => c.id !== ev.id && c.callId !== ev.id));
    setQuestions?.((list) => list.filter((q) => q.id !== ev.id && q.callId !== ev.id));
    setPlanReviews?.((list) => list.filter((p) => p.id !== ev.id && p.callId !== ev.id));
  }
  if (ev.type === "context") {
    setTools((list) => [
      ...list,
      {
        id: `context_${Date.now().toString(36)}`,
        name: "context_compact",
        args: { note: ev.note, before: ev.before, after: ev.after },
        result: ev.note,
        ok: true,
      },
    ]);
  }
  if (ev.type === "retry") {
    // 画成一条已完成的步骤卡：「网络波动，2 秒后第 1/3 次重试 · 原因」，不弄成红色错误
    setTools((list) => [
      ...list,
      {
        id: `retry_${Date.now().toString(36)}_${ev.attempt}`,
        name: "network_retry",
        args: { attempt: ev.attempt, max: ev.max, delayMs: ev.delayMs, reason: ev.reason },
        result: ev.reason,
        ok: true,
      },
    ]);
  }
  if (ev.type === "command") {
    setCommands?.((list) => [...list.filter((c) => c.id !== ev.id), { id: ev.id, callId: ev.callId, command: ev.command, cwd: ev.cwd }]);
  }
  if (ev.type === "question") {
    setQuestions?.((list) => [
      ...list.filter((q) => q.id !== ev.id),
      { id: ev.id, callId: ev.callId, question: ev.question, options: ev.options },
    ]);
  }
  if (ev.type === "plan_review") {
    setPlanReviews?.((list) => [...list.filter((p) => p.id !== ev.id), { id: ev.id, callId: ev.callId, plan: ev.plan }]);
  }
  if (ev.type === "git_setup") {
    setGitSetup?.({
      id: ev.id,
      reason: ev.reason,
      installCommand: ev.installCommand,
      hint: ev.hint,
      canAutoInstall: ev.canAutoInstall,
    });
  }
  if (ev.type === "plan") setPlan?.(() => ({ steps: ev.steps, explanation: ev.explanation }));
  if (ev.type === "token" || ev.type === "thinking" || ev.type === "tool_start" || ev.type === "usage") {
    // 重试之后上游又有输出：把「网络波动」卡标成已恢复
    const pending = (t: LiveTool) => t.name === "network_retry" && !(t.args as Record<string, unknown> | undefined)?.recovered;
    setTools((list) =>
      list.some(pending) ? list.map((t) => (pending(t) ? { ...t, args: { ...((t.args as Record<string, unknown>) || {}), recovered: true } } : t)) : list,
    );
  }
  if (ev.type === "usage") setUsage?.((n) => n + (ev.totalTokens || 0));
  if (ev.type === "media" && (ev.url || ev.status === "completed")) {
    setMedia((list) => [...list, { kind: ev.kind, url: ev.url, jobId: ev.jobId }]);
  }
  if (ev.type === "terminal") setTerminal((s) => s + ev.chunk);
  if (ev.type === "diff") {
    const row: DiffRow = {
      id: ev.diff.id,
      conversation_id: "",
      path: ev.diff.path,
      original: ev.diff.original,
      proposed: ev.diff.proposed,
      unified: ev.diff.unified,
      status: ev.status === "applied" ? "applied" : "pending",
      created_at: Date.now(),
    };
    setDiffs((list) => {
      const i = list.findIndex((d) => d.id === row.id);
      if (i < 0) return [row, ...list];
      const next = [...list];
      next[i] = { ...next[i], ...row };
      return next;
    });
  }
  if (ev.type === "error") setStreaming((s) => s + `\n\n**错误：** ${ev.message}`);
}

export type { LiveTool, LiveMedia, PlanState, PendingCommand, PendingQuestion, PendingPlan, GitSetup };
