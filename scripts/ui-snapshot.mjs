/**
 * UI 自校验：起一个假上游 + 本地服务，用 Electron 打开页面、走完试用/发消息/Agent 流程，
 * 在关键状态截图到 apps/desktop/release/snapshots/。不联网，不碰线上库。
 *
 *   node scripts/ui-snapshot.mjs            # web 模式 + desktop(agent) 模式都截
 *   node scripts/ui-snapshot.mjs web        # 只截网页版
 *   node scripts/ui-snapshot.mjs desktop    # 只截桌面 Agent
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "apps", "desktop", "release", "snapshots");
const electronBin = path.join(root, "apps", "desktop", "node_modules", "electron", "dist", "electron.exe");
const only = process.argv[2] || "all";

fs.mkdirSync(outDir, { recursive: true });

// ---------- 假上游：网页给 markdown 长回复；桌面按脚本回工具调用 ----------
const CHAT_REPLY = `好的，这是一个对比：

| 方案 | 优点 | 缺点 |
|---|---|---|
| A | 简单 | 扩展性差 |
| B | 灵活 | 上手成本高 |

推荐先用 **A**，示例代码：

\`\`\`ts
export function pick(list: string[]): string {
  return list[0] ?? "";
}
\`\`\`

要点：
1. 先跑通再优化
2. 保持接口稳定
`;

const AGENT_SCRIPT = [
  { tool: { name: "update_plan", args: { plan: [{ step: "读取配置", status: "in_progress" }, { step: "把 LIMIT 改成 20", status: "pending" }, { step: "跑测试", status: "pending" }] } } },
  { tool: { name: "read_file", args: { path: "src/config.ts" } } },
  { tool: { name: "update_plan", args: { plan: [{ step: "读取配置", status: "completed" }, { step: "把 LIMIT 改成 20", status: "in_progress" }, { step: "跑测试", status: "pending" }] } } },
  { tool: { name: "edit_file", args: { path: "src/config.ts", old_string: "const LIMIT = 10;", new_string: "const LIMIT = 20;" } } },
  { tool: { name: "run_terminal", args: { command: "echo tests passed" } } },
  { tool: { name: "update_plan", args: { plan: [{ step: "读取配置", status: "completed" }, { step: "把 LIMIT 改成 20", status: "completed" }, { step: "跑测试", status: "completed" }] } } },
  { content: "已把 `src/config.ts` 里的 `LIMIT` 从 10 改成 20，测试通过。\n\n改动文件：\n- `src/config.ts`" },
];
let agentCursor = 0;

function sse(res, chunks) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.some((t) => t.function?.name === "read_file");
    if (hasTools) {
      const turn = AGENT_SCRIPT[agentCursor++] ?? { content: "(done)" };
      if (turn.tool) {
        sse(res, [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${agentCursor}`, function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]);
      } else {
        sse(res, [
          { choices: [{ delta: { content: turn.content } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } },
        ]);
      }
      return;
    }
    // 网页：分片流式发，像真的一样一个字一个字出
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const parts = CHAT_REPLY.match(/[\s\S]{1,12}/g) ?? [];
    let i = 0;
    const tick = () => {
      if (i < parts.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
        setTimeout(tick, 15);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 150, total_tokens: 450 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    };
    tick();
  });
});
const upstreamPort = await new Promise((r) => upstream.listen(0, "127.0.0.1", () => r(upstream.address().port)));

function startServer(mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `agnes-snap-${mode}-`));
  const ws = path.join(tmp, "ws");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "config.ts"), "export const NAME = 'demo';\nconst LIMIT = 10;\nexport { LIMIT };\n");
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "demo-project", scripts: { test: "echo ok", build: "tsc" } }, null, 2));
  fs.writeFileSync(path.join(ws, "README.md"), "# demo\n");
  // 别撞上本机其他 dev 服务（8787/8791 都有人用），取高位端口
  const port = mode === "web" ? 18731 : 18732;
  const env = {
    ...process.env,
    AGNES_SKIP_DOTENV: "1",
    NODE_ENV: "",
    DESKTOP_MODE: mode === "desktop" ? "1" : "",
    LICENSE_SERVER_URL: "",
    APP_AUTH_TOKEN: "",
    AGNES_API_KEY: "snapshot-key",
    AGNES_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    DATA_DIR: path.join(tmp, "data"),
    WORKSPACE_ROOT: ws,
    WEB_DIST: path.join(root, "apps", "web", "dist"),
    PORT: String(port),
    HOST: "127.0.0.1",
    OSS_NO_ADMIN_HOST: "admin.localhost",
    OSS_NO_ADMIN_USER: "",
    OSS_NO_ADMIN: "",
    AUTO_APPLY: "false",
  };
  const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--filter", "@agnes/server", "exec", "tsx", "src/index.ts"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  child.stdout.on("data", (d) => process.stdout.write(`[server:${mode}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[server:${mode}] ${d}`));
  return { child, port, ws };
}

async function waitHealth(port) {
  for (let i = 0; i < 120; i++) {
    try {
      // 确认是我们的服务在答，不是端口上别的东西
      const r = await fetch(`http://127.0.0.1:${port}/api/session`);
      if (r.ok) {
        const j = await r.json();
        if (typeof j.desktopMode === "boolean") return;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on ${port} did not come up`);
}

function runElectron(script, env) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `agnes-snap-${Date.now()}.mjs`);
    fs.writeFileSync(file, script);
    const child = spawn(electronBin, [file], { env: { ...process.env, ...env, ELECTRON_ENABLE_LOGGING: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      const s = String(d);
      if (!/DevTools|Passthrough|GPU|dxgi|Fontconfig|sandbox/i.test(s)) process.stderr.write(`[electron] ${s}`);
    });
    child.on("close", (code) => {
      fs.rmSync(file, { force: true });
      if (code === 0) resolve(out);
      else reject(new Error(`electron exited ${code}\n${out}`));
    });
  });
}

const ELECTRON_SCRIPT = String.raw`
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

const url = process.env.SNAP_URL;
const outDir = process.env.SNAP_OUT;
const mode = process.env.SNAP_MODE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每次全新的 userData：否则 localStorage 里上一轮的侧栏折叠/页签状态会带进这一轮，截图不可重复
app.setPath("userData", path.join(process.env.SNAP_PROFILE, "userData"));

app.whenReady().then(async () => {
  // 窗口必须可见：隐藏窗口的 capturePage 可能拿到陈旧帧
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, backgroundColor: "#0c0d10", webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.showInactive();
  const shot = async (name) => {
    await sleep(120);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name + ".png"), img.toPNG());
    const err = await win.webContents.executeJavaScript("document.querySelector('.error')?.textContent || ''", true).catch(() => "");
    console.log("shot " + name + (err ? "  [page error: " + err + "]" : ""));
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitFor = async (selectorOrFn, ms = 15000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const isFn = selectorOrFn.trim().startsWith("(");
      const ok = await js(isFn ? "(" + selectorOrFn + ")()" : "Boolean(document.querySelector(" + JSON.stringify(selectorOrFn) + "))");
      if (ok) return true;
      await sleep(150);
    }
    return false;
  };
  const click = (sel) => js("(()=>{const el=document.querySelector(" + JSON.stringify(sel) + ");if(!el)return false;el.click();return true;})()");
  const clickByText = async (sel, text) => {
    const ok = await js("(()=>{const el=[...document.querySelectorAll(" + JSON.stringify(sel) + ")].find(e=>e.textContent.trim().includes(" + JSON.stringify(text) + "));if(!el)return false;el.click();return true;})()");
    console.log("click " + sel + " '" + text + "' -> " + ok);
    return ok;
  };
  const type = async (sel, text) => {
    await js("(()=>{const el=document.querySelector(" + JSON.stringify(sel) + ");el.focus();return true;})()");
    // 走 React 的受控输入：用 native setter + input 事件
    await js("(()=>{const el=document.querySelector(" + JSON.stringify(sel) + ");const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(el," + JSON.stringify(text) + ");el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
  };

  await win.loadURL(url);
  await sleep(1200);

  // 1) 锁定页：开始试用
  if (await waitFor("form button[type=submit]", 8000)) {
    await shot(mode + "-01-lock");
    await clickByText("form button[type=submit]", mode === "desktop" ? "开始试用" : "开始试用");
    await sleep(1500);
  }
  // 桌面端还要选档案
  if (mode === "desktop" && (await js("Boolean([...document.querySelectorAll('button')].find(b=>b.textContent.includes('创建档案')))"))) {
    await js("(()=>{const el=document.querySelector('.lock input.field');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(el,'我的电脑');el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
    await clickByText("button", "创建档案");
    await sleep(1500);
  }

  // 2) 空态
  await waitFor(".composer textarea", 15000);
  await sleep(600);
  await shot(mode + "-02-empty");

  if (mode === "desktop") {
    // 没有 preload，pickFolder 不存在：先通过接口把默认目录登记成工作区（设备码按网页算法现算），
    // 刷新让侧栏加载出来，再从工作区行上的「+」建 Agent
    await clickByText(".side-seg button", "Agent");
    await sleep(600);
    await shot(mode + "-03-agent-tab-empty");
    await js(
      "(async()=>{const id=localStorage.getItem('agnes_install_id');const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('agnes-device:v1:web:'+id));const hash=[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');const r=await fetch('/api/workspaces',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','x-agnes-device':hash},body:JSON.stringify({root:" +
        JSON.stringify(process.env.SNAP_WS) +
        ",name:'demo-project'})});return r.status;})()",
    ).then((s) => console.log("create workspace -> " + s));
    await win.webContents.reload();
    await sleep(2500);
    await waitFor(".composer textarea", 15000);
    await clickByText(".side-seg button", "Agent");
    await sleep(600);
    await shot(mode + "-03b-agent-tab-workspace");
    await click(".ws-acts button");
    await sleep(1200);
    await shot(mode + "-03-agent-empty");
    await type(".composer textarea", "把 @src/config.ts 里的 LIMIT 改成 20 然后跑测试");
    await sleep(300);
    await shot(mode + "-04-agent-mention");
    await js("document.querySelector('.composer').requestSubmit()");
    // 逐项确认模式：先来一张待确认的 diff（edit_file），点应用
    if (await waitFor(".diff-card", 20000)) {
      await sleep(400);
      await shot(mode + "-05-agent-diff-approval");
      await clickByText(".diff-card button", "应用");
    }
    // 然后是命令审批卡（run_terminal）
    if (await waitFor(".cmd-card", 20000)) {
      await sleep(400);
      await shot(mode + "-06-agent-cmd-approval");
      await clickByText(".cmd-card button", "运行");
    }
    // 等待结束
    await waitFor("() => !document.querySelector('.icon-btn.stop') && document.querySelector('.usage')", 30000);
    await sleep(600);
    await shot(mode + "-07-agent-done");
    // 右侧改动面板 → 点第一条
    await click(".change-row");
    await sleep(400);
    await shot(mode + "-08-agent-changes");
    // 终端 tab
    await clickByText(".side-tabs button", "终端");
    await sleep(300);
    await shot(mode + "-09-agent-terminal");
    // 刷新看历史回放
    await win.webContents.reload();
    await sleep(2500);
    await waitFor(".steps", 10000);
    await sleep(500);
    await shot(mode + "-10-agent-replay");
    // 同一工作区再开一个 Agent：侧栏应在同一个工作区分组下出现两条
    await clickByText(".side-seg button", "Agent");
    await sleep(300);
    await click(".ws-acts button");
    await sleep(1200);
    await shot(mode + "-11-agent-second-in-workspace");
    // 打开工作区菜单
    await js("(()=>{const b=[...document.querySelectorAll('.ws-acts button')].at(-1);b&&b.click();return true;})()");
    await sleep(300);
    await shot(mode + "-12-workspace-menu");
  } else {
    await type(".composer textarea", "给我对比两个方案，带表格和代码");
    await sleep(300);
    await shot(mode + "-03-typing");
    await js("document.querySelector('.composer').requestSubmit()");
    await sleep(900);
    await shot(mode + "-04-streaming");
    await waitFor("() => !document.querySelector('.icon-btn.stop')", 30000);
    await sleep(700);
    await shot(mode + "-05-answer");
    // 第二轮 + 重新生成
    await type(".composer textarea", "再精简一点");
    await js("document.querySelector('.composer').requestSubmit()");
    await waitFor("() => !document.querySelector('.icon-btn.stop')", 30000);
    await sleep(500);
    await shot(mode + "-06-two-turns");
    // 悬停操作条：直接把 opacity 打开，并放大截一张看清图标
    await js("document.querySelectorAll('.msg-actions').forEach(e=>e.style.opacity='1')");
    await js("document.querySelector('.transcript').scrollTop = 1e9");
    await win.webContents.setZoomFactor(1.6);
    await sleep(500);
    await js("document.querySelector('.transcript').scrollTop = 1e9");
    await sleep(300);
    await shot(mode + "-07-actions-zoom");
    await win.webContents.setZoomFactor(1);
    await sleep(300);
    // 侧栏悬停操作
    await js("document.querySelectorAll('.conv-acts').forEach(e=>e.style.display='inline-flex')");
    await sleep(200);
    await shot(mode + "-08-sidebar");
    // 折叠侧栏
    await click(".brand .ghost-icon");
    await sleep(400);
    await shot(mode + "-09-collapsed");
  }
  app.exit(0);
});
`;

function killTree(child) {
  // Windows 下 child.kill() 只杀 shell 壳，tsx 孙进程会留下来继续占端口
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill();
    }
  } else {
    child.kill();
  }
}

async function snap(mode) {
  const { child, port, ws } = startServer(mode);
  try {
    await waitHealth(port);
    console.log(`server ${mode} ready on ${port}`);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), `agnes-snap-profile-${mode}-`));
    const out = await runElectron(ELECTRON_SCRIPT, {
      SNAP_URL: `http://127.0.0.1:${port}`,
      SNAP_OUT: outDir,
      SNAP_MODE: mode,
      SNAP_WS: ws,
      SNAP_PROFILE: profile,
    });
    process.stdout.write(out);
  } finally {
    killTree(child);
    await new Promise((r) => setTimeout(r, 800));
  }
}

try {
  if (only === "all" || only === "web") await snap("web");
  if (only === "all" || only === "desktop") await snap("desktop");
  console.log(`snapshots in ${outDir}`);
} finally {
  upstream.close();
  process.exit(0);
}
