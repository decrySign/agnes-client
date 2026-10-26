/**
 * MCP (Model Context Protocol) — stdio servers only (v1).
 *
 * Config: {dataDir}/mcp.json and/or {workspace}/.agnes/mcp.json (merged; workspace wins on name clash).
 * Tool names: mcp__{server}__{tool} (non [A-Za-z0-9_] → _).
 * Framing: default Content-Length (Claude-era / checker fixtures). Set "framing":"newline" for
 * official @modelcontextprotocol/sdk servers (spec NDJSON).
 * Sub-agents (depth>0) get the same MCP tools as the parent.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ChatToolDefinition } from "@agnes/sdk";
import { killTree } from "./proc.js";

export type McpFraming = "content-length" | "newline";

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  cwd?: string;
  /** content-length (default) or newline (SDK / current MCP spec). */
  framing?: McpFraming;
};

export type McpConfigFile = {
  mcpServers: Record<string, McpServerConfig>;
};

export type McpServerStatus = {
  name: string;
  status: "connected" | "disconnected" | "error";
  tools: number;
  error?: string;
};

export type CallMcpToolOptions = {
  mode?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type ToolEntry = {
  qualified: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type JsonRpcResult = {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  protocolVersion?: string;
  capabilities?: unknown;
  serverInfo?: { name?: string; version?: string };
  [k: string]: unknown;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const INIT_TIMEOUT_MS = 15_000;

export function sanitizeMcpToken(raw: string): string {
  const s = String(raw ?? "").replace(/[^A-Za-z0-9_]/g, "_");
  return s || "x";
}

export function mcpQualifiedName(server: string, tool: string): string {
  return "mcp__" + sanitizeMcpToken(server) + "__" + sanitizeMcpToken(tool);
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const idx = rest.indexOf("__");
  if (idx <= 0 || idx >= rest.length - 1) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function validateServerConfig(name: string, raw: unknown): McpServerConfig {
  if (!isPlainObject(raw)) throw new Error('MCP server "' + name + '" must be an object');
  if (typeof raw.command !== "string" || !raw.command.trim()) {
    throw new Error('MCP server "' + name + '" needs a string command');
  }
  if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string"))) {
    throw new Error('MCP server "' + name + '" args must be a string array');
  }
  if (raw.env !== undefined) {
    if (!isPlainObject(raw.env) || Object.values(raw.env).some((v) => typeof v !== "string")) {
      throw new Error('MCP server "' + name + '" env must be a string map');
    }
  }
  if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") {
    throw new Error('MCP server "' + name + '" disabled must be boolean');
  }
  if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
    throw new Error('MCP server "' + name + '" cwd must be a string');
  }
  if (raw.framing !== undefined && raw.framing !== "content-length" && raw.framing !== "newline") {
    throw new Error('MCP server "' + name + '" framing must be content-length or newline');
  }
  return {
    command: raw.command.trim(),
    args: Array.isArray(raw.args) ? (raw.args as string[]) : undefined,
    env: raw.env as Record<string, string> | undefined,
    disabled: raw.disabled === true,
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    framing: raw.framing as McpFraming | undefined,
  };
}

export function loadMcpConfig(filePath: string): McpConfigFile {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    const empty: McpConfigFile = { mcpServers: {} };
    rememberConfig(empty, resolved);
    return empty;
  }
  let rawText: string;
  try {
    rawText = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    throw new Error("cannot read MCP config " + resolved + ": " + (err instanceof Error ? err.message : String(err)));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error("MCP config " + resolved + " is not valid JSON: " + (err instanceof Error ? err.message : String(err)));
  }
  if (!isPlainObject(parsed)) throw new Error("MCP config " + resolved + " must be a JSON object");
  if (parsed.mcpServers === undefined) {
    const empty: McpConfigFile = { mcpServers: {} };
    rememberConfig(empty, resolved);
    return empty;
  }
  if (!isPlainObject(parsed.mcpServers)) {
    throw new Error("MCP config " + resolved + ": mcpServers must be an object");
  }
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(parsed.mcpServers)) {
    if (!name.trim()) throw new Error("MCP server name cannot be empty");
    mcpServers[name] = validateServerConfig(name, entry);
  }
  const cfg: McpConfigFile = { mcpServers };
  rememberConfig(cfg, resolved);
  return cfg;
}

export function loadMergedMcpConfig(dataDir: string, workspaceRoot?: string): McpConfigFile {
  const merged: McpConfigFile = { mcpServers: {} };
  const paths = [path.join(dataDir, "mcp.json")];
  if (workspaceRoot) paths.push(path.join(workspaceRoot, ".agnes", "mcp.json"));
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    Object.assign(merged.mcpServers, loadMcpConfig(p).mcpServers);
  }
  rememberConfig(merged, paths.join("+"));
  return merged;
}

function safeEnv(extra?: Record<string, string>): Record<string, string> {
  // Inherit a small safe set (same idea as the SDK) — never log values
  const keys =
    process.platform === "win32"
      ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"]
      : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && !v.startsWith("()")) env[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === "string") env[k] = v;
    }
  }
  return env;
}

function schemaToParameters(inputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== "object") return { type: "object", properties: {} };
  const out: Record<string, unknown> = { ...inputSchema };
  if (out.type === undefined) out.type = "object";
  return out;
}

function formatCallResult(result: JsonRpcResult): string {
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((p) => {
      if (p && p.type === "text" && typeof p.text === "string") return p.text;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .filter(Boolean)
    .join("\n");
  const body = text || "(empty)";
  if (result.isError) return "工具失败：" + body;
  return body;
}

/** Minimal JSON-RPC stdio session (Content-Length or newline). */
class McpSession {
  private child: ChildProcess;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: JsonRpcResult) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private framing: McpFraming;
  private closed = false;

  constructor(cfg: McpServerConfig) {
    this.framing = cfg.framing ?? "content-length";
    this.child = spawn(cfg.command, cfg.args ?? [], {
      env: safeEnv(cfg.env),
      cwd: cfg.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.child.stderr?.on("data", () => {
      /* discard — may contain secrets */
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.on("error", (err) => this.failAll(err));
    this.child.on("close", () => {
      this.closed = true;
      this.failAll(new Error("MCP process exited"));
    });
  }

  get pid(): number | undefined {
    return this.child.pid ?? undefined;
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.framing === "newline") this.drainNewline();
    else this.drainContentLength();
  }

  private drainContentLength(): void {
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;
      const raw = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      this.handleMessage(raw);
    }
  }

  private drainNewline(): void {
    for (;;) {
      const idx = this.buf.indexOf("\n");
      if (idx < 0) return;
      let line = this.buf.subarray(0, idx).toString("utf8");
      this.buf = this.buf.subarray(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      this.handleMessage(line);
    }
  }

  private handleMessage(raw: string): void {
    let msg: { id?: number; result?: JsonRpcResult; error?: { message?: string; code?: number } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id == null || !this.pending.has(Number(msg.id))) return;
    const p = this.pending.get(Number(msg.id))!;
    this.pending.delete(Number(msg.id));
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) {
      const err = new Error(msg.error.message || "MCP error");
      (err as { code?: number }).code = msg.error.code;
      p.reject(err);
    } else {
      p.resolve((msg.result ?? {}) as JsonRpcResult);
    }
  }

  private write(msg: object): void {
    if (this.closed) throw new Error("MCP session closed");
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    if (this.framing === "newline") {
      this.child.stdin?.write(body);
      this.child.stdin?.write("\n");
    } else {
      this.child.stdin?.write("Content-Length: " + body.length + "\r\n\r\n");
      this.child.stdin?.write(body);
    }
  }

  request(method: string, params?: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<JsonRpcResult> {
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error("MCP timeout after " + timeoutMs + "ms");
        (err as { code?: string }).code = "ETIMEDOUT";
        reject(err);
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          opts.signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
        timer,
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    try {
      this.write({ jsonrpc: "2.0", method, params: params ?? {} });
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("MCP session closed"));
    const pid = this.child.pid;
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
    killTree(pid ?? undefined);
  }
}

type ServerState = {
  name: string;
  config: McpServerConfig;
  status: "connected" | "disconnected" | "error";
  error?: string;
  session?: McpSession;
  tools: ToolEntry[];
};

export class McpHub {
  private servers = new Map<string, ServerState>();
  private toolIndex = new Map<string, ToolEntry>();
  private serverByToken = new Map<string, string>();

  async start(config: McpConfigFile): Promise<void> {
    await this.dispose();
    for (const [name, cfg] of Object.entries(config.mcpServers ?? {})) {
      if (cfg.disabled) {
        this.servers.set(name, { name, config: cfg, status: "disconnected", tools: [] });
        this.serverByToken.set(sanitizeMcpToken(name), name);
        continue;
      }
      try {
        await this.startOne(name, cfg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[mcp] server "' + name + '" failed to start: ' + message.slice(0, 200));
        this.servers.set(name, { name, config: cfg, status: "error", error: message.slice(0, 500), tools: [] });
        this.serverByToken.set(sanitizeMcpToken(name), name);
      }
    }
  }

  private async startOne(name: string, cfg: McpServerConfig): Promise<void> {
    const session = new McpSession(cfg);
    try {
      await session.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "agnes-client", version: "0.1.0" },
        },
        { timeoutMs: INIT_TIMEOUT_MS },
      );
      session.notify("notifications/initialized");
      const listed = await session.request("tools/list", {}, { timeoutMs: INIT_TIMEOUT_MS });
      const tools: ToolEntry[] = [];
      for (const t of listed.tools ?? []) {
        const toolName = String(t.name ?? "").trim();
        if (!toolName) continue;
        const qualified = mcpQualifiedName(name, toolName);
        const entry: ToolEntry = {
          qualified,
          server: name,
          tool: toolName,
          description: String(t.description ?? "MCP tool " + toolName + " from " + name).slice(0, 500),
          inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        };
        tools.push(entry);
        this.toolIndex.set(qualified, entry);
      }
      this.servers.set(name, { name, config: cfg, status: "connected", session, tools });
      this.serverByToken.set(sanitizeMcpToken(name), name);
    } catch (err) {
      await session.close().catch(() => {});
      throw err;
    }
  }

  toolDefinitions(): ChatToolDefinition[] {
    const out: ChatToolDefinition[] = [];
    for (const entry of this.toolIndex.values()) {
      out.push({
        type: "function",
        function: {
          name: entry.qualified,
          description: "[MCP:" + entry.server + "] " + entry.description,
          parameters: schemaToParameters(entry.inputSchema),
        },
      });
    }
    return out;
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      status: s.status,
      tools: s.tools.length,
      ...(s.error ? { error: s.error } : {}),
    }));
  }

  resolveServerName(tokenOrName: string): string | undefined {
    if (this.servers.has(tokenOrName)) return tokenOrName;
    return this.serverByToken.get(sanitizeMcpToken(tokenOrName));
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown> = {},
    opts: CallMcpToolOptions = {},
  ): Promise<string> {
    const real = this.resolveServerName(server) ?? server;
    const state = this.servers.get(real);
    if (!state || state.status !== "connected" || !state.session) {
      const why = state?.error || state?.status || "not connected";
      return "工具失败：MCP 服务器 " + server + " 不可用（" + why + "）";
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (opts.signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }
    try {
      const result = await state.session.request(
        "tools/call",
        { name: tool, arguments: args },
        { signal: opts.signal, timeoutMs },
      );
      return formatCallResult(result);
    } catch (err) {
      if (opts.signal?.aborted || (err as { name?: string })?.name === "AbortError") {
        const abortErr = new Error("Aborted");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(msg)) {
        const abortErr = new Error(msg || "Aborted");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      if (/timeout/i.test(msg) || (err as { code?: string })?.code === "ETIMEDOUT") {
        const t = new Error("MCP timeout after " + timeoutMs + "ms");
        (t as { code?: string }).code = "ETIMEDOUT";
        throw t;
      }
      throw err instanceof Error ? err : new Error(msg);
    }
  }

  async callQualified(name: string, args: Record<string, unknown>, opts: CallMcpToolOptions = {}): Promise<string> {
    const entry = this.toolIndex.get(name);
    if (!entry) {
      const parsed = parseMcpToolName(name);
      if (!parsed) return "工具失败：未知 MCP 工具 " + name;
      return this.callTool(parsed.server, parsed.tool, args, opts);
    }
    return this.callTool(entry.server, entry.tool, args, opts);
  }

  async dispose(): Promise<void> {
    const states = [...this.servers.values()];
    this.servers.clear();
    this.toolIndex.clear();
    this.serverByToken.clear();
    for (const s of states) {
      if (s.session) await s.session.close().catch(() => {});
      else killTree(undefined);
    }
  }
}

let sharedHub: McpHub | null = null;
let lastConfig: McpConfigFile | null = null;
let lastConfigPath: string | null = null;

function rememberConfig(cfg: McpConfigFile, from: string): void {
  lastConfig = cfg;
  lastConfigPath = from;
}

export function getSharedMcpHub(): McpHub | null {
  return sharedHub;
}

export async function ensureSharedMcpHub(config: McpConfigFile): Promise<McpHub> {
  if (!sharedHub) sharedHub = new McpHub();
  await sharedHub.start(config);
  rememberConfig(config, lastConfigPath ?? "(memory)");
  return sharedHub;
}

export async function disposeSharedMcpHub(): Promise<void> {
  if (sharedHub) {
    await sharedHub.dispose();
    sharedHub = null;
  }
}

export async function listMcpTools(configPath: string): Promise<ChatToolDefinition[]> {
  const cfg = loadMcpConfig(configPath);
  const hub = await ensureSharedMcpHub(cfg);
  return hub.toolDefinitions();
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown> = {},
  opts: CallMcpToolOptions = {},
): Promise<string> {
  if (opts.mode) return callEphemeral(server, tool, args, opts);
  if (!sharedHub) {
    if (lastConfig) await ensureSharedMcpHub(lastConfig);
    else throw new Error("MCP hub not started; call listMcpTools or ensureSharedMcpHub first");
  }
  return sharedHub!.callTool(server, tool, args, opts);
}

async function callEphemeral(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  opts: CallMcpToolOptions,
): Promise<string> {
  const base = lastConfig?.mcpServers?.[server];
  if (!base) throw new Error('unknown MCP server "' + server + '" (load a config that defines it first)');
  const hub = new McpHub();
  const env = { ...(base.env ?? {}), MCP_MODE: String(opts.mode) };
  try {
    await hub.start({ mcpServers: { [server]: { ...base, env, disabled: false } } });
    return await hub.callTool(server, tool, args, opts);
  } finally {
    await hub.dispose();
  }
}

export function getMcpStatus(): { servers: McpServerStatus[] } {
  if (!sharedHub) return { servers: [] };
  return { servers: sharedHub.status() };
}
