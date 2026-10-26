import type { Workspace } from "./workspace.js";

/**
 * 用户消息里的 `@src/app.ts` 会被展开成文件内容附在消息后面（Cursor 的 @file）。
 * 只展开工作区里真实存在的文本文件，读取仍走 Workspace 沙箱，所以 .env / 越界路径都读不到。
 * 展开后的内容只发给模型，不写回数据库——历史里存的还是用户原话。
 */
// 前面必须是行首/空白/标点，免得把邮箱 me@x.com 当成文件；允许 .gitignore 这种 dotfile
// 可选 #符号：`@src/App.tsx#handleSend` 只展开符号附近的窗口
const MENTION_RE =
  /(?:^|[\s(（【「,，;；:：])@([\w.\\/-]*\.[A-Za-z0-9]{1,8})(?:#([A-Za-z_$][\w$.-]*))?(?=$|[\s)）】」,，;；:：!！?？])/g;
const MAX_FILES = 6;
const MAX_LINES_PER_FILE = 400;

export type MentionRef = { path: string; symbol?: string };

export function extractMentionRefs(text: string): MentionRef[] {
  const out: MentionRef[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const rel = match[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const symbol = match[2] || undefined;
    if (!rel) continue;
    if (out.some((item) => item.path === rel && item.symbol === symbol)) continue;
    out.push({ path: rel, symbol });
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

export function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const ref of extractMentionRefs(text)) {
    if (!out.includes(ref.path)) out.push(ref.path);
  }
  return out;
}

function symbolLine(text: string, symbol: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`);
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((line) => re.test(line));
  return idx >= 0 ? idx + 1 : 0;
}

export async function expandMentions(ws: Workspace, text: string): Promise<{ content: string; attached: string[] }> {
  const mentions = extractMentionRefs(text);
  if (!mentions.length) return { content: text, attached: [] };
  const blocks: string[] = [];
  const attached: string[] = [];
  for (const ref of mentions) {
    try {
      if (!ws.exists(ref.path)) continue;
      let body: string;
      if (ref.symbol) {
        const raw = await ws.readFile(ref.path);
        const line = symbolLine(raw, ref.symbol);
        body = line
          ? `符号 ${ref.symbol}\n${await ws.readFileLines(ref.path, Math.max(1, line - 15), 80)}`
          : await ws.readFileLines(ref.path, 1, MAX_LINES_PER_FILE);
      } else {
        body = await ws.readFileLines(ref.path, 1, MAX_LINES_PER_FILE);
      }
      const symbolAttr = ref.symbol ? ` symbol="${ref.symbol}"` : "";
      blocks.push(`<file path="${ref.path}"${symbolAttr}>\n${body}\n</file>`);
      if (!attached.includes(ref.path)) attached.push(ref.path);
    } catch {
      // 二进制 / 越界 / 密钥文件：静默跳过，模型自己会看到 @ 没展开
    }
  }
  if (!blocks.length) return { content: text, attached: [] };
  return {
    content: `${text}\n\n[用户 @ 了以下文件，内容如下]\n${blocks.join("\n\n")}`,
    attached,
  };
}
