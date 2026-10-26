import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { createProvider, getMcpStatus, probeProvider, reloadMcp, removeProvider, saveSettings, updateProvider, type McpServerInfo } from "./api.js";
import { DesktopPromo } from "./DesktopPromo.js";
import { APPROVAL_MODES, type ApprovalMode, type ModelCapsInput, type ModelCapsView, type ModelProvider, type Settings, type ThinkingLevel } from "./types.js";
import { TOOL_TIMEOUT_FIELDS, timeoutDraft, timeoutsFromDraft } from "./tool-timeouts.js";

const PROTOCOLS: Array<{ id: ModelProvider["protocol"]; label: string }> = [
  { id: "openai-completions", label: "openai-completions" },
  { id: "openai-responses", label: "openai-responses" },
  { id: "anthropic-messages", label: "anthropic-messages" },
];

const THINKING_LABEL: Record<ThinkingLevel, string> = { off: "关闭", low: "低", medium: "中", high: "高" };
const ALL_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

/** 能力表单的草稿：都是字符串，空 = 不填（按官方文档或保守默认） */
type CapsDraft = { contextWindow: string; maxTokens: string; supportsImages: "" | "yes" | "no"; thinking: "" | ThinkingLevel; compact: string };
const EMPTY_CAPS: CapsDraft = { contextWindow: "", maxTokens: "", supportsImages: "", thinking: "", compact: "" };

/** 压缩阈值输入框：「60%」= 占窗口的比例，纯数字 = token 数，留空 = 默认 */
function compactOf(text: string): { compactRatio: number | null; compactTokens: number | null } {
  const t = text.trim();
  if (/^\d+(?:\.\d+)?%$/.test(t)) return { compactRatio: Number(t.slice(0, -1)) / 100, compactTokens: null };
  if (/^\d+$/.test(t)) return { compactRatio: null, compactTokens: Number(t) };
  return { compactRatio: null, compactTokens: null };
}

export function compactFieldError(text: string, contextWindow: number): string {
  const t = text.trim();
  if (!t) return "";
  if (/^\d+(?:\.\d+)?%$/.test(t)) {
    const pct = Number(t.slice(0, -1));
    return pct >= 5 && pct <= 95 ? "" : "压缩阈值的百分比要在 5% 到 95% 之间";
  }
  if (!/^\d+$/.test(t)) return "压缩阈值写百分比（如 60%）或 token 数（如 200000），留空用默认";
  const n = Number(t);
  if (n < 4096) return "压缩阈值的 token 数不能小于 4,096";
  if (contextWindow && n >= contextWindow) return `压缩阈值 ${fmtTokens(n)} 要小于上下文窗口 ${fmtTokens(contextWindow)}`;
  return "";
}

function draftOf(caps?: ModelCapsInput): CapsDraft {
  return {
    contextWindow: caps?.contextWindow ? String(caps.contextWindow) : "",
    maxTokens: caps?.maxTokens ? String(caps.maxTokens) : "",
    supportsImages: caps?.supportsImages === undefined ? "" : caps.supportsImages ? "yes" : "no",
    thinking: caps?.thinking ?? "",
    compact: caps?.compactTokens ? String(caps.compactTokens) : caps?.compactRatio ? `${Number((caps.compactRatio * 100).toFixed(2))}%` : "",
  };
}

/** 发给服务端：空的发 null，服务端当没填 */
function draftToInput(draft: CapsDraft): Record<string, unknown> {
  return {
    contextWindow: draft.contextWindow.trim() ? Number(draft.contextWindow.trim()) : null,
    maxTokens: draft.maxTokens.trim() ? Number(draft.maxTokens.trim()) : null,
    supportsImages: draft.supportsImages === "" ? null : draft.supportsImages === "yes",
    thinking: draft.thinking || null,
    ...compactOf(draft.compact),
  };
}

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** 整数输入框：留空 = 不填；带小数点或其他字符就报错，不偷偷剥掉（4096.5 不能变成 40965） */
export function intFieldError(text: string): string {
  const t = text.trim();
  return !t || /^\d+$/.test(t) ? "" : "必须是整数";
}

/** 保存前检查一行能力：窗口、输出必须是整数；最大输出不能大于生效窗口（填的，没填就是文档或默认） */
export function capsDraftError(label: string, draft: CapsDraft, effective?: ModelCapsView): string {
  if (intFieldError(draft.contextWindow)) return `${label}：上下文窗口必须是整数`;
  if (intFieldError(draft.maxTokens)) return `${label}：最大输出必须是整数`;
  const mt = draft.maxTokens.trim() ? Number(draft.maxTokens.trim()) : 0;
  const cw = draft.contextWindow.trim() ? Number(draft.contextWindow.trim()) : 0;
  const compactErr = compactFieldError(draft.compact, cw || effective?.fallback?.contextWindow || 0);
  if (compactErr) return `${label}：${compactErr}`;
  if (!mt) return "";
  if (cw) return mt > cw ? `${label}：最大输出 ${fmtTokens(mt)} 不能大于上下文窗口 ${fmtTokens(cw)}` : "";
  const base = effective?.fallback;
  if (base && mt > base.contextWindow) {
    return `${label}：最大输出 ${fmtTokens(mt)} 大于生效的上下文窗口 ${fmtTokens(base.contextWindow)}（${base.origin === "docs" ? "官方文档值" : "没查到文档，保守默认值"}），请调小最大输出，或同时填一个更大的上下文窗口`;
  }
  return "";
}

const ORIGIN_LABEL = { config: "设置", docs: "文档", default: "默认" } as const;

/** 一行能力摘要，设置页和提供方卡片共用 */
export function capsSummary(caps: ModelCapsView | undefined): string {
  if (!caps) return "";
  const img = caps.supportsImages === true ? "支持图片" : caps.supportsImages === false ? "不支持图片" : "图片未知";
  const think = caps.thinking ? `思考 ${THINKING_LABEL[caps.thinking]}` : "思考按上游默认";
  const guess = caps.origin.contextWindow === "default" || caps.origin.maxTokens === "default" ? "（没查到文档，窗口/输出用保守默认）" : "";
  const compact = caps.compactThreshold ? `压缩阈值 ${fmtTokens(caps.compactThreshold)} token` : "压缩按默认";
  return `窗口 ${fmtTokens(caps.contextWindow)}（${ORIGIN_LABEL[caps.origin.contextWindow]}）· 输出上限 ${fmtTokens(caps.maxTokens)}（${ORIGIN_LABEL[caps.origin.maxTokens]}）· ${img} · ${think} · ${compact}${guess}`;
}

function CapsRow({
  label,
  draft,
  effective,
  onChange,
}: {
  label: string;
  draft: CapsDraft;
  effective?: ModelCapsView;
  onChange: (next: CapsDraft) => void;
}) {
  const hold = (origin: ModelCapsView["origin"]["contextWindow"] | undefined, n: number | undefined) =>
    effective && n && origin !== "config" ? `${origin === "docs" ? "文档" : "默认"} ${fmtTokens(n)}` : "留空自动";
  const imgAuto = effective && effective.origin.supportsImages !== "config"
    ? effective.supportsImages === true
      ? "自动（文档：支持）"
      : effective.supportsImages === false
        ? "自动（文档：不支持）"
        : "自动（未知，按支持处理）"
    : "自动";
  const levels = effective?.thinkingLevels ?? ALL_LEVELS;
  const rowErr = capsDraftError(label, draft, effective);
  return (
    <div className="caps-row" data-model={label} style={{ borderTop: "1px solid rgba(127,127,127,0.2)", paddingTop: 8, marginTop: 8 }}>
      <div className="hint" style={{ fontWeight: 600 }}>
        {label}
        {effective?.source ? (
          <a href={effective.source} target="_blank" rel="noreferrer" style={{ marginLeft: 8, fontWeight: 400 }}>
            文档
          </a>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
        <label className="hint" style={{ flex: "1 1 120px" }}>
          上下文窗口
          <input
            className="field caps-context"
            style={{ width: "100%", marginTop: 4 }}
            inputMode="numeric"
            value={draft.contextWindow}
            placeholder={hold(effective?.origin.contextWindow, effective?.contextWindow)}
            onChange={(e) => onChange({ ...draft, contextWindow: e.target.value })}
          />
        </label>
        <label className="hint" style={{ flex: "1 1 120px" }}>
          最大输出
          <input
            className="field caps-max"
            style={{ width: "100%", marginTop: 4 }}
            inputMode="numeric"
            value={draft.maxTokens}
            placeholder={hold(effective?.origin.maxTokens, effective?.maxTokens)}
            onChange={(e) => onChange({ ...draft, maxTokens: e.target.value })}
          />
        </label>
        <label className="hint" style={{ flex: "1 1 120px" }} title="发给模型的上下文超过这个量就压缩。写百分比（占窗口，如 60%）或 token 数（如 200000）；留空用默认（约 3.6 万字）">
          压缩阈值
          <input
            className="field caps-compact"
            style={{ width: "100%", marginTop: 4 }}
            value={draft.compact}
            placeholder="留空默认，如 60% 或 200000"
            onChange={(e) => onChange({ ...draft, compact: e.target.value })}
          />
        </label>
        <label className="hint" style={{ flex: "1 1 120px" }}>
          图片输入
          <select
            className="select caps-images"
            style={{ width: "100%", marginTop: 4 }}
            value={draft.supportsImages}
            onChange={(e) => onChange({ ...draft, supportsImages: e.target.value as CapsDraft["supportsImages"] })}
          >
            <option value="">{imgAuto}</option>
            <option value="yes">支持</option>
            <option value="no">不支持</option>
          </select>
        </label>
        <label className="hint" style={{ flex: "1 1 120px" }}>
          思考档位
          <select
            className="select caps-thinking"
            style={{ width: "100%", marginTop: 4 }}
            value={draft.thinking}
            disabled={!levels.length}
            onChange={(e) => onChange({ ...draft, thinking: e.target.value as CapsDraft["thinking"] })}
          >
            <option value="">{levels.length ? "上游默认" : "这个模型不支持调节"}</option>
            {levels.map((level) => (
              <option key={level} value={level}>
                {THINKING_LABEL[level]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {rowErr ? <div className="error caps-error">{rowErr}</div> : null}
    </div>
  );
}

/** 内置（Agnes 官方渠道）模型的能力：默认取官方文档，可以在这里改 */
function BuiltinCapsSection({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const builtin = settings.models.chat.filter((m) => !m.startsWith("custom|"));
  const [open, setOpen] = useState(false);
  const [caps, setCaps] = useState<Record<string, CapsDraft>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!builtin.length) return null;
  return (
    <section className="builtin-caps" style={{ marginTop: 28 }}>
      <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>内置模型能力</h3>
      <p className="hint">上下文窗口、最大输出、图片和思考档位默认取 Agnes 官方文档。请求的输出上限 = min(最大输出, 窗口 − 估算输入 − 4096)。</p>
      {open ? (
        <div className="card" style={{ padding: 12, marginTop: 10 }}>
          {builtin.map((m) => (
            <CapsRow key={m} label={m} draft={caps[m] ?? EMPTY_CAPS} effective={settings.modelCaps?.[m]} onChange={(d) => setCaps((cur) => ({ ...cur, [m]: d }))} />
          ))}
          {err ? <div className="error">{err}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              className="btn btn-primary builtin-caps-save"
              type="button"
              disabled={busy}
              onClick={() => {
                const bad = builtin.map((m) => capsDraftError(m, caps[m] ?? EMPTY_CAPS, settings.modelCaps?.[m])).find(Boolean);
                if (bad) {
                  setErr(bad);
                  return;
                }
                setBusy(true);
                setErr("");
                void saveSettings({ builtinModelCaps: Object.fromEntries(builtin.map((m) => [m, draftToInput(caps[m] ?? EMPTY_CAPS)])) })
                  .then((next) => {
                    onChange(next);
                    setOpen(false);
                  })
                  .catch((error: unknown) => setErr(error instanceof Error ? error.message : String(error)))
                  .finally(() => setBusy(false));
              }}
            >
              保存
            </button>
            <button className="btn" type="button" onClick={() => setOpen(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          {builtin.map((m) => (
            <div key={m} className="hint caps-summary" data-model={m}>
              {m}：{capsSummary(settings.modelCaps?.[m])}
            </div>
          ))}
          <button
            className="btn builtin-caps-edit"
            type="button"
            style={{ marginTop: 8 }}
            onClick={() => {
              setCaps(Object.fromEntries(builtin.map((m) => [m, draftOf(settings.builtinModelCaps?.[m])])));
              setErr("");
              setOpen(true);
            }}
          >
            编辑能力
          </button>
        </>
      )}
    </section>
  );
}

export function modelLabel(id: string, providers: ModelProvider[] | undefined): string {
  if (!id.startsWith("custom|")) return id;
  const rest = id.slice("custom|".length);
  const cut = rest.indexOf("|");
  const providerId = cut > 0 ? rest.slice(0, cut) : "";
  const model = cut > 0 ? rest.slice(cut + 1) : id;
  const name = providers?.find((provider) => provider.id === providerId)?.name || providerId;
  return `${name} · ${model}`;
}

export function SettingsPage({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [workspace, setWorkspace] = useState(settings.workspaceRoot ?? "");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(settings.approvalMode ?? "suggest");
  const [commandAllow, setCommandAllow] = useState(settings.commandAllow ?? "");
  const [toolTimeouts, setToolTimeouts] = useState(() => timeoutDraft(settings.toolTimeouts));
  const [chatModel, setChatModel] = useState(settings.chatModel);
  const [modelErr, setModelErr] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [updateMsg, setUpdateMsg] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [tab, setTab] = useState<"general" | "models" | "mcp">("general");
  const [mcpServers, setMcpServers] = useState<McpServerInfo[] | null>(null);
  const [mcpErr, setMcpErr] = useState("");
  const [mcpBusy, setMcpBusy] = useState(false);

  // onClose 每次渲染都是新函数：放进 ref，监听只挂一次
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // 删掉 provider 后服务端会把默认模型改回内置的，这里跟上
  useEffect(() => {
    setChatModel(settings.chatModel);
  }, [settings.chatModel]);

  useEffect(() => {
    void window.agnesDesktop?.appVersion?.().then(setAppVersion).catch(() => {});
  }, []);
  useEffect(() => {
    setApprovalMode(settings.approvalMode ?? "suggest");
    setCommandAllow(settings.commandAllow ?? "");
  }, [settings.approvalMode, settings.commandAllow]);
  useEffect(() => {
    setToolTimeouts(timeoutDraft(settings.toolTimeouts));
  }, [settings.toolTimeouts]);
  useEffect(() => {
    if (tab !== "mcp") return;
    setMcpErr("");
    void getMcpStatus()
      .then((r) => setMcpServers(r.servers))
      .catch((error: unknown) => setMcpErr(error instanceof Error ? error.message : String(error)));
  }, [tab]);

  return (
    <div className="settings-layer" onMouseDown={onClose}>
      <div className="settings-window" role="dialog" aria-modal="true" aria-label="设置" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-window-bar">
          <strong>设置</strong>
          <button type="button" className="ghost-icon" aria-label="关闭设置" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="settings-window-body">
          <nav className="settings-window-nav" aria-label="设置分类">
            <button type="button" className={tab === "general" ? "is-on" : ""} onClick={() => setTab("general")}>
              通用设置
            </button>
            <button type="button" className={tab === "models" ? "is-on" : ""} onClick={() => setTab("models")}>
              模型
            </button>
            <button type="button" className={tab === "mcp" ? "is-on" : ""} onClick={() => setTab("mcp")}>
              MCP
            </button>
          </nav>
          <div className="settings">
      {tab === "general" ? (
      <>
      {settings.desktopMode ? (
        <>
          <p className="hint">终端只存在于本机客户端。Agent 读写的是你选的本机文件夹。</p>
          {appVersion || window.agnesDesktop ? (
            <div className="hint" style={{ marginTop: 8 }}>
              <div>
                当前版本 {appVersion || "…"}。启动约 20 秒后会自动检查，之后每 6 小时再查。有新版本会弹出下载进度，完成并校验后才重启。
              </div>
              {window.agnesDesktop?.checkUpdate ? (
                <div className="toolbar" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={checkingUpdate}
                    onClick={async () => {
                      setCheckingUpdate(true);
                      setUpdateMsg("");
                      try {
                        const next = await window.agnesDesktop!.checkUpdate!();
                        setUpdateMsg(next.message);
                      } catch (error) {
                        setUpdateMsg(error instanceof Error ? error.message : String(error));
                      } finally {
                        setCheckingUpdate(false);
                      }
                    }}
                  >
                    {checkingUpdate ? "正在检查…" : "检查更新"}
                  </button>
                </div>
              ) : null}
              {updateMsg ? <p style={{ marginTop: 8 }}>{updateMsg}</p> : null}
            </div>
          ) : null}
          <p className="hint">
            当前：终端 {settings.allowTerminal ? "开" : "关"} · Agent 写文件 {settings.allowWrites === false ? "关" : "开"}
          </p>
          <p className="hint">
            {`对话只写在本机 SQLite${settings.dataDir ? `（${settings.dataDir}）` : ""}。试用次数${settings.licenseRemote ? "在授权服务器上扣" : "在本机库（开发模式，删库会重置）"}。`}
          </p>
        </>
      ) : (
        <>
          <p className="hint">登录和卡密在「账户」。模型在左边的「模型」。</p>
          <DesktopPromo downloadUrl={settings.desktopDownloadUrl} />
        </>
      )}
      </>
      ) : null}
      {tab === "models" ? (
      <>
      {settings.desktopMode ? (
        <label className="hint" style={{ display: "block", marginTop: 16 }}>
          <div>新对话默认模型</div>
          <select
            className="select"
            style={{ width: "100%", marginTop: 6 }}
            value={chatModel}
            onChange={(e) => {
              const value = e.target.value;
              setChatModel(value);
              setModelErr("");
              void saveSettings({ chatModel: value })
                .then(onChange)
                .catch((error: unknown) => {
                  setChatModel(settings.chatModel);
                  setModelErr(error instanceof Error ? error.message : String(error));
                });
            }}
          >
            {settings.models.chat.map((m) => (
              <option key={m} value={m}>
                {modelLabel(m, settings.providers)}
              </option>
            ))}
          </select>
          {modelErr ? <p className="card-error">{modelErr}</p> : null}
          <p className="hint">只影响之后新建的对话。已有对话在输入框下方单独换。自定义模型走你填的地址，不占用 Agnes 的对话次数。</p>
        </label>
      ) : (
        <p className="hint" style={{ marginTop: 16 }}>
          网页版的默认模型由部署方设置。每个对话可以在输入框下方单独换模型。
        </p>
      )}
      {settings.desktopMode ? <BuiltinCapsSection settings={settings} onChange={onChange} /> : null}
      {settings.desktopMode ? <ProviderSection settings={settings} onChange={onChange} /> : null}
      </>
      ) : null}
      {tab === "mcp" ? (
      <>
        <p className="hint" style={{ marginTop: 16 }}>
          MCP（Model Context Protocol）通过本地 stdio 进程扩展工具。配置文件：数据目录下的 mcp.json，或工作区 .agnes/mcp.json。改完点「重新加载」或重启客户端。详见 docs/mcp.md。
        </p>
        <p className="hint">子 Agent 也能使用 MCP 工具。MCP 进程以当前用户权限运行，只添加你信任的服务器。</p>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn"
            disabled={mcpBusy}
            onClick={() => {
              setMcpBusy(true);
              setMcpErr("");
              void reloadMcp()
                .then((r) => setMcpServers(r.servers))
                .catch((error: unknown) => setMcpErr(error instanceof Error ? error.message : String(error)))
                .finally(() => setMcpBusy(false));
            }}
          >
            {mcpBusy ? "重新加载中…" : "重新加载"}
          </button>
        </div>
        {mcpErr ? <p className="card-error">{mcpErr}</p> : null}
        {mcpServers && mcpServers.length === 0 ? <p className="hint" style={{ marginTop: 12 }}>当前没有配置 MCP 服务器。</p> : null}
        {mcpServers && mcpServers.length > 0 ? (
          <ul className="hint" style={{ marginTop: 12, paddingLeft: 18 }}>
            {mcpServers.map((s) => (
              <li key={s.name} style={{ marginBottom: 6 }}>
                <strong>{s.name}</strong>
                {" · "}
                {s.status === "connected" ? "已连接" : s.status === "error" ? "出错" : "未连接"}
                {" · "}
                {s.tools} 个工具
                {s.error ? ` · ${s.error}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </>
      ) : null}
      {tab === "general" && settings.desktopMode ? (
        <label className="hint" style={{ display: "block", marginTop: 16 }}>
          <div>Agent 审批</div>
          <select
            className="select"
            style={{ width: "100%", marginTop: 6 }}
            value={approvalMode}
            onChange={(e) => setApprovalMode(e.target.value as ApprovalMode)}
          >
            {APPROVAL_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.hint}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {tab === "general" && settings.desktopMode ? (
        <label className="hint" style={{ display: "block", marginTop: 16 }}>
          <div>命令允许规则</div>
          <textarea
            className="field"
            style={{ width: "100%", marginTop: 6, minHeight: 140, resize: "vertical" }}
            value={commandAllow}
            onChange={(e) => setCommandAllow(e.target.value)}
            spellCheck={false}
          />
          <p className="hint" style={{ marginTop: 6 }}>
            一行一条，按前缀匹配。「只问命令」里这些会直接跑。「每次都问」仍然全部确认。删除、联网、git push 写进来也会被丢掉，全自动下仍要询问。
          </p>
        </label>
      ) : null}
      {tab === "general" && settings.desktopMode ? (
        <div className="hint" style={{ marginTop: 16 }}>
          <div>工具超时（秒，留空 = 内置默认）</div>
          {TOOL_TIMEOUT_FIELDS.map((f) => (
            <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
              <span style={{ flex: 1 }}>{f.label}</span>
              <input
                className="field"
                style={{ width: 110 }}
                inputMode="decimal"
                placeholder={`默认 ${f.def}`}
                value={toolTimeouts[f.key] ?? ""}
                onChange={(e) => setToolTimeouts((m) => ({ ...m, [f.key]: e.target.value }))}
              />
            </label>
          ))}
          <p className="hint" style={{ marginTop: 6 }}>
            到点只停这一次调用，卡片标红，结果交给模型。读写文件、提问、子 Agent 不设超时；模型自己给了 timeout_ms 的命令以它为准（最长 5 分钟）。
          </p>
        </div>
      ) : null}
      {tab === "general" && settings.desktopMode ? (
        <>
          {settings.relayManaged ? (
            <p className="hint" style={{ marginTop: 16 }}>
              模型调用由授权服务器代发，卡密即可使用，不需要自备 API Key。
            </p>
          ) : (
            <label className="hint" style={{ display: "block", marginTop: 16 }}>
              <div>Agnes API Key（本机保存）</div>
              <input
                type="password"
                className="field"
                style={{ width: "100%", marginTop: 6 }}
                placeholder={settings.hasApiKey ? "已配置，留空则不修改" : "粘贴 Token Plan 密钥"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
          )}
          <label className="hint" style={{ display: "block", marginTop: 16 }}>
            <div>本机工作区</div>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <input className="field" style={{ flex: 1 }} value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
              <button
                className="btn"
                onClick={async () => {
                  const picked = await window.agnesDesktop?.pickFolder();
                  if (picked) setWorkspace(picked);
                }}
              >
                浏览
              </button>
            </div>
          </label>
        </>
      ) : null}
      {tab === "general" ? (
        <>
      <button
        className="btn btn-primary"
        style={{ marginTop: 20 }}
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            // 先校验超时，填错了直接提示，密钥也不先存
            const timeouts = settings.desktopMode ? timeoutsFromDraft(toolTimeouts, settings.toolTimeouts) : undefined;
            if (apiKey && window.agnesDesktop) await window.agnesDesktop.saveSecret(apiKey);
            const next = await saveSettings(
              settings.desktopMode
                ? { chatModel, approvalMode, commandAllow, toolTimeouts: timeouts, workspaceRoot: workspace, ...(apiKey ? { apiKey } : {}) }
                : {},
            );
            onChange(next);
            setApiKey("");
            setSaved("已保存");
            setTimeout(() => setSaved(""), 2000);
          } catch (error) {
            setSaved(`没保存上：${error instanceof Error ? error.message : String(error)}`);
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? "正在保存…" : "保存"}
      </button>
      {saved ? <span className="hint">{saved}</span> : null}
        </>
      ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProviderSection({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState("");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState<ModelProvider["protocol"]>("openai-completions");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelDraft, setModelDraft] = useState("");
  const [timeoutSec, setTimeoutSec] = useState("");
  const [idleSec, setIdleSec] = useState("");
  const [caps, setCaps] = useState<Record<string, CapsDraft>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");

  function reset(provider?: ModelProvider) {
    setEditing(provider?.id || "");
    setId(provider?.id || "");
    setName(provider?.name || "");
    setBaseUrl(provider?.baseUrl || "");
    setProtocol(provider?.protocol || "openai-completions");
    setApiKey("");
    setModels(provider?.models || []);
    setModelDraft("");
    setTimeoutSec(provider?.timeoutMs ? String(Math.round(provider.timeoutMs / 1000)) : "");
    setIdleSec(provider?.streamIdleTimeoutMs ? String(Math.round(provider.streamIdleTimeoutMs / 1000)) : "");
    setCaps(Object.fromEntries(Object.entries(provider?.modelCaps ?? {}).map(([m, c]) => [m, draftOf(c)])));
    setErr("");
    setOpen(true);
  }

  async function save() {
    const timeoutBad = intFieldError(timeoutSec) ? "首包超时必须是整数（秒）" : intFieldError(idleSec) ? "流空闲超时必须是整数（秒）" : "";
    const capsBad = models.map((m) => capsDraftError(m, caps[m] ?? EMPTY_CAPS, settings.modelCaps?.[`custom|${editing || id}|${m}`])).find(Boolean);
    if (timeoutBad || capsBad) {
      setErr(timeoutBad || capsBad || "");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const toMs = (v: string) => (v.trim() ? Number(v.trim()) * 1000 : null);
      // 输入框没动过（还是打开时显示的整秒数）就原样保留存储的毫秒值，避免 5500 被四舍五入成 6000
      const keepMs = (text: string, orig?: number) =>
        orig && text === String(Math.round(orig / 1000)) ? orig : toMs(text);
      const provider = editing ? (settings.providers || []).find((p) => p.id === editing) : undefined;
      const body = {
        id,
        name,
        baseUrl,
        protocol,
        apiKey,
        models,
        timeoutMs: keepMs(timeoutSec, provider?.timeoutMs),
        streamIdleTimeoutMs: keepMs(idleSec, provider?.streamIdleTimeoutMs),
        modelCaps: Object.fromEntries(models.map((m) => [m, draftToInput(caps[m] ?? EMPTY_CAPS)])),
      };
      const next = editing ? await updateProvider(editing, body) : await createProvider(body);
      onChange(next);
      setOpen(false);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginTop: 28 }}>
      <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>自定义模型</h3>
      <p className="hint">密钥加密保存在这台电脑。三种协议都能用 Agent 和工具调用。改了 API 地址的域名，要重新填写密钥。</p>
      {(settings.providers || []).map((provider) => (
        <div key={provider.id} className="card" style={{ padding: 12, marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <div>
              <b>{provider.name}</b>
              <span className="hint" style={{ marginLeft: 8 }}>
                {provider.protocol}
                {provider.hasKey ? " · 已保存密钥" : ""}
              </span>
              <div className="hint">{provider.baseUrl}</div>
              <div className="hint">{provider.models.length ? provider.models.join("、") : "还没有模型：点「编辑」添加模型 ID 后才能选用"}</div>
              {provider.models.map((m) => (
                <div key={m} className="hint caps-summary" data-model={m}>
                  {m}：{capsSummary(settings.modelCaps?.[`custom|${provider.id}|${m}`])}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" type="button" onClick={() => reset(provider)}>
                编辑
              </button>
              {confirmDelete === provider.id ? (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    void removeProvider(provider.id)
                      .then(onChange)
                      .catch((error: unknown) => setErr(error instanceof Error ? error.message : String(error)));
                    setConfirmDelete("");
                  }}
                >
                  确认删除
                </button>
              ) : (
                <button className="btn" type="button" onClick={() => setConfirmDelete(provider.id)}>
                  删除
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
      {open ? (
        <div className="card" style={{ padding: 12, marginTop: 10 }}>
          <label className="hint" style={{ display: "block" }}>
            Provider ID
            <input className="field" style={{ width: "100%", marginTop: 6 }} value={id} disabled={Boolean(editing)} placeholder="acme-gateway" onChange={(e) => setId(e.target.value)} />
          </label>
          <p className="hint">以小写字母开头，用来区分提供方。</p>
          <label className="hint" style={{ display: "block", marginTop: 10 }}>
            显示名称
            <input className="field" style={{ width: "100%", marginTop: 6 }} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="hint" style={{ display: "block", marginTop: 10 }}>
            API 地址
            <input className="field" style={{ width: "100%", marginTop: 6 }} value={baseUrl} placeholder="https://gateway.example/v1" onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <label className="hint" style={{ display: "block", marginTop: 10 }}>
            API 协议
            <select className="select" style={{ width: "100%", marginTop: 6 }} value={protocol} onChange={(e) => setProtocol(e.target.value as ModelProvider["protocol"])}>
              {PROTOCOLS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <label className="hint" style={{ display: "block", flex: 1 }}>
              首包超时（秒）
              <input
                className="field"
                style={{ width: "100%", marginTop: 6 }}
                inputMode="numeric"
                value={timeoutSec}
                placeholder="留空用默认"
                onChange={(e) => setTimeoutSec(e.target.value)}
              />
              {intFieldError(timeoutSec) ? <span className="error timeout-error">必须是整数</span> : null}
            </label>
            <label className="hint" style={{ display: "block", flex: 1 }}>
              流空闲超时（秒）
              <input
                className="field"
                style={{ width: "100%", marginTop: 6 }}
                inputMode="numeric"
                value={idleSec}
                placeholder="留空用默认"
                onChange={(e) => setIdleSec(e.target.value)}
              />
              {intFieldError(idleSec) ? <span className="error timeout-error">必须是整数</span> : null}
            </label>
          </div>
          <label className="hint" style={{ display: "block", marginTop: 10 }}>
            API 密钥
            <input className="field" style={{ width: "100%", marginTop: 6 }} type="password" value={apiKey} placeholder={editing ? "已保存，留空则不修改" : "输入 API 密钥"} onChange={(e) => setApiKey(e.target.value)} />
          </label>
          <div className="hint" style={{ marginTop: 12 }}>
            模型目录
            <button
              className="btn"
              type="button"
              style={{ marginLeft: 8 }}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setErr("");
                void probeProvider({ baseUrl, apiKey, protocol, providerId: editing || undefined })
                  .then((res) => {
                    setModels(res.models);
                    // 渠道 /models 带了窗口 / 输出 / 图片元数据就预填进去，用户已经填过的不动
                    setCaps((cur) => {
                      const next = { ...cur };
                      for (const [m, meta] of Object.entries(res.meta ?? {})) {
                        const d = next[m] ?? EMPTY_CAPS;
                        next[m] = {
                          contextWindow: d.contextWindow || (meta.contextWindow ? String(meta.contextWindow) : ""),
                          maxTokens: d.maxTokens || (meta.maxTokens ? String(meta.maxTokens) : ""),
                          supportsImages: d.supportsImages || (meta.supportsImages === undefined ? "" : meta.supportsImages ? "yes" : "no"),
                          thinking: d.thinking,
                          compact: d.compact,
                        };
                      }
                      return next;
                    });
                  })
                  .catch((error: unknown) => setErr(error instanceof Error ? error.message : String(error)))
                  .finally(() => setBusy(false));
              }}
            >
              获取可用模型
            </button>
          </div>
          <p className="hint">只有加进目录的模型才会出现在模型选择里。获取不到时，在下面手动添加。</p>
          {models.length ? <p className="hint">{models.join("、")}</p> : null}
          {models.length ? (
            <div className="provider-caps" style={{ marginTop: 8 }}>
              <div className="hint">模型能力：留空按官方文档；文档里查不到的用保守默认（窗口 128,000、输出 8,192，此时 OpenAI 兼容协议不带输出上限）。</div>
              {models.map((m) => (
                <CapsRow
                  key={m}
                  label={m}
                  draft={caps[m] ?? EMPTY_CAPS}
                  effective={settings.modelCaps?.[`custom|${editing || id}|${m}`]}
                  onChange={(d) => setCaps((cur) => ({ ...cur, [m]: d }))}
                />
              ))}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input className="field" style={{ flex: 1 }} value={modelDraft} placeholder="模型 ID，例如 gpt-4o" onChange={(e) => setModelDraft(e.target.value)} />
            <button
              className="btn"
              type="button"
              onClick={() => {
                const next = modelDraft.trim();
                if (!next || models.includes(next)) return;
                setModels((list) => [...list, next]);
                setModelDraft("");
              }}
            >
              添加模型
            </button>
          </div>
          {err ? <div className="error">{err}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void save()}>
              {editing ? "保存提供方" : "创建提供方"}
            </button>
            <button className="btn" type="button" onClick={() => setOpen(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <button className="btn" type="button" style={{ marginTop: 10 }} onClick={() => reset()}>
          添加自定义提供方
        </button>
      )}
      {err && !open ? <div className="error">{err}</div> : null}
    </section>
  );
}
