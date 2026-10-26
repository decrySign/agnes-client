import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

/**
 * Skills 放在工作区里，每个技能一个目录 + 一份 SKILL.md：
 *   <工作区>/.agnes/skills/<名字>/SKILL.md
 *   <工作区>/.cursor/skills/<名字>/SKILL.md   （兼容，可直接复用 Cursor 那套）
 *
 * 系统提示里只挂名字和一句描述，正文等模型调 read_skill 再取，省上下文。
 * 注意 .agnes 在 Workspace 的黑名单里，所以这里自己读文件：模型传的是**技能名**，
 * 会拿去和扫出来的清单做精确匹配，拼路径这一步永远不碰用户输入。
 */
const SKILL_DIRS = [
  [".agnes", "skills"],
  [".cursor", "skills"],
] as const;

const MAX_SKILLS = 40;
const MAX_DESC = 300;
const MAX_BODY = 24_000;
const EXTRA_EXTS = new Set([".md", ".markdown", ".txt"]);

export type SkillMeta = {
  /** 目录名，也是 read_skill 的入参 */
  name: string;
  title: string;
  description: string;
  source: string;
  file: string;
  /** 同目录下可另外读取的参考文件 */
  extras: string[];
};

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 只认 `key: value` 和紧随其后的缩进续行（覆盖 `description: >-` 这种折叠块），
 * 不引 YAML 依赖。技能元信息就这两个字段，够用。
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out: Record<string, string> = {};
  let key = "";
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (kv && !/^\s/.test(raw)) {
      key = kv[1].toLowerCase();
      out[key] = kv[2].replace(/^[>|][-+]?\s*$/, "").trim();
    } else if (key) {
      out[key] = `${out[key] ?? ""} ${raw.trim()}`.trim();
    }
  }
  return out;
}

function skillFileIn(dir: string): string | null {
  for (const name of ["SKILL.md", "skill.md", "Skill.md"]) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

/** 扫工作区里的技能。工作区不存在或没有技能目录就返回空数组，不抛错。 */
export function listSkills(workspaceRoot: string): SkillMeta[] {
  const root = path.resolve(workspaceRoot);
  const found = new Map<string, SkillMeta>();
  for (const parts of SKILL_DIRS) {
    const base = path.join(root, ...parts);
    let entries: string[];
    try {
      if (!fs.statSync(base).isDirectory()) continue;
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries.sort((a, b) => a.localeCompare(b))) {
      if (found.size >= MAX_SKILLS) break;
      // 先扫到的（.agnes）优先，同名不被 .cursor 覆盖
      if (found.has(name)) continue;
      const dir = path.join(base, name);
      let file: string | null;
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        file = skillFileIn(dir);
      } catch {
        continue;
      }
      if (!file) continue;
      let head = "";
      try {
        head = fs.readFileSync(file, "utf8").slice(0, 4000);
      } catch {
        continue;
      }
      const meta = parseFrontmatter(head);
      let extras: string[] = [];
      try {
        extras = fs
          .readdirSync(dir)
          .filter((f) => f !== path.basename(file) && EXTRA_EXTS.has(path.extname(f).toLowerCase()))
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 12);
      } catch {
        extras = [];
      }
      found.set(name, {
        name,
        title: meta.name || name,
        description: clip(meta.description || "", MAX_DESC),
        source: parts.join("/"),
        file,
        extras,
      });
    }
  }
  return [...found.values()];
}

/** 注入系统提示的那一段。没有技能时返回空串，提示里就不会出现这一节。 */
export function skillsPromptSection(skills: SkillMeta[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => {
    const extras = s.extras.length ? `（另有参考文件：${s.extras.join(", ")}）` : "";
    return `- ${s.name}${s.title && s.title !== s.name ? `（${s.title}）` : ""}: ${s.description || "无描述"}${extras}`;
  });
  return `可用 Skills（工作区里的技能手册，命中任务时先用 read_skill 读全文再动手，不要凭猜测复述）：
${lines.join("\n")}`;
}

/** 按技能名取正文；extra 传同目录的参考文件名，同样走精确匹配。 */
export async function readSkill(skills: SkillMeta[], name: string, extra = ""): Promise<string> {
  const wanted = String(name || "").trim();
  const skill = skills.find((s) => s.name === wanted || s.name.toLowerCase() === wanted.toLowerCase());
  if (!skill) {
    return skills.length
      ? `没有这个技能: ${wanted || "(空)"}。可用: ${skills.map((s) => s.name).join(", ")}`
      : "当前工作区没有配置 Skills";
  }
  const pick = String(extra || "").trim();
  if (pick) {
    const hit = skill.extras.find((f) => f === pick || f.toLowerCase() === pick.toLowerCase());
    if (!hit) {
      return `技能 ${skill.name} 没有这个参考文件: ${pick}。可用: ${skill.extras.join(", ") || "(无)"}`;
    }
    const body = await fsPromises.readFile(path.join(path.dirname(skill.file), hit), "utf8");
    return body.slice(0, MAX_BODY);
  }
  const body = await fsPromises.readFile(skill.file, "utf8");
  return body.slice(0, MAX_BODY);
}
