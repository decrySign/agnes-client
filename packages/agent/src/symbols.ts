import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

export type SymbolHit = {
  name: string;
  path: string;
  line: number;
  kind: "export" | "symbol";
};

const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.agnes/**",
  "**/.vite/**",
];

const LINE_RULES: Array<{ re: RegExp; kind: SymbolHit["kind"] }> = [
  { re: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "export" },
  { re: /^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "export" },
  { re: /^\s*export\s+(?:const|let|var|type|interface|enum|class|function|async function)\s+([A-Za-z_$][\w$]*)/, kind: "export" },
  { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "symbol" },
  { re: /^\s*class\s+([A-Za-z_$][\w$]*)/, kind: "symbol" },
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/, kind: "symbol" },
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, kind: "symbol" },
];

const cache = new Map<string, { at: number; hits: SymbolHit[] }>();

export function symbolsInText(rel: string, text: string): SymbolHit[] {
  const file = rel.replace(/\\/g, "/");
  const hits: SymbolHit[] = [];
  const lines = text.split(/\r?\n/);
  const max = Math.min(lines.length, 4000);
  for (let i = 0; i < max; i++) {
    for (const rule of LINE_RULES) {
      const match = rule.re.exec(lines[i]);
      if (!match?.[1] || match[1].length < 2) continue;
      const kind = rule.kind === "export" || /^\s*export\s/.test(lines[i]) ? "export" : "symbol";
      hits.push({ name: match[1], path: file, line: i + 1, kind });
      break;
    }
  }
  return hits;
}

export async function collectSymbols(root: string): Promise<SymbolHit[]> {
  const key = path.resolve(root);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 20_000) return cached.hits;
  let files: string[] = [];
  try {
    files = await fg(["**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,vue}"], {
      cwd: key,
      ignore: IGNORE,
      onlyFiles: true,
      dot: false,
      suppressErrors: true,
    });
  } catch {
    files = [];
  }
  const hits: SymbolHit[] = [];
  for (const rel of files.slice(0, 160)) {
    if (rel.endsWith(".d.ts")) continue;
    if (hits.length > 800) break;
    try {
      const abs = path.join(key, rel);
      const stat = await fs.stat(abs);
      if (stat.size > 180_000) continue;
      const text = await fs.readFile(abs, "utf8");
      hits.push(...symbolsInText(rel, text));
    } catch {
      /* skip unreadable */
    }
  }
  cache.set(key, { at: Date.now(), hits });
  return hits;
}

export function rankSymbols(hits: SymbolHit[], query: string, limit: number): SymbolHit[] {
  const q = query.trim().toLowerCase();
  const ranked = hits
    .filter((hit) => !q || hit.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const aStart = q && a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStart = q && b.name.toLowerCase().startsWith(q) ? 0 : 1;
      const aExport = a.kind === "export" ? 0 : 1;
      const bExport = b.kind === "export" ? 0 : 1;
      return aStart - bStart || aExport - bExport || a.name.length - b.name.length || a.path.localeCompare(b.path);
    });
  const seen = new Set<string>();
  const out: SymbolHit[] = [];
  for (const hit of ranked) {
    const id = `${hit.name}\0${hit.path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

/** 开工前塞进项目速览的符号清单。没有源码就返回空串。 */
export async function formatSymbolMap(root: string): Promise<string> {
  const hits = rankSymbols(await collectSymbols(root), "", 40);
  if (!hits.length) return "";
  const lines = hits.map((hit) => `  ${hit.name} — ${hit.path}:${hit.line}`);
  const body = `Symbols (name — file:line; read the file before editing, this list can be stale):\n${lines.join("\n")}`;
  return body.length > 2200 ? `${body.slice(0, 2200)}\n  …` : body;
}
