import { useState, type DragEvent } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  BookOpen,
  Trash2,
} from "lucide-react";
import type { Conversation, ConversationGroup, Workspace } from "./types.js";

export type SidebarTab = "chats" | "agents";

/** ChatGPT 侧栏的日期分组：今天 / 昨天 / 前 7 天 / 前 30 天 / 更早 */
export function groupByDate(list: Conversation[]): Array<{ label: string; items: Conversation[] }> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 3600 * 1000;
  const buckets: Array<{ label: string; test: (t: number) => boolean }> = [
    { label: "今天", test: (t) => t >= startOfToday },
    { label: "昨天", test: (t) => t >= startOfToday - day },
    { label: "前 7 天", test: (t) => t >= startOfToday - 7 * day },
    { label: "前 30 天", test: (t) => t >= startOfToday - 30 * day },
    { label: "更早", test: () => true },
  ];
  const out = buckets.map((b) => ({ label: b.label, items: [] as Conversation[] }));
  for (const c of list) {
    const t = c.updated_at || c.created_at;
    const idx = buckets.findIndex((b) => b.test(t));
    out[idx === -1 ? out.length - 1 : idx].items.push(c);
  }
  return out.filter((g) => g.items.length);
}

type Renaming = { kind: "conv" | "ws" | "group"; id: string; title: string } | null;
type DragKind = { kind: "agent"; id: string } | { kind: "workspace"; id: string } | { kind: "chat"; id: string } | null;
type DropHint = { id: string; place: "before" | "after" | "into" } | null;
type MoveTarget = { id: string; name: string };

const AGENT_MIME = "application/x-agnes-agent";
const WS_MIME = "application/x-agnes-workspace";
const CHAT_MIME = "application/x-agnes-chat";
/** 拖到「未分组」区域的落点 id */
const UNGROUPED = "__ungrouped__";

function ConvRow({
  c,
  active,
  renaming,
  onOpen,
  onRename,
  onRenameStart,
  onRenameCancel,
  onRenameChange,
  onDelete,
  onDragStart,
  onDragEnd,
  moveTargets,
  moveTitle = "移动到其他工作区",
  onMove,
  icon,
  working,
  blocked,
}: {
  c: Conversation;
  active: boolean;
  renaming: Renaming;
  onOpen: () => void;
  onRename: (title: string) => void;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onRenameChange: (title: string) => void;
  onDelete: () => void;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
  moveTargets?: MoveTarget[];
  moveTitle?: string;
  onMove?: (targetId: string) => void;
  icon?: boolean;
  working?: boolean;
  blocked?: boolean;
}) {
  const editing = renaming?.kind === "conv" && renaming.id === c.id;
  const [moveOpen, setMoveOpen] = useState(false);
  const canMove = Boolean(onMove && moveTargets && moveTargets.length > 0);
  return (
    <div
      className={`conv-item${active ? " active" : ""}${working ? " is-working" : ""}${blocked ? " is-blocked" : ""}`}
      draggable={!editing && Boolean(onDragStart)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {editing ? (
        <input
          className="conv-rename"
          autoFocus
          value={renaming.title}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={() => onRename(renaming.title)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRename(renaming.title);
            if (e.key === "Escape") onRenameCancel();
          }}
        />
      ) : (
        <button className="conv-title" onClick={onOpen} onDoubleClick={onRenameStart} title={working ? `${c.title}（正在思考）` : blocked ? `${c.title}（同一工作区有 Agent 正在改文件）` : c.title}>
          {icon ? <Bot size={12} className="conv-icon" /> : null}
          <span>{c.title}</span>
          {working ? <span className="conv-working-dot" aria-hidden /> : null}
        </button>
      )}
      <span className="conv-acts">
        {canMove ? (
          <span className="conv-move">
            <button type="button" title={moveTitle} aria-label={moveTitle} onClick={() => setMoveOpen((v) => !v)}>
              <FolderInput size={12} />
            </button>
            {moveOpen ? (
              <div className="ws-menu conv-move-menu" onMouseLeave={() => setMoveOpen(false)}>
                {moveTargets!.map((target) => (
                  <button
                    key={target.id || UNGROUPED}
                    type="button"
                    onClick={() => {
                      setMoveOpen(false);
                      onMove!(target.id);
                    }}
                  >
                    {target.id ? <FolderOpen size={12} /> : <FolderMinus size={12} />} {target.name}
                  </button>
                ))}
              </div>
            ) : null}
          </span>
        ) : null}
        <button type="button" title="重命名" onClick={onRenameStart}>
          <Pencil size={12} />
        </button>
        <button type="button" title="删除" onClick={onDelete}>
          <Trash2 size={12} />
        </button>
      </span>
    </div>
  );
}

/**
 * 侧栏两页签：「对话」= 自定义分组 + 未分组的按日期（ChatGPT 式）；「Agent」= Codex 式按工作区分组，
 * 每个工作区是一个可折叠的项目，下面挂它的 Agent 任务。
 * 工作区可置顶、拖拽排序；Agent 可拖到别的工作区（PATCH workspaceId）；对话可拖进 / 拖出分组，也可用菜单移动。
 */
export function Sidebar({
  desktopMode,
  tab,
  onTab,
  conversations,
  workspaces,
  currentId,
  workingIds,
  busyWorkspaceIds,
  canAgent,
  onOpen,
  onRenameConv,
  onDeleteConv,
  onNewAgent,
  onAddWorkspace,
  onRenameWorkspace,
  onChangeWorkspaceRoot,
  onDeleteWorkspace,
  onPinWorkspace,
  onReorderWorkspaces,
  onMoveAgent,
  onOpenGuide,
  groups = [],
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveToGroup,
}: {
  desktopMode: boolean;
  tab: SidebarTab;
  onTab: (t: SidebarTab) => void;
  conversations: Conversation[];
  workspaces: Workspace[];
  currentId: string | null;
  workingIds?: readonly string[];
  busyWorkspaceIds?: readonly string[];
  canAgent: boolean;
  onOpen: (id: string) => void;
  onRenameConv: (id: string, title: string) => void;
  onDeleteConv: (id: string) => void;
  onNewAgent: (workspaceId: string) => void;
  onAddWorkspace: () => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onChangeWorkspaceRoot: (id: string) => void;
  onDeleteWorkspace: (ws: Workspace) => void;
  onPinWorkspace?: (id: string, pinned: boolean) => void;
  onReorderWorkspaces?: (ids: string[]) => void;
  onMoveAgent?: (id: string, workspaceId: string) => void;
  onOpenGuide?: (ws: Workspace) => void;
  groups?: ConversationGroup[];
  onCreateGroup?: (name: string) => void;
  onRenameGroup?: (id: string, name: string) => void;
  onDeleteGroup?: (group: ConversationGroup) => void;
  onMoveToGroup?: (conversationId: string, groupId: string | null) => void;
}) {
  const [renaming, setRenaming] = useState<Renaming>(null);
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragKind>(null);
  const [drop, setDrop] = useState<DropHint>(null);

  const chats = conversations.filter((c) => c.mode !== "agent");
  const agents = conversations.filter((c) => c.mode === "agent");
  const groupIds = new Set(groups.map((g) => g.id));
  const byGroup = new Map<string, Conversation[]>();
  const ungrouped: Conversation[] = [];
  for (const c of chats) {
    if (c.group_id && groupIds.has(c.group_id)) byGroup.set(c.group_id, [...(byGroup.get(c.group_id) ?? []), c]);
    else ungrouped.push(c);
  }
  const byWorkspace = new Map<string, Conversation[]>();
  for (const a of agents) {
    const key = a.workspace_id ?? "__none__";
    byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), a]);
  }
  const orphan = byWorkspace.get("__none__") ?? [];
  const pinned = workspaces.filter((w) => w.pinned);
  const rest = workspaces.filter((w) => !w.pinned);

  const convProps = (c: Conversation, icon = false, homeWsId?: string) => ({
    c,
    icon,
    active: c.id === currentId,
    working: workingIds?.includes(c.id),
    blocked: Boolean(homeWsId && busyWorkspaceIds?.includes(homeWsId) && !workingIds?.includes(c.id)),
    renaming,
    onOpen: () => onOpen(c.id),
    onRenameStart: () => setRenaming({ kind: "conv", id: c.id, title: c.title }),
    onRenameCancel: () => setRenaming(null),
    onRenameChange: (title: string) => setRenaming({ kind: "conv", id: c.id, title }),
    onRename: (title: string) => {
      setRenaming(null);
      if (title.trim() && title.trim() !== c.title) onRenameConv(c.id, title.trim());
    },
    onDelete: () => onDeleteConv(c.id),
    onDragStart: onMoveAgent
      ? (e: DragEvent) => {
          e.dataTransfer.setData(AGENT_MIME, c.id);
          e.dataTransfer.setData("text/plain", `agnes-agent:${c.id}`);
          e.dataTransfer.effectAllowed = "move";
          setDrag({ kind: "agent", id: c.id });
        }
      : undefined,
    moveTargets: onMoveAgent ? workspaces.filter((w) => w.id !== homeWsId) : undefined,
    onMove: onMoveAgent ? (workspaceId: string) => onMoveAgent(c.id, workspaceId) : undefined,
  });

  function readDrag(e: DragEvent): DragKind {
    const agent = e.dataTransfer.getData(AGENT_MIME) || (e.dataTransfer.getData("text/plain").startsWith("agnes-agent:") ? e.dataTransfer.getData("text/plain").slice("agnes-agent:".length) : "");
    const ws = e.dataTransfer.getData(WS_MIME) || (e.dataTransfer.getData("text/plain").startsWith("agnes-ws:") ? e.dataTransfer.getData("text/plain").slice("agnes-ws:".length) : "");
    const chat = e.dataTransfer.getData(CHAT_MIME) || (e.dataTransfer.getData("text/plain").startsWith("agnes-chat:") ? e.dataTransfer.getData("text/plain").slice("agnes-chat:".length) : "");
    if (agent) return { kind: "agent", id: agent };
    if (ws) return { kind: "workspace", id: ws };
    if (chat) return { kind: "chat", id: chat };
    return drag;
  }

  function endDrag() {
    setDrag(null);
    setDrop(null);
  }

  /** 「对话」页签的行：可拖进分组，菜单里也能移动 */
  const chatProps = (c: Conversation) => {
    const base = convProps(c);
    if (!onMoveToGroup) return { ...base, onDragStart: undefined, moveTargets: undefined, onMove: undefined };
    const targets: MoveTarget[] = groups.filter((g) => g.id !== c.group_id).map((g) => ({ id: g.id, name: g.name }));
    if (c.group_id && groupIds.has(c.group_id)) targets.push({ id: "", name: "移出分组" });
    return {
      ...base,
      onDragStart: (e: DragEvent) => {
        e.dataTransfer.setData(CHAT_MIME, c.id);
        e.dataTransfer.setData("text/plain", `agnes-chat:${c.id}`);
        e.dataTransfer.effectAllowed = "move";
        setDrag({ kind: "chat", id: c.id });
      },
      onDragEnd: endDrag,
      moveTargets: targets,
      moveTitle: "移动到分组",
      onMove: (groupId: string) => onMoveToGroup(c.id, groupId || null),
    };
  };

  function chatDropProps(targetId: string) {
    return {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (drag?.kind !== "chat") return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDrop({ id: targetId, place: "into" });
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDrop((cur) => (cur?.id === targetId ? null : cur));
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        const payload = readDrag(e);
        if (payload?.kind !== "chat") return;
        e.preventDefault();
        e.stopPropagation();
        endDrag();
        const conv = chats.find((c) => c.id === payload.id);
        const groupId = targetId === UNGROUPED ? null : targetId;
        if (!conv || (conv.group_id ?? null) === groupId || !onMoveToGroup) return;
        onMoveToGroup(conv.id, groupId);
        if (groupId && collapsed[groupId]) setCollapsed((m) => ({ ...m, [groupId]: false }));
      },
    };
  }

  function renderGroup(group: ConversationGroup) {
    const items = byGroup.get(group.id) ?? [];
    const isCollapsed = collapsed[group.id] ?? false;
    const editing = renaming?.kind === "group" && renaming.id === group.id;
    const dropHere = drop?.id === group.id;
    const menuKey = `group:${group.id}`;
    return (
      <div
        key={group.id}
        className={`ws-group conv-folder${items.some((c) => c.id === currentId) ? " has-active" : ""}${dropHere ? " drop-into" : ""}`}
        {...chatDropProps(group.id)}
      >
        <div className="ws-head">
          <button type="button" className="ws-toggle" onClick={() => setCollapsed((m) => ({ ...m, [group.id]: !isCollapsed }))}>
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
          {editing ? (
            <input
              className="conv-rename"
              autoFocus
              value={renaming.title}
              onChange={(e) => setRenaming({ kind: "group", id: group.id, title: e.target.value })}
              onBlur={() => {
                setRenaming(null);
                const name = renaming.title.trim();
                if (name && name !== group.name) onRenameGroup?.(group.id, name);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <button
              type="button"
              className="ws-name"
              title={group.name}
              onDoubleClick={() => setRenaming({ kind: "group", id: group.id, title: group.name })}
              onClick={() => setCollapsed((m) => ({ ...m, [group.id]: !isCollapsed }))}
            >
              <Folder size={13} />
              <span>{group.name}</span>
              <span className="ws-count">{items.length}</span>
            </button>
          )}
          <span className="ws-acts">
            <button type="button" title="更多" aria-label="分组操作" onClick={() => setMenuFor(menuFor === menuKey ? null : menuKey)}>
              <MoreHorizontal size={13} />
            </button>
          </span>
          {menuFor === menuKey ? (
            <div className="ws-menu" onMouseLeave={() => setMenuFor(null)}>
              <button
                type="button"
                onClick={() => {
                  setMenuFor(null);
                  setRenaming({ kind: "group", id: group.id, title: group.name });
                }}
              >
                <Pencil size={12} /> 重命名
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setMenuFor(null);
                  onDeleteGroup?.(group);
                }}
              >
                <Trash2 size={12} /> 删除分组（保留对话）
              </button>
            </div>
          ) : null}
        </div>
        {!isCollapsed ? (
          <div className="ws-items">
            {items.length === 0 ? (
              <div className="side-hint conv-folder-empty">把对话拖到这里，或用对话右侧的移动按钮</div>
            ) : (
              items.map((c) => <ConvRow key={c.id} {...chatProps(c)} />)
            )}
          </div>
        ) : null}
      </div>
    );
  }

  function placeOf(e: DragEvent<HTMLElement>): "before" | "after" {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2 ? "before" : "after";
  }

  function reorderGroup(group: Workspace[], fromId: string, toId: string, place: "before" | "after") {
    if (!onReorderWorkspaces || fromId === toId) return;
    const ids = group.map((w) => w.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    const next = ids.filter((id) => id !== fromId);
    let insert = next.indexOf(toId);
    if (insert < 0) return;
    if (place === "after") insert += 1;
    next.splice(insert, 0, fromId);
    onReorderWorkspaces(next);
  }

  function renderWorkspace(ws: Workspace, group: Workspace[]) {
    const items = byWorkspace.get(ws.id) ?? [];
    const isCollapsed = collapsed[ws.id] ?? false;
    const editing = renaming?.kind === "ws" && renaming.id === ws.id;
    const hasActive = items.some((c) => c.id === currentId);
    const wsBusy = busyWorkspaceIds?.includes(ws.id);
    const dropHere = drop?.id === ws.id;
    const draggingThis = drag?.kind === "workspace" && drag.id === ws.id;
    return (
      <div
        key={ws.id}
        className={`ws-group ${hasActive ? "has-active" : ""} ${ws.exists ? "" : "missing"} ${ws.pinned ? "pinned" : ""} ${wsBusy ? "is-busy" : ""} ${draggingThis ? "dragging" : ""} ${dropHere && drop.place === "into" ? "drop-into" : ""} ${dropHere && drop.place === "before" ? "drop-before" : ""} ${dropHere && drop.place === "after" ? "drop-after" : ""}`}
        onDragOver={(e) => {
          if (!drag) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (drag.kind === "agent") setDrop({ id: ws.id, place: "into" });
          else if (drag.id !== ws.id) setDrop({ id: ws.id, place: placeOf(e) });
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDrop((cur) => (cur?.id === ws.id ? null : cur));
        }}
        onDrop={(e) => {
          e.preventDefault();
          const payload = readDrag(e);
          setDrag(null);
          setDrop(null);
          if (!payload) return;
          if (payload.kind === "agent") {
            if (payload.id && onMoveAgent) onMoveAgent(payload.id, ws.id);
            if (isCollapsed) setCollapsed((m) => ({ ...m, [ws.id]: false }));
            return;
          }
          if (payload.kind === "workspace") reorderGroup(group, payload.id, ws.id, placeOf(e));
        }}
      >
        <div className="ws-head">
          {onReorderWorkspaces ? (
            <button
              type="button"
              className="ws-grip"
              title="拖动排序"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(WS_MIME, ws.id);
                e.dataTransfer.setData("text/plain", `agnes-ws:${ws.id}`);
                e.dataTransfer.effectAllowed = "move";
                setDrag({ kind: "workspace", id: ws.id });
              }}
              onDragEnd={() => {
                setDrag(null);
                setDrop(null);
              }}
            >
              <GripVertical size={13} />
            </button>
          ) : null}
          <button type="button" className="ws-toggle" onClick={() => setCollapsed((m) => ({ ...m, [ws.id]: !isCollapsed }))}>
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
          {editing ? (
            <input
              className="conv-rename"
              autoFocus
              value={renaming.title}
              onChange={(e) => setRenaming({ kind: "ws", id: ws.id, title: e.target.value })}
              onBlur={() => {
                setRenaming(null);
                if (renaming.title.trim() && renaming.title.trim() !== ws.name) onRenameWorkspace(ws.id, renaming.title.trim());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <button
              type="button"
              className="ws-name"
              title={`${ws.root}${ws.exists ? "" : "（目录不存在）"}`}
              onDoubleClick={() => setRenaming({ kind: "ws", id: ws.id, title: ws.name })}
              onClick={() => setCollapsed((m) => ({ ...m, [ws.id]: !isCollapsed }))}
            >
              <FolderOpen size={13} />
              {ws.pinned ? <Pin size={11} className="ws-pin-mark" /> : null}
              <span>{ws.name}</span>
              <span className="ws-count">{items.length}</span>
              {wsBusy ? <span className="ws-running">运行中</span> : null}
            </button>
          )}
          <span className="ws-acts">
            <button type="button" title="在这个工作区新建 Agent" onClick={() => onNewAgent(ws.id)}>
              <Plus size={13} />
            </button>
            <button type="button" title="更多" onClick={() => setMenuFor(menuFor === ws.id ? null : ws.id)}>
              <MoreHorizontal size={13} />
            </button>
          </span>
          {menuFor === ws.id ? (
            <div className="ws-menu" onMouseLeave={() => setMenuFor(null)}>
              {onPinWorkspace ? (
                <button
                  type="button"
                  onClick={() => {
                    setMenuFor(null);
                    onPinWorkspace(ws.id, !ws.pinned);
                  }}
                >
                  {ws.pinned ? <PinOff size={12} /> : <Pin size={12} />} {ws.pinned ? "取消置顶" : "置顶"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setMenuFor(null);
                  setRenaming({ kind: "ws", id: ws.id, title: ws.name });
                }}
              >
                <Pencil size={12} /> 重命名
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuFor(null);
                  onChangeWorkspaceRoot(ws.id);
                }}
              >
                <FolderOpen size={12} /> 换目录
              </button>
              {onOpenGuide ? (
                <button
                  type="button"
                  onClick={() => {
                    setMenuFor(null);
                    onOpenGuide(ws);
                  }}
                >
                  <BookOpen size={12} /> 技能与说明
                </button>
              ) : null}
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setMenuFor(null);
                  onDeleteWorkspace(ws);
                }}
              >
                <Trash2 size={12} /> 移除工作区
              </button>
            </div>
          ) : null}
        </div>
        <div className="ws-path" title={ws.root}>
          {ws.root}
        </div>
        {!isCollapsed ? (
          <div className="ws-items">
            {items.length === 0 ? (
              <button type="button" className="ws-empty" onClick={() => onNewAgent(ws.id)}>
                <Plus size={12} /> 新建第一个 Agent
              </button>
            ) : (
              items.map((c) => <ConvRow key={c.id} {...convProps(c, true, ws.id)} />)
            )}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {desktopMode ? (
        <div className="side-seg">
          <button type="button" className={tab === "chats" ? "active" : ""} onClick={() => onTab("chats")}>
            对话{chats.length ? <span className="side-count">{chats.length}</span> : null}
          </button>
          <button type="button" className={tab === "agents" ? "active" : ""} onClick={() => onTab("agents")}>
            Agent{agents.length ? <span className="side-count">{agents.length}</span> : null}
          </button>
        </div>
      ) : null}

      {tab === "chats" || !desktopMode ? (
        <div className="conv-list" onDragEnd={endDrag}>
          {onCreateGroup ? (
            newGroup === null ? (
              <button type="button" className="ws-add" onClick={() => setNewGroup("")}>
                <FolderPlus size={14} />
                新建分组
              </button>
            ) : (
              <input
                className="conv-rename conv-group-new"
                autoFocus
                maxLength={40}
                placeholder="分组名，回车确定"
                value={newGroup}
                onChange={(e) => setNewGroup(e.target.value)}
                onBlur={() => {
                  const name = (newGroup ?? "").trim();
                  setNewGroup(null);
                  if (name) onCreateGroup(name);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                  if (e.key === "Escape") setNewGroup(null);
                }}
              />
            )
          ) : null}
          {groups.map((group) => renderGroup(group))}
          {chats.length === 0 ? <div className="side-hint">还没有对话，点上面「新对话」开始。</div> : null}
          <div
            className={`conv-ungrouped${drag?.kind === "chat" && groups.length ? " is-dragging" : ""}${drop?.id === UNGROUPED ? " drop-into" : ""}`}
            {...chatDropProps(UNGROUPED)}
          >
            {drag?.kind === "chat" && groups.length ? <div className="conv-ungrouped-hint">拖到这里移出分组</div> : null}
            {groupByDate(ungrouped).map((group) => (
              <div key={group.label} className="conv-group">
                <div className="conv-group-label">{group.label}</div>
                {group.items.map((c) => (
                  <ConvRow key={c.id} {...chatProps(c)} />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div
          className="conv-list"
          onDragEnd={() => {
            setDrag(null);
            setDrop(null);
          }}
        >
          <button type="button" className="ws-add" onClick={onAddWorkspace} disabled={!canAgent} title={canAgent ? "" : "试用不能用 Agent"}>
            <FolderPlus size={14} />
            添加工作区
          </button>
          {workspaces.length === 0 ? (
            <div className="side-hint">工作区就是一个项目目录，下面可以开多个 Agent 任务并行跑；同一个文件的写入会自动排队，不会互相覆盖。</div>
          ) : null}
          {pinned.length ? (
            <div className="ws-section">
              <div className="conv-group-label">置顶</div>
              {pinned.map((ws) => renderWorkspace(ws, pinned))}
            </div>
          ) : null}
          {rest.map((ws) => renderWorkspace(ws, rest))}
          {orphan.length ? (
            <div className="ws-group">
              <div className="ws-head">
                <span className="ws-name muted">
                  <FolderOpen size={13} />
                  <span>未归入工作区</span>
                </span>
              </div>
              <div className="ws-items">
                {orphan.map((c) => (
                  <ConvRow key={c.id} {...convProps(c, true)} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
