import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_OLD = 3;

export function logDir() {
  return path.join(app.getPath("userData"), "logs");
}

function logFile() {
  return path.join(logDir(), "agnes.log");
}

function fileLogEnabled() {
  return app.isPackaged || process.env.AGNES_FORCE_FILE_LOG === "1";
}

function formatArgs(args) {
  return args
    .map((value) => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.stack || value.message || String(value);
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
}

function rotateIfNeeded() {
  const file = logFile();
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_BYTES) return;

  const dir = logDir();
  const oldest = path.join(dir, `agnes.${MAX_OLD}.log`);
  try {
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = MAX_OLD - 1; i >= 1; i -= 1) {
      const src = path.join(dir, `agnes.${i}.log`);
      const dest = path.join(dir, `agnes.${i + 1}.log`);
      if (fs.existsSync(src)) fs.renameSync(src, dest);
    }
    fs.renameSync(file, path.join(dir, "agnes.1.log"));
  } catch {
    /* 轮转失败时继续往当前文件写，避免丢日志 */
  }
}

function writeLine(level, args) {
  if (!fileLogEnabled()) return;
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    rotateIfNeeded();
    const line = `${new Date().toISOString()} ${level} ${formatArgs(args)}\n`;
    fs.appendFileSync(logFile(), line);
  } catch {
    /* 写文件失败不能再走 console，避免递归 */
  }
}

let hooked = false;

export function installFileLog() {
  if (!fileLogEnabled()) return;
  if (hooked) return;
  hooked = true;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  console.log = (...args) => {
    orig.log(...args);
    writeLine("LOG", args);
  };
  console.info = (...args) => {
    orig.info(...args);
    writeLine("INFO", args);
  };
  console.warn = (...args) => {
    orig.warn(...args);
    writeLine("WARN", args);
  };
  console.error = (...args) => {
    orig.error(...args);
    writeLine("ERROR", args);
  };
  console.debug = (...args) => {
    orig.debug(...args);
    writeLine("DEBUG", args);
  };
}
