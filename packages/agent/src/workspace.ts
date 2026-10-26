import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import type { FileNode } from "./types.js";
import { findGitBin } from "./git-checkpoint.js";
import { formatSymbolMap } from "./symbols.js";

const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".agnes",
  ".next",
  ".turbo",
  ".vite",
  "unpackage",
  "target",
  "__pycache__",
]);

const SECRET_NAMES = new Set([".env", ".env.local", ".env.production", "id_rsa", "id_ed25519"]);
const BLOCKED_SEGMENTS = new Set([".git", "node_modules", ".agnes"]);
const SQLITE_NAMES = new Set(["agnes.sqlite", "agnes.sqlite-wal", "agnes.sqlite-shm"]);
const MAX_READ = 400_000;
const MAX_GREP_HITS = 80;

function isSecretName(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_NAMES.has(n) || n.startsWith(".env.");
}

function posixRel(rel: string): string {
  return rel.replace(/\\/g, "/");
}

function hasBlockedSegment(rel: string): boolean {
  return posixRel(rel)
    .split("/")
    .filter(Boolean)
    .some((seg) => BLOCKED_SEGMENTS.has(seg.toLowerCase()));
}

function isSqliteName(name: string): boolean {
  return SQLITE_NAMES.has(name.toLowerCase());
}

function assertNotSecret(rel: string, abs: string): void {
  if (isSecretName(path.basename(rel)) || isSecretName(path.basename(abs))) {
    throw new WorkspaceError("拒绝访问密钥类文件");
  }
}

function assertNotHostFile(rel: string, abs: string): void {
  assertNotSecret(rel, abs);
  if (hasBlockedSegment(rel) || hasBlockedSegment(abs)) {
    throw new WorkspaceError("拒绝访问受保护路径");
  }
  if (isSqliteName(path.basename(rel)) || isSqliteName(path.basename(abs))) {
    throw new WorkspaceError("拒绝访问数据库文件");
  }
}

function assertSafeInput(input: string): void {
  if (input.includes("\0")) throw new WorkspaceError("非法路径");
  const t = input.trim();
  if (!t) return;
  if (t.startsWith("\\\\") || t.startsWith("//")) throw new WorkspaceError("非法路径");
}

export function assertSafeGlob(pattern: string): void {
  const p = posixRel(pattern.trim());
  if (!p || p.includes("\0")) throw new WorkspaceError("非法匹配规则");
  if (p.startsWith("/") || p.startsWith("//") || /^[a-zA-Z]:/.test(pattern.trim())) {
    throw new WorkspaceError("非法匹配规则");
  }
  if (p.split("/").some((seg) => seg === "..")) throw new WorkspaceError("非法匹配规则");
}

/**
 * 比较用的真实路径：存在的那一段用 realpathSync.native 展开（软链、联接点、8.3 短名都还原），
 * 还不存在的尾巴原样接回去。这样 C:\Windows\Temp\还没建的目录 也能认出在 Windows 底下。
 */
function realishPath(resolved: string): string {
  let head = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      if (fsSync.existsSync(head)) {
        const real = fsSync.realpathSync.native(head);
        return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
      }
    } catch {
      /* 读不到就再往上找 */
    }
    const parent = path.dirname(head);
    if (parent === head) return resolved;
    tail.push(path.basename(head));
    head = parent;
  }
}

/**
 * Windows 上比较用的形式：正斜杠换反斜杠、去掉 \\?\ 和 \\.\ 前缀（\\?\UNC\ 还原成 \\）、小写、去掉末尾斜杠。
 * 网络路径开头的两个反斜杠保留（以前一并压成一个，\\主机\c$\windows 就认不出是网络路径了）
 */
function winKey(p: string): string {
  let s = p
    .replace(/\//g, "\\")
    .replace(/^\\\\[?.]\\(?=[a-z]:)/i, "")
    .replace(/^\\\\[?.]\\unc\\/i, "\\\\");
  const unc = s.startsWith("\\\\");
  s = s.replace(/\\{2,}/g, "\\");
  if (unc) s = "\\" + s;
  return s.toLowerCase().replace(/\\+$/, "");
}

/**
 * Windows 输入预处理（在 path.resolve 之前）：
 * - 拒绝 UNC 和一切 \\ 开头的网络路径（含 \\localhost\C$\…、\\?\UNC\…）；
 * - \\?\ 和 \\.\ 后面是本地盘符的，去掉前缀按本地路径继续查；后面不是盘符的（卷 GUID、设备）拒绝；
 * - 逐段去掉末尾的点和空格（Win32 打开路径时也这样去掉：C:\Windows. 就是 C:\Windows），去掉后的路径拿去比黑名单；
 *   但只要有一段末尾带点或空格（`.`、`..` 除外），黑名单过了也要拒（problem）：Node 的 fs 会加 \\?\ 前缀，
 *   mkdir 建出来的是字面上带点的目录，和校验的不是同一个；
 * - Windows 保留设备名（CON、PRN、AUX、NUL、CONIN$、CONOUT$、COM1–9、LPT1–9、COM¹²³、LPT¹²³，忽略大小写，带扩展名也算）同样记为 problem；
 * - 盘符之后的段里带冒号（备用数据流、第二个盘符）、或整段只有点的，直接拒绝。
 */
const WIN_RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i;

function cleanWinInput(raw: string): { path: string; problem?: string } {
  let s = String(raw).trim().replace(/\//g, "\\");
  if (s.includes("\0")) throw new WorkspaceError("工作区路径不合法");
  if (/^\\\\[?.]\\/.test(s)) {
    const rest = s.slice(4);
    if (/^unc(?:\\|$)/i.test(rest)) throw new WorkspaceError("工作区不能是网络路径（UNC）");
    if (!/^[a-z]:(?:\\|$)/i.test(rest)) throw new WorkspaceError("工作区不能是设备路径");
    s = rest;
  } else if (s.startsWith("\\\\")) {
    throw new WorkspaceError("工作区不能是网络路径（UNC）");
  }
  let problem: string | undefined;
  const out = s.split("\\").map((seg, i) => {
    if (seg === "" || seg === "." || seg === "..") return seg;
    if (i === 0 && /^[a-z]:$/i.test(seg)) return seg;
    if (i > 0 && seg.includes(":")) throw new WorkspaceError("工作区不能用带冒号的路径段");
    const t = seg.replace(/[. ]+$/, "");
    if (!t) throw new WorkspaceError("工作区不能用只有点或空格的路径段");
    if (t !== seg) problem = problem || `工作区不能用末尾带点或空格的路径段：「${seg}」`;
    // 设备名看第一个点之前的部分（con.txt、nul.tar.gz 也是设备），Windows 也会去掉它末尾的空格（con .txt）
    else if (WIN_RESERVED_NAME.test(seg.split(".")[0].replace(/ +$/, ""))) problem = problem || `工作区不能用 Windows 保留设备名：「${seg}」`;
    return t;
  });
  return { path: out.join("\\"), problem };
}

/** 真实路径是管理共享 \\主机\c$\… 时，按本地 c:\… 再查一遍（软链指向 \\localhost\C$\Windows 也拦） */
function adminShareAsLocal(key: string): string | null {
  const m = /^\\\\[^\\]+\\([a-z])\$(\\.*)?$/.exec(key);
  return m ? `${m[1]}:${m[2] ?? ""}` : null;
}

/**
 * Windows 黑名单：磁盘根、整个 Windows 目录树（任意盘的 \Windows，加上 SystemRoot / windir 指向的位置）、
 * Program Files，以及 Users 目录本身（C:\Users\某人\… 照常允许）
 */
function assertSafeWinRoot(n: string): void {
  if (/^[a-z]:$/.test(n)) {
    throw new WorkspaceError("工作区不能是磁盘根目录");
  }
  const systemRoots = [process.env.SystemRoot, process.env.windir].filter((v): v is string => Boolean(v && v.trim())).map(winKey);
  const underSystem = systemRoots.some((r) => r && (n === r || n.startsWith(`${r}\\`)));
  if (/^[a-z]:\\windows(?:\\|$)/.test(n) || underSystem || /^[a-z]:\\program files/.test(n)) {
    throw new WorkspaceError("工作区不能指向系统目录");
  }
  // ProgramData 整个子树（含 %ProgramData% / %ALLUSERSPROFILE% 实际指向的目录；指向盘根这种怪值不认）
  const dataRoots = [process.env.ProgramData, process.env.ALLUSERSPROFILE]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map(winKey)
    .filter((r) => /^[a-z]:\\./.test(r));
  if (/^[a-z]:\\programdata(?:\\|$)/.test(n) || dataRoots.some((r) => n === r || n.startsWith(`${r}\\`))) {
    throw new WorkspaceError("工作区不能指向系统目录");
  }
  const homeParent = winKey(path.dirname(os.homedir()));
  if (/^[a-z]:\\users$/.test(n) || (/^[a-z]:\\[^\\]+$/.test(homeParent) && n === homeParent)) {
    throw new WorkspaceError("工作区不能是 Users 目录本身，请选某个用户下面的文件夹");
  }
}

/**
 * 校验工作区目录，返回校验所用的规范路径。调用方保存、建目录都要用这个返回值，保证三者是同一个路径
 * （Windows 上 \\?\C:\… 会还原成 C:\…）。
 */
export function assertSafeWorkspaceRoot(root: string): string {
  if (process.platform === "win32") {
    // 先拒网络路径、剥本地设备前缀、去掉每段末尾的点和空格，再 resolve
    const cleaned = cleanWinInput(root);
    const resolved = path.resolve(cleaned.path);
    // 已存在的最长前缀用 realpathSync.native 展开：联接点、软链、8.3 短名（C:\WINDOW~1）都还原成真实路径
    const real = realishPath(resolved);
    for (const candidate of new Set([winKey(resolved), winKey(real)])) {
      if (candidate.startsWith("\\\\")) {
        // 只有真实路径会走到这里（输入里的网络路径上面已经拒了）：映射盘照常允许，管理共享按本地盘再查
        const local = adminShareAsLocal(candidate);
        if (local) assertSafeWinRoot(local);
        continue;
      }
      assertSafeWinRoot(candidate);
    }
    // 黑名单先查（C:\Windows.、C:\Users. 照旧报系统目录），过了再报格式问题
    if (cleaned.problem) throw new WorkspacePathFormatError(cleaned.problem);
    return resolved;
  }
  const resolved = path.resolve(root);
  const real = realishPath(resolved);
  const n = real.replace(/[\\/]+$/, "") || "/";
  const exact = new Set(["/", "/etc", "/usr", "/bin", "/sbin", "/root", "/proc", "/sys", "/dev", "/var", "/boot", "/lib", "/lib64", "/home", "/opt", "/run"]);
  if (exact.has(n) || n.startsWith("/etc/") || n.startsWith("/proc/") || n.startsWith("/sys/") || n.startsWith("/dev/")) {
    throw new WorkspaceError("工作区不能指向系统目录");
  }
  return resolved;
}

export function assertInside(root: string, abs: string): void {
  const rootRes = path.resolve(root);
  const absRes = path.resolve(abs);
  const a = process.platform === "win32" ? absRes.toLowerCase() : absRes;
  const r = process.platform === "win32" ? rootRes.toLowerCase() : rootRes;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  if (a !== r && !a.startsWith(prefix)) {
    throw new WorkspaceError("路径越出工作区");
  }
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** 路径写法本身不行（段末尾带点或空格、Windows 保留设备名）：服务端把这句原样告诉用户，不换成「系统目录」那句 */
export class WorkspacePathFormatError extends WorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathFormatError";
  }
}

export class Workspace {
  constructor(public root: string) {
    this.root = assertSafeWorkspaceRoot(path.resolve(root));
  }

  resolve(relOrAbs: string): string {
    assertSafeInput(relOrAbs);
    const input = relOrAbs.trim() || ".";
    const abs = path.resolve(this.root, input);
    assertInside(this.root, abs);
    if (fsSync.existsSync(abs)) {
      const realRoot = fsSync.realpathSync(this.root);
      const realAbs = fsSync.realpathSync(abs);
      assertInside(realRoot, realAbs);
      return realAbs;
    }
    const parent = path.dirname(abs);
    if (fsSync.existsSync(parent)) {
      const realParent = fsSync.realpathSync(parent);
      const realRoot = fsSync.existsSync(this.root) ? fsSync.realpathSync(this.root) : path.resolve(this.root);
      assertInside(realRoot, path.join(realParent, path.basename(abs)));
    }
    return abs;
  }

  relative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  readablePath(rel: string): string {
    const abs = this.resolve(rel);
    assertNotHostFile(rel, abs);
    return abs;
  }

  exists(rel: string): boolean {
    return fsSync.existsSync(this.resolve(rel));
  }

  async listDir(rel = ".", depth = 3): Promise<FileNode[]> {
    const abs = this.resolve(rel);
    return this.walk(abs, depth);
  }

  private async walk(abs: string, depth: number): Promise<FileNode[]> {
    if (depth < 0) return [];
    let entries: string[];
    try {
      entries = await fs.readdir(abs);
    } catch {
      return [];
    }
    entries.sort((a, b) => a.localeCompare(b));
    const nodes: FileNode[] = [];
    for (const name of entries) {
      if (SKIP_DIR.has(name) || isSecretName(name)) continue;
      const child = path.join(abs, name);
      let stat;
      try {
        stat = await fs.stat(child);
      } catch {
        continue;
      }
      const rel = this.relative(child);
      if (stat.isDirectory()) {
        nodes.push({
          name,
          path: rel,
          type: "dir",
          children: depth > 0 ? await this.walk(child, depth - 1) : undefined,
        });
      } else {
        nodes.push({ name, path: rel, type: "file" });
      }
    }
    return nodes;
  }

  async readFile(rel: string): Promise<string> {
    const abs = this.resolve(rel);
    assertNotHostFile(rel, abs);
    const stat = await fs.stat(abs);
    if (stat.size > MAX_READ) {
      throw new WorkspaceError(`文件过大（>${MAX_READ} bytes）: ${rel}`);
    }
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) {
      throw new WorkspaceError(`二进制文件不可读: ${rel}`);
    }
    return buf.toString("utf8");
  }

  /**
   * 带行号分段读，给模型看的格式和 Cursor 一致：`  12|code`。大文件不用整份吞，
   * 也让模型能精确说「第 40 行」而不是靠猜。
   */
  async readFileLines(rel: string, offset = 1, limit = 400): Promise<string> {
    const text = await this.readFile(rel);
    const lines = text.split(/\r?\n/);
    const total = lines.length;
    const from = Math.min(Math.max(1, Math.floor(offset) || 1), Math.max(total, 1));
    const count = Math.min(Math.max(1, Math.floor(limit) || 1), 2000);
    const to = Math.min(total, from + count - 1);
    const width = String(to).length;
    const body = lines
      .slice(from - 1, to)
      .map((line, i) => `${String(from + i).padStart(width, " ")}|${line}`)
      .join("\n");
    const head = `${rel} (${total} lines, showing ${from}-${to})`;
    const tail = to < total ? `\n... ${total - to} more lines. Call read_file with offset=${to + 1} to continue.` : "";
    return `${head}\n${body}${tail}`;
  }

  /**
   * 精确替换：old_string 必须在文件里恰好出现一次（replace_all 除外）。这是给 LLM 用的
   * 最稳的编辑原语——比让它吐整份文件省 token，比让它写 unified diff 少出错。
   */
  async replaceInFile(
    rel: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<{ ok: true; content: string; count: number } | { ok: false; reason: string }> {
    if (!oldString) return { ok: false, reason: "old_string 不能为空；新建文件请用 write_file" };
    if (oldString === newString) return { ok: false, reason: "old_string 与 new_string 相同，无需修改" };
    const original = await this.readFile(rel);
    const count = original.split(oldString).length - 1;
    if (count === 0) {
      return {
        ok: false,
        reason: "old_string 在文件中不存在。请先 read_file 拿到精确原文（包括空格与缩进）再重试",
      };
    }
    if (count > 1 && !replaceAll) {
      return {
        ok: false,
        reason: `old_string 出现了 ${count} 次，无法确定改哪一处。多带几行上下文让它唯一，或设 replace_all=true`,
      };
    }
    const content = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, () => newString);
    return { ok: true, content, count: replaceAll ? count : 1 };
  }

  async fileSnap(rel: string): Promise<{ mtimeMs: number; size: number; ctimeMs: number; ino: number } | null> {
    try {
      const abs = this.resolve(rel);
      assertNotHostFile(rel, abs);
      const st = await fs.stat(abs);
      if (!st.isFile()) return null;
      return { mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs, ino: st.ino };
    } catch {
      return null;
    }
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const abs = this.resolve(rel);
    assertNotHostFile(rel, abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  async glob(pattern: string): Promise<string[]> {
    assertSafeGlob(pattern);
    const matches = await fg(pattern.replace(/\\/g, "/"), {
      cwd: this.root,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.env", "**/.env.*"],
      onlyFiles: true,
      absolute: false,
    });
    return matches.slice(0, 200);
  }

  async grep(query: string, globPattern?: string): Promise<string> {
    const pattern = globPattern || "**/*.{ts,tsx,js,jsx,py,go,rs,java,json,md,css,html}";
    const files = await this.glob(pattern);
    const hits: string[] = [];
    const needle = query.toLowerCase();
    for (const file of files) {
      if (hits.length >= MAX_GREP_HITS) break;
      let text: string;
      try {
        text = await this.readFile(file);
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (hits.length >= MAX_GREP_HITS) return;
        if (line.toLowerCase().includes(needle)) {
          hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    }
    return hits.length ? hits.join("\n") : "无匹配";
  }

  async fileToDataUri(relOrUrl: string): Promise<string> {
    if (relOrUrl.startsWith("data:") || /^https:\/\//i.test(relOrUrl)) return relOrUrl;
    if (/^[a-z][a-z0-9+.-]*:/i.test(relOrUrl)) {
      throw new WorkspaceError("只允许工作区文件或 HTTPS 资源");
    }
    const abs = this.resolve(relOrUrl);
    assertNotHostFile(relOrUrl, abs);
    const buf = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
            ? "image/gif"
            : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  }
}

export function defaultWorkspaceRoot(): string {
  return path.join(os.homedir(), "AgnesWorkspace");
}

const STACK_MARKERS: Array<[string, string]> = [
  ["package.json", "Node.js"],
  ["pnpm-workspace.yaml", "pnpm workspace"],
  ["tsconfig.json", "TypeScript"],
  ["requirements.txt", "Python"],
  ["pyproject.toml", "Python (pyproject)"],
  ["go.mod", "Go"],
  ["Cargo.toml", "Rust"],
  ["pom.xml", "Java (Maven)"],
  ["build.gradle", "Java/Kotlin (Gradle)"],
  ["build.gradle.kts", "Kotlin (Gradle)"],
  ["Gemfile", "Ruby"],
  ["composer.json", "PHP"],
  ["Dockerfile", "Docker"],
  ["docker-compose.yml", "Docker Compose"],
  ["vite.config.ts", "Vite"],
  ["next.config.js", "Next.js"],
  ["next.config.mjs", "Next.js"],
  ["nuxt.config.ts", "Nuxt"],
  ["angular.json", "Angular"],
  ["pubspec.yaml", "Flutter/Dart"],
  ["CMakeLists.txt", "CMake"],
  ["Makefile", "Make"],
];

function runGit(bin: string, cwd: string, args: string[], timeoutMs = 2500): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve("");
    }, timeoutMs);
    child.stdout?.on("data", (buf: Buffer) => {
      out += buf.toString("utf8");
      if (out.length > 20_000) child.kill();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

export type GitSummary = { branch: string; changed: string[] };

/** 不是 git 仓库返回 null；git 不在 PATH 也当 null，别让顶栏因此报错 */
export async function gitSummary(root: string): Promise<GitSummary | null> {
  if (!fsSync.existsSync(path.join(root, ".git"))) return null;
  const bin = await findGitBin();
  if (!bin) return null;
  const [branch, status] = await Promise.all([
    runGit(bin, root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(bin, root, ["status", "--porcelain", "--untracked-files=normal"]),
  ]);
  if (!branch && !status) return null;
  return { branch, changed: status ? status.split(/\r?\n/).filter(Boolean) : [] };
}

function renderTree(nodes: FileNode[], indent: string, budget: { left: number }): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    if (budget.left <= 0) {
      lines.push(`${indent}…`);
      break;
    }
    budget.left -= 1;
    lines.push(`${indent}${node.name}${node.type === "dir" ? "/" : ""}`);
    if (node.children?.length) lines.push(...renderTree(node.children, `${indent}  `, budget));
  }
  return lines;
}

/**
 * 开工前塞给模型的项目速览：技术栈、git 状态、两层目录树。Cursor/Codex 都会先给这个，
 * 省掉模型头几轮盲目 list_dir 的往返。控制在 ~120 行以内，别把上下文吃光。
 */
export async function projectContext(root: string): Promise<string> {
  const ws = new Workspace(root);
  const parts: string[] = [];

  const stack: string[] = [];
  for (const [file, label] of STACK_MARKERS) {
    if (fsSync.existsSync(path.join(ws.root, file))) stack.push(label);
  }
  let pkgLine = "";
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(ws.root, "package.json"), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 12);
    pkgLine = `package.json: ${pkg.name ?? "(unnamed)"}${scripts.length ? ` · scripts: ${scripts.join(", ")}` : ""}`;
  } catch {
    pkgLine = "";
  }
  if (stack.length) parts.push(`Stack: ${[...new Set(stack)].join(", ")}`);
  if (pkgLine) parts.push(pkgLine);

  const git = await gitSummary(ws.root);
  if (git) {
    const shown = git.changed.slice(0, 15).map((l) => `  ${l}`);
    parts.push(
      `Git: branch ${git.branch || "?"}, ${git.changed.length ? `${git.changed.length} changed file(s)` : "clean"}${
        shown.length ? `\n${shown.join("\n")}${git.changed.length > 15 ? `\n  … ${git.changed.length - 15} more` : ""}` : ""
      }`,
    );
  }

  const tree = await ws.listDir(".", 1);
  const budget = { left: 80 };
  const lines = renderTree(tree, "  ", budget);
  parts.push(`Top-level layout (depth 2, use list_dir/glob for more):\n${lines.join("\n") || "  (empty)"}`);

  try {
    const symbols = await formatSymbolMap(ws.root);
    if (symbols) parts.push(symbols);
  } catch {
    /* 符号地图失败不影响开工 */
  }

  return parts.join("\n");
}
