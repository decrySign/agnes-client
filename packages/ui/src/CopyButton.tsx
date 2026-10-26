import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "./api.js";

/** 对话气泡下的复制按钮；创作卡片的「复制提示词」也用这一个 */
export function CopyAct({ text, title = "复制" }: { text: string; title?: string }) {
  const [done, setDone] = useState(false);
  const label = done ? "已复制" : title;
  return (
    <button
      type="button"
      className="msg-act"
      title={label}
      aria-label={label}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
