import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * 连子孙一起杀。`shell: true` 在 Windows 上起的是 cmd.exe，`child.kill()` 只杀 cmd，
 * 它拉起的 node / python / pnpm 会继续跑并握着 stdout 管道，`close` 事件永远不来。
 * taskkill /T 按进程树杀；其它平台退回 SIGKILL（子进程通常随 shell 一起退出）。
 */
/**
 * 强制杀整个进程树，用于「发过信号几秒还没退出」的升级：
 * Windows taskkill /PID <pid> /T /F；其它平台对进程组和进程本身都发 SIGKILL。
 * 只能传「还没收到 exit」的子进程 pid：那时 Node 还握着它的进程句柄，pid 不会被复用；
 * exit 之后 pid 可能已经属于别人，/T 会连别人的整棵树一起杀（孤儿收尾用 reapOrphanTree）。
 * 这里只负责发出 taskkill，不等结果；杀没杀掉由调用方看 exit / close 事件，没到就按退避再来。
 */
export function forceKillTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => {
        /* taskkill 不在 PATH：只能放弃 */
      });
      killer.unref();
    } catch {
      /* ignore */
    }
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => {
        /* taskkill 不在 PATH：只能放弃 */
      });
      killer.unref();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export type OrphanRoot = {
  /** 已经退出的 shell 的 pid（现在可能已被别的进程复用） */
  pid: number | undefined;
  /** spawn 之前的 Date.now()：shell 的创建时间不会早于它 */
  startedAt: number;
  /** 收到 shell exit 事件时的 Date.now()：shell 的子进程都创建在它之前 */
  exitedAt: number;
};

// Windows：一次快照全部进程，按「父 pid + 创建时间」认亲，不信任已退出 shell 的 pid 本身。
// - 根：父 pid = shell pid，且创建时间在 [startedAt, exitedAt] 内；如果现在有进程占着 shell 的 pid 且创建于 startedAt 之后，
//   它就是复用者，上界收紧到它的创建时间（复用者的子进程都比它晚）。
// - 往下：父 pid = 已认定的进程（此刻还活着，pid 没被复用）且创建时间不早于它。
// - 杀之前用 Get-Process 再核对一次创建时间（差 ≤1ms），只杀单个进程，不带 /T。
const REAP_PS = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)",
  "$root = [int]$env:AGNES_REAP_PID",
  "$self = [int]$env:AGNES_REAP_SELF",
  "$from = $epoch.AddMilliseconds([double]$env:AGNES_REAP_FROM)",
  "$to = $epoch.AddMilliseconds([double]$env:AGNES_REAP_TO)",
  "$all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; Parent = [int]$_.ParentProcessId; Created = $_.CreationDate.ToUniversalTime() } })",
  "foreach ($p in $all) { if ($p.Id -eq $root -and $p.Created -ge $from -and $p.Created -lt $to) { $to = $p.Created } }",
  "$picked = @{}",
  "$queue = New-Object System.Collections.Queue",
  "foreach ($p in $all) { if ($p.Parent -eq $root -and $p.Id -ne $root -and $p.Created -ge $from -and $p.Created -le $to) { $picked[$p.Id] = $p; $queue.Enqueue($p) } }",
  "while ($queue.Count -gt 0) { $q = $queue.Dequeue(); foreach ($p in $all) { if ($p.Parent -eq $q.Id -and $p.Id -ne $q.Id -and $p.Created -ge $q.Created -and -not $picked.ContainsKey($p.Id)) { $picked[$p.Id] = $p; $queue.Enqueue($p) } } }",
  "$n = 0",
  "foreach ($p in $picked.Values) {",
  "  if ($p.Id -eq $self -or $p.Id -eq $PID -or $p.Id -le 4) { continue }",
  "  $proc = Get-Process -Id $p.Id",
  "  if (-not $proc) { continue }",
  "  $started = $proc.StartTime",
  "  if (-not $started) { continue }",
  "  if ([Math]::Abs(($started.ToUniversalTime() - $p.Created).TotalMilliseconds) -gt 1) { continue }",
  "  try { $proc.Kill(); $n++ } catch {}",
  "}",
  "[Console]::Out.Write([string]$n)",
].join("\n");

function powershellExe(): string {
  const sys = process.env.SystemRoot || process.env.windir;
  if (sys) {
    const full = path.join(sys, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(full)) return full;
  }
  return "powershell.exe";
}

/**
 * shell 已经退出、它拉起的进程还握着输出管道时（`start /b` 等留下的孤儿）用来收尾。
 * 这时 shell 的 pid 可能已被复用，不能再 taskkill /T 它：Windows 上按上面的「父 pid + 创建时间」规则认亲后逐个杀；
 * 其它平台 shell 起在独立进程组里（detached），对进程组发 SIGKILL，不对 pid 本身发。
 * done(n)：杀掉的进程数；查不到、出错、超时都是 0。不阻塞调用方。
 */
export function reapOrphanTree(root: OrphanRoot, done?: (killed: number) => void): void {
  const finish = (n: number) => {
    try {
      done?.(n);
    } catch {
      /* ignore */
    }
  };
  const pid = root.pid;
  if (!pid || pid <= 4) return finish(0);
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return finish(1);
    } catch {
      return finish(0);
    }
  }
  try {
    const ps = spawn(
      powershellExe(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(REAP_PS, "utf16le").toString("base64")],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 60_000,
        env: {
          ...process.env,
          AGNES_REAP_PID: String(pid),
          AGNES_REAP_SELF: String(process.pid),
          AGNES_REAP_FROM: String(Math.floor(root.startedAt)),
          AGNES_REAP_TO: String(Math.ceil(root.exitedAt)),
        },
      },
    );
    let out = "";
    let settled = false;
    const end = (n: number) => {
      if (settled) return;
      settled = true;
      finish(n);
    };
    ps.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    ps.on("error", () => end(0));
    ps.on("close", () => end(Number.parseInt(out.trim(), 10) || 0));
  } catch {
    finish(0);
  }
}
