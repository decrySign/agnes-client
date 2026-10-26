import { desktopZipUrl } from "./api.js";

export function DesktopPromo({
  downloadUrl,
  compact = false,
}: {
  downloadUrl?: string;
  compact?: boolean;
}) {
  const href = downloadUrl || desktopZipUrl();
  return (
    <aside className={compact ? "promo promo-compact" : "promo"}>
      <div className="promo-kicker">桌面版 · 付费</div>
      <p>网页只能对话。Agent、读写本地文件只在付费桌面客户端里。</p>
      <a className="btn btn-primary" href={href}>
        下载桌面客户端
      </a>
    </aside>
  );
}
