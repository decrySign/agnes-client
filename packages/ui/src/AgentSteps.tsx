import { useState, type ReactNode } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  CircleHelp,
  Clapperboard,
  FileEdit,
  FilePlus,
  FileText,
  FolderTree,
  GitBranch,
  Image as ImageIcon,
  ListTodo,
  Loader2,
  NotebookPen,
  Search,
  Terminal,
  WifiOff,
  XCircle,
} from "lucide-react";
import type { Message, PlanStep } from "./types.js";
import { MarkdownBody } from "./MarkdownBody.js";
import { failureNote, GROUP_MIN, looksFailed, summarizeSteps } from "./step-groups.js";

export type StepTool = {
  id: string;
  name: string;
  args?: unknown;
  result?: string;
  /** undefined = 还在跑 */
  ok?: boolean;
  /** 子 Agent 的步骤：指向派它的 task 调用 id */
  parent?: string;
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function s(v: unknown, max = 80): string {
  const t = typeof v === "string" ? v : "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 把工具调用翻成一行人话，像 Cursor 的 "Read file · Searched codebase" */
export function describeTool(name: string, args: unknown, result?: string): { icon: ReactNode; title: string; meta?: string } {
  const a = rec(args);
  const path = s(a.path, 90);
  switch (name) {
    case "read_file": {
      const from = typeof a.offset === "number" ? a.offset : 1;
      const m = result ? /\((\d+) lines, showing (\d+)-(\d+)\)/.exec(result) : null;
      return {
        icon: <FileText size={13} />,
        title: `读取 ${path}`,
        meta: m ? `L${m[2]}–${m[3]} / 共 ${m[1]} 行` : from > 1 ? `从第 ${from} 行` : undefined,
      };
    }
    case "edit_file":
      return { icon: <FileEdit size={13} />, title: `编辑 ${path}`, meta: a.replace_all ? "替换全部" : undefined };
    case "write_file":
      return { icon: <FilePlus size={13} />, title: `写入 ${path}` };
    case "apply_patch":
      return { icon: <FileEdit size={13} />, title: `打补丁 ${path}` };
    case "grep": {
      const hits = result && result !== "无匹配" ? result.split("\n").filter(Boolean).length : 0;
      return {
        icon: <Search size={13} />,
        title: `搜索 "${s(a.query, 50)}"`,
        meta: result ? (hits ? `${hits} 处` : "无匹配") : undefined,
      };
    }
    case "glob": {
      const n = result && result !== "(none)" ? result.split("\n").filter(Boolean).length : 0;
      return { icon: <Search size={13} />, title: `查找 ${s(a.pattern, 60)}`, meta: result ? `${n} 个文件` : undefined };
    }
    case "list_dir":
      return { icon: <FolderTree size={13} />, title: `浏览 ${s(a.path, 60) || "."}` };
    case "run_terminal": {
      const bg = a.background === true;
      const code = result ? /^exit (-?\d+)/.exec(result)?.[1] : undefined;
      const tid = typeof result === "string" ? /terminal_id=([^\s]+)/.exec(result)?.[1] : undefined;
      return {
        icon: <Terminal size={13} />,
        title: bg
          ? `后台启动 ${s(a.command, 90) || "命令"}`
          : s(a.command, 110) || "运行命令",
        meta: bg ? (tid ? `id ${tid}` : "后台") : code !== undefined ? (code === "0" ? "退出 0" : `退出 ${code}`) : undefined,
      };
    }
    case "await_terminal":
      return {
        icon: <Terminal size={13} />,
        title: `等待终端 ${s(a.terminal_id, 40)}`,
        meta: result && /^exit /.test(result) ? "已结束" : result && /timed out/.test(result) ? "超时" : undefined,
      };
    case "read_terminal":
      return { icon: <Terminal size={13} />, title: `读取终端 ${s(a.terminal_id, 40)}` };
    case "stop_terminal":
      return { icon: <Terminal size={13} />, title: `停止终端 ${s(a.terminal_id, 40)}` };
    case "list_terminals":
      return { icon: <Terminal size={13} />, title: "后台终端列表" };
    case "generate_image":
      return { icon: <ImageIcon size={13} />, title: `生成图片：${s(a.prompt, 60)}` };
    case "generate_video":
      return { icon: <Clapperboard size={13} />, title: `生成视频：${s(a.prompt, 60)}` };
    case "read_skill":
      return { icon: <BookOpen size={13} />, title: `读取技能 ${s(a.name, 40)}`, meta: s(a.file, 40) || undefined };
    case "typecheck":
      return {
        icon: <Check size={13} />,
        title: "类型检查",
        meta: result ? (result.includes("没通过") || result.includes("超时") ? "未通过" : "通过") : undefined,
      };
    case "update_plan":
      return { icon: <ListTodo size={13} />, title: "更新计划" };
    case "ask_user": {
      const answer = result?.startsWith("用户回答：") ? result.slice("用户回答：".length) : "";
      return {
        icon: <CircleHelp size={13} />,
        title: `问你：${s(a.question, 80) || "一个选择"}`,
        meta: answer ? `答：${s(answer, 40)}` : result ? "没有回答" : undefined,
      };
    }
    case "present_plan": {
      const heading = typeof a.plan === "string" ? /^#+\s*(.+)$/m.exec(a.plan)?.[1] ?? "" : "";
      const meta = !result
        ? undefined
        : result.startsWith("用户批准")
          ? "已批准"
          : result.startsWith("用户还想改")
            ? "退回修改"
            : result.startsWith("用户没有确认")
              ? "未确认"
              : undefined;
      return { icon: <NotebookPen size={13} />, title: `方案：${s(heading, 70) || "待确认"}`, meta };
    }
    case "context_compact":
      return {
        icon: <FileText size={13} />,
        title: s(a.note, 80) || "已缩短发给模型的上下文",
        meta: typeof a.before === "number" && typeof a.after === "number" ? `${a.before} → ${a.after} 字` : undefined,
      };
    case "network_retry": {
      const attempt = typeof a.attempt === "number" ? a.attempt : 1;
      const max = typeof a.max === "number" ? a.max : 3;
      const secs = typeof a.delayMs === "number" ? Math.round(a.delayMs / 1000) : 1;
      if (a.recovered) return { icon: <WifiOff size={13} />, title: `网络波动，第 ${attempt}/${max} 次重试后已恢复`, meta: s(a.reason, 60) || undefined };
      return { icon: <WifiOff size={13} />, title: `网络波动，${secs} 秒后第 ${attempt}/${max} 次重试`, meta: s(a.reason, 60) || undefined };
    }
    case "git_checkpoint": {
      const action = s(a.action, 20);
      if (action === "init") return { icon: <GitBranch size={13} />, title: "已初始化 git 仓库" };
      if (action === "skip" || action === "missing") return { icon: <GitBranch size={13} />, title: "本轮不自动提交 git" };
      if (action === "ready") return { icon: <GitBranch size={13} />, title: "已找到 Git" };
      return { icon: <GitBranch size={13} />, title: path ? `已提交 git · ${path}` : "git 检查点" };
    }
    case "web_search": {
      const n = result ? result.split(/\r?\n/).filter((l) => /^\d+\. /.test(l)).length : 0;
      return { icon: <Search size={13} />, title: `联网搜索 "${s(a.query, 50)}"`, meta: result ? `${n} 条` : undefined };
    }
    case "web_fetch":
      return { icon: <FileText size={13} />, title: `读取网页 ${s(a.url, 80)}` };
    case "task":
      return { icon: <Circle size={13} />, title: `子 Agent：${s(a.description, 60) || "子任务"}`, meta: a.readonly === false ? "可写" : "只读" };
    default: {
      if (name.startsWith("mcp__")) {
        const rest = name.slice("mcp__".length);
        const cut = rest.indexOf("__");
        const server = cut > 0 ? rest.slice(0, cut) : rest;
        const tool = cut > 0 ? rest.slice(cut + 2) : "";
        return { icon: <Circle size={13} />, title: `MCP：${server}${tool ? " / " + tool : ""}` };
      }
      return { icon: <Circle size={13} />, title: name };
    }
  }
}

export function ToolStep({ tool, subSteps = [] }: { tool: StepTool; subSteps?: StepTool[] }) {
  const [open, setOpen] = useState(false);
  const running = tool.result === undefined;
  const failed = tool.ok === false;
  const d = describeTool(tool.name, tool.args, tool.result);
  if (subSteps.length) {
    const latest = subSteps[subSteps.length - 1]!;
    const now = running ? describeTool(latest.name, latest.args, latest.result).title : "";
    d.meta = `${d.meta ? `${d.meta} · ` : ""}${subSteps.length} 步${now ? ` · ${now}` : ""}`;
  }
  const detail = tool.result ?? "";
  // 失败要一眼看出来：标题旁一句原因；命令的退出码做成带红点的药丸（dsh 同款），描述保持中性
  const failNote = failed ? failureNote(tool.name, detail) : "";
  const exitPill = failed && tool.name === "run_terminal" && /^exit -?\d+/.test(detail);
  // 方案原文是 markdown，回放时按排版显示，不要塞进 JSON 参数里
  const planText = tool.name === "present_plan" ? rec(tool.args).plan : undefined;
  const argText = (() => {
    try {
      return JSON.stringify(tool.args, null, 2);
    } catch {
      return String(tool.args ?? "");
    }
  })();
  return (
    <div className={`step ${running ? "running" : failed ? "failed" : "done"}`}>
      <button type="button" className="step-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="step-status" role="img" aria-label={running ? "进行中" : failed ? "失败" : "完成"}>
          {running ? <Loader2 size={13} className="spin" /> : failed ? <XCircle size={13} /> : <Check size={13} />}
        </span>
        <span className="step-icon">{d.icon}</span>
        <span className="step-title">{d.title}</span>
        {failNote ? (
          <span className="step-fail" title={failNote}>
            {failNote}
          </span>
        ) : null}
        {d.meta ? <span className={exitPill ? "step-meta step-exit" : "step-meta"}>{d.meta}</span> : null}
        <span className="step-chev">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
      </button>
      {open ? (
        <div className="step-body">
          {subSteps.length ? (
            <div className="steps sub-steps" style={{ marginLeft: 12 }}>
              {subSteps.map((c) => (
                <ToolStep key={c.id} tool={c} />
              ))}
            </div>
          ) : null}
          {typeof planText === "string" ? (
            <div className="plan-review-body">
              <MarkdownBody text={planText} />
            </div>
          ) : argText && argText !== "{}" ? (
            <pre className="step-pre">
              <span className="step-label">参数</span>
              {argText.slice(0, 3000)}
            </pre>
          ) : null}
          {detail ? (
            <pre className="step-pre">
              <span className="step-label">结果</span>
              {detail.slice(0, 4000)}
              {detail.length > 4000 ? "\n…" : ""}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 一段连续的工具调用（中间没有文字）折成一组。参照 dsh 的过程分组：组头写数量、分类和失败数，
 * 跑的时候展开、显示当前这一步；跑完收起。组收起时里面卡片的开合状态跟着重置（dsh 同样在外层收起时重置）。
 * 只有 1 个工具时不加组头，照旧一张卡片。
 */
export function ToolGroup({ tools, plan, live = false }: { tools: StepTool[]; plan?: PlanStep[]; live?: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const sum = summarizeSteps(tools);
  const top = tools.filter((t) => !t.parent);
  const cards = top.map((t) => <ToolStep key={t.id} tool={t} subSteps={tools.filter((c) => c.parent === t.id)} />);
  const planCard = plan ? <PlanCard steps={plan} /> : null;
  if (sum.total < GROUP_MIN) {
    return (
      <div className={live ? "steps live" : "steps"}>
        {planCard}
        {cards}
      </div>
    );
  }
  const expanded = open ?? live;
  const latest = top[top.length - 1];
  const now = sum.running && latest ? describeTool(latest.name, latest.args, latest.result).title : "";
  return (
    <div className={`steps step-group${live ? " live" : ""}${sum.failed ? " has-failed" : ""}`}>
      {planCard}
      <button type="button" className="step-group-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <span className="step-chev">{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="step-group-title">{sum.running ? `正在执行第 ${sum.total} 个工具` : `执行了 ${sum.total} 个工具`}</span>
        <span className="step-meta step-group-meta">{now || sum.label}</span>
        {sum.failed ? (
          <span className="step-group-failed">
            <XCircle size={12} />
            {sum.failed} 个失败
          </span>
        ) : null}
      </button>
      {expanded ? <div className="step-group-body">{cards}</div> : null}
    </div>
  );
}

export function PlanCard({ steps, explanation }: { steps: PlanStep[]; explanation?: string }) {
  const done = steps.filter((x) => x.status === "completed").length;
  return (
    <div className="plan-card">
      <div className="plan-head">
        <ListTodo size={13} />
        <span>计划</span>
        <span className="plan-progress">
          {done}/{steps.length}
        </span>
      </div>
      {explanation ? <div className="plan-note">{explanation}</div> : null}
      <ul className="plan-list">
        {steps.map((st, i) => (
          <li key={i} className={`plan-item ${st.status}`}>
            {st.status === "completed" ? (
              <Check size={13} />
            ) : st.status === "in_progress" ? (
              <CircleDot size={13} />
            ) : (
              <Circle size={13} />
            )}
            <span>{st.step}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ToolCallRow = { id: string; function: { name: string; arguments: string } };

export type TranscriptBlock =
  | { kind: "message"; message: Message }
  | { kind: "steps"; id: string; at: number; tools: StepTool[]; plan?: PlanStep[] };

/**
 * 把库里的消息流整理成可渲染的块：user/assistant 文本原样，assistant.tool_calls 加上紧随的
 * tool 结果合成一组步骤卡。这样重开对话也能看到 Agent 当时做了什么，而不是只剩最后一句。
 */
export function groupTranscript(messages: Message[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const results = new Map<string, string>();
  const nestedByParent = new Map<string, StepTool[]>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      results.set(m.tool_call_id, m.content || "");
      if (m.attachments) {
        try {
          const meta = JSON.parse(m.attachments) as { sub_steps?: StepTool[] };
          if (Array.isArray(meta.sub_steps) && meta.sub_steps.length) {
            nestedByParent.set(
              m.tool_call_id,
              meta.sub_steps.map((st) => ({
                ...st,
                parent: st.parent || m.tool_call_id!,
              })),
            );
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  for (const m of messages) {
    if (m.role === "tool" || m.role === "system") continue;
    if (m.role === "notice") {
      blocks.push({ kind: "message", message: m });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls) {
      let calls: ToolCallRow[] = [];
      try {
        calls = JSON.parse(m.tool_calls) as ToolCallRow[];
      } catch {
        calls = [];
      }
      if (m.content?.trim()) blocks.push({ kind: "message", message: { ...m, tool_calls: null } });
      if (calls.length) {
        let plan: PlanStep[] | undefined;
        const tools: StepTool[] = [];
        for (const call of calls) {
          let args: unknown = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            args = call.function.arguments;
          }
          const result = results.get(call.id);
          if (call.function.name === "update_plan") {
            const raw = rec(args).plan;
            if (Array.isArray(raw)) {
              plan = raw
                .map((x) => rec(x))
                .filter((x) => typeof x.step === "string")
                .map((x) => ({
                  step: String(x.step),
                  status: (x.status as PlanStep["status"]) || "pending",
                }));
            }
            continue;
          }
          tools.push({
            id: call.id,
            name: call.function.name,
            args,
            result: result ?? "",
            ok: result === undefined ? undefined : !looksFailed(call.function.name, result),
          });
          const kids = nestedByParent.get(call.id);
          if (kids?.length) tools.push(...kids);
        }
        if (tools.length || plan) blocks.push({ kind: "steps", id: m.id, at: m.created_at, tools, plan });
      }
      continue;
    }
    if (m.role === "user" || m.role === "assistant") blocks.push({ kind: "message", message: m });
  }
  // 计划是原地更新的（Codex 也这样），回放时只在最后一次更新的位置画最终状态，
  // 中间那些 1/3、2/3 的快照不重复出现；每个用户提问之后各自算一轮
  let lastPlanIdx = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b.kind === "message" && b.message.role === "user") lastPlanIdx = -1;
    if (b.kind === "steps" && b.plan) {
      if (lastPlanIdx >= 0) (blocks[lastPlanIdx] as { plan?: PlanStep[] }).plan = undefined;
      lastPlanIdx = i;
    }
  }
  return blocks.filter((b) => b.kind === "message" || b.tools.length || b.plan);
}

// looksFailed 挪到 step-groups.ts（纯函数，自测和 agent 的 toolResultFailed 对照）
