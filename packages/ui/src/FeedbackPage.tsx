import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { ImagePlus, Megaphone } from "lucide-react";
import { listMyFeedback, submitFeedback, type FeedbackItem } from "./api.js";
import { FEEDBACK_KINDS, type FeedbackKind } from "./types.js";
import { MediaImg, MediaThumb } from "./MediaSrc.js";
import { MarkdownBody } from "./MarkdownBody.js";

const MAX_IMAGES = 3;

function kindLabel(kind: string): string {
  return FEEDBACK_KINDS.find((k) => k.id === kind)?.label || "其他";
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
}

function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  if (!out.length) {
    for (let i = 0; i < data.files.length; i++) {
      const file = data.files[i];
      if (file && isImageFile(file)) out.push(file);
    }
  }
  return out;
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > 2 * 1024 * 1024) {
      reject(new Error("单张图片不能超过 2MB"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function statusLabel(row: FeedbackItem): string {
  if (row.status === "adopted") {
    if (row.rewardApplied === "pending") return `已采纳 · 待激活卡密时加赠 ${row.rewardDays} 天`;
    if (row.rewardApplied === "noop") return "已采纳";
    return `已采纳 · 授权 +${row.rewardDays} 天`;
  }
  if (row.status === "rejected") return "未采纳";
  return "待处理";
}

export function FeedbackPage({ desktopMode }: { desktopMode: boolean }) {
  const [kind, setKind] = useState<FeedbackKind | "">("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [contact, setContact] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const load = useCallback(async () => {
    setItems(await listMyFeedback());
  }, []);

  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  async function addFiles(files: File[]) {
    const accepted: string[] = [];
    let failed = "";
    try {
      for (const file of files) {
        if (accepted.length >= MAX_IMAGES) break;
        if (!isImageFile(file)) continue;
        accepted.push(await readImage(file));
      }
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    }
    if (!accepted.length) {
      if (failed) setErr(failed);
      return;
    }
    let capped = false;
    setImages((prev) => {
      if (prev.length >= MAX_IMAGES) {
        capped = true;
        return prev;
      }
      return [...prev, ...accepted].slice(0, MAX_IMAGES);
    });
    if (capped && !failed) failed = "最多 3 张截图";
    setErr(failed);
  }

  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = imageFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      void addFilesRef.current(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragOver(false);
    const files = imageFiles(event.dataTransfer);
    if (!files.length) {
      if (event.dataTransfer.files.length) setErr("只能上传图片");
      return;
    }
    void addFiles(files);
  }

  return (
    <div
      className="settings"
      onDragEnter={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <h2>
        <Megaphone size={18} className="mr-1 inline" />
        需求反馈
      </h2>
      <p className="hint">
        {desktopMode
          ? "写下遇到的问题或想加的能力。截图可以 Ctrl+V 粘贴，也可以拖进来。被采纳后，已经开通的授权会立刻延长相应天数；还在试用的，会记下来，下次激活卡密时叠加。"
          : "写下遇到的问题或想加的能力。截图可以 Ctrl+V 粘贴，也可以拖进来。被采纳后会记下授权天数，桌面端开通后加到到期日上。"}
      </p>

      <form
        className={`card${dragOver ? " is-drop" : ""}`}
        style={{ padding: 16, marginTop: 16 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setErr("");
          setOk("");
          if (!kind) {
            setErr("请先选择上面的反馈类型");
            return;
          }
          if (body.trim().length < 8) {
            setErr("描述再写具体一点，至少 8 个字");
            return;
          }
          setBusy(true);
          try {
            const saved = await submitFeedback({ title, body, kind, images, contact });
            setKind("");
            setTitle("");
            setBody("");
            setContact("");
            setImages([]);
            setOk(saved.ticketNo ? `已提交，工单号 ${saved.ticketNo}。我们会在后台逐条看。` : "已提交，我们会在后台逐条看。");
            await load();
          } catch (error) {
            setErr(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="hint" style={{ marginBottom: 12 }}>
          <div>类型（必选）</div>
          <div className={`feedback-kinds${err && !kind ? " is-missing" : ""}`} role="radiogroup" aria-label="反馈类型">
            {FEEDBACK_KINDS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={kind === item.id}
                className={kind === item.id ? "chip is-on" : "chip"}
                onClick={() => {
                  setKind(item.id);
                  setErr("");
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <label>
          标题（可选）
          <input className="field" value={title} maxLength={80} placeholder="例如：暗色主题" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          描述
          <textarea
            className="area"
            value={body}
            maxLength={4000}
            placeholder="你想解决什么问题？现在怎么用的、期望变成什么样？"
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <div className="toolbar">
          <label className="btn">
            <ImagePlus size={14} className="mr-1 inline" />
            添加截图（最多 {MAX_IMAGES} 张）
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              multiple
              onChange={(e) => {
                if (e.target.files) void addFiles(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <div className="feedback-drop-hint">{dragOver ? "松开即可添加截图" : "把截图拖到这里，或在本页按 Ctrl+V 粘贴"}</div>
        {images.length ? (
          <div className="studio-refs">
            {images.map((src, i) => (
              <span className="studio-ref" key={i}>
                <img src={src} alt="" />
                <button
                  type="button"
                  onClick={() => setImages((list) => list.filter((_, idx) => idx !== i))}
                  aria-label="去掉这张图"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <label style={{ marginTop: 12, display: "block" }}>
          联系方式（可选）
          <input className="field" value={contact} maxLength={64} placeholder="微信 / 邮箱，方便我们回访" onChange={(e) => setContact(e.target.value)} />
        </label>
        {err ? <p className="error">{err}</p> : null}
        {ok ? <p className="form-ok">{ok}</p> : null}
        <div className="toolbar">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "提交中…" : "提交反馈"}
          </button>
        </div>
      </form>

      <h3 style={{ marginTop: 28, fontSize: 15 }}>我提交过的</h3>
      {items.length === 0 ? (
        <p className="hint">还没有记录。</p>
      ) : (
        <ul className="feedback-list">
          {items.map((row) => (
            <li key={row.id} className="card" style={{ padding: 12, marginTop: 10 }}>
              <div className="feedback-meta">
                <strong>
                  <span className="feedback-ticket">{row.ticketNo || "工单"}</span>
                  <span className="feedback-kind">{kindLabel(row.kind)}</span>
                  {row.title || "未命名"}
                </strong>
                <span className={`feedback-status is-${row.status}`}>{statusLabel(row)}</span>
              </div>
              <p className="hint" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
                {row.body}
              </p>
              {row.images.length ? (
                <div className="studio-refs">
                  {row.images.map((img) => (
                    <span className="studio-ref" key={img.name}>
                      <MediaImg src={img.url} alt="" />
                    </span>
                  ))}
                </div>
              ) : null}
              {row.adminNote ? <p className="hint">运营回复：{row.adminNote}</p> : null}
              {row.replies?.length ? (
                <div className="feedback-replies">
                  {row.replies.map((reply) => {
                    const loose = reply.images.filter((img) => !reply.body.includes(img.url));
                    return (
                      <div className="feedback-reply" key={reply.id}>
                        <div className="feedback-reply-head">
                          <strong>{reply.author || "运营"}回复</strong>
                          <span>{new Date(reply.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
                        </div>
                        {reply.body ? <MarkdownBody text={reply.body} /> : null}
                        {loose.length ? (
                          <div className="feedback-reply-pics">
                            {loose.map((img) => (
                              <MediaThumb key={img.name} src={img.url} name={img.name} />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <p className="hint">{new Date(row.createdAt).toLocaleString("zh-CN", { hour12: false })}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
