import { useEffect, useState } from "react";
import { getSkillBody, getWorkspaceGuide, type SkillInfo } from "./api.js";
import type { Workspace } from "./types.js";

export function SkillsPanel({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const [rules, setRules] = useState<{ path: string; text: string } | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [openName, setOpenName] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError("");
    setOpenName("");
    setBody("");
    void getWorkspaceGuide(workspace.id)
      .then((guide) => {
        if (cancelled) return;
        setRules(guide.rules);
        setSkills(guide.skills);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  async function toggle(name: string) {
    if (openName === name) {
      setOpenName("");
      setBody("");
      return;
    }
    setOpenName(name);
    setBody("读取中…");
    try {
      const next = await getSkillBody(workspace.id, name);
      setBody(next.body);
    } catch (err) {
      setBody(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal guide" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>技能与说明 · {workspace.name}</h3>
        <p>项目说明每次都会交给模型。技能只在任务对上时才读取全文。</p>
        {error ? <p>{error}</p> : null}
        <div className="guide-block">
          <div className="guide-label">{rules ? rules.path : "没有 AGENTS.md"}</div>
          {rules ? <pre className="guide-pre">{rules.text}</pre> : <p>把短规矩放在工作区的 .agnes/AGENTS.md 或 AGENTS.md。</p>}
        </div>
        <div className="guide-label">技能 {skills.length}</div>
        {skills.length ? (
          <ul className="guide-skills">
            {skills.map((skill) => (
              <li key={skill.name}>
                <button type="button" onClick={() => void toggle(skill.name)}>
                  <b>{skill.title || skill.name}</b>
                  <span>{skill.description || skill.source}</span>
                </button>
                {openName === skill.name ? <pre className="guide-pre">{body}</pre> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>把技能放在 .agnes/skills/名字/SKILL.md，或沿用 .cursor/skills。</p>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
