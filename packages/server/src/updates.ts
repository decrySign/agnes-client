import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type UpdateManifest = {
  ok: true;
  version: string;
  sha256: string;
  size: number;
  electron: string;
  notes: string;
};

export const EMPTY_UPDATE: UpdateManifest = { ok: true, version: "", sha256: "", size: 0, electron: "", notes: "" };

const NOTES_MAX = 500;

function manifestNotes(raw: unknown): string {
  return String(raw || "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, NOTES_MAX);
}

export function resolveUpdateDir(raw: string, dataDir: string): string {
  const value = String(raw || "").trim();
  if (!value) return join(dataDir, "updates");
  return isAbsolute(value) ? value : resolve(dataDir, value);
}

function packagePathFrom(dir: string, raw: Record<string, unknown>): string {
  const name = String(raw.file || "app.asar").replace(/\\/g, "/");
  if (!name || name.includes("..") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return "";
  const full = join(dir, name.split("/").pop() || "app.asar");
  return existsSync(full) ? full : "";
}

export function readUpdateManifest(dir: string): UpdateManifest {
  const file = join(dir, "latest.json");
  if (!existsSync(file)) return EMPTY_UPDATE;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const version = String(raw.version || "").trim();
    const sha256 = String(raw.sha256 || "")
      .trim()
      .toLowerCase();
    const electron = String(raw.electron || "").trim();
    const pkg = packagePathFrom(dir, raw);
    const size = pkg && existsSync(pkg) ? statSync(pkg).size : Number(raw.size) || 0;
    if (!version || !sha256) return EMPTY_UPDATE;
    return { ok: true, version, sha256, size, electron, notes: manifestNotes(raw.notes) };
  } catch {
    return EMPTY_UPDATE;
  }
}

export const DESKTOP_ZIP_NAME = "Agnes-win-x64.zip";

export function desktopZipPath(dir: string): string {
  const full = join(dir, DESKTOP_ZIP_NAME);
  return existsSync(full) ? full : "";
}

export function updatePackagePath(dir: string): string {
  const file = join(dir, "latest.json");
  if (!existsSync(file)) return "";
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return packagePathFrom(dir, raw);
  } catch {
    return "";
  }
}
