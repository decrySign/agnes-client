import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Download, Loader2, Maximize2, Minimize2, X } from "lucide-react";
import { downloadMedia, fetchMediaObjectUrl, isAppMediaUrl, mediaVariantUrl } from "./api.js";

/**
 * 网页把媒体放在 API 子域，<img> 带不了 x-agnes-device，直接 src=/api/media/:id 会 401。
 * 自家媒体用带凭证的 fetch 转成 blob URL；data / 外链仍走原生 src。
 * fallbacks：前一个加载失败就换下一个（预览图 → 原图 → 上游外链）。
 */
export function MediaImg({
  src,
  alt = "",
  className,
  fallbacks,
  onClick,
  title,
}: {
  src: string;
  alt?: string;
  className?: string;
  fallbacks?: string[];
  onClick?: (event: MouseEvent<HTMLImageElement>) => void;
  title?: string;
}) {
  const chain = [src, ...(fallbacks ?? [])].filter(Boolean);
  const [index, setIndex] = useState(0);
  const key = chain.join("|");
  useEffect(() => setIndex(0), [key]);
  const active = chain[Math.min(index, chain.length - 1)] || "";
  const next = () => setIndex((i) => (i + 1 < chain.length ? i + 1 : i));
  const { url, failed } = useAuthedMedia(active);
  useEffect(() => {
    if (failed) next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, active]);
  if (!url) return null;
  return <img src={url} alt={alt} className={className} onClick={onClick} title={title} onError={next} />;
}

export function MediaVideo({
  src,
  className,
  style,
  autoPlay,
}: {
  src: string;
  className?: string;
  style?: CSSProperties;
  autoPlay?: boolean;
}) {
  const { url } = useAuthedMedia(src);
  if (!url) return null;
  return <video src={url} className={className} style={style} controls playsInline autoPlay={autoPlay} />;
}

function useAuthedMedia(src: string): { url: string; failed: boolean } {
  const [blob, setBlob] = useState("");
  const [failed, setFailed] = useState(false);
  const direct = !src || src.startsWith("data:") || src.startsWith("blob:") || !isAppMediaUrl(src);
  useEffect(() => {
    setFailed(false);
    if (direct) {
      setBlob("");
      return;
    }
    let alive = true;
    let created = "";
    void fetchMediaObjectUrl(src)
      .then((url) => {
        if (!alive) {
          URL.revokeObjectURL(url);
          return;
        }
        created = url;
        setBlob(url);
      })
      .catch(() => {
        if (!alive) return;
        setBlob("");
        setFailed(true);
      });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src, direct]);
  if (!src) return { url: "", failed: false };
  if (direct) return { url: src, failed: false };
  return { url: blob, failed };
}

/** 下载原图 / 原视频：自家媒体走 ?download=1 拿服务端给的文件名 */
export function DownloadButton({
  src,
  name,
  label = false,
  className = "msg-act",
}: {
  src: string;
  name: string;
  label?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const title = err || (busy ? "正在下载…" : "下载原文件");
  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={title}
      disabled={busy || !src}
      onClick={async (event) => {
        event.stopPropagation();
        setBusy(true);
        setErr("");
        try {
          await downloadMedia(src, name);
        } catch (error) {
          setErr(error instanceof Error ? error.message : "下载失败");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
      {label ? <span>{err ? "下载失败" : "下载"}</span> : null}
    </button>
  );
}

/** 点开看原图：1:1 / 适应窗口切换、下载、Esc 或点背景关闭 */
export function MediaLightbox({ src, name, onClose, fallbacks }: { src: string; name: string; onClose: () => void; fallbacks?: string[] }) {
  const [actual, setActual] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const closeOnBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="查看原图" onClick={closeOnBackdrop}>
      <div className="lightbox-bar">
        <button type="button" className="lightbox-btn" onClick={() => setActual((v) => !v)} title={actual ? "适应窗口" : "按原始尺寸 1:1 查看"}>
          {actual ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          <span>{actual ? "适应窗口" : "1:1"}</span>
        </button>
        <DownloadButton src={src} name={name} label className="lightbox-btn" />
        <button type="button" className="lightbox-btn" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
          <X size={16} />
        </button>
      </div>
      <div className={`lightbox-stage${actual ? " is-actual" : ""}`} onClick={closeOnBackdrop}>
        <MediaImg src={src} fallbacks={fallbacks} alt="" className="lightbox-img" />
      </div>
    </div>,
    document.body,
  );
}

/** 列表 / 网格 / 对话里的图：显示服务端预览图（最高 400px，等比），点开看原图 */
export function MediaThumb({
  src,
  name,
  alt = "",
  className = "",
  fallbacks = [],
}: {
  src: string;
  name: string;
  alt?: string;
  className?: string;
  fallbacks?: string[];
}) {
  const [open, setOpen] = useState(false);
  const preview = mediaVariantUrl(src, "preview");
  const chain = preview !== src ? [src, ...fallbacks] : fallbacks;
  return (
    <>
      <MediaImg
        src={preview}
        fallbacks={chain}
        alt={alt}
        className={`media-thumb ${className}`.trim()}
        title="点击查看原图"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      />
      {open ? <MediaLightbox src={src} name={name} fallbacks={fallbacks} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
