import { useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { copyText } from "./api.js";
import { MediaThumb } from "./MediaSrc.js";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

/** ChatGPT 式代码块：顶栏语言标签 + 复制按钮 */
function CodeBlock({ children, ...rest }: ComponentPropsWithoutRef<"pre">) {
  const [done, setDone] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const className = (child && typeof child === "object" && "props" in child
    ? (child as { props: { className?: string } }).props.className
    : "") ?? "";
  const lang = /language-([\w+-]+)/.exec(className)?.[1] ?? "";
  const raw = textOf(children).replace(/\n$/, "");
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang || "text"}</span>
        <button
          type="button"
          onClick={async () => {
            if (await copyText(raw)) {
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            }
          }}
        >
          {done ? <Check size={12} /> : <Copy size={12} />}
          {done ? "已复制" : "复制"}
        </button>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

export function MarkdownBody({ text }: { text: string }) {
  const content = useMemo(() => text || "", [text]);
  return (
    <div className="markdown-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          // 自家图片（反馈截图等）要带设备头取，统一走 MediaThumb：缩略显示，点开看原图
          img: ({ src, alt }) =>
            typeof src === "string" && src ? (
              <MediaThumb src={src} alt={alt || ""} name={src.split("?")[0]!.split("/").pop() || "image.png"} className="md-img" />
            ) : null,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
