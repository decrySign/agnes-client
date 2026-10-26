/**
 * Agent 循环端到端：假上游按脚本回工具调用，验证完整一轮——
 * @文件展开 → update_plan → read_file(带行号) → edit_file(精确替换 → diff → 自动应用) → 总结，
 * 然后 revert 撤销，再看历史回放需要的 tool 消息是否都落库。
 *
 * 假上游刻意按真实 OpenAI 兼容格式发：先 finish_reason:"tool_calls"，再 [DONE]。
 * 这个顺序曾让 loop 把 finish 盖成 "stop" 而跳过工具执行，所以别改成只发一个。
 * 跑法：pnpm check:agent
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { ensureLocalKeyOperator } from "./entitlements.js";
import { customModelId, PROVIDERS_KV } from "./providers.js";
import { AgnesClient, ensureToolCallArguments, type ChatMessage } from "@agnes/sdk";
import { CANCELLED_TOOL_RESULT, compactForModel, executeTool, expandMentions, extractMentions, planModelSummary, readProjectRules, revertConversationCommits, ruleForCommand, shouldConfirmCommand, symbolsInText, toolResultFailed, typecheckCommand, Workspace, withWorkspaceLock, checkpointWrite, findGitBin, type ToolRuntime } from "@agnes/agent";

function fail(m: string): never {
  throw new Error(m);
}

/** 跑完统一删掉，别在 %TEMP% 里越堆越多 */
const tempDirs: string[] = [];
function makeTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 失败退出时库文件可能还开着，尽力而为 */
    }
  }
});

{
  const truncated =
    '{"new_string": "| 2026-08-21 | 还花呗（建设银行） | ¥486.94 |\\n| 2026-09-12 | 卖出笔记本电脑 | +¥2,164.80（售价 ¥2,200 − 服务费/邮费，实际到手） |\\n| **2026-08 大额支出小计** | | **¥2,513.76** |\\n| **2026-07 大额支出小计** | | **¥4,655.50** |"';
  const ensured = ensureToolCallArguments(truncated);
  if (ensured.valid) fail("截断的 arguments 不应标成 valid");
  JSON.parse(ensured.json);
  if (!Object.keys(JSON.parse(ensured.json) as object).includes("new_string")) fail("截断修复应保住已拼完的字段");
  JSON.parse(ensureToolCallArguments("{}").json);
  if (!ensureToolCallArguments('{"path":"a.md"}').valid) fail("完整 JSON 应 valid");
  console.log("tool-args OK: 截断 arguments 可修成合法 JSON");
}

{
  const fat = "文件正文\n" + "x".repeat(20_000);
  const oldTool = { role: "tool" as const, tool_call_id: "old", content: fat };
  const fresh = "本轮刚读到的内容，必须原样留给模型";
  const history = [
    { role: "system" as const, content: "sys" },
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "最早的任务：记住口令 alpha" },
        { type: "image_url" as const, image_url: { url: `data:image/png;base64,${"A".repeat(500)}` } },
      ],
    },
    {
      role: "assistant" as const,
      content: "看过了",
      tool_calls: [{ id: "old", type: "function" as const, function: { name: "read_file", arguments: "y".repeat(2_000) } }],
    },
    oldTool,
    { role: "user" as const, content: "第二轮" },
    { role: "assistant" as const, content: "继续" },
    { role: "user" as const, content: "第三轮" },
    { role: "assistant" as const, content: "继续" },
    { role: "user" as const, content: "第四轮" },
    { role: "assistant" as const, content: "继续" },
    { role: "user" as const, content: "第五轮" },
    { role: "assistant" as const, content: "继续" },
    { role: "user" as const, content: "第六轮" },
    { role: "assistant" as const, content: "继续" },
    { role: "user" as const, content: "现在改这一处" },
    { role: "assistant" as const, content: null, tool_calls: [{ id: "new", type: "function" as const, function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }] },
    { role: "tool" as const, tool_call_id: "new", content: fresh },
  ];
  const fillers: typeof history = [];
  for (let i = 0; i < 6; i++) {
    fillers.push(
      { role: "user", content: `填充${i}` },
      { role: "assistant", content: "继续", tool_calls: [{ id: `f${i}`, type: "function", function: { name: "grep", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `f${i}`, content: `小结果${i}` },
    );
  }
  history.splice(4, 0, ...fillers);
  const manyShort: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "system", content: "s" }];
  for (let i = 0; i < 30; i++) {
    manyShort.push({ role: "user", content: `问${i}` }, { role: "assistant", content: `答${i}` });
  }
  const folded = compactForModel(manyShort);
  if (!folded.stats.summarizedTurns) fail("条数过多即使字数不多也要摘录，否则首 token 会拖过空闲超时");
  if (folded.messages.length > 48) fail(`摘录后消息仍然太多: ${folded.messages.length}`);
  if (!JSON.stringify(folded.messages).includes("问29")) fail("最近一轮用户发言必须留下");
  const small = compactForModel([{ role: "system", content: "hi" }, { role: "user", content: "你好" }]);
  if (small.stats.changed) fail("短对话不该压缩");
  if (small.messages.length !== 2) fail("短对话应原样返回");

  const packed = compactForModel(history, 4_000);
  if (!packed.stats.changed) fail("超预算应压缩");
  if (!(packed.stats.after < packed.stats.before)) fail("压缩后应该更短");
  if (packed.stats.after > 8_000) fail(`旧工具没压下去: ${packed.stats.after}`);
  if (oldTool.content !== fat) fail("压缩不能改掉库里的原文");
  const blob = JSON.stringify(packed.messages);
  if (!blob.includes("现在改这一处")) fail("最近一条用户消息必须留在上下文里");
  if (!blob.includes(fresh)) fail("本轮工具结果必须留全文");
  if (blob.includes(fat)) fail("更早的大段工具输出不该原样重放");
  if (!blob.includes("较早的工具结果已省略")) fail("超窗口的工具结果应收成一行，而不是整段丢掉对话");
  if (blob.includes("A".repeat(500))) fail("更早的 data URI 图片不该重放");
  if (!blob.includes("alpha")) fail("更早的用户原话不能丢");
  const toolIds = new Set<string>();
  for (const message of packed.messages) {
    for (const call of message.tool_calls ?? []) toolIds.add(call.id);
  }
  for (const message of packed.messages) {
    if (message.role === "tool" && message.tool_call_id && !toolIds.has(message.tool_call_id)) {
      fail(`压缩后工具结果 ${message.tool_call_id} 失去了对应的 tool_call`);
    }
  }
  const latestUser = [...packed.messages].reverse().find((message) => message.role === "user");
  if (typeof latestUser?.content === "string" && latestUser.content.includes("[较早的图片")) {
    fail("当前这轮的图片不该被省略");
  }
  console.log(
    `上下文压缩 OK: ${packed.stats.before}→${packed.stats.after} 字，省略工具 ${packed.stats.stubbedTools}，摘录 ${packed.stats.summarizedTurns} 轮`,
  );
  const digested = compactForModel(manyShort, undefined, "DIGEST_TOKEN 先改配置再写测试");
  if (!JSON.stringify(digested.messages).includes("DIGEST_TOKEN")) fail("超长对话应改用模型摘录");
  if (!JSON.stringify(digested.messages).includes("问29")) fail("模型摘录后仍要留下最近一轮");
  const plan = planModelSummary(manyShort);
  if (!plan || !plan.prompt.includes("用户：")) fail("超长对话应能计划模型摘录");
  console.log("模型摘录 OK");
}

// ---- FB-1005：较早的大参数工具调用只截短字符串，不再换成 { omitted, preview }；照抄占位的调用不执行 ----
{
  const longPath = "src/features/billing/config.ts";
  const editArgs = JSON.stringify({ path: longPath, old_string: "const A = 1;\n".repeat(80), new_string: "const A = 2;\n".repeat(80) });
  const hist: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "改配置" },
    { role: "assistant", content: null, tool_calls: [{ id: "e1", type: "function", function: { name: "edit_file", arguments: editArgs } }] },
    { role: "tool", tool_call_id: "e1", content: `已写入 ${longPath}` },
    { role: "assistant", content: "改好了" },
    { role: "user", content: "再看看" },
  ];
  const clippedRun = compactForModel(hist, 1_000);
  const call = clippedRun.messages.flatMap((m) => m.tool_calls ?? []).find((c) => c.id === "e1");
  if (!call) fail("较早的工具调用不该被丢掉");
  const clippedArgs = call.function.arguments;
  if (clippedArgs.includes("omitted") || clippedArgs.includes("preview")) fail(`压缩后不该再出现 omitted 占位: ${clippedArgs}`);
  if (clippedArgs.length >= 600) fail(`长参数应被截短: ${clippedArgs.length}`);
  const parsedArgs = JSON.parse(clippedArgs) as Record<string, unknown>;
  if (Object.keys(parsedArgs).join(",") !== "path,old_string,new_string") fail(`压缩应保留原参数键: ${Object.keys(parsedArgs).join(",")}`);
  if (parsedArgs.path !== longPath) fail("短的 path 应原样保留");
  if (!String(parsedArgs.old_string).includes("已截断，原长 1040 字")) fail(`长字符串应带截断标记: ${String(parsedArgs.old_string).slice(-40)}`);
  if (hist[2].tool_calls?.[0]?.function.arguments !== editArgs) fail("压缩不能改掉库里的原始参数");
  if (!JSON.stringify(clippedRun.messages).includes("不要照抄截断的参数")) fail("系统提示应说明截断参数只是摘录");
  const rawHist: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "u1" },
    { role: "assistant", content: null, tool_calls: [{ id: "r1", type: "function", function: { name: "write_file", arguments: "{not json " + "y".repeat(700) } }] },
    { role: "tool", tool_call_id: "r1", content: "ok" },
    { role: "user", content: "u2" },
  ];
  const rawCall = compactForModel(rawHist, 300).messages.flatMap((m) => m.tool_calls ?? []).find((c) => c.id === "r1");
  if (!rawCall) fail("非 JSON 参数的调用不该被丢掉");
  const rawParsed = JSON.parse(rawCall.function.arguments) as unknown;
  if (typeof rawParsed !== "string" || !rawParsed.includes("已截断") || rawCall.function.arguments.includes("omitted")) {
    fail(`非 JSON 参数应退成截短的 JSON 字符串: ${rawCall.function.arguments}`);
  }

  const dir = makeTemp("agnes-fb1005-");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  const ws = new Workspace(dir);
  const rt: ToolRuntime = {
    workspaceRoot: dir,
    autoApply: true,
    allowTerminal: false,
    allowWrites: true,
    gitCheckpoints: false,
    emit: () => {},
    waitForApply: async () => "applied",
    saveImage: async () => fail("不该出图"),
    saveVideo: async () => fail("不该出视频"),
  };
  const exec = (name: string, args: unknown) => executeTool(name, JSON.stringify(args), ws, rt, {} as never, { image: "", video: "" }, `fb-${name}`);
  const bad: Array<[string, unknown]> = [
    ["edit_file", { omitted: "True", preview: "{\"path\": \"a.txt\", \"old_string\": \"hel" }],
    ["apply_patch", { omitted: true, preview: "{\"path\": \"a.txt\"" }],
    ["write_file", { omitted: true, preview: "x" }],
    ["edit_file", { path: "a.txt", old_string: "hello", new_string: "bye…[已截断，原长 300 字]" }],
    ["write_file", { path: "b.txt", content: "开头…[已截断，原长 5000 字]" }],
  ];
  for (const [name, args] of bad) {
    const result = await exec(name, args);
    if (!result.startsWith("工具失败：这次的参数是上下文压缩留下的占位")) fail(`${name} 占位参数应被拦下: ${result}`);
    if (!toolResultFailed(name, result)) fail(`${name} 占位参数应标成失败`);
  }
  const noPath = await exec("edit_file", { path: "", old_string: "hello", new_string: "bye" });
  if (!noPath.includes("缺少 path")) fail(`缺 path 的 edit_file 应直接报错，不能落到目录上 EISDIR: ${noPath}`);
  if (fs.readFileSync(path.join(dir, "a.txt"), "utf8") !== "hello\n") fail("占位参数不该改动文件");
  if (fs.existsSync(path.join(dir, "b.txt"))) fail("占位参数不该新建文件");
  const good = await exec("edit_file", { path: "a.txt", old_string: "hello", new_string: "bye" });
  if (!good.includes("已写入") || fs.readFileSync(path.join(dir, "a.txt"), "utf8") !== "bye\n") fail(`正常 edit_file 应照常写入: ${good}`);
  console.log("FB-1005 OK: 压缩保留参数键、无 omitted；占位 / 截断参数不执行、不碰文件");
}

{
  if (!shouldConfirmCommand("full-auto", "curl --version", "")) fail("full-auto 下 curl 仍要询问");
  if (shouldConfirmCommand("full-auto", "echo hi", "")) fail("full-auto 下普通命令不该问");
  if (!shouldConfirmCommand("full-auto", "git status && rm -rf tmp", "")) fail("带删除的命令链要询问");
  if (shouldConfirmCommand("auto-edit", "pnpm typecheck", "")) fail("允许规则里的命令在只问命令档不该问");
  if (!shouldConfirmCommand("auto-edit", "echo hi", "")) fail("不在允许规则里的命令仍要问");
  if (!shouldConfirmCommand("suggest", "git status", "")) fail("每次都问不能被允许规则绕过");
  if (ruleForCommand("rm -rf tmp")) fail("危险命令不能记成允许规则");
  if (ruleForCommand("pnpm test --filter @agnes/server") !== "pnpm test") fail("记住这条应收到命令前缀");
  console.log("命令规则 OK");
}

{
  const dir = makeTemp("agnes-rules-");
  fs.mkdirSync(path.join(dir, ".agnes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "根说明不该优先");
  fs.writeFileSync(path.join(dir, ".agnes", "AGENTS.md"), "用 pnpm，不要改 lockfile");
  const rules = readProjectRules(dir);
  if (!rules || rules.path !== ".agnes/AGENTS.md" || !rules.text.includes("用 pnpm")) fail("应优先读 .agnes/AGENTS.md");
  const pkg = path.join(dir, "package.json");
  fs.writeFileSync(pkg, JSON.stringify({ scripts: { typecheck: "tsc -p tsconfig.json --noEmit" } }));
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  const cmd = typecheckCommand(dir);
  if (!cmd || cmd.command !== "pnpm typecheck") fail(`类型检查命令不对: ${cmd?.command}`);
  const symbols = symbolsInText("src/app.ts", "export function handleSend() {\n  return 1;\n}\nfunction localOnly() {}\n");
  if (!symbols.some((s) => s.name === "handleSend" && s.kind === "export" && s.line === 1)) fail("应抽出导出函数");
  if (!symbols.some((s) => s.name === "localOnly")) fail("应抽出普通函数");
  const ws = new Workspace(dir);
  fs.writeFileSync(path.join(dir, "src.ts"), "export function handleSend() {\n  return 1;\n}\n");
  const expanded = await expandMentions(ws, "看下 @src.ts#handleSend");
  if (!expanded.content.includes("符号 handleSend") || !expanded.attached.includes("src.ts")) fail("符号提及应展开附近窗口");
  if (extractMentions("邮箱 me@x.com").includes("x.com")) fail("邮箱不该被当成提及");
  let asked = "";
  const denied = await executeTool(
    "run_terminal",
    JSON.stringify({ command: "curl --version" }),
    ws,
    {
      workspaceRoot: dir,
      autoApply: true,
      allowTerminal: true,
      allowWrites: false,
      approvalMode: "full-auto",
      commandAllow: "",
      confirmCommands: false,
      emit() {},
      waitForApply: async () => "applied" as const,
      waitForCommand: async (_id: string, command: string) => {
        asked = command;
        return "denied" as const;
      },
      saveImage: async () => ({ id: "i", publicUrl: "" }),
      saveVideo: async () => ({ id: "v", publicUrl: "" }),
    },
    {} as never,
    { image: "", video: "" },
    "curl1",
  );
  if (!asked.includes("curl") || !denied.includes("拒绝")) fail(`危险命令应被拦住: ${denied}`);
  console.log("项目说明 / 符号 / 类型检查命令 OK");
}

{
  const git = await findGitBin();
  if (!git) {
    console.log("跳过 git 回退：没有 Git");
  } else {
    const root = makeTemp("agnes-revert-");
    fs.writeFileSync(path.join(root, "a.txt"), "base\n");
    execFileSync(git, ["init"], { cwd: root, stdio: "ignore" });
    execFileSync(git, ["-c", "user.email=u@u", "-c", "user.name=u", "-c", "commit.gpgsign=false", "add", "a.txt"], { cwd: root });
    execFileSync(git, ["-c", "user.email=u@u", "-c", "user.name=u", "-c", "commit.gpgsign=false", "commit", "-m", "base"], {
      cwd: root,
    });
    const runtime = {
      workspaceRoot: root,
      conversationId: "c_one",
      autoApply: true,
      allowTerminal: false,
      allowWrites: true,
      emit() {},
      waitForApply: async () => "applied" as const,
      saveImage: async () => ({ id: "i", publicUrl: "" }),
      saveVideo: async () => ({ id: "v", publicUrl: "" }),
    } satisfies ToolRuntime;
    const since = Date.now();
    fs.writeFileSync(path.join(root, "a.txt"), "v1\n");
    await checkpointWrite(runtime, "a.txt");
    fs.writeFileSync(path.join(root, "b.txt"), "other\n");
    await checkpointWrite({ ...runtime, conversationId: "c_two" }, "b.txt");
    const restored = await revertConversationCommits(root, "c_one", since);
    if (!restored.ok || restored.reverted < 1) fail(`回退失败: ${JSON.stringify(restored)}`);
    const text = fs.readFileSync(path.join(root, "a.txt"), "utf8");
    if (!text.includes("base") || text.includes("v1")) fail(`回退后内容不对: ${JSON.stringify(text)}`);
    if (!fs.existsSync(path.join(root, "b.txt"))) fail("别的对话的提交不该被回退");
    fs.writeFileSync(path.join(root, "dirty.txt"), "x");
    const blocked = await revertConversationCommits(root, "c_one", since);
    if (blocked.ok) fail("有未提交改动时不该回退");
    console.log("按消息回退 OK");
  }
}

type Turn = {
  content?: string;
  tool?: { name: string; args: Record<string, unknown>; rawArguments?: string };
  /** 一轮里并排发多个工具调用；ids 可以故意给重复的，验证本机去重 */
  tools?: Array<{ name: string; args: Record<string, unknown>; id?: string }>;
  /** 直接回一个 HTTP 错误（不重试的 400），验证上游失败退额度 */
  status?: number;
};
const script: Turn[] = [
  { tool: { name: "update_plan", args: { plan: [{ step: "读文件", status: "in_progress" }, { step: "改常量", status: "pending" }] } } },
  { tool: { name: "read_file", args: { path: "src/config.ts", offset: 1, limit: 10 } } },
  { tool: { name: "edit_file", args: { path: "src/config.ts", old_string: "const LIMIT = 10;", new_string: "const LIMIT = 20;" } } },
  { tool: { name: "update_plan", args: { plan: [{ step: "读文件", status: "completed" }, { step: "改常量", status: "completed" }] } } },
  { content: "已把 LIMIT 从 10 改成 20。" },
];
let cursor = 0;
/** 按请求正文里的关键字分流：两个 Agent 并行时各走各的剧本，不再共用一个 cursor */
type Route = { needle: string; turns: Turn[]; cursor: number };
const routes: Route[] = [];
/** 前 N 次请求直接断连，用来验证 SDK 的瞬时网络错误重试 */
let dropNext = 0;
const systemPrompts: string[] = [];
type UpstreamMsg = { role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { arguments?: string } }> };
/** 每次请求的 messages，用来检查回放给上游的历史 */
const upstreamBodies: UpstreamMsg[][] = [];
/**
 * 跟真实 OpenAI 一样严格：每个 assistant.tool_calls 后面必须紧跟全部 tool 结果，
 * id 不能重复，也不能有对不上号的 tool 消息。停在半截的工具批次以前会在这里 400。
 */
function toolPairProblem(messages: UpstreamMsg[]): string {
  const seen = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool") return `orphan tool message ${m.tool_call_id}`;
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const ids = m.tool_calls.map((tc) => String(tc.id ?? ""));
    for (const tid of ids) {
      if (!tid || seen.has(tid)) return `duplicate tool_call id ${tid}`;
      seen.add(tid);
    }
    const got = new Set<string>();
    let j = i + 1;
    for (; j < messages.length && messages[j]!.role === "tool"; j++) got.add(String(messages[j]!.tool_call_id ?? ""));
    for (const tid of ids) if (!got.has(tid)) return `missing tool result for ${tid}`;
    for (const tid of got) if (!ids.includes(tid)) return `tool result ${tid} has no call`;
    i = j - 1;
  }
  return "";
}
let holdNeedle = "";
let onHeld: (() => void) | null = null;
let releaseHold: (() => void) | null = null;

function armHold(needle: string): Promise<void> {
  holdNeedle = needle;
  releaseHold = null;
  return new Promise((resolve) => {
    onHeld = resolve;
  });
}

const upstream = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    void (async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (dropNext > 0) {
        dropNext -= 1;
        req.socket.destroy();
        return;
      }
      if (holdNeedle && raw.includes(holdNeedle)) {
        onHeld?.();
        onHeld = null;
        await new Promise<void>((r) => {
          releaseHold = r;
        });
      }
      const body = JSON.parse(raw) as { messages: UpstreamMsg[] };
      upstreamBodies.push(body.messages);
      const pairProblem = toolPairProblem(body.messages);
      if (pairProblem) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `invalid tool pairing: ${pairProblem}`, type: "invalid_request_error", code: "400" } }));
        return;
      }
      for (const m of body.messages) {
        for (const tc of m.tool_calls ?? []) {
          const args = tc.function?.arguments ?? "{}";
          try {
            JSON.parse(args);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message: `Assistant tool call ***.arguments must be valid JSON.`,
                  type: "upstream_error",
                  code: "400",
                },
              }),
            );
            return;
          }
        }
      }
      systemPrompts.push(String(body.messages[0]?.content ?? ""));
      const route = routes.find((r) => raw.includes(r.needle));
      const turn = route ? (route.turns[route.cursor++] ?? { content: "(route exhausted)" }) : (script[cursor++] ?? { content: "(script exhausted)" });
      if (turn.status) {
        res.writeHead(turn.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fake upstream refused", type: "invalid_request_error", code: String(turn.status) } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (turn.tools) {
        const calls = turn.tools.map((t, i) => ({
          index: i,
          id: t.id ?? `call_${cursor}_${i}`,
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        }));
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      } else if (turn.tool) {
        const argumentsJson = turn.tool.rawArguments ?? JSON.stringify(turn.tool.args);
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: `call_${cursor}`, function: { name: turn.tool.name, arguments: argumentsJson } },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.content } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
    })();
  });
});
const port = await new Promise<number>((r) =>
  upstream.listen(0, "127.0.0.1", () => {
    const a = upstream.address();
    r(typeof a === "object" && a ? a.port : 0);
  }),
);

const tmp = makeTemp("agnes-loop-");
const proj = path.join(tmp, "proj");
fs.mkdirSync(path.join(proj, "src"), { recursive: true });
fs.writeFileSync(path.join(proj, "src", "config.ts"), "export const NAME = 'x';\nconst LIMIT = 10;\nexport { LIMIT };\n");
fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { test: "echo ok" } }));

process.env.NODE_ENV = "";
process.env.DESKTOP_MODE = "1";
process.env.LICENSE_SERVER_URL = "";
process.env.APP_AUTH_TOKEN = "";
process.env.AGNES_API_KEY = "k";
process.env.AGNES_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.AUTO_APPLY = "true";
process.env.DATA_DIR = path.join(tmp, "data");
process.env.WORKSPACE_ROOT = path.join(tmp, "default-ws");
const cfg = loadConfig(tmp);
const db = openDb(cfg.dataDir);
const app = createApp(cfg, db);

const device = "5d".repeat(32);
ensureLocalKeyOperator(db, device);
const trial = await app.request("/api/entitlements/status", { method: "POST", headers: { "x-agnes-device": device } });
const sid = (trial.headers.get("set-cookie") ?? "").match(/agnes_sid=([^;]+)/)?.[1] ?? "";
const H = { "Content-Type": "application/json", "x-agnes-device": device, cookie: `agnes_sid=${decodeURIComponent(sid)}` };

const conv = (await (
  await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "agent", workspaceRoot: proj }) })
).json()) as { id: string };

const res = await app.request(`/api/conversations/${conv.id}/messages`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ content: "把 @src/config.ts 里的 LIMIT 改成 20" }),
});
if (res.status !== 200) fail(`send: ${await res.text()}`);
const sse = await res.text();

// ---- 事件流 ----
const events = [...sse.matchAll(/^event: (\w+)\ndata: (.+)$/gm)].map((m) => ({ name: m[1], data: JSON.parse(m[2]) as Record<string, unknown> }));
const names = events.map((e) => e.name);
const need = ["plan", "tool_start", "tool_end", "diff", "usage", "token", "finish"];
for (const n of need) {
  if (!names.includes(n)) {
    console.log("RAW SSE >>>\n" + sse.slice(0, 3000) + "\n<<<");
    console.log("upstream calls:", cursor, "system prompts captured:", systemPrompts.length);
    fail(`事件流缺 ${n}: ${[...new Set(names)].join(",")}`);
  }
}
const mentionStatus = events.find((e) => e.name === "status" && e.data.phase === "mentions");
if (!mentionStatus || !(mentionStatus.data.files as string[]).includes("src/config.ts")) fail("@文件 应有 mentions 状态事件");
const plans = events.filter((e) => e.name === "plan");
if (plans.length !== 2) fail(`应有 2 次计划更新，实际 ${plans.length}`);
const lastPlan = plans[1].data.steps as Array<{ status: string }>;
if (!lastPlan.every((s) => s.status === "completed")) fail("最后一次计划应全部完成");
const toolEnds = events.filter((e) => e.name === "tool_end");
const editEnd = toolEnds.find((e) => e.data.name === "edit_file");
if (!editEnd || editEnd.data.ok !== true) fail(`edit_file 应成功: ${JSON.stringify(editEnd?.data)}`);
const readEnd = toolEnds.find((e) => e.data.name === "read_file");
if (!String(readEnd?.data.result).includes("2|const LIMIT = 10;")) fail("read_file 应带行号");
const usage = events.find((e) => e.name === "usage");
if (usage?.data.totalTokens !== 120) fail("usage 事件应透出 token 数");
const diffEv = events.find((e) => e.name === "diff");
if (diffEv?.data.status !== "applied") fail("AUTO_APPLY/full-auto 的 diff 事件应为 applied，前端才不会弹出应用按钮");
console.log("事件流 OK:", [...new Set(names)].join(", "));

// ---- 系统提示：项目速览 + @文件 展开 ----
if (!systemPrompts[0].includes("Project snapshot") || !systemPrompts[0].includes("package.json: proj")) fail("系统提示应含项目速览");
if (!systemPrompts[0].includes("edit_file")) fail("系统提示应引导 edit_file");
console.log("系统提示 OK: 含项目速览与 edit_file 引导");

// ---- 文件真的改了（AUTO_APPLY）----
const after = fs.readFileSync(path.join(proj, "src", "config.ts"), "utf8");
if (!after.includes("const LIMIT = 20;")) fail("文件应已被 edit_file 修改");
console.log("edit_file 落盘 OK");
try {
  const subject = execFileSync("git", ["-C", proj, "log", "-1", "--pretty=%s"], { encoding: "utf8" }).trim();
  if (!subject.startsWith("agnes:")) fail(`写入后应有 agnes git 提交，实际: ${subject}`);
  console.log("git checkpoint OK:", subject);
} catch (err) {
  fail(`写入后应能 git log: ${err instanceof Error ? err.message : String(err)}`);
}

// ---- 历史落库：assistant.tool_calls + tool 结果都在，UI 回放靠这个 ----
const detail = (await (await app.request(`/api/conversations/${conv.id}`, { headers: H })).json()) as {
  messages: Array<{ role: string; tool_calls: string | null; tool_call_id: string | null }>;
  diffs: Array<{ id: string; status: string; path: string }>;
};
const toolMsgs = detail.messages.filter((m) => m.role === "tool");
const callMsgs = detail.messages.filter((m) => m.role === "assistant" && m.tool_calls);
if (toolMsgs.length !== 4 || callMsgs.length !== 4) fail(`历史应含 4 组工具调用，实际 calls=${callMsgs.length} results=${toolMsgs.length}`);
console.log("历史落库 OK: 4 组 tool_calls + 4 条结果");

// ---- 撤销 ----
const applied = detail.diffs.find((d) => d.status === "applied");
if (!applied) fail("应有一条 applied diff");
const revert = await app.request(`/api/diffs/${applied.id}/revert`, { method: "POST", headers: H });
if (revert.status !== 200) fail(`撤销失败: ${await revert.text()}`);
if (!fs.readFileSync(path.join(proj, "src", "config.ts"), "utf8").includes("const LIMIT = 10;")) fail("撤销后应恢复原文");
const again = await app.request(`/api/diffs/${applied.id}/revert`, { method: "POST", headers: H });
if (again.status !== 400) fail("重复撤销应 400");
// 文件被外部改过 → 拒绝撤销
const detail2 = (await (await app.request(`/api/conversations/${conv.id}`, { headers: H })).json()) as { diffs: Array<{ id: string; status: string }> };
if (!detail2.diffs.some((d) => d.status === "reverted")) fail("diff 状态应变为 reverted");
console.log("撤销 OK: 恢复原文、状态 reverted、重复撤销被拒");

// ---- 工作区是一等实体：一个目录一个工作区，下面挂多个 Agent ----
type WsRow = { id: string; name: string; root: string; agents: number; exists: boolean };
const wsList = (await (await app.request("/api/workspaces", { headers: H })).json()) as WsRow[];
const projWs = wsList.find((w) => w.root === proj);
if (!projWs) fail("用 workspaceRoot 建的 Agent 应自动登记成工作区");
if (projWs.agents !== 1 || !projWs.exists || projWs.name !== path.basename(proj)) fail(`工作区元信息不对: ${JSON.stringify(projWs)}`);
const convA2 = (await (
  await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "agent", workspaceId: projWs.id }) })
).json()) as { id: string; workspace_id: string; title: string };
if (convA2.workspace_id !== projWs.id) fail("按 workspaceId 建的 Agent 应挂到该工作区");
if (convA2.title !== "新任务") fail("Agent 默认标题应是「新任务」");
const sameRoot = (await (
  await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "agent", workspaceRoot: proj }) })
).json()) as { workspace_id: string };
if (sameRoot.workspace_id !== projWs.id) fail("同一目录再建 Agent 不该生成第二个工作区");
const wsAfter = (await (await app.request("/api/workspaces", { headers: H })).json()) as WsRow[];
if (wsAfter.filter((w) => w.root === proj).length !== 1) fail("同一目录只能有一个工作区");
if (wsAfter.find((w) => w.id === projWs.id)?.agents !== 3) fail("工作区下应统计到 3 个 Agent");
const chatConv = (await (
  await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "chat" }) })
).json()) as { workspace_id: string | null };
if (chatConv.workspace_id !== null) fail("chat 对话不该挂工作区");
const renamed = (await (
  await app.request(`/api/workspaces/${projWs.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ name: "我的项目" }) })
).json()) as WsRow;
if (renamed.name !== "我的项目") fail("工作区应可重命名");
const other = (await (
  await app.request("/api/workspaces", { method: "POST", headers: H, body: JSON.stringify({ root: path.join(tmp, "other-proj") }) })
).json()) as WsRow;
const reordered = (await (
  await app.request("/api/workspaces/reorder", { method: "POST", headers: H, body: JSON.stringify({ ids: [other.id, projWs.id] }) })
).json()) as Array<WsRow & { pinned: boolean; sort_order: number }>;
if (reordered[0]?.id !== other.id) fail("reorder 后 extra 工作区应排到最前");
const pinned = (await (
  await app.request(`/api/workspaces/${projWs.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ pinned: true }) })
).json()) as WsRow & { pinned: boolean };
if (!pinned.pinned) fail("工作区应可置顶");
const afterPin = (await (await app.request("/api/workspaces", { headers: H })).json()) as Array<WsRow & { pinned: boolean }>;
if (afterPin[0]?.id !== projWs.id || !afterPin[0]?.pinned) fail("置顶工作区应排在最前");
const noCascade = await app.request(`/api/workspaces/${projWs.id}`, { method: "DELETE", headers: H });
if (noCascade.status !== 409) fail("有 Agent 的工作区不带 cascade 不能删");
const moved = (await (
  await app.request(`/api/conversations/${convA2.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ workspaceId: other.id }) })
).json()) as { workspace_id: string };
if (moved.workspace_id !== other.id) fail("Agent 应可移动到别的工作区");
const treeOther = (await (await app.request(`/api/workspace?conversationId=${convA2.id}`, { headers: H })).json()) as { root: string };
if (treeOther.root !== path.join(tmp, "other-proj")) fail("移动后文件树应跟着工作区走");
const cascaded = (await (await app.request(`/api/workspaces/${other.id}?cascade=1`, { method: "DELETE", headers: H })).json()) as { removedAgents: number };
if (cascaded.removedAgents !== 1) fail("cascade 删除应连同 Agent 一起删");
const gone = await app.request(`/api/conversations/${convA2.id}`, { headers: H });
if (gone.status !== 404) fail("被 cascade 删掉的 Agent 不该还能打开");
const badRoot = await app.request("/api/workspaces", {
  method: "POST",
  headers: H,
  body: JSON.stringify({ root: process.platform === "win32" ? "C:\\Windows" : "/etc" }),
});
if (badRoot.status !== 400) fail("系统目录不能登记成工作区");
console.log("工作区 OK: 一目录一工作区、多 Agent 归组、置顶排序、移动、cascade 删除、危险目录拒绝");

// ---- 审批模式：切到 suggest，run_terminal 必须先问；边读 SSE 边批 ----
async function readSse(res: Response, onEvent: (name: string, data: Record<string, unknown>) => Promise<void> | void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const m = /^event: (\w+)\ndata: (.+)$/m.exec(frame);
      if (m) await onEvent(m[1], JSON.parse(m[2]) as Record<string, unknown>);
    }
  }
}

const modeRes = await app.request("/api/settings", { method: "PUT", headers: H, body: JSON.stringify({ approvalMode: "suggest" }) });
if (((await modeRes.json()) as { approvalMode?: string }).approvalMode !== "suggest") fail("审批模式应切到 suggest");
script.length = 0;
script.push({ tool: { name: "run_terminal", args: { command: "echo approved-run" } } }, { content: "命令跑完了。" });
cursor = 0;
const conv2 = (await (
  await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "agent", workspaceRoot: proj }) })
).json()) as { id: string };
const streamRes = await app.request(`/api/conversations/${conv2.id}/messages`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ content: "跑一下" }),
});
if (streamRes.status !== 200 || !streamRes.body) fail("suggest 模式发消息失败");
let approved = false;
let sawCommand = false;
let terminalOut = "";
await readSse(streamRes, async (name, data) => {
  if (name === "command") {
    sawCommand = true;
    if (data.command !== "echo approved-run") fail("command 事件应带命令原文");
    const bad = await app.request("/api/commands/nope/approve", { method: "POST", headers: H });
    if (bad.status !== 404) fail("不存在的命令审批应 404");
    const ok = await app.request(`/api/commands/${String(data.id)}/approve`, { method: "POST", headers: H });
    if (ok.status !== 200) fail(`审批失败: ${await ok.text()}`);
    approved = true;
  }
  if (name === "terminal") terminalOut += String(data.chunk ?? "");
});
if (!sawCommand || !approved) fail("suggest 模式应先发 command 事件等审批");
if (!terminalOut.includes("approved-run")) fail(`批准后命令应真的执行，终端输出: ${terminalOut}`);
console.log("命令审批 OK: suggest 模式先问，批准后执行");

// 拒绝：模型应收到「用户拒绝」而不是命令输出
script.length = 0;
script.push({ tool: { name: "run_terminal", args: { command: "echo should-not-run" } } }, { content: "好的不跑了。" });
cursor = 0;
const denyRes = await app.request(`/api/conversations/${conv2.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ content: "再跑" }) });
let denied = false;
let toolEndText = "";
await readSse(denyRes, async (name, data) => {
  if (name === "command" && !denied) {
    denied = true;
    await app.request(`/api/commands/${String(data.id)}/deny`, { method: "POST", headers: H });
  }
  if (name === "tool_end") toolEndText = `${String(data.result ?? "")}|ok=${String(data.ok)}`;
});
if (!denied) fail("第二条命令也应先问");
if (!toolEndText.startsWith("用户拒绝执行该命令") || !toolEndText.endsWith("ok=false")) fail(`拒绝后工具结果不对: ${toolEndText}`);
console.log("命令拒绝 OK: 模型收到拒绝、步骤标红");

// suggest：写文件必须点应用，点之前不落盘
script.length = 0;
script.push(
  { tool: { name: "edit_file", args: { path: "src/config.ts", old_string: "const LIMIT = 10;", new_string: "const LIMIT = 30;" } } },
  { content: "已改。" },
);
cursor = 0;
const convSuggestWrite = (await (
  await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "agent", workspaceRoot: proj }) })
).json()) as { id: string };
const suggestWriteRes = await app.request(`/api/conversations/${convSuggestWrite.id}/messages`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ content: "把 LIMIT 改成 30" }),
});
if (suggestWriteRes.status !== 200 || !suggestWriteRes.body) fail("suggest 写文件发消息失败");
let suggestDiffStatus = "";
await readSse(suggestWriteRes, async (name, data) => {
  if (name === "diff") {
    suggestDiffStatus = String(data.status ?? "");
    if (suggestDiffStatus !== "pending") fail(`suggest 的 diff 应为 pending，实际 ${suggestDiffStatus}`);
    if (fs.readFileSync(path.join(proj, "src", "config.ts"), "utf8").includes("const LIMIT = 30;")) {
      fail("点应用前文件不该被改");
    }
    const ok = await app.request(`/api/diffs/${(data.diff as { id: string }).id}/apply`, { method: "POST", headers: H });
    if (ok.status !== 200) fail(`应用失败: ${await ok.text()}`);
  }
});
if (suggestDiffStatus !== "pending") fail("suggest 应发出 pending diff");
if (!fs.readFileSync(path.join(proj, "src", "config.ts"), "utf8").includes("const LIMIT = 30;")) fail("点应用后文件应被改");
console.log("suggest 写文件 OK: 先 pending，点应用才落盘");

// full-auto：不问直接跑
await app.request("/api/settings", { method: "PUT", headers: H, body: JSON.stringify({ approvalMode: "full-auto" }) });
script.length = 0;
script.push({ tool: { name: "run_terminal", args: { command: "echo auto-run" } } }, { content: "done" });
cursor = 0;
const autoText = await (
  await app.request(`/api/conversations/${conv2.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ content: "跑" }) })
).text();
if (autoText.includes("event: command")) fail("full-auto 不该发 command 事件");
if (!autoText.includes("auto-run")) fail("full-auto 应直接执行");
console.log("full-auto OK: 不问直接跑");

// ---- 重新生成 / 回退 ----
script.length = 0;
script.push({ content: "第二版回答" });
cursor = 0;
type MsgRow = { id: string; role: string; content: string | null };
const before = (await (await app.request(`/api/conversations/${conv2.id}`, { headers: H })).json()) as { messages: MsgRow[] };
const userCount = before.messages.filter((m) => m.role === "user").length;
const regen = await app.request(`/api/conversations/${conv2.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ regenerate: true }) });
if (regen.status !== 200) fail(`regenerate: ${await regen.text()}`);
await regen.text();
const regenAfter = (await (await app.request(`/api/conversations/${conv2.id}`, { headers: H })).json()) as { messages: MsgRow[] };
if (regenAfter.messages.filter((m) => m.role === "user").length !== userCount) fail("regenerate 不该增删用户消息");
if (regenAfter.messages.at(-1)?.content !== "第二版回答") fail("regenerate 后最后一条应是新回答");
if (regenAfter.messages.some((m) => m.role === "assistant" && m.content === "done")) fail("regenerate 应删掉上一版回答");
console.log("重新生成 OK: 用户消息不变，旧回答被替换");

const firstUserRow = before.messages.find((m) => m.role === "user")!;
const rewind = await app.request(`/api/conversations/${conv2.id}/messages/${firstUserRow.id}/rewind`, { method: "POST", headers: H });
if (rewind.status !== 200) fail(`rewind: ${await rewind.text()}`);
const emptyConv = (await (await app.request(`/api/conversations/${conv2.id}`, { headers: H })).json()) as { messages: unknown[] };
if (emptyConv.messages.length !== 0) fail(`回退到第一条用户消息之前应清空，实际 ${emptyConv.messages.length}`);
console.log("回退 OK: 该消息及之后全部删除");

// ---- 截断的 tool_call arguments：不能原样回放给上游（会 400），也不能拿残缺 JSON 去改文件 ----
script.length = 0;
script.push(
  {
    tool: {
      name: "edit_file",
      args: {},
      rawArguments:
        '{"path":"src/config.ts","old_string":"const LIMIT = 20;","new_string":"const LIMIT = 99;',
    },
  },
  { content: "参数截断了，请再发一次完整 JSON。" },
);
cursor = 0;
const convTrunc = (await (
  await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "agent", workspaceRoot: proj }) })
).json()) as { id: string };
const truncSse = await (
  await app.request(`/api/conversations/${convTrunc.id}/messages`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ content: "把 LIMIT 改成 99" }),
  })
).text();
if (truncSse.includes("Agnes API 400") || truncSse.includes("must be valid JSON")) {
  fail(`截断 arguments 回放不应打到上游 400: ${truncSse.slice(0, 500)}`);
}
if (!truncSse.includes("arguments 不是合法 JSON")) fail("截断的 tool call 应回工具失败而不是执行");
if (fs.readFileSync(path.join(proj, "src", "config.ts"), "utf8").includes("const LIMIT = 99;")) {
  fail("截断的 edit_file 不该落盘");
}
const truncDetail = (await (await app.request(`/api/conversations/${convTrunc.id}`, { headers: H })).json()) as {
  messages: Array<{ role: string; tool_calls: string | null; content: string | null }>;
};
const truncCall = truncDetail.messages.find((m) => m.role === "assistant" && m.tool_calls);
if (!truncCall?.tool_calls) fail("截断调用应落库");
for (const tc of JSON.parse(truncCall.tool_calls) as Array<{ function: { arguments: string } }>) {
  JSON.parse(tc.function.arguments);
}
if (!truncDetail.messages.some((m) => m.role === "tool" && String(m.content).includes("不是合法 JSON"))) {
  fail("应有一条工具结果告诉模型 JSON 被截断");
}
if (!truncDetail.messages.some((m) => m.role === "assistant" && m.content === "参数截断了，请再发一次完整 JSON。")) {
  fail("下一轮应能继续对话而不是整段请求失败");
}
console.log("截断 tool arguments OK: 不 400、不落盘、模型可重试");

// ---- 网络瞬时故障：上游直接断连一次，SDK 应重试并把 retry 事件透给界面，而不是整轮「请求失败」 ----
script.length = 0;
cursor = 0;
script.push({ content: "重试后成功" });
dropNext = 1;
const convRetry = (await (
  await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "agent", workspaceRoot: proj }) })
).json()) as { id: string };
const retrySse = await (
  await app.request(`/api/conversations/${convRetry.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ content: "网络抖一下" }) })
).text();
if (!retrySse.includes("event: retry")) fail(`断连一次应发出 retry 事件: ${retrySse.slice(0, 400)}`);
if (!retrySse.includes("重试后成功")) fail(`重试后应拿到正常回答: ${retrySse.slice(0, 400)}`);
if (retrySse.includes("请求失败")) fail("重试成功不该再报请求失败");
if (dropNext !== 0) fail("假上游应真的断过一次");
console.log("网络重试 OK: 断连一次自动重试，界面收到 retry 事件");

// ---- 同一工作区多个 Agent 可以并行；写入 + git 提交按目录排队，改动互不覆盖 ----
{
  // 1) withWorkspaceLock：同目录串行，不同目录互不等待
  const soloRoot = path.join(tmp, "solo-proj");
  fs.mkdirSync(soloRoot, { recursive: true });
  const order: string[] = [];
  const la = withWorkspaceLock(proj, async () => {
    order.push("a-in");
    await new Promise((r) => setTimeout(r, 80));
    order.push("a-out");
  });
  const lb = withWorkspaceLock(proj, async () => {
    order.push("b-in");
    order.push("b-out");
  });
  const lc = withWorkspaceLock(soloRoot, async () => {
    order.push("c-in");
  });
  await Promise.all([la, lb, lc]);
  if (order.indexOf("b-in") < order.indexOf("a-out")) fail(`同目录写入应排队，实际顺序 ${order.join(" > ")}`);
  if (order.indexOf("c-in") > order.indexOf("a-out")) fail(`不同目录不该互相等待，实际顺序 ${order.join(" > ")}`);

  // 2) 两个 edit_file 同时改同一个文件的不同位置：没有锁时第二个会用旧内容整份覆盖、丢掉第一个改动
  const wsX = new Workspace(proj);
  const silent: ToolRuntime = {
    workspaceRoot: proj,
    autoApply: true,
    allowTerminal: false,
    allowWrites: true,
    gitCheckpoints: false,
    emit: () => {},
    waitForApply: async () => "rejected",
    saveImage: async () => fail("不该出图"),
    saveVideo: async () => fail("不该出视频"),
  };
  const fakeAgnes = new AgnesClient({ apiKey: "k", baseUrl: `http://127.0.0.1:${port}/v1` });
  const models = { image: "img", video: "vid" };
  const before = fs.readFileSync(path.join(proj, "src", "config.ts"), "utf8");
  if (!before.includes("NAME = 'x'") || !before.includes("const LIMIT = 30;")) fail(`并行测试前置内容不对: ${before}`);
  const [r1, r2] = await Promise.all([
    executeTool("edit_file", JSON.stringify({ path: "src/config.ts", old_string: "NAME = 'x'", new_string: "NAME = 'a'" }), wsX, silent, fakeAgnes, models, "c1"),
    executeTool("edit_file", JSON.stringify({ path: "src/config.ts", old_string: "const LIMIT = 30;", new_string: "const LIMIT = 31;" }), wsX, silent, fakeAgnes, models, "c2"),
  ]);
  const merged = fs.readFileSync(path.join(proj, "src", "config.ts"), "utf8");
  if (!merged.includes("NAME = 'a'") || !merged.includes("const LIMIT = 31;")) {
    fail(`并行 edit_file 丢了改动: ${r1} | ${r2} | ${merged}`);
  }
  console.log("写入互斥 OK: 同目录排队、不同目录并行、并发 edit_file 两处改动都保住");
}

// 3) HTTP 层：同一工作区两个 Agent 一起跑都 200（以前第二个 409），各改一处，git 各提交一次
const convA = (await (
  await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "agent", workspaceRoot: proj }) })
).json()) as { id: string };
const convB = (await (
  await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "agent", workspaceRoot: proj }) })
).json()) as { id: string };
routes.length = 0;
routes.push(
  {
    needle: "任务甲",
    turns: [{ tool: { name: "edit_file", args: { path: "src/config.ts", old_string: "NAME = 'a'", new_string: "NAME = 'b'" } } }, { content: "甲 结束" }],
    cursor: 0,
  },
  {
    needle: "任务乙",
    turns: [{ tool: { name: "edit_file", args: { path: "src/config.ts", old_string: "const LIMIT = 31;", new_string: "const LIMIT = 32;" } } }, { content: "乙 结束" }],
    cursor: 0,
  },
);
const commitsBefore = execFileSync("git", ["-C", proj, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
const [resA, resB] = await Promise.all([
  app.request(`/api/conversations/${convA.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ content: "任务甲：把 NAME 改成 b" }) }),
  app.request(`/api/conversations/${convB.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ content: "任务乙：把 LIMIT 改成 32" }) }),
]);
if (resA.status !== 200 || resB.status !== 200) fail(`同工作区两个 Agent 应都能开跑，实际 ${resA.status} / ${resB.status}`);
const [sseA, sseB] = await Promise.all([resA.text(), resB.text()]);
if (!sseA.includes("甲 结束") || !sseB.includes("乙 结束")) fail("两个 Agent 都应跑完");
const both = fs.readFileSync(path.join(proj, "src", "config.ts"), "utf8");
if (!both.includes("NAME = 'b'") || !both.includes("const LIMIT = 32;")) fail(`并行 Agent 的改动应都落盘: ${both}`);
const commitsAfter = execFileSync("git", ["-C", proj, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
if (Number(commitsAfter) - Number(commitsBefore) !== 2) fail(`两个 Agent 各应提交一次，实际多了 ${Number(commitsAfter) - Number(commitsBefore)} 个 commit`);
if (/index\.lock/.test(sseA + sseB)) fail("并行提交不该撞 index.lock");
console.log("并行 Agent OK: 同工作区两个 Agent 同时 200，两处改动都在，git 提交 2 次无 index.lock");

// 4) 同一对话未结束再发仍然 409（这条不放开）
script.length = 0;
cursor = 0;
script.push({ content: "占住结束" });
routes.length = 0;
const held = armHold("占住HOLD");
const holdRes = Promise.resolve(
  app.request(`/api/conversations/${convA.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ content: "请占住HOLD" }) }),
);
let holdResponse: Response | undefined;
const drainHold = holdRes.then(async (res: Response) => {
  holdResponse = res;
  return res.text();
});
await Promise.race([
  held,
  drainHold.then((text) => fail(`占住的 Agent 流已结束却没碰到 hold: ${text.slice(0, 300)}`)),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("等上游 hold 超时")), 15_000)),
]);
const dup = await app.request(`/api/conversations/${convA.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ content: "同一条再发" }) });
if (dup.status !== 409) fail(`同一对话重复发送应 409，实际 ${dup.status}`);
holdNeedle = "";
releaseHold!();
await drainHold;
if (!holdResponse || holdResponse.status !== 200) fail(`占住的 Agent 结束后应 200，实际 ${holdResponse?.status}`);
console.log("同对话互斥 OK: 未结束再发 409");

// 5) suggest 模式：等审批期间文件被别人改了，点「应用」应拒绝并让模型重读，而不是把别人的改动盖掉
await app.request("/api/settings", { method: "PUT", headers: H, body: JSON.stringify({ approvalMode: "suggest" }) });
script.length = 0;
cursor = 0;
script.push(
  { tool: { name: "edit_file", args: { path: "src/config.ts", old_string: "const LIMIT = 32;", new_string: "const LIMIT = 33;" } } },
  { content: "过期了，我重新读。" },
);
const convStale = (await (
  await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "agent", workspaceRoot: proj }) })
).json()) as { id: string };
const staleRes = await app.request(`/api/conversations/${convStale.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ content: "LIMIT 改 33" }) });
let staleApply: Response | undefined;
let staleToolResult = "";
await readSse(staleRes, async (name, data) => {
  if (name === "diff") {
    // 另一个任务趁审批前改了同一个文件
    const cur = fs.readFileSync(path.join(proj, "src", "config.ts"), "utf8");
    fs.writeFileSync(path.join(proj, "src", "config.ts"), cur.replace("NAME = 'b'", "NAME = 'c'"));
    staleApply = await app.request(`/api/diffs/${(data.diff as { id: string }).id}/apply`, { method: "POST", headers: H });
  }
  if (name === "tool_end") staleToolResult = `${String(data.result ?? "")}|ok=${String(data.ok)}`;
});
if (!staleApply || staleApply.status !== 409) fail(`过期的 diff 应用应 409，实际 ${staleApply?.status}`);
if (!staleToolResult.startsWith("写入失败") || !staleToolResult.endsWith("ok=false")) fail(`过期写入应回工具失败: ${staleToolResult}`);
const staleFile = fs.readFileSync(path.join(proj, "src", "config.ts"), "utf8");
if (!staleFile.includes("NAME = 'c'") || !staleFile.includes("const LIMIT = 32;")) fail(`过期的 diff 不该盖掉别人的改动: ${staleFile}`);
console.log("过期审批 OK: 文件被改过后点应用 409，模型收到重读提示，别人的改动没被盖掉");

// ================= 评审修复回归（fix/review-0.1.30）=================
type Ev = { name: string; data: Record<string, unknown> };
type HistRow = { role: string; content: string | null; tool_calls: string | null; tool_call_id: string | null };
const parseSse = (text: string): Ev[] =>
  [...text.matchAll(/^event: (\w+)\ndata: (.+)$/gm)].map((m) => ({ name: m[1]!, data: JSON.parse(m[2]!) as Record<string, unknown> }));
const newAgent = async (extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await app.request("/api/conversations", { method: "POST", headers: H, body: JSON.stringify({ mode: "agent", workspaceRoot: proj, ...extra }) });
  if (r.status !== 200) fail(`建 Agent 失败: ${await r.text()}`);
  return ((await r.json()) as { id: string }).id;
};
const sendMsg = (convId: string, payload: Record<string, unknown>) =>
  app.request(`/api/conversations/${convId}/messages`, { method: "POST", headers: H, body: JSON.stringify(payload) });
const historyOf = async (convId: string): Promise<HistRow[]> =>
  ((await (await app.request(`/api/conversations/${convId}`, { headers: H })).json()) as { messages: HistRow[] }).messages;
const planModeOf = (convId: string) => Number((db.prepare("SELECT plan_mode FROM conversations WHERE id = ?").get(convId) as { plan_mode: number }).plan_mode);
const chatUsed = () => Number((db.prepare("SELECT COALESCE(SUM(chat_used), 0) AS n FROM entitlements").get() as { n: number }).n);
const resetScript = (...turns: Turn[]) => {
  routes.length = 0;
  script.length = 0;
  script.push(...turns);
  cursor = 0;
};

// 1) 计划模式竞态：开关跟着消息一起提交，第一轮就生效（以前 PATCH 没落库就发送，第一轮照样改文件）
{
  resetScript(
    { tool: { name: "edit_file", args: { path: "src/config.ts", old_string: "const LIMIT = 32;", new_string: "const LIMIT = 77;" } } },
    { content: "先出方案。" },
  );
  const cid = await newAgent();
  const promptIdx = systemPrompts.length;
  const evs = parseSse(await (await sendMsg(cid, { content: "改 LIMIT", planMode: true })).text());
  const end = evs.find((e) => e.name === "tool_end" && e.data.name === "edit_file");
  if (!String(end?.data.result ?? "").includes("当前是计划模式")) fail(`planMode 随消息提交后第一轮就该拦写入: ${JSON.stringify(end?.data)}`);
  if (!systemPrompts[promptIdx]?.includes("# Plan mode")) fail("planMode 随消息提交后第一轮系统提示就该带计划模式说明");
  if (fs.readFileSync(path.join(proj, "src", "config.ts"), "utf8").includes("const LIMIT = 77;")) fail("计划模式下文件不该被改");
  if (planModeOf(cid) !== 1) fail("planMode:true 应写进对话");
  await (await sendMsg(cid, { content: "关掉计划模式", planMode: false })).text();
  if (planModeOf(cid) !== 0) fail("planMode:false 应关掉计划模式");
  console.log("计划模式竞态 OK: planMode 随消息提交，第一轮就生效");
}

// 2) ask_user：卡片 id 本机生成、带 callId；选项去重；/pending 能补回卡片；答完 tool_end 用 callId 收卡
{
  resetScript(
    { tool: { name: "ask_user", args: { question: "用哪种方案？", options: [{ label: "甲" }, { label: "甲" }, { label: "乙" }] } } },
    { content: "好的，用甲。" },
  );
  const cid = await newAgent();
  const seen: { qid: string; callId: string; endId: string; end: string; labels: string; pending?: { running: boolean; cards: Array<Record<string, unknown>> }; reAnswer: number } = {
    qid: "",
    callId: "",
    endId: "",
    end: "",
    labels: "",
    reAnswer: 0,
  };
  await readSse(await sendMsg(cid, { content: "帮我选" }), async (name, data) => {
    if (name === "question") {
      seen.qid = String(data.id);
      seen.callId = String(data.callId ?? "");
      seen.labels = (data.options as Array<{ label: string }>).map((o) => o.label).join(",");
      seen.pending = (await (await app.request(`/api/conversations/${cid}/pending`, { headers: H })).json()) as typeof seen.pending;
      const ok = await app.request(`/api/questions/${seen.qid}/answer`, { method: "POST", headers: H, body: JSON.stringify({ text: "甲" }) });
      if (ok.status !== 200) fail(`回答失败: ${await ok.text()}`);
      seen.reAnswer = (await app.request(`/api/questions/${seen.qid}/answer`, { method: "POST", headers: H, body: JSON.stringify({ text: "乙" }) })).status;
    }
    if (name === "tool_end" && data.name === "ask_user") {
      seen.endId = String(data.id);
      seen.end = `${String(data.result)}|ok=${String(data.ok)}`;
    }
  });
  if (!seen.qid.startsWith("q") || !seen.callId || seen.qid === seen.callId) fail(`提问 id 应本机生成并带 callId: ${seen.qid} / ${seen.callId}`);
  if (seen.labels !== "甲,乙") fail(`重复选项应去重: ${seen.labels}`);
  if (seen.reAnswer !== 404) fail(`答过的问题再答应 404，实际 ${seen.reAnswer}`);
  if (seen.endId !== seen.callId) fail("ask_user 的 tool_end id 应等于提问的 callId，界面靠它收卡");
  if (!seen.end.startsWith("用户回答：甲") || !seen.end.endsWith("ok=true")) fail(`回答结果不对: ${seen.end}`);
  if (!seen.pending?.running || !seen.pending.cards.some((card) => card.type === "question" && card.id === seen.qid)) {
    fail(`等回答时 /pending 应补回提问卡片: ${JSON.stringify(seen.pending)}`);
  }
  const after = (await (await app.request(`/api/conversations/${cid}/pending`, { headers: H })).json()) as { running: boolean; cards: unknown[] };
  if (after.running || after.cards.length) fail(`跑完后 /pending 应为空: ${JSON.stringify(after)}`);
  console.log("ask_user OK: 本机 id + callId、选项去重、/pending 补卡、答完收卡");
}

// 3) present_plan：要求修改不算工具失败、计划模式保持；批准后关掉计划模式
{
  const planMd = "# 改 LIMIT\n\n1. 读 config\n2. 改常量";
  resetScript(
    { tool: { name: "present_plan", args: { plan: planMd } } },
    { tool: { name: "present_plan", args: { plan: `${planMd}\n3. 跑测试` } } },
    { content: "方案已批准，开始实现。" },
  );
  const cid = await newAgent();
  const reviews: Array<{ id: string; callId: string }> = [];
  const ends: Array<{ id: string; result: string; ok: boolean }> = [];
  const modes: boolean[] = [];
  await readSse(await sendMsg(cid, { content: "先给方案", planMode: true }), async (name, data) => {
    if (name === "plan_review") {
      reviews.push({ id: String(data.id), callId: String(data.callId ?? "") });
      const action = reviews.length === 1 ? "revise" : "approve";
      if (action === "revise" && planModeOf(cid) !== 1) fail("等确认时计划模式应开着");
      const ok = await app.request(`/api/plans/${String(data.id)}/${action}`, { method: "POST", headers: H, body: JSON.stringify({ note: "补一步测试" }) });
      if (ok.status !== 200) fail(`${action} 失败: ${await ok.text()}`);
    }
    if (name === "tool_end" && data.name === "present_plan") ends.push({ id: String(data.id), result: String(data.result), ok: data.ok === true });
    if (name === "plan_mode") modes.push(data.active === true);
  });
  if (reviews.length !== 2) fail(`应有两次方案确认，实际 ${reviews.length}`);
  if (reviews.some((rv) => !rv.id.startsWith("plan") || !rv.callId || rv.id === rv.callId)) fail(`方案卡片 id 应本机生成并带 callId: ${JSON.stringify(reviews)}`);
  if (ends[0]?.id !== reviews[0]!.callId) fail("present_plan 的 tool_end id 应等于 callId");
  if (!ends[0]?.result.startsWith("用户还想改计划") || !ends[0].ok) fail(`要求修改不该算工具失败: ${JSON.stringify(ends[0])}`);
  if (!ends[1]?.result.startsWith("用户批准了这份计划") || !ends[1].ok) fail(`批准结果不对: ${JSON.stringify(ends[1])}`);
  if (!modes.includes(false)) fail("批准后应发 plan_mode=false");
  if (planModeOf(cid) !== 0) fail("批准后对话的计划模式应关闭");
  console.log("present_plan OK: 修改意见不标红、计划模式保持；批准后关闭");

  // 等确认时点停止：方案按取消处理，模型收到「没有确认」，历史成对
  resetScript({ tool: { name: "present_plan", args: { plan: planMd } } }, { content: "(不该走到这里)" });
  const cid2 = await newAgent();
  let stopEnd = "";
  let finishReason = "";
  await readSse(await sendMsg(cid2, { content: "给方案", planMode: true }), async (name, data) => {
    if (name === "plan_review") await app.request(`/api/conversations/${cid2}/stop`, { method: "POST", headers: H });
    if (name === "tool_end" && data.name === "present_plan") stopEnd = `${String(data.result)}|ok=${String(data.ok)}`;
    if (name === "finish") finishReason = String(data.reason);
  });
  if (!stopEnd.startsWith("用户没有确认这份计划") || !stopEnd.endsWith("ok=false")) fail(`停止时方案应按取消处理: ${stopEnd}`);
  if (finishReason !== "abort") fail(`停止后 finish 应为 abort，实际 ${finishReason}`);
  if (planModeOf(cid2) !== 1) fail("取消方案不该关掉计划模式");
  console.log("方案中途停止 OK: 按取消处理、计划模式保持");
}

// 4) 一批工具跑到一半点停止：没跑到的调用补「已取消」，下一条消息上游不 400
{
  resetScript(
    {
      tools: [
        { name: "run_terminal", args: { command: "echo batch-a" } },
        { name: "read_file", args: { path: "src/config.ts" } },
      ],
    },
    { content: "停了之后接着聊。" },
  );
  const cid = await newAgent();
  let stopped = false;
  await readSse(await sendMsg(cid, { content: "跑两个" }), async (name) => {
    if (name === "command" && !stopped) {
      stopped = true;
      await app.request(`/api/conversations/${cid}/stop`, { method: "POST", headers: H });
    }
  });
  if (!stopped) fail("suggest 模式下 run_terminal 应先发 command 事件");
  const rows = await historyOf(cid);
  const callRow = rows.find((m) => m.role === "assistant" && m.tool_calls);
  if (!callRow?.tool_calls) fail("停止后 assistant.tool_calls 也应落库");
  const callIds = (JSON.parse(callRow.tool_calls) as Array<{ id: string }>).map((tc) => tc.id);
  const results = rows.filter((m) => m.role === "tool");
  for (const cidx of callIds) if (!results.some((m) => m.tool_call_id === cidx)) fail(`停止后调用 ${cidx} 缺结果`);
  if (!results.some((m) => m.content === CANCELLED_TOOL_RESULT)) fail("没跑到的工具应记「已取消」");
  const next = await (await sendMsg(cid, { content: "继续" })).text();
  if (next.includes("invalid tool pairing") || !next.includes("停了之后接着聊。")) fail(`停止后下一条消息应正常: ${next.slice(0, 400)}`);
  console.log("工具批次中途停止 OK: 没跑到的调用补已取消，下一条正常");
}

// 5) 旧版本留下的残缺历史（tool_calls 落单 + 孤儿 tool 消息）在发给上游前修好
{
  resetScript({ content: "旧历史修好了" });
  const cid = await newAgent();
  const t0 = Date.now() - 10_000;
  const ins = db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, tool_call_id, tool_calls, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  ins.run(`m_legacy_u_${t0}`, cid, "user", "旧问题", null, null, "[]", t0);
  ins.run(
    `m_legacy_a_${t0}`,
    cid,
    "assistant",
    null,
    null,
    JSON.stringify([{ id: "legacy_1", type: "function", function: { name: "read_file", arguments: '{"path":"package.json"}' } }]),
    "[]",
    t0 + 1,
  );
  ins.run(`m_legacy_t_${t0}`, cid, "tool", "孤儿结果", "ghost", null, "[]", t0 + 2);
  const bodiesBefore = upstreamBodies.length;
  const text = await (await sendMsg(cid, { content: "接着来" })).text();
  if (!text.includes("旧历史修好了")) fail(`残缺历史应在发送前修好，而不是 400: ${text.slice(0, 400)}`);
  const sent = upstreamBodies[bodiesBefore]!;
  if (!sent.some((m) => m.role === "tool" && m.tool_call_id === "legacy_1" && m.content === CANCELLED_TOOL_RESULT)) fail("落单的 tool_call 应补占位结果");
  if (sent.some((m) => m.tool_call_id === "ghost")) fail("孤儿 tool 消息不该发给上游");
  console.log("历史修复 OK: 落单调用补占位、孤儿结果丢掉");
}

// 6) 只读工具并行 + 上游给重复 call id 时本机改成唯一
{
  resetScript(
    {
      tools: [
        { name: "read_file", args: { path: "src/config.ts" }, id: "dup" },
        { name: "grep", args: { pattern: "LIMIT" }, id: "dup" },
        { name: "list_dir", args: { path: "." }, id: "dup2" },
      ],
    },
    { content: "三个都看完了。" },
  );
  const cid = await newAgent();
  const evs = parseSse(await (await sendMsg(cid, { content: "并行读" })).text());
  const order = evs.filter((e) => e.name === "tool_start" || e.name === "tool_end").map((e) => e.name);
  if (order.slice(0, 3).join(",") !== "tool_start,tool_start,tool_start") fail(`连着的只读工具应一起开跑: ${order.join(",")}`);
  const endIds = evs.filter((e) => e.name === "tool_end").map((e) => String(e.data.id));
  if (endIds.length !== 3 || new Set(endIds).size !== 3) fail(`重复的上游 call id 应改成唯一: ${endIds.join(",")}`);
  if (!evs.some((e) => e.name === "token" && String(e.data.text).includes("三个都看完了"))) fail("并行工具后应继续对话");
  resetScript({ tools: [{ name: "read_file", args: { path: "package.json" }, id: "dup" }] }, { content: "第二轮也行。" });
  const text2 = await (await sendMsg(cid, { content: "再读一次" })).text();
  if (text2.includes("invalid tool pairing") || !text2.includes("第二轮也行。")) fail(`同一对话再次出现相同 call id 也应正常: ${text2.slice(0, 400)}`);
  console.log("只读工具并行 OK: 一起开跑、重复 call id 去重");
}

// 7) 上游一开始就失败：退回本次扣的对话次数；成功的照常扣
{
  resetScript({ status: 400 });
  const cid = await newAgent();
  const before = chatUsed();
  const failed = await (await sendMsg(cid, { content: "上游会拒绝" })).text();
  if (!failed.includes("event: error")) fail(`上游 400 应发 error 事件: ${failed.slice(0, 300)}`);
  if (chatUsed() !== before) fail(`上游失败应退回对话次数: ${before} -> ${chatUsed()}`);
  resetScript({ content: "这次成功" });
  await (await sendMsg(cid, { content: "再来" })).text();
  if (chatUsed() !== before + 1) fail(`成功的对话应扣一次: ${before} -> ${chatUsed()}`);
  console.log("额度退还 OK: 上游失败不扣次，成功照常扣");
}

// 8) 自定义提供方：openai-responses 协议能跑工具；密钥加密落库；改域名必须重填密钥；删掉后对话回落默认模型
{
  const respBodies: Array<{ input: Array<{ type?: string; call_id?: string; output?: string }>; tools?: unknown[] }> = [];
  const respAuth: string[] = [];
  const respUpstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      respAuth.push(String(req.headers.authorization ?? ""));
      if (!req.url?.startsWith("/v1/responses")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as (typeof respBodies)[number];
      respBodies.push(body);
      const output = body.input.find((item) => item.type === "function_call_output");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const ev = (o: Record<string, unknown>) => res.write(`event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`);
      if (!output) {
        ev({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "fc_1", name: "read_file" } });
        ev({ type: "response.function_call_arguments.done", output_index: 0, arguments: JSON.stringify({ path: "package.json" }) });
        ev({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } });
      } else {
        ev({ type: "response.output_text.delta", delta: String(output.output).includes("proj") ? "responses 读到了 package.json" : "没读到" });
        ev({ type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 6 } } });
      }
      res.end();
    });
  });
  const rport = await new Promise<number>((r) =>
    respUpstream.listen(0, "127.0.0.1", () => {
      const a = respUpstream.address();
      r(typeof a === "object" && a ? a.port : 0);
    }),
  );
  const providerBody = { id: "resp", name: "Resp", baseUrl: `http://127.0.0.1:${rport}/v1`, protocol: "openai-responses", models: ["gpt-test"] };
  const created = await app.request("/api/providers", { method: "POST", headers: H, body: JSON.stringify({ ...providerBody, apiKey: "resp-secret-key" }) });
  if (created.status !== 200) fail(`添加提供方失败: ${await created.text()}`);
  const rawKv = String((db.prepare("SELECT value FROM kv WHERE key = ?").get(PROVIDERS_KV) as { value: string }).value);
  if (rawKv.includes("resp-secret-key") || !rawKv.includes("apiKeyEnc")) fail("提供方密钥应加密落库");

  const model = customModelId("resp", "gpt-test");
  const cid = await newAgent({ model });
  const before = chatUsed();
  const evs = parseSse(await (await sendMsg(cid, { content: "用 responses 读 package.json" })).text());
  const readEnd = evs.find((e) => e.name === "tool_end" && e.data.name === "read_file");
  if (!readEnd || readEnd.data.ok !== true) fail(`responses 协议应能调工具: ${JSON.stringify(evs.filter((e) => e.name === "error"))}`);
  if (!evs.some((e) => e.name === "token" && String(e.data.text).includes("responses 读到了 package.json"))) fail("responses 第二轮应拿到工具结果");
  if (!respBodies[0]?.tools?.length) fail("responses 请求应带上工具定义");
  const call = respBodies[1]?.input.find((item) => item.type === "function_call");
  const out = respBodies[1]?.input.find((item) => item.type === "function_call_output");
  if (!call?.call_id || call.call_id !== out?.call_id) fail("responses 回放应把 function_call 和 function_call_output 配成对");
  if (respAuth.some((a) => a !== "Bearer resp-secret-key")) fail("responses 请求应带解密后的密钥");
  if (chatUsed() !== before) fail("自定义模型不该扣内置对话次数");

  const rehost = await app.request("/api/providers/resp", {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ ...providerBody, baseUrl: `http://localhost:${rport}/v1` }),
  });
  if (rehost.status !== 400 || !(await rehost.text()).includes("重新填写 API 密钥")) fail("换域名不重填密钥应拒绝");
  const probe = await app.request("/api/providers/probe", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ providerId: "resp", baseUrl: `http://localhost:${rport}/v1`, protocol: "openai-responses" }),
  });
  if (probe.status !== 400 || !(await probe.text()).includes("重新填写 API 密钥")) fail("探测新域名时不该带上旧密钥");
  const hitsBeforeProbe = respAuth.length;
  if (hitsBeforeProbe !== 2) fail(`拒绝时不该打到提供方，实际请求 ${hitsBeforeProbe} 次`);
  const renamed = await app.request("/api/providers/resp", { method: "PUT", headers: H, body: JSON.stringify({ ...providerBody, name: "Resp 2" }) });
  if (renamed.status !== 200) fail(`同域名改名不需要重填密钥: ${await renamed.text()}`);
  const badModel = await app.request(`/api/conversations/${cid}`, { method: "PATCH", headers: H, body: JSON.stringify({ model: "custom|nope|x" }) });
  if (badModel.status !== 400) fail(`不存在的自定义模型应拒绝，实际 ${badModel.status}`);

  const removed = await app.request("/api/providers/resp", { method: "DELETE", headers: H });
  if (removed.status !== 200) fail(`删除提供方失败: ${await removed.text()}`);
  const convAfter = (await (await app.request(`/api/conversations/${cid}`, { headers: H })).json()) as { model?: string; conversation?: { model?: string } };
  const modelAfter = String(convAfter.model ?? convAfter.conversation?.model ?? "");
  if (!modelAfter || modelAfter.startsWith("custom|resp|")) fail(`删掉提供方后对话应回落默认模型，实际 ${modelAfter}`);
  await new Promise<void>((r) => respUpstream.close(() => r()));
  console.log("自定义提供方 OK: responses 协议跑工具、密钥加密、换域名要重填密钥、删除后回落默认模型");
}
await new Promise<void>((r) => upstream.close(() => r()));
db.close();
for (const dir of tempDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.warn(`临时目录没删干净，请手动删除 ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log("agent loop check passed");
