import { useState } from "react";
import { desktopZipUrl } from "./api.js";
import type { BetaOffer, Entitlement } from "./types.js";

const ANNOUNCE_KEY = "agnes_beta_announce_dismissed";
const REWARD_KEY = "agnes_beta_reward_dismissed";

function dismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* 隐私模式写不进也只是下次再看到 */
  }
}

function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function quotaLine(beta: BetaOffer): string {
  return `${beta.planName}（${beta.durationDays} 天，对话 ${beta.chatQuota} 次、图片 ${beta.imageQuota} 张、视频 ${beta.videoQuota} 条）`;
}

export function WebBetaNotice({ beta, downloadUrl }: { beta: BetaOffer | null | undefined; downloadUrl?: string }) {
  const [hidden, setHidden] = useState(() => dismissed(ANNOUNCE_KEY));
  if (!beta?.open || hidden) return null;
  const href = downloadUrl || desktopZipUrl();
  return (
    <aside className="beta-banner" role="status">
      <div>
        <strong>公测公告</strong>
        <p>
          首次使用桌面客户端可以领取一张{quotaLine(beta)}，领取后立即开通。使用中提交反馈，问题被采纳后会按相应天数延长使用时间。
        </p>
      </div>
      <div className="beta-banner-actions">
        <a className="btn btn-primary" href={href}>
          下载桌面客户端
        </a>
        <button
          type="button"
          className="btn"
          onClick={() => {
            remember(ANNOUNCE_KEY);
            setHidden(true);
          }}
        >
          知道了
        </button>
      </div>
    </aside>
  );
}

export function DesktopBetaNotice({
  beta,
  entitlement,
  onClaim,
  onFeedback,
}: {
  beta: BetaOffer | null | undefined;
  entitlement: Entitlement | null;
  onClaim: () => Promise<void>;
  onFeedback: () => void;
}) {
  const [rewardHidden, setRewardHidden] = useState(() => dismissed(REWARD_KEY));
  const [claiming, setClaiming] = useState(false);
  const [err, setErr] = useState("");
  if (!beta) return null;

  if (beta.eligible && entitlement?.plan !== "licensed") {
    return (
      <aside className="beta-banner" role="status">
        <div>
          <strong>公测可领月卡</strong>
          <p>
            这台设备可以领取一张{quotaLine(beta)}，领取后立即开通。反馈被采纳后，会在到期日上增加相应天数（默认每次 {beta.rewardDays} 天）。
          </p>
          {err ? <p className="beta-banner-error">{err}</p> : null}
        </div>
        <div className="beta-banner-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={claiming}
            onClick={() => {
              setErr("");
              setClaiming(true);
              void onClaim()
                .then(() => {
                  forget(REWARD_KEY);
                  setRewardHidden(false);
                })
                .catch((error: unknown) => {
                  setErr(error instanceof Error ? error.message : String(error));
                })
                .finally(() => setClaiming(false));
            }}
          >
            {claiming ? "开通中…" : "领取并开通"}
          </button>
        </div>
      </aside>
    );
  }

  if (!beta.claimed || entitlement?.plan !== "licensed" || entitlement.status === "revoked" || rewardHidden) return null;
  const until = entitlement.expiresAt
    ? new Date(entitlement.expiresAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })
    : "";
  return (
    <aside className="beta-banner" role="status">
      <div>
        <strong>公测月卡已开通</strong>
        <p>
          {until ? `有效至 ${until}。` : ""}
          到「反馈」提交使用中的问题，被采纳后会在到期日上增加相应天数（默认每次 {beta.rewardDays} 天）。
        </p>
      </div>
      <div className="beta-banner-actions">
        <button type="button" className="btn btn-primary" onClick={onFeedback}>
          去反馈
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            remember(REWARD_KEY);
            setRewardHidden(true);
          }}
        >
          知道了
        </button>
      </div>
    </aside>
  );
}
