import fs from "node:fs";
import path from "node:path";

const MAX_RULES = 2000;

/**
 * 始终注入的项目说明。`.agnes/AGENTS.md` 优先于仓库根的 `AGENTS.md`。
 * 技能正文仍然等 read_skill，这里只放短规矩。
 */
export function readProjectRules(root: string): { path: string; text: string } | null {
  const candidates = [
    { abs: path.join(root, ".agnes", "AGENTS.md"), rel: ".agnes/AGENTS.md" },
    { abs: path.join(root, "AGENTS.md"), rel: "AGENTS.md" },
  ];
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file.abs);
      if (!stat.isFile() || stat.size > 200_000) continue;
      const raw = fs.readFileSync(file.abs, "utf8").replace(/^\uFEFF/, "").trim();
      if (!raw) continue;
      const text = raw.length > MAX_RULES ? `${raw.slice(0, MAX_RULES)}\n…(已截断，全文在 ${file.rel})` : raw;
      return { path: file.rel, text };
    } catch {
      /* try the next file */
    }
  }
  return null;
}
