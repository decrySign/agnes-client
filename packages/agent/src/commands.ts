import type { ApprovalMode } from "./types.js";

/**
 * 默认放行只读 git 和项目自带的检查脚本。
 * 「只问命令」会直接跑这些；「每次都问」仍然全部确认。
 * 用户在设置里改的是整份清单，一行一条，按前缀匹配。
 */
export const DEFAULT_COMMAND_ALLOW = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git rev-parse",
  "git branch",
  "pnpm test",
  "pnpm typecheck",
  "pnpm lint",
  "pnpm exec tsc",
  "npm test",
  "npm run typecheck",
  "npm run lint",
  "npx tsc",
  "yarn test",
  "yarn typecheck",
  "ls",
  "dir",
  "pwd",
].join("\n");

export type CommandClass = "allow" | "ask" | "danger";

function segments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;&|\n])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 删除、联网、改 git 远端、装系统软件。即使用户开了全自动也要问。 */
function isDangerSegment(segment: string): boolean {
  const text = segment.trim();
  if (/^(format|mkfs|shutdown|reboot)\b/i.test(text)) return true;
  return (
    /\b(rm|rmdir|del|erase|curl|wget|sudo|chmod|chown|winget)\b/i.test(text) ||
    /\bRemove-Item\b/i.test(text) ||
    /\bInvoke-(WebRequest|RestMethod|Expression)\b/i.test(text) ||
    /\b(iwr|iex)\b/i.test(text) ||
    /\bgit\s+(push|reset|clean|config)\b/i.test(text) ||
    /\bbrew\s+install\b/i.test(text) ||
    /\b(?:npm|pnpm|yarn)\s+(?:install|add|i)\s+\S*\s-g\b/i.test(text) ||
    /\b(?:npm|pnpm|yarn)\s+global\b/i.test(text) ||
    /\$\(/.test(text) ||
    /`/.test(text)
  );
}

export function isDangerousCommand(command: string): boolean {
  const parts = segments(command);
  return (parts.length ? parts : [command]).some(isDangerSegment);
}

/** 空文本用默认清单。超长行和危险规则丢掉，最多 40 条。 */
export function parseAllowRules(text: string | undefined | null): string[] {
  const src = (text ?? "").trim() ? String(text) : DEFAULT_COMMAND_ALLOW;
  const out: string[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, " ");
    if (!line || line.startsWith("#") || line.length > 120) continue;
    if (isDangerousCommand(line)) continue;
    if (out.includes(line)) continue;
    out.push(line);
    if (out.length >= 40) break;
  }
  return out.length ? out : DEFAULT_COMMAND_ALLOW.split("\n");
}

export function normalizeAllowText(text: string | undefined | null): string {
  return parseAllowRules(text).join("\n");
}

function matchesRule(segment: string, rule: string): boolean {
  const cmd = segment.replace(/\s+/g, " ").trim();
  const prefix = rule.replace(/\s+/g, " ").trim();
  if (!prefix) return false;
  return cmd === prefix || cmd.startsWith(`${prefix} `);
}

export function classifyCommand(command: string, allowText?: string | null): CommandClass {
  const parts = segments(command);
  if (!parts.length) return "ask";
  if (parts.some(isDangerSegment)) return "danger";
  const rules = parseAllowRules(allowText);
  if (parts.every((part) => rules.some((rule) => matchesRule(part, rule)))) return "allow";
  return "ask";
}

/**
 * suggest：命令都问。
 * auto-edit：允许规则里的直接跑，其余问。
 * full-auto：普通命令直接跑。
 * 危险命令三种档位都问。
 */
export function shouldConfirmCommand(mode: ApprovalMode, command: string, allowText?: string | null): boolean {
  const kind = classifyCommand(command, allowText);
  if (kind === "danger") return true;
  if (mode === "suggest") return true;
  if (mode === "full-auto") return false;
  return kind !== "allow";
}

/** 审批卡「记住这条」写入允许规则的前缀。危险命令返回 null。 */
export function ruleForCommand(command: string): string | null {
  if (isDangerousCommand(command)) return null;
  const segment = segments(command)[0];
  if (!segment) return null;
  const parts = segment.replace(/\s+/g, " ").trim().split(" ");
  const head = parts[0]?.toLowerCase() ?? "";
  if (!head) return null;
  if (head === "git" && parts[1]) return `git ${parts[1]}`;
  if ((head === "pnpm" || head === "npm" || head === "yarn" || head === "bun") && parts[1]) {
    if (parts[1] === "run" && parts[2]) return `${parts[0]} run ${parts[2]}`;
    return `${parts[0]} ${parts[1]}`;
  }
  const rule = parts.slice(0, 2).join(" ");
  return rule.length > 120 ? null : rule;
}

export function appendAllowRule(current: string | undefined | null, rule: string): string {
  const clean = rule.replace(/\s+/g, " ").trim();
  if (!clean || isDangerousCommand(clean)) return normalizeAllowText(current);
  const rules = parseAllowRules(current);
  if (rules.includes(clean)) return rules.join("\n");
  return [...rules, clean].slice(0, 40).join("\n");
}
