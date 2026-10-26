import type { StepTool, TranscriptBlock } from "./AgentSteps.js";

/**
 * 工具卡片的纯逻辑（不含 JSX，自测可以直接 import）：
 * - mergeStepRuns：中间没有文字的连续几轮工具调用并成一组
 * - summarizeSteps：组头上的数量、失败数和分类
 * - looksFailed：与 packages/agent 的 toolResultFailed 保持一致（历史回放没有 ok 位，只能看文本）
 * - failureNote：失败卡片标题旁的一句原因
 */

/** 顶层工具调用达到这个数才折成一组；只有 1 个时照旧显示单张卡片 */
export const GROUP_MIN = 2;

export function mergeStepRuns(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.kind === "steps" && last && last.kind === "steps") {
      out[out.length - 1] = { ...last, tools: [...last.tools, ...b.tools], plan: b.plan ?? last.plan };
      continue;
    }
    out.push(b);
  }
  return out;
}

export function toolKind(name: string): string {
  if (name === "read_file" || name === "read_skill") return "读取";
  if (name === "list_dir" || name === "glob" || name === "grep") return "查找";
  if (name === "edit_file" || name === "write_file" || name === "apply_patch") return "修改";
  if (/^(run|await|read|stop)_terminal$/.test(name) || name === "list_terminals") return "命令";
  if (name === "web_search" || name === "web_fetch") return "联网";
  if (name.startsWith("mcp__")) return "MCP";
  if (name === "task") return "子 Agent";
  if (name === "generate_image" || name === "generate_video") return "生成";
  return "其他";
}

export type StepSummary = { total: number; failed: number; running: number; label: string };

export function summarizeSteps(tools: StepTool[]): StepSummary {
  const top = tools.filter((t) => !t.parent);
  const counts = new Map<string, number>();
  for (const t of top) {
    const k = toolKind(t.name);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return {
    total: top.length,
    failed: top.filter((t) => t.ok === false).length,
    running: top.filter((t) => t.result === undefined).length,
    label: [...counts].map(([k, n]) => `${k} ${n}`).join(" · "),
  };
}

const WRITE_TOOLS = new Set(["write_file", "edit_file", "apply_patch"]);

/** 与 packages/agent/src/tools.ts 的 toolResultFailed 逐条对应；另外认 UI 自己的「已取消：」 */
export function looksFailed(name: string, result: string): boolean {
  if (/^已取消：/.test(result)) return true;
  if (name === "web_search" || name === "web_fetch") return /^(调用失败|工具失败)/.test(result);
  if (name.startsWith("mcp__")) return /^(调用失败|工具失败)/.test(result);
  if (name === "task") return /^调用失败/.test(result);
  if (/^工具失败/.test(result)) return true;
  if (WRITE_TOOLS.has(name)) return /^(无法应用|old_string|用户拒绝|当前部署已禁止|编辑失败|写入失败)/.test(result);
  if (name === "run_terminal") return /^exit (?!0\b)-?\d+/.test(result) || /^用户拒绝执行/.test(result);
  if (name === "await_terminal" || name === "read_terminal" || name === "stop_terminal" || name === "list_terminals") return false;
  if (name === "read_skill") return /^(没有这个技能|技能 .* 没有这个参考文件|当前工作区没有配置)/.test(result);
  if (name === "present_plan" || name === "ask_user") return /^用户没有回答|^用户没有确认/.test(result);
  if (name === "typecheck") return /没通过|超时|失败/.test(result);
  return false;
}

/** 失败卡片标题旁的一句原因。命令的退出码已经在 meta 里（做成药丸），这里返回空 */
export function failureNote(name: string, result: string): string {
  if (name === "run_terminal" && /^exit -?\d+/.test(result)) return "";
  const first = (result.split(/\r?\n/).find((l) => l.trim()) ?? "")
    .trim()
    .replace(/^(工具失败|调用失败|写入失败|编辑失败)\s*(\([^)]*\))?\s*[:：]?\s*/, "");
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}
