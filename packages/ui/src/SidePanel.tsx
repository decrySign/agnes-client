import { useMemo, useState } from "react";
import { FileDiff, FolderTree, Terminal, Undo2 } from "lucide-react";
import { DiffView } from "./DiffView.js";
import { FileTree } from "./FileTree.js";
import { applyDiff, rejectDiff, revertDiff } from "./api.js";
import type { DiffRow, FileNode } from "./types.js";

type Tab = "changes" | "files" | "terminal";

/**
 * Codex 桌面端右侧那一栏：本次对话改过的文件（逐文件 diff + 接受/拒绝/撤销）、项目文件、终端输出。
 * 对话流里只保留待确认的 diff 卡，已应用的历史都在这里翻。
 */
export function SidePanel({
  diffs,
  tree,
  terminal,
  openFile,
  onOpenFile,
  onRefresh,
  onError,
}: {
  diffs: DiffRow[];
  tree: FileNode[];
  terminal: string;
  openFile: { path: string; content: string } | null;
  onOpenFile: (node: FileNode) => void;
  onRefresh: () => void;
  onError: (message: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("changes");
  const [picked, setPicked] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // 同一文件多次改动只列最新一条，旧的折进详情
  const byFile = useMemo(() => {
    const map = new Map<string, DiffRow[]>();
    for (const d of [...diffs].sort((a, b) => b.created_at - a.created_at)) {
      const list = map.get(d.path) ?? [];
      list.push(d);
      map.set(d.path, list);
    }
    return [...map.entries()];
  }, [diffs]);
  const current = picked ? diffs.find((d) => d.id === picked) : byFile[0]?.[1][0];
  const pendingCount = diffs.filter((d) => d.status === "pending").length;

  const act = async (fn: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await fn();
      onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const statusLabel = (s: string) =>
    s === "pending" ? "待确认" : s === "applied" ? "已应用" : s === "reverted" ? "已撤销" : "已拒绝";

  return (
    <aside className="side-panel">
      <div className="side-tabs">
        <button type="button" className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
          <FileDiff size={13} />
          改动{pendingCount ? <span className="side-badge">{pendingCount}</span> : diffs.length ? ` ${byFile.length}` : ""}
        </button>
        <button type="button" className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
          <FolderTree size={13} />
          文件
        </button>
        <button type="button" className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}>
          <Terminal size={13} />
          终端
        </button>
      </div>

      {tab === "changes" ? (
        <div className="side-body">
          {byFile.length === 0 ? (
            <div className="side-empty">Agent 改过的文件会列在这里，逐个看 diff、接受或撤销。</div>
          ) : (
            <>
              <ul className="change-list">
                {byFile.map(([path, list]) => {
                  const head = list[0];
                  const active = current?.path === path;
                  return (
                    <li key={path} className={active ? "active" : ""}>
                      <button type="button" className="change-row" onClick={() => setPicked(head.id)}>
                        <span className={`change-dot ${head.status}`} />
                        <span className="change-path" title={path}>
                          {path}
                        </span>
                        <span className="change-status">{statusLabel(head.status)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {current ? (
                <div className="change-detail">
                  <div className="change-detail-head">
                    <span className="path" title={current.path}>
                      {current.path}
                    </span>
                    <span style={{ display: "flex", gap: 6 }}>
                      {current.status === "pending" ? (
                        <>
                          <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={working} onClick={() => void act(() => applyDiff(current.id))}>
                            接受
                          </button>
                          <button className="btn" style={{ fontSize: 12 }} disabled={working} onClick={() => void act(() => rejectDiff(current.id))}>
                            拒绝
                          </button>
                        </>
                      ) : current.status === "applied" ? (
                        <button className="btn" style={{ fontSize: 12 }} disabled={working} onClick={() => void act(() => revertDiff(current.id))}>
                          <Undo2 size={12} /> 撤销
                        </button>
                      ) : (
                        <span className="hint">{statusLabel(current.status)}</span>
                      )}
                    </span>
                  </div>
                  <div className="change-diff">
                    <DiffView unified={current.unified} />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : tab === "files" ? (
        <div className="side-body">
          <div className="side-tree">
            <FileTree nodes={tree} active={openFile?.path} onOpen={onOpenFile} />
          </div>
          {openFile ? (
            <div className="change-detail">
              <div className="change-detail-head">
                <span className="path" title={openFile.path}>
                  {openFile.path}
                </span>
              </div>
              <pre className="file-preview">{openFile.content}</pre>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="side-body">
          <pre className="term-out">{terminal || "Agent 执行命令的输出会实时出现在这里。"}</pre>
        </div>
      )}
    </aside>
  );
}
