import { useEffect, useRef, useState } from "react";
import { errorRefunded, generateImage, listMedia, mediaFileName } from "./api.js";
import { CopyAct } from "./CopyButton.js";
import { DownloadButton, MediaThumb } from "./MediaSrc.js";
import { StudioComposer, type StudioRef } from "./StudioComposer.js";
import type { MediaJob } from "./types.js";

const SIZES = ["1K", "2K", "3K", "4K"];
const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
const COUNTS = [1, 2, 3, 4];
/** 同一设备中转最多 8 路，这里留出对话和视频的空位：同时最多 3 张在生成 */
const MAX_INFLIGHT = 3;

type LocalJob = { id: string; prompt: string; status: "running" | "failed"; error?: string; refunded?: boolean };

export type ImageQuotaView = { used: number; remaining: number | null; limit: number; scope?: "today" | "plan" };

export function failedLabel(refunded?: boolean): string {
  return refunded ? "失败 · 次数已退回" : "失败";
}

export function ImageStudio({
  quota,
  onUsed,
}: {
  quota?: ImageQuotaView;
  onUsed?: () => Promise<void> | void;
}) {
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("2K");
  const [ratio, setRatio] = useState("1:1");
  const [count, setCount] = useState(1);
  const [error, setError] = useState("");
  const [items, setItems] = useState<MediaJob[]>([]);
  const [local, setLocal] = useState<LocalJob[]>([]);
  const [inflight, setInflight] = useState(0);
  const [refs, setRefs] = useState<StudioRef[]>([]);
  const inflightRef = useRef(0);
  const planScope = quota?.scope === "plan";
  const exhausted = quota?.remaining === 0;
  const short = quota?.remaining != null && quota.remaining > 0 && quota.remaining < count;
  const empty = items.length === 0 && local.length === 0;
  // 空闲时一次最多 4 张（第 4 张在服务端排队）；已有在跑的，加上这次不能超过 3 张
  const hold = inflight > 0 && inflight + count > MAX_INFLIGHT;

  async function refresh() {
    setItems(await listMedia("image"));
  }

  useEffect(() => {
    void refresh();
  }, []);

  function bump(delta: number) {
    inflightRef.current = Math.max(0, inflightRef.current + delta);
    setInflight(inflightRef.current);
  }

  const holdText = `同时最多生成 ${MAX_INFLIGHT} 张，正在生成 ${inflight} 张，等完成几张再发（或把张数调小）`;
  const runningNote = inflight > 0 ? `正在生成 ${inflight} 张，可以继续写下一条。` : "";
  const queueNote = count > MAX_INFLIGHT ? `同时最多生成 ${MAX_INFLIGHT} 张，第 ${MAX_INFLIGHT + 1} 张会排队。` : "";
  const costNote =
    quota && quota.remaining !== null ? `本次扣 ${count} 张，剩余 ${quota.remaining} 张${planScope ? "（本卡）" : "（今日）"}` : `本次扣 ${count} 张`;
  const foot = exhausted
    ? planScope
      ? `本卡出图额度已用完（共 ${quota?.limit ?? 0} 张）`
      : `今日出图次数已用完（每天 ${quota?.limit ?? 0} 张）`
    : short
      ? `余量不够：本次要 ${count} 张，只剩 ${quota?.remaining ?? 0} 张，请把张数调小`
      : hold
        ? holdText
        : `${runningNote}${costNote}。${queueNote}Enter 发送，Shift+Enter 换行，参考图可拖入或粘贴。`;

  return (
    <div className="studio-dock">
      <div className={`studio-scroll${empty ? " is-empty" : ""}`}>
        {empty ? (
          <div className="hero">
            <h1 className="hero-title">描述你想要的图片</h1>
            <p className="hero-sub">也可以附上参考图，拖进来、粘贴或点加号。一次最多 4 张。</p>
          </div>
        ) : (
          <div className="media-grid">
            {local.map((job) => (
              <figure key={job.id} className="card media-card">
                <div className={`hint card-pending${job.status === "failed" ? " is-failed" : ""}`}>
                  {job.status === "failed" ? failedLabel(job.refunded) : "生成中"}
                </div>
                <figcaption>
                  <span className="card-prompt">{job.prompt.slice(0, 80)}</span>
                  {job.error ? <span className="error">{job.error}</span> : null}
                </figcaption>
                <div className="card-acts">
                  <CopyAct text={job.prompt} title="复制提示词" />
                </div>
              </figure>
            ))}
            {items.map((item) => {
              const src = item.playUrl || item.result_url || "";
              const fallbacks = item.result_url && item.result_url !== src ? [item.result_url] : [];
              return (
                <figure key={item.id} className="card media-card">
                  {src ? (
                    <MediaThumb src={src} name={mediaFileName("image", item.id)} fallbacks={fallbacks} />
                  ) : (
                    <div className={`hint card-pending${item.status === "failed" ? " is-failed" : ""}`}>
                      {item.status === "failed" ? failedLabel(false) : item.status}
                    </div>
                  )}
                  <figcaption>
                    <span className="card-prompt" title={item.prompt}>
                      {item.prompt.slice(0, 80)}
                    </span>
                  </figcaption>
                  <div className="card-acts">
                    <CopyAct text={item.prompt} title="复制提示词" />
                    {src ? <DownloadButton src={src} name={mediaFileName("image", item.id)} /> : null}
                  </div>
                </figure>
              );
            })}
          </div>
        )}
      </div>
      <StudioComposer
        placeholder="描述你想要的图片"
        prompt={prompt}
        onPrompt={setPrompt}
        refs={refs}
        maxRefs={4}
        onRefs={(next) => {
          setError("");
          setRefs(next);
        }}
        busy={false}
        hold={hold || short}
        exhausted={exhausted}
        error={error}
        onError={setError}
        foot={foot}
        controls={
          <>
            <select className="select studio-pill" aria-label="尺寸" value={size} onChange={(e) => setSize(e.target.value)}>
              {SIZES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
            <select className="select studio-pill" aria-label="比例" value={ratio} onChange={(e) => setRatio(e.target.value)}>
              {RATIOS.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
            <select
              className="select studio-pill"
              aria-label="张数"
              title="一次生成几张，每张单独扣一次"
              value={count}
              onChange={(e) => setCount(Number(e.target.value) || 1)}
            >
              {COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n} 张
                </option>
              ))}
            </select>
          </>
        }
        onSubmit={() => {
          const n = count;
          if (inflightRef.current > 0 && inflightRef.current + n > MAX_INFLIGHT) {
            setError(holdText);
            return;
          }
          if (quota?.remaining != null && quota.remaining < n) {
            setError(`余量不够：本次要 ${n} 张，只剩 ${quota.remaining} 张`);
            return;
          }
          const text = prompt.trim();
          const images = refs.map((ref) => ref.dataUrl);
          const sizeNow = size;
          const ratioNow = ratio;
          const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const ids = Array.from({ length: n }, (_, i) => `pending_${stamp}_${i}`);
          bump(n);
          setPrompt("");
          setRefs([]);
          setError("");
          setLocal((list) => [...ids.map((id) => ({ id, prompt: text || "参考图", status: "running" as const })), ...list]);
          void generateImage({ prompt: text, size: sizeNow, ratio: ratioNow, images, count: n })
            .then(async (res) => {
              const results = res.items ?? [res];
              const failed = new Map<string, { error: string; refunded?: boolean }>();
              results.forEach((item, i) => {
                if (item && "error" in item && typeof item.error === "string") failed.set(ids[i], { error: item.error, refunded: item.refunded });
              });
              setLocal((list) =>
                list
                  .filter((job) => !ids.includes(job.id) || failed.has(job.id))
                  .map((job) => {
                    const bad = failed.get(job.id);
                    return bad ? { ...job, status: "failed" as const, error: bad.error, refunded: Boolean(bad.refunded) } : job;
                  }),
              );
              await refresh();
              await onUsed?.();
            })
            .catch(async (err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              const refunded = errorRefunded(err);
              setLocal((list) => list.map((job) => (ids.includes(job.id) ? { ...job, status: "failed", error: message, refunded } : job)));
              await onUsed?.();
            })
            .finally(() => {
              bump(-n);
              setError((prev) => (prev.startsWith("同时最多") ? "" : prev));
            });
        }}
      />
    </div>
  );
}
