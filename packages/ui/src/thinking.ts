/**
 * 把模型写进正文里的草稿和正式回答分开。
 * 上游若走 reasoning 字段，调用方再拼到 thinking 上。
 * 已落库的旧消息也能靠这段在界面上拆开，不用改历史数据。
 */

const THINK_OPEN = /<think\b[^>]*>/i;

const SCRATCH_LINE =
  /^(?:hmm\b|wait\b|let me\b|actually\b|i(?:'ll| will| need to| should)\b|ok(?:ay)?,?\s+(?:so|wait|let)\b|so old\b|让我|等一下|不对[，,。]|我再(?:算|看|核)|重新(?:算|核))/i;

export type ScratchSplit = { thinking: string; answer: string };

function isScratchLine(line: string): boolean {
  return SCRATCH_LINE.test(line.trim());
}

function peelParagraph(paragraph: string): ScratchSplit {
  const trimmed = paragraph.trim();
  if (!trimmed) return { thinking: "", answer: "" };
  const lines = trimmed.split("\n");
  const listAt = lines.findIndex((line, index) => index > 0 && /^(?:[-*]|\d+\.)\s/.test(line.trim()));
  if (listAt > 0) {
    const head = lines.slice(0, listAt).join("\n").trim();
    const rest = lines.slice(listAt).join("\n").trim();
    if (head && isScratchLine(head)) return { thinking: head, answer: rest };
    return { thinking: "", answer: trimmed };
  }
  if (isScratchLine(trimmed)) return { thinking: trimmed, answer: "" };
  return { thinking: "", answer: trimmed };
}

export function splitScratch(text: string): ScratchSplit {
  let thinking = "";
  let rest = text.replace(/<think\b[^>]*>([\s\S]*?)<\/think>/gi, (_all, inner: string) => {
    const bit = String(inner).trim();
    if (bit) thinking += `${bit}\n\n`;
    return "\n\n";
  });
  const openAt = rest.search(THINK_OPEN);
  if (openAt >= 0) {
    const after = rest.slice(openAt).replace(THINK_OPEN, "").trim();
    if (after) thinking += `${after}\n\n`;
    rest = rest.slice(0, openAt);
  }

  const thoughts: string[] = [];
  const answers: string[] = [];
  if (thinking.trim()) thoughts.push(thinking.trim());
  for (const part of rest.split(/\n{2,}/)) {
    const peeled = peelParagraph(part);
    if (peeled.thinking) thoughts.push(peeled.thinking);
    if (peeled.answer) answers.push(peeled.answer);
  }
  return { thinking: thoughts.join("\n\n").trim(), answer: answers.join("\n\n").trim() };
}

export function thoughtLabel(text: string, live: boolean): string {
  if (live) return "正在思考";
  return text.trim().length < 220 ? "简短思考" : "思考过程";
}
