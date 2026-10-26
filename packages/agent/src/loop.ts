import {
  AgnesApiError,
  isContextOverflowError,
  isUpstreamTimeoutError,
  parseUpstreamError,
  upstreamErrorLog,
  type AgnesClient,
  type ChatMessage,
  type ChatToolCall,
} from "@agnes/sdk";
import { ensureToolCallArguments } from "@agnes/sdk";
import { selectTools, executeTool, toolResultFailed, PARALLEL_SAFE_TOOLS } from "./tools.js";
import { skillsPromptSection, type SkillMeta } from "./skills.js";
import { agentSystem, CHAT_SYSTEM, PLAN_POLICY, createIntroStripper, withPersona, withSkills } from "./prompts.js";
import { disallowedReason, REFUSAL_TEXT } from "./safety.js";
import { withGoal } from "./goal.js";
import { CANCELLED_TOOL_RESULT, compactBudget, compactForModel, messageChars, planModelSummary, repairToolPairs, type SummaryCache } from "./context.js";
import { estimateInputTokens, requestLimits, stripImagesForModel, type ModelCaps } from "./model-caps.js";
import { Workspace } from "./workspace.js";
import { typecheckCommand, runTypecheck } from "./verify.js";
import type { AgentEvent, ToolRuntime } from "./types.js";
import type { ChatToolDefinition } from "@agnes/sdk";

export type RunAgentParams = {
  agnes: AgnesClient;
  model: string;
  mode: "chat" | "agent";
  history: ChatMessage[];
  workspace: Workspace;
  runtime: ToolRuntime;
  imageModel: string;
  videoModel: string;
  persona?: { name: string; body: string } | null;
  /** 当前工作区扫到的技能，空数组表示不挂 read_skill */
  skills?: SkillMeta[];
  /** 项目速览（技术栈 / git / 目录树 / 符号），只在 agent 模式注入 */
  projectContext?: string;
  /** AGENTS.md，始终注入，和按需读取的技能分开 */
  projectRules?: string;
  /** 用户给这条对话设的目标，每轮注入系统提示 */
  goal?: string;
  /** 上一轮已经归纳过的旧对话。条数没涨多少就复用，避免每轮都再打一次模型 */
  summaryCache?: SummaryCache | null;
  /** 自定义模型走这里。图像和视频工具仍用 agnes */
  chatClient?: ChatStreamer;
  /** 这个模型的能力（窗口 / 输出上限 / 图片 / 思考档位）。不传就和以前一样不带输出上限 */
  caps?: ModelCaps;
  summarize?: (prompt: string) => Promise<string>;
  onSummaryCache?: (cache: SummaryCache) => void;
  maxTurns?: number;
  /** 子 Agent 深度：0 是主 Agent，子 Agent 不能再派子 Agent */
  depth?: number;
};

/** 只要求流式对话这一个能力，自定义 provider（OpenAI / Responses / Anthropic）都实现它 */
export type ChatStreamer = {
  chatCompletionsStream: (
    body: Parameters<AgnesClient["chatCompletionsStream"]>[0],
    opts?: Pick<NonNullable<Parameters<AgnesClient["chatCompletionsStream"]>[1]>, "signal" | "onRetry">,
  ) => ReturnType<AgnesClient["chatCompletionsStream"]>;
};

/** upstreamFailed：整轮一个上游事件都没收到就失败了，宿主据此退还对话额度 */
/** UI replay: nested tool steps under a parent call (e.g. task). Not sent to the model. */
export type NestedToolStep = {
  id: string;
  name: string;
  args?: unknown;
  result?: string;
  ok?: boolean;
  parent?: string;
};

export type RunAgentResult = {
  assistant: ChatMessage;
  extra: ChatMessage[];
  upstreamFailed?: boolean;
  /** parent tool_call_id → child steps for transcript persistence */
  nestedSteps?: Record<string, NestedToolStep[]>;
};

type ToolAcc = { id: string; name: string; arguments: string };

function freshCallId(turn: number, index: number, used: Set<string>): string {
  const base = `call_${Date.now().toString(36)}_${turn}_${index}`;
  let id = base;
  for (let n = 1; used.has(id); n++) id = `${base}_${n}`;
  return id;
}

function applyToolDelta(acc: Map<number, ToolAcc>, index: number, id?: string, name?: string, args?: string): void {
  const current = acc.get(index) ?? { id: "", name: "", arguments: "" };
  if (id) current.id = id;
  if (name) current.name = name;
  if (args !== undefined && args !== "") current.arguments += args;
  acc.set(index, current);
}

/** 上游报超长 / 首包超时后压缩重试：每轮最多一次，整次运行最多这么多次（dsh 的 maxOverflowRetries 默认也是 1 次） */
const MAX_COMPACT_RETRIES = 2;
/** 首包超时只在请求够大时才压缩重试；小请求超时和上下文无关，压了也没用 */
const TIMEOUT_COMPACT_MIN_TOKENS = 16_000;

const TRUNCATED_TOOL_ARGS =
  "工具失败：arguments 不是合法 JSON（可能被截断）。请重新完整输出这次 function call。";

/**
 * 上游报上下文超长、压缩也帮不上（压不动或已经压缩重试过）时给界面的话：
 * - 对话里只有当前这一轮（history 里只有这一条用户消息），发出去的最后一条就是它（后面没有工具往返）：
 *   说清是这条消息本身太长，后面附上游原文；
 * - 其余情况：说明已经自动压缩重试过几次，可以 /compact 或开新对话。
 *   （压缩重试后更早的轮次会收成 system 摘录，所以不能只数发出去的那份里有几条用户消息）
 */
export function overflowMessage(err: unknown, base: string, history: ChatMessage[], outgoing: ChatMessage[], compactRetries: number): string {
  const upstream =
    err instanceof AgnesApiError
      ? parseUpstreamError(err.body).message || err.body.trim().slice(0, 500) || base
      : err instanceof Error
        ? err.message
        : String(err);
  const users = history.filter((m) => m.role === "user").length;
  if (users === 1 && outgoing.length > 0 && outgoing[outgoing.length - 1].role === "user") {
    return `当前这条消息本身已超过模型上下文窗口，请缩短或分段发送。上游原文：${upstream}`;
  }
  const tried = compactRetries > 0 ? `已自动压缩重试 ${compactRetries} 次仍超长，` : "再压缩也帮不上，";
  return `${base}。${tried}可以用 /compact 压缩这条对话，或开一个新对话。上游原文：${upstream}`;
}

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const { agnes, model, mode, workspace, runtime, imageModel, videoModel, persona } = params;
  const talk = params.chatClient ?? agnes;
  // 一个中等任务（探索 + 改 3 个文件 + 跑测试）轻松超过 20 轮，Cursor/Codex 都在 50+
  const maxTurns = params.maxTurns ?? (mode === "agent" ? 60 : 12);
  const extra: ChatMessage[] = [];
  const nestedSteps: Record<string, NestedToolStep[]> = {};
  let lastAssistant: ChatMessage = { role: "assistant", content: "" };
  const lastUser = [...params.history].reverse().find((m) => m.role === "user");
  const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : "";
  if (disallowedReason(lastUserText, "chat")) {
    lastAssistant = { role: "assistant", content: REFUSAL_TEXT };
    extra.push(lastAssistant);
    runtime.emit({ type: "token", text: REFUSAL_TEXT });
    runtime.emit({ type: "finish", reason: "policy" });
    return { assistant: lastAssistant, extra, nestedSteps: Object.keys(nestedSteps).length ? nestedSteps : undefined };
  }
  const skills = params.skills ?? [];
  const systemForTurn = (): ChatMessage => {
    const base = mode === "agent" ? agentSystem(workspace.root, params.projectContext ?? "", params.projectRules ?? "") : CHAT_SYSTEM;
    const guided = mode === "agent" && runtime.planMode ? `${base}\n\n${PLAN_POLICY}` : base;
    return {
      role: "system",
      content: withGoal(withPersona(withSkills(guided, skillsPromptSection(skills)), persona), params.goal),
    };
  };
  // 不支持图片的模型：历史里的图换成一行说明，不然整轮都会被上游拒掉
  const history = params.caps?.supportsImages === false ? stripImagesForModel(params.history) : params.history;
  const messages: ChatMessage[] = [systemForTurn(), ...history];
  const tools = selectTools(mode, {
    allowTerminal: runtime.allowTerminal,
    allowWrites: runtime.allowWrites,
    allowImage: runtime.allowImage,
    allowVideo: runtime.allowVideo,
    hasSkills: skills.length > 0,
    // Sub-agents inherit runtime.mcp, so they see the same MCP tools
    mcpTools: runtime.mcp?.toolDefinitions() ?? [],
  });
  const depth = params.depth ?? 0;
  if (mode === "agent" && depth === 0) tools.push(TASK_TOOL);
  // 子 Agent 没法和用户对话，也不该改主 Agent 的计划
  if (depth > 0) {
    for (let i = tools.length - 1; i >= 0; i--) {
      if (SUBAGENT_BLOCKED.has(tools[i]!.function.name)) tools.splice(i, 1);
    }
  }

  // 压缩预算：设置里配了压缩阈值就按 token 估，没配和以前一样按字数。上游报超长 / 首包超时后减半，本次运行后面都用减半后的
  const plan0 = compactBudget(params.caps, tools.length ? estimateInputTokens([], tools) : 0);
  const compactOptions = plan0.options;
  const measure = compactOptions.measure ?? ((list: ChatMessage[]) => list.reduce((sum, message) => sum + messageChars(message), 0));
  let budget = plan0.budget;
  let compactRetries = 0;
  let retryPending = false;
  // 交给模型归纳的原文上限：小窗口模型按窗口的 1/4 收
  const maxPromptChars = params.caps ? Math.min(12_000, Math.floor(params.caps.contextWindow / 4)) : undefined;
  let finished = false;
  let announcedContext = false;
  let summaryCache = params.summaryCache ?? null;
  let summaries = 0;
  let dirtyWrites = false;
  let typecheckDone = false;
  let gotUpstream = false;
  // 上游给的 id 可能缺省，也可能和历史里的重复（有的兼容网关每轮都从 call_0 数起）
  const usedCallIds = new Set<string>();
  for (const message of params.history) for (const call of message.tool_calls ?? []) usedCallIds.add(call.id);
  for (let turn = 0; turn < maxTurns; turn++) {
    if (runtime.signal?.aborted) {
      runtime.emit({ type: "finish", reason: "abort" });
      finished = true;
      break;
    }
    messages[0] = systemForTurn();
    // 界面显示「第 N 步」：只有主 Agent 报，子 Agent 的轮次不往上冒
    if (depth === 0) runtime.emit({ type: "step", index: turn + 1, max: maxTurns });
    const stripper = createIntroStripper(messages.some((m) => m.role === "assistant"));
    const toolAcc = new Map<number, ToolAcc>();
    let content = "";
    let finish: string | null = null;
    let turnUpstream = false;
    const isCompactRetry = retryPending;
    retryPending = false;

    const preview = compactForModel(messages, budget, undefined, compactOptions);
    let digest: string | undefined;
    if (preview.stats.summarizedTurns > 0) {
      const plan = planModelSummary(messages, budget, { ...compactOptions, previous: summaryCache, maxPromptChars });
      const reusable =
        plan && summaryCache && plan.count >= summaryCache.count && plan.count - summaryCache.count < 12
          ? summaryCache.text
          : "";
      if (reusable) digest = reusable;
      else if (plan && params.summarize && summaries < 2) {
        try {
          const text = (await params.summarize(plan.prompt)).trim().slice(0, 4000);
          // 摘录不比原文短就不用（dsh 也是这么做的），改走机械摘录
          if (text && text.length < plan.sourceChars) {
            summaries += 1;
            digest = text;
            summaryCache = { count: plan.count, text };
            await params.onSummaryCache?.(summaryCache);
          }
        } catch (err) {
          if (runtime.signal?.aborted || isAbortError(err)) {
            runtime.emit({ type: "finish", reason: "abort" });
            return { assistant: lastAssistant, extra, nestedSteps: Object.keys(nestedSteps).length ? nestedSteps : undefined };
          }
          console.info("[chat] 上下文摘录失败，改用截断", err instanceof Error ? err.message : err);
        }
      }
    }
    const packed = digest ? compactForModel(messages, budget, digest, compactOptions) : preview;
    if (packed.stats.changed && !announcedContext) {
      announcedContext = true;
      console.info(
        `[chat] 上下文压缩 ${packed.stats.before}→${packed.stats.after} 字，省略工具结果 ${packed.stats.stubbedTools} 条，摘录 ${packed.stats.summarizedTurns} 轮（界面历史未删）`,
      );
      runtime.emit({
        type: "context",
        before: packed.stats.before,
        after: packed.stats.after,
        note: packed.stats.summarizedTurns
          ? "更早的对话已收成摘录发给模型，界面里的完整记录还在"
          : "较早的工具输出不再整段发给模型，这条对话的记录还在",
      });
    }
    const outgoing = repairToolPairs(packed.messages);
    // 输出上限 = min(maxTokens, 窗口 − 估算输入 − 4096)，并带上设置里选的思考档位
    const limits = requestLimits(params.caps, outgoing, tools.length ? tools : undefined);
    try {
      for await (const event of talk.chatCompletionsStream(
        {
          model,
          messages: outgoing,
          ...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
          ...limits,
        },
        {
          signal: runtime.signal,
          // 连接被重置 / 超时这类瞬时故障自动重试，别让一次网络抖动把整轮 Agent 打成「请求失败」
          onRetry: (info) => runtime.emit({ type: "retry", ...info }),
        },
      )) {
        if (runtime.signal?.aborted) break;
        gotUpstream = true;
        turnUpstream = true;
        if (event.type === "thinking") {
          await Promise.resolve(runtime.emit({ type: "thinking", text: event.text }));
        } else if (event.type === "content") {
          const visible = stripper.push(event.text);
          content += visible;
          if (visible) await Promise.resolve(runtime.emit({ type: "token", text: visible }));
        } else if (event.type === "tool_call_delta") {
          applyToolDelta(toolAcc, event.index, event.id, event.name, event.arguments);
        } else if (event.type === "usage") {
          runtime.emit({
            type: "usage",
            promptTokens: event.promptTokens ?? 0,
            completionTokens: event.completionTokens ?? 0,
            totalTokens: event.totalTokens ?? (event.promptTokens ?? 0) + (event.completionTokens ?? 0),
          });
        } else if (event.type === "finish") {
          // 上游先给 finish_reason: "tool_calls"，紧接着再发 [DONE]（SDK 译成 "stop"）。
          // 只认第一个，否则 finish 被盖成 stop，下面就把模型要的工具调用整个跳过了。
          if (finish === null) finish = event.reason;
        }
      }
      const tail = stripper.flush();
      if (tail) {
        content += tail;
        await Promise.resolve(runtime.emit({ type: "token", text: tail }));
      }
    } catch (err) {
      if (runtime.signal?.aborted || isAbortError(err)) {
        if (content) {
          lastAssistant = { role: "assistant", content };
          extra.push(lastAssistant);
        }
        runtime.emit({ type: "finish", reason: "abort" });
        return { assistant: lastAssistant, extra, nestedSteps: Object.keys(nestedSteps).length ? nestedSteps : undefined };
      }
      // 上游明确说上下文超长，或者大请求一个字都没回就超时：把发给模型那份再压一半，自动重试一次。
      // 只在这一轮上游一个事件都没给、没出字也没工具调用时做，界面不会重复出字；压不动（压完不比原来小）就照常报错
      const overflow = isContextOverflowError(err);
      const timedOut = !overflow && isUpstreamTimeoutError(err);
      if ((overflow || timedOut) && !isCompactRetry && !turnUpstream && !content && toolAcc.size === 0 && compactRetries < MAX_COMPACT_RETRIES) {
        const sentSize = measure(outgoing);
        const bigEnough = overflow || estimateInputTokens(outgoing, tools.length ? tools : undefined) >= TIMEOUT_COMPACT_MIN_TOKENS;
        const halved = Math.floor(Math.min(budget, sentSize) / 2);
        const trial = bigEnough ? compactForModel(messages, halved, digest, compactOptions) : null;
        if (trial && measure(trial.messages) < sentSize) {
          budget = halved;
          compactRetries += 1;
          retryPending = true;
          console.info(
            `[chat] ${overflow ? "上游报上下文超长" : "上游首包超时"}，压缩后重试 ${sentSize}→${measure(trial.messages)}（${plan0.unit === "tokens" ? "估算 token" : "字"}） ${upstreamErrorLog(err)}`,
          );
          runtime.emit({
            type: "context",
            before: trial.stats.before,
            after: trial.stats.after,
            note: overflow
              ? "上游说上下文太长，已把发给模型的上下文再压缩一次，正在自动重试；界面里的完整记录还在"
              : "上游迟迟没有开始回复，已把发给模型的上下文再压缩一次，正在自动重试；界面里的完整记录还在",
          });
          turn -= 1;
          continue;
        }
      }
      const sentChars = packed.messages.reduce((sum, message) => sum + messageChars(message), 0);
      console.error(
        `[chat] 上游失败 ${upstreamErrorLog(err)} promptChars=${sentChars} messages=${packed.messages.length}`,
      );
      let message = err instanceof AgnesApiError ? err.message : err instanceof Error ? err.message : String(err);
      if (overflow) message = overflowMessage(err, message, messages, outgoing, compactRetries);
      runtime.emit({ type: "error", message });
      lastAssistant = { role: "assistant", content: content || `请求失败：${message}` };
      extra.push(lastAssistant);
      runtime.emit({ type: "finish", reason: "error" });
      return { assistant: lastAssistant, extra, nestedSteps: Object.keys(nestedSteps).length ? nestedSteps : undefined, upstreamFailed: !gotUpstream };
    }

    if (runtime.signal?.aborted) {
      if (content) {
        lastAssistant = { role: "assistant", content };
        extra.push(lastAssistant);
      }
      runtime.emit({ type: "finish", reason: "abort" });
      finished = true;
      break;
    }

    const argOk = new Map<string, boolean>();
    const toolCalls: ChatToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t], i) => {
        const id = t.id && !usedCallIds.has(t.id) ? t.id : freshCallId(turn, i, usedCallIds);
        usedCallIds.add(id);
        const ensured = ensureToolCallArguments(t.arguments || "{}");
        argOk.set(id, ensured.valid);
        return {
          id,
          type: "function" as const,
          function: { name: t.name, arguments: ensured.json },
        };
      })
      .filter((t) => t.function.name);

    lastAssistant = {
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
    messages.push(lastAssistant);
    extra.push(lastAssistant);

    if (!toolCalls.length) {
      if (mode === "agent" && dirtyWrites && !typecheckDone && !runtime.signal?.aborted) {
        typecheckDone = true;
        dirtyWrites = false;
        const spec = typecheckCommand(workspace.root);
        if (spec) {
          // 同一对话里每轮都从 turn 0 数起，typecheck_1 会和上一轮的撞号
          const checkId = usedCallIds.has(`typecheck_${turn}`) ? freshCallId(turn, toolAcc.size, usedCallIds) : `typecheck_${turn}`;
          usedCallIds.add(checkId);
          runtime.emit({ type: "tool_start", id: checkId, name: "typecheck", args: { command: spec.label } });
          const checked = await runTypecheck(workspace.root, spec.command, 90_000, runtime.signal);
          const text = checked.ok
            ? `类型检查通过（${spec.label}）`
            : `类型检查没通过（${spec.label}）。请只修这些错误，不要扩大改动。\n${checked.tail}`;
          runtime.emit({
            type: "tool_end",
            id: checkId,
            name: "typecheck",
            result: text.slice(0, 8000),
            ok: checked.ok,
          });
          const checkCall: ChatToolCall = {
            id: checkId,
            type: "function",
            function: { name: "typecheck", arguments: JSON.stringify({ command: spec.label }) },
          };
          const checkAssistant: ChatMessage = { role: "assistant", content: null, tool_calls: [checkCall] };
          const checkTool: ChatMessage = { role: "tool", tool_call_id: checkId, content: text.slice(0, 8000) };
          messages.push(checkAssistant, checkTool);
          extra.push(checkAssistant, checkTool);
          if (!checked.ok && !runtime.signal?.aborted) continue;
        }
      }
      runtime.emit({ type: "finish", reason: finish || "stop" });
      finished = true;
      break;
    }

    const runCall = async (call: ChatToolCall): Promise<string> =>
      argOk.get(call.id) && call.function.name === "task" && depth === 0
        ? (async () => {
            const out = await runSubAgent(params, call.id, call.function.arguments);
            if (out.steps.length) nestedSteps[call.id] = out.steps;
            return out.text;
          })()
        : argOk.get(call.id)
        ? executeTool(
            call.function.name,
            call.function.arguments,
            workspace,
            runtime,
            agnes,
            { image: imageModel, video: videoModel },
            call.id,
            skills,
          )
        : Promise.resolve(TRUNCATED_TOOL_ARGS);
    const answered = new Set<string>();
    for (let i = 0; i < toolCalls.length; ) {
      if (runtime.signal?.aborted) break;
      // 连着的只读工具（读文件 / 搜索 / 列目录）一起跑；写入、命令、提问仍一个一个来
      let j = i + 1;
      const parallelOk = (c: ChatToolCall) => argOk.get(c.id) && (PARALLEL_SAFE_TOOLS.has(c.function.name) || isReadonlyTask(c));
      if (parallelOk(toolCalls[i]!)) {
        while (j < toolCalls.length && parallelOk(toolCalls[j]!)) j++;
      }
      const batch = toolCalls.slice(i, j);
      i = j;
      for (const call of batch) {
        runtime.emit({ type: "tool_start", id: call.id, name: call.function.name, args: safeJson(call.function.arguments) });
      }
      const results = await Promise.all(batch.map(runCall));
      batch.forEach((call, k) => {
        const result = results[k]!;
        runtime.emit({
          type: "tool_end",
          id: call.id,
          name: call.function.name,
          result: result.slice(0, 8000),
          ok: !toolResultFailed(call.function.name, result),
        });
        const toolMsg: ChatMessage = {
          role: "tool",
          tool_call_id: call.id,
          content: result.slice(0, 24_000),
        };
        answered.add(call.id);
        messages.push(toolMsg);
        extra.push(toolMsg);
        if (call.function.name === "task" && !isReadonlyTask(call) && !toolResultFailed("task", result) && !/^调用失败/.test(result)) dirtyWrites = true;
        if (
          (call.function.name === "edit_file" || call.function.name === "write_file" || call.function.name === "apply_patch") &&
          /已写入|用户已应用/.test(result) &&
          !toolResultFailed(call.function.name, result)
        ) {
          dirtyWrites = true;
        }
      });
    }
    // 中途停止：没跑到的调用也要有结果，否则历史里 tool_calls 落单，下一条消息上游直接 400
    for (const call of toolCalls) {
      if (answered.has(call.id)) continue;
      const toolMsg: ChatMessage = { role: "tool", tool_call_id: call.id, content: CANCELLED_TOOL_RESULT };
      messages.push(toolMsg);
      extra.push(toolMsg);
    }
  }

  if (!finished) {
    // 步数用完还在调工具：明确收尾，别让界面等一个永远不来的 finish，历史也别以 tool 消息结尾
    const note = `本轮已执行 ${maxTurns} 步仍未完成。回复「继续」我会接着做。`;
    lastAssistant = { role: "assistant", content: note };
    extra.push(lastAssistant);
    await Promise.resolve(runtime.emit({ type: "token", text: note }));
    runtime.emit({ type: "finish", reason: "max_turns" });
  }

  return { assistant: lastAssistant, extra, nestedSteps: Object.keys(nestedSteps).length ? nestedSteps : undefined };
}

function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { name?: string }).name === "AbortError");
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 子 Agent：独立上下文跑一个子任务，只把最终结论交回主 Agent（对标 Codex / Claude Code 的 Task） */
export const TASK_TOOL: ChatToolDefinition = {
  type: "function",
  function: {
    name: "task",
    description:
      "Delegate a self-contained sub-task to a sub-agent with its own fresh context. Use it for broad codebase exploration, research across many files, or independent pieces of work, so your own context stays small. The sub-agent cannot see this conversation: put every needed detail in prompt. It returns only its final report. Several readonly tasks in one response run in parallel. Set readonly=false only when the sub-agent must edit files or run commands.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "3-8 word label shown to the user" },
        prompt: { type: "string", description: "Full, self-contained instructions and what to report back" },
        readonly: { type: "boolean", description: "Default true: only read/search tools" },
      },
      required: ["description", "prompt"],
    },
  },
};

const SUBAGENT_BLOCKED = new Set(["ask_user", "present_plan", "update_plan"]);

const SUBAGENT_NOTE =
  "You are a sub-agent working on one delegated task for a parent agent. The user cannot see you or answer questions. Work autonomously, then reply with a concise final report of findings or changes (file paths, key facts). That report is all the parent will see.";

function taskArgs(raw: string): { description: string; prompt: string; readonly: boolean } {
  const parsed = safeJson(raw);
  const o = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return {
    description: typeof o.description === "string" ? o.description.slice(0, 80) : "子任务",
    prompt: typeof o.prompt === "string" ? o.prompt : "",
    readonly: o.readonly !== false,
  };
}

function isReadonlyTask(call: ChatToolCall): boolean {
  return call.function.name === "task" && taskArgs(call.function.arguments).readonly;
}

async function runSubAgent(
  parent: RunAgentParams,
  callId: string,
  rawArgs: string,
): Promise<{ text: string; steps: NestedToolStep[] }> {
  const args = taskArgs(rawArgs);
  if (!args.prompt.trim()) return { text: "调用失败：task 需要 prompt", steps: [] };
  const rt = parent.runtime;
  const readonly = args.readonly || Boolean(rt.planMode);
  const prefix = `${callId}:`;
  let finishReason = "";
  const errors: string[] = [];
  const steps: NestedToolStep[] = [];
  const emit = (ev: AgentEvent) => {
    if (ev.type === "finish") finishReason = ev.reason;
    if (ev.type === "error") errors.push(ev.message);
    switch (ev.type) {
      case "tool_start": {
        const id = prefix + ev.id;
        steps.push({ id, name: ev.name, args: ev.args, parent: callId });
        return rt.emit({ ...ev, id, parent: callId });
      }
      case "tool_end": {
        const id = prefix + ev.id;
        const row = steps.find((x) => x.id === id);
        if (row) {
          row.result = ev.result;
          row.ok = ev.ok;
        }
        return rt.emit({ ...ev, id, parent: callId });
      }
      // 交互类事件要让用户看到并处理（子 Agent 不能提问，question 不上传）
      case "diff":
      case "terminal":
      case "command":
      case "git_setup":
      case "media":
      case "usage":
      case "retry":
        return rt.emit(ev);
      default:
        return undefined;
    }
  };
  const runtime: ToolRuntime = {
    ...rt,
    allowWrites: rt.allowWrites && !readonly,
    allowTerminal: rt.allowTerminal && !readonly,
    allowImage: false,
    allowVideo: false,
    planMode: false,
    onPlanModeChange: undefined,
    emit,
  };
  try {
    const result = await runAgent({
      ...parent,
      runtime,
      history: [{ role: "user", content: `${SUBAGENT_NOTE}\n\n# Task: ${args.description}\n\n${args.prompt}` }],
      persona: null,
      summaryCache: null,
      onSummaryCache: undefined,
      maxTurns: Math.min(parent.maxTurns ?? 40, 40),
      depth: (parent.depth ?? 0) + 1,
    });
    const text = typeof result.assistant.content === "string" ? result.assistant.content.trim() : "";
    const failed = rt.signal?.aborted || result.upstreamFailed || ["error", "abort", "max_turns", "policy"].includes(finishReason);
    if (!failed && finishReason === "length") {
      // 子 Agent 撞到输出上限：结果是半截的，要让主 Agent 知道，别当成完整结论
      return {
        text: ["注意：子 Agent 的输出达到模型单次输出上限被截断，以下内容不完整，必要时请缩小任务范围后重试。", text].filter(Boolean).join("\n"),
        steps,
      };
    }
    if (!failed) return { text: text || "子任务结束，但没有给出结论", steps };
    const why = rt.signal?.aborted ? "被用户中止" : finishReason === "max_turns" ? "达到轮数上限" : "出错";
    return {
      text: [`调用失败：子 Agent ${why}，没有完成`, errors.length ? `错误：${errors.join("；")}` : "", text ? `已有输出：\n${text}` : ""].filter(Boolean).join("\n"),
      steps,
    };
  } catch (err) {
    return { text: `调用失败：子任务出错 ${err instanceof Error ? err.message : String(err)}`, steps };
  }
}
