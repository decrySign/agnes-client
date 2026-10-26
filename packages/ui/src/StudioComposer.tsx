import { useRef, type DragEvent, type ReactNode } from "react";
import { ArrowUp, Loader2, Plus, X } from "lucide-react";
import { useAutoGrow } from "./autogrow.js";

export type StudioRef = { name: string; dataUrl: string };

const MAX_BYTES = 8 * 1024 * 1024;

export function readStudioImage(file: File): Promise<StudioRef> {
  if (!file.type.startsWith("image/")) return Promise.reject(new Error("只能上传图片"));
  if (file.size > MAX_BYTES) return Promise.reject(new Error("单张参考图不能超过 8MB"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name || "参考图", dataUrl: String(reader.result) });
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

export function StudioComposer({
  placeholder,
  prompt,
  onPrompt,
  refs,
  maxRefs,
  onRefs,
  busy,
  hold = false,
  exhausted,
  error,
  onError,
  foot,
  controls,
  onSubmit,
}: {
  placeholder: string;
  prompt: string;
  onPrompt: (value: string) => void;
  refs: StudioRef[];
  maxRefs: number;
  onRefs: (next: StudioRef[]) => void;
  busy: boolean;
  /** 名额满了：发送键停用，加号和输入框仍可用 */
  hold?: boolean;
  exhausted: boolean;
  error: string;
  onError: (message: string) => void;
  foot: string;
  controls: ReactNode;
  onSubmit: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const grow = useAutoGrow(areaRef, prompt);
  const canSend = !busy && !hold && !exhausted && (prompt.trim().length > 0 || refs.length > 0);

  async function addFiles(list: File[]) {
    const room = maxRefs - refs.length;
    const images = list.filter((file) => file.type.startsWith("image/")).slice(0, room);
    if (!images.length) return;
    try {
      const next = await Promise.all(images.map(readStudioImage));
      onError("");
      onRefs([...refs, ...next].slice(0, maxRefs));
    } catch (err) {
      onError(err instanceof Error ? err.message : "读取参考图失败");
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    void addFiles([...event.dataTransfer.files]);
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSubmit();
      }}
    >
      <div className="composer-box" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        {refs.length ? (
          <div className="composer-pics">
            {refs.map((ref, index) => (
              <span key={`${ref.name}-${index}`} className="composer-pic">
                <img src={ref.dataUrl} alt={ref.name} />
                <button
                  type="button"
                  aria-label="移除参考图"
                  onClick={() => onRefs(refs.filter((_, i) => i !== index))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={areaRef}
          rows={1}
          placeholder={placeholder}
          value={prompt}
          onFocus={grow.onFocus}
          onBlur={grow.onBlur}
          onChange={(event) => onPrompt(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.some((file) => file.type.startsWith("image/"))) {
              event.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSend) onSubmit();
            }
          }}
        />
        <div className="composer-tools">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(event) => {
              void addFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="icon-btn ghost"
            title={maxRefs > 1 ? "添加参考图" : "添加参考图"}
            disabled={busy || refs.length >= maxRefs}
            onClick={() => fileRef.current?.click()}
          >
            <Plus size={18} />
          </button>
          {controls}
          <button className="icon-btn send" type="submit" disabled={!canSend} title="生成">
            {busy || hold ? <Loader2 className="animate-spin" size={18} /> : <ArrowUp size={18} />}
          </button>
        </div>
      </div>
      {error ? <div className="error studio-error">{error}</div> : null}
      <p className="composer-foot">{foot}</p>
    </form>
  );
}
