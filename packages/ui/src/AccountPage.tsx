import { useState } from "react";
import { activateLicense, loginCloud, logoutCloud, registerCloud } from "./api.js";
import { licenseSummary } from "./entitlement.js";
import type { Entitlement, Settings } from "./types.js";

export function AccountPage({
  settings,
  entitlement,
  cloudUser,
  onEntitlement,
  onCloudUser,
  onRefresh,
}: {
  settings: Settings;
  entitlement: Entitlement | null;
  cloudUser: { username: string } | null;
  onEntitlement: (e: Entitlement) => void;
  onCloudUser: (user: { username: string } | null) => void;
  onRefresh?: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [activated, setActivated] = useState("");

  async function afterSign(user: { username: string }) {
    onCloudUser(user);
    try {
      if (!code.trim()) return;
      const next = await activateLicense(code.trim());
      onEntitlement(next.entitlement);
      setCode("");
      setActivated("已激活");
    } finally {
      await onRefresh?.();
    }
  }

  return (
    <div className="settings">
      <h2>{cloudUser ? "账户" : "登录"}</h2>
      <p className="hint">
        {settings.desktopMode
          ? "账号在网页和桌面是同一个。登录后激活码记在这个账号上，换电脑不用再贴一次。"
          : "账号在网页和桌面是同一个。登录后可以激活卡密。网页不能使用 Agent，也不能改本地文件。"}
      </p>
      {entitlement ? (
        <p className="hint">
          {entitlement.plan === "licensed"
            ? licenseSummary(entitlement)
            : settings.desktopMode
              ? `试用 ${entitlement.chatUsed}/${entitlement.chatQuota}，剩余 ${entitlement.remaining ?? 0} 次。`
              : "还没激活。未登录时按每天的免费额度使用。"}
        </p>
      ) : null}
      <form
        className="card"
        style={{ padding: 12, marginTop: 16 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setErr("");
          setActivated("");
          if (!cloudUser) {
            setErr("请先登录或注册");
            return;
          }
          if (!code.trim()) {
            setErr("请先填写卡密");
            return;
          }
          try {
            const next = await activateLicense(code.trim());
            onEntitlement(next.entitlement);
            setCode("");
            setActivated(entitlement?.plan === "licensed" ? "已续期" : "激活成功");
          } catch (error) {
            setErr(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        {cloudUser ? (
          <div className="hint">
            当前账号 {cloudUser.username}
            <button
              className="btn"
              style={{ marginLeft: 8 }}
              type="button"
              onClick={() => {
                void logoutCloud().then(() => {
                  onCloudUser(null);
                  setActivated("");
                });
              }}
            >
              退出
            </button>
          </div>
        ) : (
          <>
            <input
              className="field"
              style={{ width: "100%", margin: "8px 0" }}
              placeholder="账号"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              className="field"
              style={{ width: "100%", margin: "0 0 8px" }}
              placeholder="密码"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => {
                  setErr("");
                  void loginCloud(username.trim(), password)
                    .then((res) => afterSign(res.user))
                    .catch((error: unknown) => setErr(error instanceof Error ? error.message : String(error)));
                }}
              >
                登录
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setErr("");
                  void registerCloud(username.trim(), password)
                    .then((res) => afterSign(res.user))
                    .catch((error: unknown) => setErr(error instanceof Error ? error.message : String(error)));
                }}
              >
                注册
              </button>
            </div>
          </>
        )}
        <div style={{ fontWeight: 600, margin: "14px 0 6px" }}>
          {entitlement?.plan === "licensed" ? "续期 / 换卡" : "激活卡密"}
        </div>
        <div className="hint">
          {cloudUser
            ? "卡密记在这个账号上。填了卡密再点登录或注册，会一并激活。"
            : "先登录。如果输入框里已经写了卡密，登录或注册成功后会直接激活。"}
        </div>
        <input
          className="field"
          style={{ width: "100%", margin: "8px 0" }}
          placeholder="卡密（可选，登录时一并激活）"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={!cloudUser}>
          {entitlement?.plan === "licensed" ? "续期" : "激活卡密"}
        </button>
        {activated ? <span className="hint" style={{ marginLeft: 8 }}>{activated}</span> : null}
      </form>
      {err ? <div className="error">{err}</div> : null}
    </div>
  );
}
