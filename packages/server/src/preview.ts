import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

/**
 * 列表 / 网格 / 对话里用的 WebP 预览图：长边 800，按 media id 缓存在 DATA_DIR/previews。
 * sharp 是原生模块：Docker 里正常可用；桌面包里不打进去（只走 asar 的在线更新带不上原生二进制），
 * 加载不到或转换失败都返回 null，调用方回落到原图。
 */
export const PREVIEW_EDGE = 800;

type SharpPipeline = {
  rotate(): SharpPipeline;
  resize(opts: { width: number; height: number; fit: "inside"; withoutEnlargement: boolean }): SharpPipeline;
  webp(opts: { quality: number }): SharpPipeline;
  toFile(file: string): Promise<unknown>;
};
type SharpFactory = (input: string, opts?: { failOn?: "none"; animated?: boolean }) => SharpPipeline;

let sharpLoader: Promise<SharpFactory | null> | null = null;

export function loadSharp(): Promise<SharpFactory | null> {
  if (process.env.AGNES_DISABLE_SHARP === "1") return Promise.resolve(null);
  if (!sharpLoader) {
    // 变量名导入：esbuild 打桌面包时不去解析它，运行时找不到就当没有
    const name = "sharp";
    sharpLoader = import(/* @vite-ignore */ name)
      .then((mod: { default?: unknown }) => {
        const fn = (mod.default ?? mod) as unknown;
        return typeof fn === "function" ? (fn as SharpFactory) : null;
      })
      .catch(() => null);
  }
  return sharpLoader;
}

/** 测试用：清掉已缓存的加载结果 */
export function resetSharpForTests(): void {
  sharpLoader = null;
}

export function previewDir(dataDir: string): string {
  return path.join(dataDir, "previews");
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const pending = new Map<string, Promise<string | null>>();

/** 返回预览图绝对路径；sharp 不可用或源文件不是可解码图片时返回 null */
export async function ensureMediaPreview(dataDir: string, mediaId: string, sourcePath: string): Promise<string | null> {
  if (!SAFE_ID.test(mediaId)) return null;
  const dir = previewDir(dataDir);
  const out = path.join(dir, `${mediaId}.webp`);
  try {
    const [src, cached] = await Promise.all([fsPromises.stat(sourcePath), fsPromises.stat(out)]);
    if (cached.size > 0 && cached.mtimeMs >= src.mtimeMs) return out;
  } catch {
    /* 没缓存，往下生成 */
  }
  const running = pending.get(out);
  if (running) return running;
  const job = (async () => {
    const sharp = await loadSharp();
    if (!sharp) return null;
    const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await fsPromises.mkdir(dir, { recursive: true });
      await sharp(sourcePath, { failOn: "none", animated: false })
        .rotate()
        .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(tmp);
      await fsPromises.rename(tmp, out);
      return out;
    } catch {
      fs.rmSync(tmp, { force: true });
      return null;
    }
  })();
  pending.set(out, job);
  try {
    return await job;
  } finally {
    pending.delete(out);
  }
}
