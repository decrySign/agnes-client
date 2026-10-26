import { useEffect, useRef, useState } from "react";
import { errorRefunded, generateVideo, listMedia, mediaFileName } from "./api.js";
import { CopyAct } from "./CopyButton.js";
import { failedLabel } from "./ImageStudio.js";
import { DownloadButton, MediaVideo } from "./MediaSrc.js";
import { StudioComposer, type StudioRef } from "./StudioComposer.js";
import type { MediaJob } from "./types.js";

const SECONDS = ["4", "5", "6", "8", "10", "12"];
const RATIOS = ["16:9", "9:16", "1:1", "4:3", "21:9"];
/** 网页每分钟最多 3 条，同时占满会把后面的直接打回去 */
const MAX_INFLIGHT = 2;

type LocalJob = { id: string; prompt: string; status: "running" | "failed"; error?: string; refunded?: boolean };

function isPending(item: MediaJob): boolean {
  return item.status !== "completed" && item.status !== "failed";
}

function statusText(status: string): string {
  if (status === "processing" || status === "queued" || status === "running" || status === "pending") return "生成中";
  if (status === "failed") return "失败";
  if (status === "completed") return "完成";
  return status;
}

export function VideoStudio({
  quota,
  onUsed,
}: {
  quota?: { used: number; remaining: number | null; limit: number; windowDays: number };
  onUsed?: () => Promise<void> | void;
}) {
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState("5");
  const [ratio, setRatio] = useState("16:9");
  const [error, setError] = useState("");
  const [items, setItems] = useState<MediaJob[]>([]);
  const [local, setLocal] = useState<LocalJob[]>([]);
  const [inflight, setInflight] = useState(0);
  const [refs, setRefs] = useState<StudioRef[]>([]);
  const inflightRef = useRef(0);
  const windowDays = quota?.windowDays ?? 3;
  const exhausted = quota?.remaining === 0;
  const pending = items.some(isPending);
  const empty = items.length === 0 && local.length === 0;
  const hold = inflight >= MAX_INFLIGHT;

  async function refresh() {
    setItems(await listMedia("video"));
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refresh(), 6000);
    return () => clearInterval(timer);
  }, [pending]);

  function bump(delta: number) {
    inflightRef.current = Math.max(0, inflightRef.current + delta);
    setInflight(inflightRef.current);
  }

  const runningNote = inflight > 0 ? `正在提交 ${inflight} 条，可以继续写下一条。` : "";
  const foot = quota
    ? exhausted
      ? `近 ${windowDays} 天视频次数已用完（每 ${windowDays} 天 ${quota.limit} 条）`
      : hold
        ? `正在提交的已经有 ${MAX_INFLIGHT} 条，等一条提交完再发`
        : `${runningNote}近 ${windowDays} 天还可生成 ${quota.remaining ?? quota.limit} / ${quota.limit} 条 · 第一张作首帧，第二张作尾帧`
    : hold
      ? `正在提交的已经有 ${MAX_INFLIGHT} 条，等一条提交完再发`
      : `${runningNote}720P，4–12 秒。第一张参考图作首帧，第二张作尾帧。`;

  return (
    <div className="studio-dock">
      <div className={`studio-scroll${empty ? " is-empty" : ""}`}>
        {empty ? (
          <div className="hero">
            <h1 className="hero-title">描述你想要的视频</h1>
            <p className="hero-sub">可以附上首帧和尾帧，拖进来、粘贴或点加号。</p>
          </div>
        ) : (
          <div className="media-grid">
            {local.map((job) => (
              <figure key={job.id} className="card media-card">
                <div className={`hint card-pending${job.status === "failed" ? " is-failed" : ""}`}>
                  {job.status === "failed" ? failedLabel(job.refunded) : "生成中"}
                </div>
                <figcaption>
                  <span className="card-prompt">{job.prompt.slice(0, 90)}</span>
                  {job.error ? <span className="error">{job.error}</span> : null}
                </figcaption>
                <div className="card-acts">
                  <CopyAct text={job.prompt} title="复制提示词" />
                </div>
              </figure>
            ))}
            {items.map((item) => {
              const src = item.playUrl || item.result_url || "";
              return (
                <figure key={item.id} className="card media-card">
                  {src ? (
                    <MediaVideo src={src} className="media-video" />
                  ) : (
                    <div className={`hint card-pending${item.status === "failed" ? " is-failed" : ""}`}>{statusText(item.status)}</div>
                  )}
                  <figcaption>
                    <span className="card-prompt" title={item.prompt}>
                      {statusText(item.status)} · {item.prompt.slice(0, 90)}
                    </span>
                    {item.error ? <span className="error">{item.error}</span> : null}
                  </figcaption>
                  <div className="card-acts">
                    <CopyAct text={item.prompt} title="复制提示词" />
                    {src && item.status === "completed" ? <DownloadButton src={src} name={mediaFileName("video", item.id)} /> : null}
                  </div>
                </figure>
              );
            })}
          </div>
        )}
      </div>
      <StudioComposer
        placeholder="描述你想要的视频"
        prompt={prompt}
        onPrompt={setPrompt}
        refs={refs}
        maxRefs={2}
        onRefs={(next) => {
          setError("");
          setRefs(next);
        }}
        busy={false}
        hold={hold}
        exhausted={exhausted}
        error={error}
        onError={setError}
        foot={foot}
        controls={
          <>
            <select className="select studio-pill" aria-label="秒数" value={seconds} onChange={(e) => setSeconds(e.target.value)}>
              {SECONDS.map((item) => (
                <option key={item} value={item}>
                  {item} 秒
                </option>
              ))}
            </select>
            <select className="select studio-pill" aria-label="比例" value={ratio} onChange={(e) => setRatio(e.target.value)}>
              {RATIOS.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </>
        }
        onSubmit={() => {
          if (inflightRef.current >= MAX_INFLIGHT) {
            setError(`正在提交的已经有 ${MAX_INFLIGHT} 条，等一条提交完再发`);
            return;
          }
          const text = prompt.trim();
          const first = refs[0]?.dataUrl;
          const last = refs[1]?.dataUrl;
          const secondsNow = seconds;
          const ratioNow = ratio;
          const id = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          bump(1);
          setPrompt("");
          setRefs([]);
          setError("");
          setLocal((list) => [{ id, prompt: text || "参考图", status: "running" }, ...list]);
          void generateVideo({
            prompt: text,
            seconds: secondsNow,
            aspectRatio: ratioNow,
            mode: first ? "keyframe" : "text",
            firstFrame: first,
            lastFrame: last,
          })
            .then(async () => {
              setLocal((list) => list.filter((job) => job.id !== id));
              await onUsed?.();
              await refresh();
            })
            .catch(async (err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              const refunded = errorRefunded(err);
              setLocal((list) => list.map((job) => (job.id === id ? { ...job, status: "failed", error: message, refunded } : job)));
              await onUsed?.();
            })
            .finally(() => {
              bump(-1);
              setError((prev) => (prev.startsWith("正在提交的已经有") ? "" : prev));
            });
        }}
      />
    </div>
  );
}
