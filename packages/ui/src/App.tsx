import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  Clapperboard,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  LogOut,
  Menu,
  MessageSquare,
  Megaphone,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Settings,
    UserRound,
  X,
} from "lucide-react";
import {
  APPROVAL_MODES,
  type Account,
  type ApprovalMode,
  type Conversation,
  type ConversationGroup,
  type DiffRow,  type Entitlement,
  type FileNode,
  type Message,
  type Persona,
  type Settings as AppSettings,
  type StreamEvent,
  type Workspace,
} from "./types.js";
import { Sidebar, type SidebarTab } from "./Sidebar.js";
import type { TurnUsage, TurnUsageTotal } from "./types.js";
import { createConversation,
  createProfile,
  createWorkspace,
  deleteConversation,
  compactConversation,
  deleteWorkspace,
  getConversation,
  getTurnUsage,
  undoLastRound as undoLastRoundApi,
  getPending,
  getSession,
  getSettings,
  getWorkspace,
  getWorkspaceFile,
  listConversations,
  listConversationGroups,
  createConversationGroup,
  renameConversationGroup,
  deleteConversationGroup,
  moveConversationToGroup,
  listPersonas,
  listWorkspaces,
  login,
  logoutAccount,
  patchConversation,
  patchWorkspace,
  reorderWorkspaces,
  rewindTo,
  saveSettings,
  selectProfile,
  sendMessage,  stopConversation,
  restoreToMessage,
  isAbortError,
  type ImageAttachment, ApiError } from "./api.js";
import { resolveDeviceHash } from "./device.js";
import {
  ChatTranscript,
  Composer,
  consumeStreamEvent,
  type QueuedMessage,
  PromptChips,
  type LiveMedia,
  type LiveTool,
  nextRunMeta,
  type RunMeta,
  type PendingCommand,
  type PendingQuestion,
  type PendingPlan,
  type GitSetup,
  type PlanState,
} from "./ChatPane.js";
import { SidePanel } from "./SidePanel.js";
import { ImageStudio, type ImageQuotaView } from "./ImageStudio.js";
import { VideoStudio } from "./VideoStudio.js";
import { PersonasPage } from "./PersonasPage.js";
import { SettingsPage, modelLabel } from "./SettingsPage.js";
import { SkillsPanel } from "./SkillsPanel.js";
import { FeedbackPage } from "./FeedbackPage.js";
import { DesktopPromo } from "./DesktopPromo.js";

type View = "chat" | "images" | "videos" | "personas" | "feedback";

const MOBILE_MQ = "(max-width: 767px)";
const SIDEBAR_KEY = "agnes_sidebar_open";

const SIDEBAR_TAB_KEY = "agnes_sidebar_tab";

/** 每个对话各自的流式 UI。服务端 abortors 已按 convId 隔离，这里不能再用全局 busy。 */
type LiveSession = {
  busy: boolean;
  streaming: string;
  thinking: string;
  tools: LiveTool[];
  plan: PlanState | null;
  usage: number;
  media: LiveMedia[];
  terminal: string;
  commands: PendingCommand[];
  questions: PendingQuestion[];
  plans: PendingPlan[];
  gitSetup: GitSetup | null;
  diffs: DiffRow[];
};

const EMPTY_LIVE: LiveSession = {
  busy: false,
  streaming: "",
  thinking: "",
  tools: [],
  plan: null,
  usage: 0,
  media: [],
  terminal: "",
  commands: [],
  questions: [],
  plans: [],
  gitSetup: null,
  diffs: [],
};


function useIsMobile() {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(MOBILE_MQ).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [authToken, setAuthToken] = useState("");
  const [needAuth, setNeedAuth] = useState(false);
  const [view, setView] = useState<View>("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [kept, setKept] = useState({ images: false, videos: false });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [diffs, setDiffs] = useState<DiffRow[]>([]);
  const [live, setLive] = useState<Record<string, LiveSession>>({});
  const [draft, setDraft] = useState<string | undefined>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [chatGroups, setChatGroups] = useState<ConversationGroup[]>([]);
  const [confirmWs, setConfirmWs] = useState<Workspace | null>(null);
  const [guideWs, setGuideWs] = useState<Workspace | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<Message | null>(null);
  const [info, setInfo] = useState("");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(() =>
    typeof window !== "undefined" && localStorage.getItem(SIDEBAR_TAB_KEY) === "agents" ? "agents" : "chats",
  );
  const [tree, setTree] = useState<FileNode[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [git, setGit] = useState<{ branch: string; changed: number } | null>(null);
  const [skills, setSkills] = useState<string[]>([]);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState("");
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [needEntitlement, setNeedEntitlement] = useState(false);
  const [needAccount, setNeedAccount] = useState(false);
  const [profiles, setProfiles] = useState<Account[]>([]);
          const mobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    if (window.matchMedia(MOBILE_MQ).matches) return false;
    return localStorage.getItem(SIDEBAR_KEY) !== "0";
  });
  const [newProfile, setNewProfile] = useState("");
  const [me, setMe] = useState<Account | null>(null);
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
      const [privacyHint, setPrivacyHint] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | undefined>();
  const [dailyChat, setDailyChat] = useState<{ used: number; remaining: number | null; limit: number } | undefined>();
  const [dailyImage, setDailyImage] = useState<{ used: number; remaining: number | null; limit: number } | undefined>();
  const [videoQuota, setVideoQuota] = useState<
    { used: number; remaining: number | null; limit: number; windowDays: number } | undefined
  >();
  // 出图余量：免费档按天，付费档看卡内剩余；用于「本次扣 N 张，剩余 M」和多张前的预检
  const imageQuotaView: ImageQuotaView | undefined = dailyImage
    ? { ...dailyImage, scope: "today" }
    : entitlement && entitlement.plan === "licensed" && !entitlement.isSuper && entitlement.imageRemaining != null
      ? {
          used: Math.max(0, entitlement.imageQuota - entitlement.imageRemaining),
          remaining: entitlement.imageRemaining,
          limit: entitlement.imageQuota,
          scope: "plan",
        }
      : undefined;

  const current = useMemo(
    () => conversations.find((c) => c.id === currentId) ?? null,
    [conversations, currentId],
  );
  const currentIdRef = useRef<string | null>(null);
  /** 各会话最近一次消息快照，切会话时先乐观展示，避免慢请求期间仍显示上一会话的流式 token */
  const messageCacheRef = useRef<Record<string, Message[]>>({});
  /** 缓存代号：切走时存快照会 +1，后台预取只在代号没变时才写回，免得旧数据盖掉新快照 */
  const cacheGenRef = useRef<Record<string, number>>({});
  const messagesRef = useRef<Message[]>(messages);
  /** openConv 请求序号：只认最后一次，防止慢响应把画面切回旧会话 */
  const openSeqRef = useRef(0);
  /** 用户点了但还没打开完的会话；非空时后台刷新一律让路 */
  const pendingIdRef = useRef<string | null>(null);
  const liveRef = useRef(live);
  const sendAbortors = useRef(new Map<string, AbortController>());
  const sendLocks = useRef(new Set<string>());
  const queuesRef = useRef<Record<string, QueuedMessage[]>>({});
  const parallelLock = useRef(false);
  /** 用户刚切过的计划模式开关，跟下一条消息一起提交（PATCH 可能还在路上） */
  const planIntent = useRef(new Map<string, boolean>());
  /** 刷新后接回来的、服务端还在跑的对话：轮询 /pending 直到跑完 */
  const detachedTimers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  /** 每个会话上一轮是否因输出上限被截断（只在本次打开期间有效） */
  const [truncatedConvs, setTruncatedConvs] = useState<Record<string, boolean>>({});
  const [abortedConvs, setAbortedConvs] = useState<Record<string, boolean>>({});
  const [turnUsageByConv, setTurnUsageByConv] = useState<Record<string, { last: TurnUsage | null; total: TurnUsageTotal }>>({});
  const [runMeta, setRunMeta] = useState<Record<string, RunMeta>>({});
  liveRef.current = live;
  messagesRef.current = messages;
  const session = currentId ? (live[currentId] ?? EMPTY_LIVE) : EMPTY_LIVE;
  // 切到会话时取一次用量记录（最近一轮 + 会话合计）；本轮结束时由 turn_usage 事件更新
  useEffect(() => {
    const id = currentId;
    if (!id || turnUsageByConv[id]) return;
    let cancelled = false;
    getTurnUsage(id, 1)
      .then((r) => {
        if (cancelled || !r || !Array.isArray(r.items) || !r.total) return;
        setTurnUsageByConv((m) => (m[id] ? m : { ...m, [id]: { last: r.items[0] ?? null, total: r.total } }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);
  const {
    busy,
    streaming,
    thinking,
    tools,
    plan,
    usage,
    media,
    terminal,
    commands,
    questions,
    plans,
    gitSetup,
  } = session;
  const shownDiffs = busy ? session.diffs : diffs;
  const modelOptions = useMemo(() => {
    if (!settings) return [];
    const available = settings.models.chat;
    const ids = current?.model && !available.includes(current.model) ? [current.model, ...available] : available;
    return ids.map((id) => ({
      id,
      label: `${modelLabel(id, settings.providers)}${available.includes(id) ? "" : "（已不可用）"}`,
    }));
  }, [settings, current?.model]);
  const workingIds = useMemo(
    () => Object.keys(live).filter((id) => live[id]?.busy),
    [live],
  );
  const occupier = useMemo(() => {
    if (!current?.workspace_id) return null;
    for (const id of workingIds) {
      if (id === currentId) continue;
      const c = conversations.find((x) => x.id === id);
      if (c?.workspace_id === current.workspace_id) return c;
    }
    return null;
  }, [workingIds, conversations, current, currentId]);
  const busyWorkspaceIds = useMemo(() => {
    const ids: string[] = [];
    for (const id of workingIds) {
      const wsId = conversations.find((c) => c.id === id)?.workspace_id;
      if (wsId && !ids.includes(wsId)) ids.push(wsId);
    }
    return ids;
  }, [workingIds, conversations]);

  function pruneLive(ids: Iterable<string>) {
    const keep = new Set(ids);
    for (const [id, timer] of [...detachedTimers.current]) {
      if (keep.has(id)) continue;
      clearInterval(timer);
      detachedTimers.current.delete(id);
    }
    for (const [id, ac] of [...sendAbortors.current]) {
      if (keep.has(id)) continue;
      ac.abort();
      sendAbortors.current.delete(id);
    }
    for (const id of [...sendLocks.current]) if (!keep.has(id)) sendLocks.current.delete(id);
    setLive((m) => {
      let changed = false;
      const next: Record<string, LiveSession> = {};
      for (const [k, v] of Object.entries(m)) {
        if (keep.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : m;
    });
  }

  function endLive(id: string) {
    setLive((m) => {
      const s = m[id];
      if (!s) return m;
      return {
        ...m,
        [id]: { ...EMPTY_LIVE, terminal: s.terminal, usage: s.usage, diffs: s.diffs },
      };
    });
  }

  function beginSend(id: string): AbortSignal {
    sendAbortors.current.get(id)?.abort();
    const ac = new AbortController();
    sendAbortors.current.set(id, ac);
    return ac.signal;
  }

  async function handleStop(id = currentId) {
    if (!id) return;
    sendAbortors.current.get(id)?.abort();
    sendAbortors.current.delete(id);
    endLive(id);
    try {
      await stopConversation(id);
    } catch {
      /* 服务端可能已经没在跑，本地也要立刻解锁 */
    }
    // 正在跑的那轮会在 handleSend 里刷新记录并接着发队列。这里再 openConv 会把刚排上的下一条冲掉。
    if (!sendLocks.current.has(id) && currentIdRef.current === id) {
      try {
        await openConv(id);
      } catch {
        /* ignore */
      }
    }
  }

  async function boot() {
    try {
      await resolveDeviceHash();
      const session = await getSession();
      setPrivacyHint(
        session.storage === "local"
          ? `对话、人设、媒体任务只写在本机 SQLite${session.dataDir ? `（${session.dataDir}）` : ""}，不会上传到我们的服务器`
          : "对话按你的设备隔离，存在这台自建服务器；只有发给模型的内容会到 Agnes API",
      );
      setEntitlement(session.entitlement);
      setProfiles(session.profiles);
      setIsDesktop(session.desktopMode);
      setDownloadUrl(session.desktopDownloadUrl);
      setDailyChat(session.dailyChat);
      setDailyImage(session.dailyImage);
      setVideoQuota(session.videoQuota);
      if (session.authRequired && !session.appAuthed) {
        setNeedAuth(true);
        setNeedEntitlement(false);
        setNeedAccount(false);
        return;
      }
      setNeedAuth(false);
      if (!session.entitlement) {
        setNeedEntitlement(true);
        setNeedAccount(false);
        setMe(null);
        return;
      }
      setNeedEntitlement(false);
      if (session.desktopMode && !session.account) {
        setNeedAccount(true);
        setMe(null);
        return;
      }
      setNeedAccount(false);
      setMe(session.account);
      const s = await getSettings();
      setSettings(s);
      const list = await listConversations();
      setConversations(list);
      setChatGroups(await listConversationGroups().catch(() => []));
      setPersonas(await listPersonas());
      if (session.desktopMode) setWorkspaces(await listWorkspaces().catch(() => []));
      if (session.desktopMode) {
        const ws = await getWorkspace(3);
        setTree(ws.tree);
      } else {
        setTree([]);
      }
      if (list[0]) {
        const detail = await getConversation(list[0].id);
        currentIdRef.current = list[0].id;
        setCurrentId(list[0].id);
        setMessages(detail.messages as Message[]);
        setDiffs(detail.diffs as DiffRow[]);
        if (session.desktopMode) void resumeDetached(list[0].id);
      } else {
        currentIdRef.current = null;
        setCurrentId(null);
        setMessages([]);
        setDiffs([]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("unauthorized")) setNeedAuth(true);
      else if (msg.includes("需要选择本机档案") || msg.includes("需要登录账户")) setNeedAccount(true);
      else if (msg.includes("未配置 AGNES_API_KEY") || msg.includes("请配置 AGNES_API_KEY")) setNeedEntitlement(true);
      else setError(msg);
    }
  }

  useEffect(() => {
    void boot();
    const timers = detachedTimers.current;
    return () => {
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
    };
  }, []);

  /**
   * 桌面端刷新或切回来时，服务端那轮可能还在跑（桌面端断开连接不停止）。
   * 把还在等用户的卡片和停止按钮接回来，轮询到跑完再刷新记录、接着发队列。
   */
  async function resumeDetached(id: string) {
    if (detachedTimers.current.has(id) || liveRef.current[id]?.busy || sendLocks.current.has(id)) return;
    let pending: { running: boolean; cards: StreamEvent[] };
    try {
      pending = await getPending(id);
    } catch {
      return;
    }
    if (!pending.running || detachedTimers.current.has(id) || liveRef.current[id]?.busy || sendLocks.current.has(id)) return;
    const apply = (cards: StreamEvent[]) => {
      setLive((m) => {
        const prev = m[id] ?? EMPTY_LIVE;
        return { ...m, [id]: { ...prev, busy: true, questions: [], plans: [], commands: [] } };
      });
      for (const card of cards) handleEvent(id, card);
    };
    liveRef.current = { ...liveRef.current, [id]: { ...(liveRef.current[id] ?? EMPTY_LIVE), busy: true } };
    apply(pending.cards);
    const timer = setInterval(() => {
      void (async () => {
        let next: { running: boolean; cards: StreamEvent[] };
        try {
          next = await getPending(id);
        } catch {
          clearInterval(timer);
          detachedTimers.current.delete(id);
          markIdle(id);
          return;
        }
        if (next.running) {
          apply(next.cards);
          return;
        }
        clearInterval(timer);
        detachedTimers.current.delete(id);
        markIdle(id);
        if (currentIdRef.current !== id) void refreshCachedConv(id);
        await openConv(id, { refresh: true }).catch(() => {});
        setConversations(await listConversations().catch(() => conversations));
        await drainQueue(id);
      })();
    }, 2500);
    detachedTimers.current.set(id, timer);
  }

  // ChatGPT 的快捷键：Ctrl/⌘+Shift+O 新对话，Shift+Esc 聚焦输入框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void newChat();
      } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((open) => !open);
      } else if (e.shiftKey && e.key === "Escape") {
        e.preventDefault();
        document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (mobile) setSidebarOpen(false);
    else setSidebarOpen(localStorage.getItem(SIDEBAR_KEY) !== "0");
  }, [mobile]);

  useEffect(() => {
    document.body.style.overflow = mobile && sidebarOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobile, sidebarOpen]);

  function setSidebar(next: boolean) {
    setSidebarOpen(next);
    if (!mobile) localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
  }

  function go(next: View) {
    setSettingsOpen(false);
    setView(next);
    if (next === "images" || next === "videos") {
      setKept((prev) => (prev[next] ? prev : { ...prev, [next]: true }));
    }
    if (mobile) setSidebarOpen(false);
  }

  async function refreshMediaQuota() {
    const session = await getSession();
    setEntitlement(session.entitlement);
    setDailyChat(session.dailyChat);
    setDailyImage(session.dailyImage);
    setVideoQuota(session.videoQuota);
  }

  /**
   * 不在眼前的会话跑完了：趁用户不在把缓存换成最终记录。
   * 以前缓存停在切走那一刻（只有提问、没有回复和工具），切回来先闪一下旧快照再跳成完整记录。
   * 只写缓存不动画面；失败就保留旧缓存，切回来时 openConv 照常拉最新的。
   */
  async function refreshCachedConv(id: string) {
    const gen = (cacheGenRef.current[id] = (cacheGenRef.current[id] ?? 0) + 1);
    try {
      const detail = await getConversation(id);
      if (currentIdRef.current === id || pendingIdRef.current === id || cacheGenRef.current[id] !== gen) return;
      messageCacheRef.current[id] = detail.messages as Message[];
    } catch {
      /* 保留旧缓存 */
    }
  }

  async function openConv(id: string, opts: { refresh?: boolean } = {}) {
    // refresh=后台刷新：用户已切走就不动画面
    const stale = () =>
      (pendingIdRef.current !== null && pendingIdRef.current !== id) || currentIdRef.current !== id;
    if (opts.refresh && stale()) return;
    // 只有用户发起的切换占序号；refresh 不抢
    const seq = opts.refresh ? openSeqRef.current : ++openSeqRef.current;
    let switchedInto = false;
    if (!opts.refresh) {
      pendingIdRef.current = id;
      // 乐观切换：侧栏高亮与流式绑定立刻跟过去，避免 getConversation 慢时主区仍播上一会话 token
      const prevId = currentIdRef.current;
      if (prevId && prevId !== id) {
        messageCacheRef.current[prevId] = messagesRef.current;
        cacheGenRef.current[prevId] = (cacheGenRef.current[prevId] ?? 0) + 1;
      }
      if (prevId !== id) {
        switchedInto = true;
        currentIdRef.current = id;
        setCurrentId(id);
        const cached = messageCacheRef.current[id];
        setMessages(cached ? cached.slice() : []);
        const runningEarly = liveRef.current[id];
        setDiffs(runningEarly?.diffs?.length ? runningEarly.diffs : []);
        setView("chat");
        if (mobile) setSidebarOpen(false);
      }
    }
    let detail!: Awaited<ReturnType<typeof getConversation>>;
    try {
      detail = await getConversation(id);
    } catch (err) {
      // 429：退避重试几次，并 toast，避免侧栏 void openConv 静默失败
      const is429 = err instanceof ApiError && err.status === 429;
      if (is429 && !opts.refresh) {
        let last: unknown = err;
        let got = false;
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 400 * 2 ** i));
          if (seq !== openSeqRef.current) return;
          try {
            detail = await getConversation(id);
            got = true;
            break;
          } catch (e2) {
            last = e2;
            if (!(e2 instanceof ApiError && e2.status === 429)) break;
          }
        }
        if (!got) {
          if (seq === openSeqRef.current) pendingIdRef.current = null;
          setError(last instanceof Error ? last.message : "请求过于频繁，请稍后再试");
          throw last;
        }
      } else {
        if (!opts.refresh && seq === openSeqRef.current) pendingIdRef.current = null;
        if (!opts.refresh && is429) setError(err instanceof Error ? err.message : "请求过于频繁，请稍后再试");
        throw err;
      }
    }
    if (seq !== openSeqRef.current) return;
    if (opts.refresh) {
      if (stale()) return;
    } else {
      pendingIdRef.current = null;
    }
    const switching = switchedInto || currentIdRef.current !== id;
    currentIdRef.current = id;
    setCurrentId(id);
    const applied = detail.messages as Message[];
    messageCacheRef.current[id] = applied;
    setMessages(applied);
    const persisted = detail.diffs as DiffRow[];
    const running = liveRef.current[id];
    if (running?.busy) {
      setDiffs(running.diffs.length ? running.diffs : persisted);
      if (!running.diffs.length && persisted.length) {
        setLive((m) => {
          const s = m[id];
          if (!s?.busy || s.diffs.length) return m;
          return { ...m, [id]: { ...s, diffs: persisted } };
        });
      }
    } else {
      setDiffs(persisted);
      setLive((m) => {
        const s = m[id];
        if (!s) return m;
        return {
          ...m,
          [id]: {
            ...EMPTY_LIVE,
            terminal: switching ? "" : s.terminal,
            usage: switching ? 0 : s.usage,
          },
        };
      });
    }
    setView("chat");
    if (mobile) setSidebarOpen(false);
    if (settings?.desktopMode && !liveRef.current[id]?.busy) void resumeDetached(id);
    // 每个对话的工作区可能不同，切过去要把文件树也换掉
    if (settings?.desktopMode && switching) {
      try {
        await reloadWorkspace(id);
      } catch {
        /* 目录被挪走时树留空，Agent 一发消息服务端会报具体错 */
      }
    }
  }

  function pickTab(t: SidebarTab) {
    setSidebarTab(t);
    localStorage.setItem(SIDEBAR_TAB_KEY, t);
  }

  async function refreshWorkspaces() {
    if (!settings?.desktopMode) return;
    setWorkspaces(await listWorkspaces().catch(() => []));
  }

  /** 新对话（chat）：不挂工作区，进「对话」页签 */
  async function newChat() {
    try {
      const conv = await createConversation({ mode: "chat", model: settings?.chatModel });
      setConversations((list) => [conv, ...list]);
      pickTab("chats");
      await openConv(conv.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 在某个工作区下新建 Agent。不指定工作区时：当前 Agent 所在的 / 最近活跃的那个；
   * 一个都没有就先让用户挑目录建一个。一个工作区可以开很多个 Agent，各干各的。
   */
  async function newAgent(workspaceId?: string) {
    if (!settings?.desktopMode) return;
    try {
      let wsId = workspaceId ?? (current?.mode === "agent" ? current.workspace_id ?? undefined : undefined) ?? workspaces[0]?.id;
      if (!wsId) {
        const created = await addWorkspace();
        if (!created) return;
        wsId = created.id;
      }
      const conv = await createConversation({ mode: "agent", model: settings.chatModel, workspaceId: wsId });
      setConversations((list) => [conv, ...list]);
      pickTab("agents");
      await refreshWorkspaces();
      await openConv(conv.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** 挑一个目录登记成工作区；同一目录只会有一个 */
  async function addWorkspace(): Promise<Workspace | null> {
    if (!window.agnesDesktop?.pickFolder) {
      setError("浏览器里选不了目录，请在桌面客户端里添加工作区");
      return null;
    }
    const picked = await window.agnesDesktop.pickFolder({ remember: false });
    if (!picked) return null;
    try {
      const ws = await createWorkspace(picked);
      await refreshWorkspaces();
      pickTab("agents");
      return ws;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function renameWorkspace(id: string, name: string) {
    try {
      await patchWorkspace(id, { name });
      await refreshWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function pinWorkspace(id: string, pinned: boolean) {
    try {
      await patchWorkspace(id, { pinned });
      await refreshWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function reorderWorkspaceList(ids: string[]) {
    try {
      setWorkspaces(await reorderWorkspaces(ids));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshWorkspaces();
    }
  }

  async function moveAgent(id: string, workspaceId: string) {
    const conv = conversations.find((c) => c.id === id);
    if (!conv || conv.workspace_id === workspaceId) return;
    try {
      const updated = await patchConversation(id, { workspaceId });
      setConversations((list) => list.map((c) => (c.id === updated.id ? updated : c)));
      await refreshWorkspaces();
      if (id === currentId) await reloadWorkspace(id).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** 换工作区目录会影响它下面所有 Agent——这正是"一个工作区多个 Agent"的含义 */
  async function changeWorkspaceRoot(id: string) {
    if (!window.agnesDesktop?.pickFolder) return;
    const picked = await window.agnesDesktop.pickFolder({ remember: false });
    if (!picked) return;
    try {
      await patchWorkspace(id, { root: picked });
      await refreshWorkspaces();
      if (current?.workspace_id === id) await reloadWorkspace(current.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeWorkspace(ws: Workspace) {
    if (ws.agents > 0) {
      setConfirmWs(ws);
      return;
    }
    await reallyRemoveWorkspace(ws);
  }

  async function reallyRemoveWorkspace(ws: Workspace) {
    setConfirmWs(null);
    try {
      await deleteWorkspace(ws.id, ws.agents > 0);
      const list = await listConversations();
      setConversations(list);
      await refreshWorkspaces();
      if (current?.workspace_id === ws.id) {
        currentIdRef.current = null;
        setCurrentId(null);
        setMessages([]);
        setDiffs([]);
      }
      pruneLive(list.map((c) => c.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshGroups() {
    setChatGroups(await listConversationGroups());
  }

  async function addChatGroup(name: string) {
    try {
      await createConversationGroup(name);
      await refreshGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function renameChatGroup(id: string, name: string) {
    try {
      await renameConversationGroup(id, name);
      await refreshGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeChatGroup(group: ConversationGroup) {
    if (!window.confirm(`删除分组「${group.name}」？里面的对话不会删除，会回到按日期排列。`)) return;
    try {
      await deleteConversationGroup(group.id);
      await refreshGroups();
      setConversations(await listConversations());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function moveChatToGroup(conversationId: string, groupId: string | null) {
    try {
      const row = await moveConversationToGroup(conversationId, groupId);
      setConversations((list) => list.map((c) => (c.id === conversationId ? { ...c, group_id: row.group_id ?? null } : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeConv(id: string) {
    await deleteConversation(id);
    delete messageCacheRef.current[id];
    setQueueList(id, []);
    const list = await listConversations();
    setConversations(list);
    await refreshWorkspaces();
    pruneLive(list.map((c) => c.id));
    // 用 ref：删除要等服务端停掉这一轮，期间用户可能已经切到别的对话
    if (currentIdRef.current === id) {
      currentIdRef.current = null;
      setCurrentId(null);
      setMessages([]);
      setDiffs([]);
    }
  }

  async function reloadWorkspace(convId = currentId) {
    const ws = await getWorkspace(3, convId || undefined);
    setTree(ws.tree);
    setWorkspaceRoot(ws.root);
    setSkills(ws.skills ?? []);
    setGit(ws.git ?? null);
  }

  /** ChatGPT 的「重新生成」：服务端删掉最后一轮助手输出再跑一遍 */
  async function regenerate() {
    const id = currentId;
    if (!id || liveRef.current[id]?.busy || sendLocks.current.has(id)) return;
    sendLocks.current.add(id);
    const session = { ...EMPTY_LIVE, busy: true, diffs };
    liveRef.current = { ...liveRef.current, [id]: session };
    setLive((m) => ({ ...m, [id]: session }));
    // 先把本地那条助手消息去掉，别让旧回答和新回答同时在屏上
    setMessages((list) => {
      const lastUser = [...list].reverse().find((m) => m.role === "user");
      return lastUser ? list.filter((m) => m.role === "user" || m.created_at <= lastUser.created_at) : list;
    });
    try {
      await sendMessage(id, "", (ev) => handleEvent(id, ev), [], { regenerate: true, signal: beginSend(id), planMode: takePlanIntent(id) });
      if (currentIdRef.current === id) {
        endLive(id);
        await openConv(id);
        if (settings?.desktopMode) await reloadWorkspace(id);
      }
      setConversations(await listConversations());
      await refreshMediaQuota();
    } catch (err) {
      if (isAbortError(err)) {
        await openConv(id, { refresh: true }).catch(() => {});
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      sendAbortors.current.delete(id);
      sendLocks.current.delete(id);
      markIdle(id);
    }
    await drainQueue(id);
  }

  /** ChatGPT 的「编辑消息」：回退到那条消息之前，把原文塞回输入框让用户改完再发 */
  async function editMessage(m: Message) {
    if (!currentId || liveRef.current[currentId]?.busy) return;
    try {
      await rewindTo(currentId, m.id);
      const detail = await getConversation(currentId);
      setMessages(detail.messages as Message[]);
      setDiffs(detail.diffs as DiffRow[]);
      setDraft(m.content || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleEvent(convId: string, ev: Parameters<typeof consumeStreamEvent>[0]) {
    if (ev.type === "plan_mode") {
      setConversations((list) => list.map((c) => (c.id === convId ? { ...c, plan_mode: ev.active ? 1 : 0 } : c)));
    }
    if (ev.type === "finish") {
      const cut = ev.reason === "length";
      setTruncatedConvs((m) => (Boolean(m[convId]) === cut ? m : { ...m, [convId]: cut }));
      const stopped = ev.reason === "abort";
      setAbortedConvs((m) => (Boolean(m[convId]) === stopped ? m : { ...m, [convId]: stopped }));
    }
    {
      const at = Date.now();
      setRunMeta((m) => {
        const n = nextRunMeta(m[convId], ev, at);
        return n === m[convId] || !n ? m : { ...m, [convId]: n };
      });
    }
    if (ev.type === "turn_usage") {
      setTurnUsageByConv((m) => {
        const prev = m[convId]?.total ?? { turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, retries: 0 };
        const { type: _t, ...rec } = ev;
        return {
          ...m,
          [convId]: {
            last: rec,
            total: {
              turns: prev.turns + 1,
              promptTokens: prev.promptTokens + rec.promptTokens,
              completionTokens: prev.completionTokens + rec.completionTokens,
              totalTokens: prev.totalTokens + rec.totalTokens,
              durationMs: prev.durationMs + rec.durationMs,
              retries: prev.retries + rec.retries,
            },
          },
        };
      });
    }
    setLive((m) => {
      const prev = m[convId] ?? EMPTY_LIVE;
      let next = prev;
      consumeStreamEvent(
        ev,
        (fn) => {
          next = { ...next, streaming: fn(next.streaming) };
        },
        (fn) => {
          next = { ...next, tools: fn(next.tools) };
        },
        (fn) => {
          next = { ...next, media: fn(next.media) };
        },
        (fn) => {
          next = { ...next, terminal: fn(next.terminal) };
        },
        (fn) => {
          next = { ...next, diffs: fn(next.diffs) };
        },
        (fn) => {
          next = { ...next, thinking: fn(next.thinking) };
        },
        (fn) => {
          next = { ...next, plan: fn(next.plan) };
        },
        (fn) => {
          next = { ...next, usage: fn(next.usage) };
        },
        (fn) => {
          next = { ...next, commands: fn(next.commands) };
        },
        (g) => {
          next = { ...next, gitSetup: g };
        },
        (fn) => {
          next = { ...next, questions: fn(next.questions) };
        },
        (fn) => {
          next = { ...next, plans: fn(next.plans) };
        },
      );
      if (next === prev) return m;
      return { ...m, [convId]: next };
    });
  }

  async function renameConv(id: string, title: string) {
    const next = title.trim();
    if (!next) return;
    try {
      const updated = await patchConversation(id, { title: next });
      setConversations((list) => list.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function takePlanIntent(id: string): boolean | undefined {
    const intent = planIntent.current.get(id);
    planIntent.current.delete(id);
    return intent;
  }

  async function setConvModel(model: string) {
    const id = currentId;
    if (!id || !model) return;
    try {
      const updated = await patchConversation(id, { model });
      setConversations((list) => list.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function setPlanMode(active: boolean) {
    if (!currentId || current?.mode !== "agent") return;
    planIntent.current.set(currentId, active);
    setConversations((list) => list.map((c) => (c.id === currentId ? { ...c, plan_mode: active ? 1 : 0 } : c)));
    try {
      const updated = await patchConversation(currentId, { planMode: active });
      setConversations((list) => list.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** 斜杠命令本地提示：只挂在提交时的会话画面，不入库 */
  function pushLocalNotice(conversationId: string, text: string) {
    const notice: Message = {
      id: `notice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversation_id: conversationId,
      role: "notice",
      content: text,
      tool_call_id: null,
      tool_calls: null,
      attachments: null,
      created_at: Date.now(),
    };
    if (currentIdRef.current === conversationId) {
      setMessages((list) => [...list, notice]);
    }
  }

  /**
   * /clear：用提交时的会话 id，在同模式/同工作区新开一条，再删旧的。
   * 不要在 await 后重新读 currentId，避免切会话后清错。
   */
  async function clearConversationForSlash(targetId: string) {
    const cur = conversations.find((c) => c.id === targetId);
    if (!cur) {
      pushLocalNotice(targetId, "对话不存在或已删除。");
      return;
    }
    try {
      const conv = await createConversation({
        mode: cur.mode === "agent" ? "agent" : "chat",
        model: cur.model || settings?.chatModel,
        workspaceId: cur.workspace_id ?? undefined,
        persona_id: cur.persona_id,
      });
      setConversations((list) => [conv, ...list.filter((c) => c.id !== targetId)]);
      if (cur.mode === "agent") pickTab("agents");
      else pickTab("chats");
      await openConv(conv.id);
      await deleteConversation(targetId);
      setConversations((list) => list.filter((c) => c.id !== targetId));
      pruneLive(
        (await listConversations().catch(() => conversations.filter((c) => c.id !== targetId))).map((c) => c.id),
      );
      pushLocalNotice(conv.id, "已新开对话（仅清空刚刚那一条，其它会话未动）。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * /new：同 /clear 新开同模式/同工作区对话，但保留旧会话不删。
   */
  async function newConversationForSlash(targetId: string) {
    const cur = conversations.find((c) => c.id === targetId);
    if (!cur) {
      pushLocalNotice(targetId, "对话不存在或已删除。");
      return;
    }
    try {
      const conv = await createConversation({
        mode: cur.mode === "agent" ? "agent" : "chat",
        model: cur.model || settings?.chatModel,
        workspaceId: cur.workspace_id ?? undefined,
        persona_id: cur.persona_id,
      });
      setConversations((list) => [conv, ...list]);
      if (cur.mode === "agent") pickTab("agents");
      else pickTab("chats");
      await openConv(conv.id);
      pushLocalNotice(conv.id, "已新开对话（原对话仍保留）。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** /model：按提交时的会话 id 切换模型 */
  async function setConvModelForSlash(targetId: string, model: string) {
    if (!targetId || !model) return;
    if (liveRef.current[targetId]?.busy || sendLocks.current.has(targetId)) {
      pushLocalNotice(targetId, "正在生成，先停止后再切换模型。");
      return;
    }
    try {
      const updated = await patchConversation(targetId, { model });
      setConversations((list) => list.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** 撤销上一轮（按钮或 /undo）：服务端删掉最后一条提问及之后的内容，原话放回输入框。文件改动不撤销 */
  async function undoRound(targetId: string) {
    if (!targetId) return;
    if (liveRef.current[targetId]?.busy || sendLocks.current.has(targetId)) {
      pushLocalNotice(targetId, "正在生成，先停止后再撤销。");
      return;
    }
    try {
      const r = await undoLastRoundApi(targetId);
      const fresh = await getTurnUsage(targetId, 1).catch(() => null);
      setTurnUsageByConv((m) => ({ ...m, [targetId]: { last: fresh?.items[0] ?? null, total: fresh?.total ?? r.usage } }));
      setTruncatedConvs((m) => (m[targetId] ? { ...m, [targetId]: false } : m));
      setAbortedConvs((m) => (m[targetId] ? { ...m, [targetId]: false } : m));
      setRunMeta((m) => {
        if (!m[targetId]) return m;
        const { [targetId]: _gone, ...rest } = m;
        return rest;
      });
      const prevLive = liveRef.current[targetId];
      const cleared = { ...EMPTY_LIVE, diffs: prevLive?.diffs ?? [] };
      liveRef.current = { ...liveRef.current, [targetId]: cleared };
      setLive((m) => ({ ...m, [targetId]: cleared }));
      if (currentIdRef.current === targetId) {
        const detail = await getConversation(targetId);
        setMessages(detail.messages as Message[]);
        setDiffs(detail.diffs as DiffRow[]);
        setDraft(r.text || "");
        pushLocalNotice(
          targetId,
          r.attachments.length
            ? "已撤销上一轮，原话已放回输入框（图片需要重新添加）。文件改动不会撤销。"
            : "已撤销上一轮，原话已放回输入框。文件改动不会撤销。",
        );
      }
    } catch (err) {
      pushLocalNotice(targetId, err instanceof Error ? err.message : String(err));
    }
  }

  /** /goal：设定或清除提交时会话的目标 */
  async function setConvGoal(targetId: string, goal: string) {
    if (!targetId) return;
    try {
      const updated = await patchConversation(targetId, { goal });
      setConversations((list) => list.map((c) => (c.id === updated.id ? updated : c)));
      pushLocalNotice(targetId, updated.goal ? `已设定本对话目标：${updated.goal}` : "已清除本对话目标。");
    } catch (err) {
      pushLocalNotice(targetId, err instanceof Error ? err.message : String(err));
    }
  }

  /** /compact confirm：只压缩提交时的会话 */
  async function compactConversationForSlash(targetId: string) {
    if (liveRef.current[targetId]?.busy || sendLocks.current.has(targetId)) {
      pushLocalNotice(targetId, "正在生成，先停止后再压缩上下文。");
      return;
    }
    try {
      const result = await compactConversation(targetId);
      pushLocalNotice(targetId, result.note || `已压缩（${result.before} → ${result.after} 字）`);
    } catch (err) {
      pushLocalNotice(targetId, err instanceof Error ? err.message : String(err));
    }
  }

  async function setApproval(mode: ApprovalMode) {
    try {
      const next = await saveSettings({ approvalMode: mode });
      setSettings(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function rememberCommand(command: string) {
    try {
      const next = await saveSettings({ rememberCommand: command });
      setSettings(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function restoreFiles() {
    const message = restoreTarget;
    const id = currentId;
    if (!message || !id) return;
    setRestoreTarget(null);
    try {
      const result = await restoreToMessage(id, message.id);
      setInfo(result.reverted ? `已回退 ${result.reverted} 个提交，聊天记录还在` : "没有需要回退的提交");
      if (settings?.desktopMode) await reloadWorkspace(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function setQueueList(convId: string, items: QueuedMessage[]) {
    const next = { ...queuesRef.current };
    if (items.length) next[convId] = items;
    else delete next[convId];
    queuesRef.current = next;
    setQueues(next);
  }

  function markIdle(id: string) {
    const prev = liveRef.current[id];
    const session = { ...EMPTY_LIVE, terminal: prev?.terminal ?? "", usage: prev?.usage ?? 0, diffs: prev?.diffs ?? [] };
    liveRef.current = { ...liveRef.current, [id]: session };
    setLive((m) => {
      const cur = m[id];
      if (!cur) return m;
      return { ...m, [id]: { ...EMPTY_LIVE, terminal: cur.terminal, usage: cur.usage, diffs: cur.diffs } };
    });
  }

  function queueFollowUp(convId: string, text: string, attachments: ImageAttachment[]) {
    const item: QueuedMessage = {
      id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      text,
      attachments,
    };
    setQueueList(convId, [...(queuesRef.current[convId] ?? []), item]);
    if (!liveRef.current[convId]?.busy && !sendLocks.current.has(convId)) void drainQueue(convId);
  }

  function removeQueued(convId: string, qid: string) {
    setQueueList(
      convId,
      (queuesRef.current[convId] ?? []).filter((item) => item.id !== qid),
    );
  }

  /** 把队首拆到一条新对话里马上跑，当前这条继续生成 */
  async function startParallel(convId: string) {
    if (parallelLock.current) return;
    const list = queuesRef.current[convId] ?? [];
    const head = list[0];
    if (!head) return;
    const source = conversations.find((c) => c.id === convId);
    parallelLock.current = true;
    setQueueList(convId, list.slice(1));
    try {
      const agent = Boolean(settings?.desktopMode && source?.mode === "agent" && source.workspace_id);
      const conv = await createConversation({
        mode: agent ? "agent" : "chat",
        model: source?.model || settings?.chatModel,
        persona_id: source?.persona_id,
        ...(agent && source?.workspace_id ? { workspaceId: source.workspace_id } : {}),
      });
      setConversations((prev) => [conv, ...prev]);
      if (agent) await refreshWorkspaces();
      await handleSend(head.text, head.attachments, { conversationId: conv.id, focus: false });
    } catch (err) {
      setQueueList(convId, [head, ...(queuesRef.current[convId] ?? [])]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      parallelLock.current = false;
    }
  }

  async function drainQueue(id: string) {
    if (liveRef.current[id]?.busy || sendLocks.current.has(id)) return;
    const list = queuesRef.current[id] ?? [];
    if (!list.length) return;
    const [head, ...rest] = list;
    setQueueList(id, rest);
    await handleSend(head.text, head.attachments, { conversationId: id, focus: false });
  }

  /**
   * 发出一条消息。生成中再调用会改成排队。
   * `conversationId` 指定对话且不抢焦点，给队列自动发送和「并行处理」用。
   */
  async function handleSend(
    text: string,
    attachments: ImageAttachment[] = [],
    opts?: { conversationId?: string; focus?: boolean },
  ) {
    const focus = opts?.focus !== false && !opts?.conversationId;
    let id = opts?.conversationId || currentId;
    if (!id) {
      const conv = await createConversation({ mode: "chat", model: settings?.chatModel, persona_id: current?.persona_id });
      setConversations((list) => [conv, ...list]);
      id = conv.id;
      currentIdRef.current = id;
      setCurrentId(id);
    } else if (focus) {
      currentIdRef.current = id;
      setCurrentId(id);
    }
    if (liveRef.current[id]?.busy || sendLocks.current.has(id)) {
      queueFollowUp(id, text, attachments);
      return;
    }
    sendLocks.current.add(id);
    const sentId = id;
    setTruncatedConvs((m) => (m[sentId] ? { ...m, [sentId]: false } : m));
    setAbortedConvs((m) => (m[sentId] ? { ...m, [sentId]: false } : m));
    const seedDiffs = currentIdRef.current === id ? diffs : (liveRef.current[id]?.diffs ?? []);
    const session = { ...EMPTY_LIVE, busy: true, diffs: seedDiffs };
    liveRef.current = { ...liveRef.current, [id]: session };
    setLive((m) => ({ ...m, [id]: session }));
    const userMsg: Message = {
      id: `local_${Date.now()}`,
      conversation_id: id,
      role: "user",
      content: text,
      tool_call_id: null,
      tool_calls: null,
      attachments: attachments.length ? JSON.stringify(attachments) : null,
      created_at: Date.now(),
    };
    if (currentIdRef.current === id) setMessages((m) => [...m, userMsg]);
    try {
      await sendMessage(id, text, (ev) => handleEvent(id, ev), attachments, { signal: beginSend(id), planMode: takePlanIntent(id) });
      if (currentIdRef.current === id) {
        markIdle(id);
        await openConv(id, { refresh: true });
        if (settings?.desktopMode) await reloadWorkspace(id);
      } else {
        void refreshCachedConv(id);
      }
      setConversations(await listConversations());
      await refreshMediaQuota();
    } catch (err) {
      if (isAbortError(err)) {
        await openConv(id, { refresh: true }).catch(() => {});
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      sendAbortors.current.delete(id);
      sendLocks.current.delete(id);
      markIdle(id);
    }
    await drainQueue(id);
  }

  if (needAuth) {
    return (
      <div className="lock">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await login(authToken);
            await boot();
          }}
        >
          <h1>Agnes 需要口令</h1>
          <p className="hint">这是可选的访客访问令牌，不是 API Key。</p>
          <input
            type="password"
            className="field"
            style={{ width: "100%", margin: "12px 0" }}
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
          />
          <button className="btn btn-primary" style={{ width: "100%" }} type="submit">
            进入
          </button>
        </form>
      </div>
    );
  }

  async function refreshSession() {
    const session = await getSession();
    setEntitlement(session.entitlement);
    setDailyChat(session.dailyChat);
    setDailyImage(session.dailyImage);
    setVideoQuota(session.videoQuota);
  }


  if (needEntitlement) {
    return (
      <div className="lock">
        <div className="lock-stack">
          <h1>请配置 AGNES_API_KEY</h1>
          <p className="hint">本开源演示壳使用你自己的 Agnes Token Plan 密钥，在设置里填写后即可对话。</p>
          <button
            className="btn btn-primary"
            style={{ width: "100%", marginTop: 12 }}
            type="button"
            onClick={() => {
              setNeedEntitlement(false);
              setSettingsOpen(true);
              void (async () => {
                try {
                  const st = await getSettings();
                  setSettings(st);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              })();
            }}
          >
            打开设置
          </button>
          <button className="btn" style={{ width: "100%", marginTop: 8 }} type="button" onClick={() => void boot()}>
            我已配置，重试
          </button>
          {error ? <div className="error">{error}</div> : null}
        </div>
      </div>
    );
  }
  if (needAccount) {
    return (
      <div className="lock">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            try {
              await createProfile(newProfile.trim() || "默认");
              setNewProfile("");
              await boot();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <h1>选择本机档案</h1>
          <p className="hint">档案只保存在这台机器，用来分开对话记录。不是服务器账号。</p>
          {profiles.map((p) => (
            <button
              key={p.id}
              className="btn"
              style={{ width: "100%", marginBottom: 8 }}
              type="button"
              onClick={async () => {
                await selectProfile(p.id);
                await boot();
              }}
            >
              {p.name}
            </button>
          ))}
          <input
            className="field"
            style={{ width: "100%", margin: "8px 0" }}
            placeholder="新档案名"
            value={newProfile}
            onChange={(e) => setNewProfile(e.target.value)}
          />
          <button className="btn btn-primary" style={{ width: "100%" }} type="submit">
            创建档案
          </button>
          {error ? <div className="error">{error}</div> : null}
        </form>
      </div>
    );
  }

  if (!settings) {
    return <div className="lock hint">{error || "加载中…"}</div>;
  }

  const agentLayout = Boolean(settings.desktopMode && current?.mode === "agent");
  const chatEmpty = !busy && !streaming && !messages.some((m) => m.role === "user" || m.role === "assistant");
  const currentWorkspace = current?.workspace_id ? workspaces.find((w) => w.id === current.workspace_id) ?? null : null;

  return (
    <div className={`shell${mobile ? " is-mobile" : ""}${sidebarOpen ? " sidebar-open" : " sidebar-collapsed"}`}>
      {mobile && sidebarOpen ? (
        <button type="button" className="sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebar(false)} />
      ) : null}
      <aside className="sidebar" aria-hidden={mobile && !sidebarOpen}>
        <div className="brand">
          <img className="brand-mark" src="/favicon.png" alt="" />
          <div className="brand-copy">
            <div className="brand-title">Agnes</div>
            <div className="brand-sub">{settings.desktopMode ? "Agent · Chat · Studio" : "Chat · Studio"}</div>
          </div>
          <button type="button" className="ghost-icon" title="收起侧栏" onClick={() => setSidebar(false)}>
            {mobile ? <X size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        <div className="sidebar-actions">
          <button className="btn btn-primary" onClick={() => void newChat()}>
            <Plus size={12} className="mr-1 inline" />
            新对话
          </button>
          {settings.desktopMode ? (
            <button className="btn btn-ghost" disabled={!entitlement?.allowAgent} title={entitlement?.allowAgent ? "在当前工作区新建 Agent" : "试用不能用 Agent"} onClick={() => void newAgent()}>
              <Bot size={12} className="mr-1 inline" />
              新 Agent
            </button>
          ) : null}
        </div>
        <nav className="nav">
          <NavBtn active={view === "chat"} onClick={() => go("chat")} icon={<MessageSquare size={15} />} label="对话" />
          <NavBtn active={view === "personas"} onClick={() => go("personas")} icon={<UserRound size={15} />} label="人设" />
          {entitlement?.allowImage ? (
            <NavBtn active={view === "images"} onClick={() => go("images")} icon={<ImageIcon size={15} />} label="图像" />
          ) : null}
          {entitlement?.allowVideo ? (
            <NavBtn active={view === "videos"} onClick={() => go("videos")} icon={<Clapperboard size={15} />} label="视频" />
          ) : null}
          <NavBtn active={view === "feedback"} onClick={() => go("feedback")} icon={<Megaphone size={15} />} label="反馈" />
        </nav>
        <Sidebar
          desktopMode={settings.desktopMode}
          tab={sidebarTab}
          onTab={pickTab}
          conversations={conversations}
          workspaces={workspaces}
          currentId={currentId}
          workingIds={workingIds}
          busyWorkspaceIds={busyWorkspaceIds}
          canAgent={Boolean(entitlement?.allowAgent)}
          onOpen={(id) => void openConv(id).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
          onRenameConv={(id, title) => void renameConv(id, title)}
          onDeleteConv={(id) => void removeConv(id)}
          onNewAgent={(wsId) => void newAgent(wsId)}
          onAddWorkspace={() => void addWorkspace()}
          onRenameWorkspace={(id, name) => void renameWorkspace(id, name)}
          onChangeWorkspaceRoot={(id) => void changeWorkspaceRoot(id)}
          onDeleteWorkspace={(ws) => void removeWorkspace(ws)}
          onPinWorkspace={(id, pinned) => void pinWorkspace(id, pinned)}
          onReorderWorkspaces={(ids) => void reorderWorkspaceList(ids)}
          onMoveAgent={(id, wsId) => void moveAgent(id, wsId)}
          onOpenGuide={(ws) => setGuideWs(ws)}
          groups={chatGroups}
          onCreateGroup={(name) => void addChatGroup(name)}
          onRenameGroup={(id, name) => void renameChatGroup(id, name)}
          onDeleteGroup={(group) => void removeChatGroup(group)}
          onMoveToGroup={(id, groupId) => void moveChatToGroup(id, groupId)}
        />
        <div className="sidebar-foot">
          <div>
            {settings.desktopMode ? (settings.hasApiKey ? "本机密钥已就绪" : "请配置 AGNES_API_KEY") : "自备密钥本地运行"}
          </div>
          <div>{privacyHint || (settings.storage === "local" ? "记录只在本机 SQLite" : "记录按设备隔离，存在自建服务器")}</div>
          {!settings.desktopMode ? <DesktopPromo compact downloadUrl={settings.desktopDownloadUrl} /> : null}
          {settings.desktopMode ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8 }}>
            <select
              className="select"
              value={me?.id ?? ""}
              onChange={async (e) => {
                await selectProfile(e.target.value);
                await boot();
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost"
              title="退出档案"
              onClick={async () => {
                await logoutAccount();
                setMe(null);
                setSettings(null);
                setConversations([]);
                setMessages([]);
                setPersonas([]);
                await boot();
              }}
            >
              <LogOut size={12} className="mr-1 inline" />
              退出
            </button>
          </div>
          ) : null}
        </div>
      </aside>
      {!mobile && !sidebarOpen ? (
        <div className="sidebar-rail">
          <button type="button" className="ghost-icon" title="打开会话列表" onClick={() => setSidebar(true)}>
            <PanelLeft size={18} />
          </button>
          <button type="button" className="ghost-icon" title="新对话" onClick={() => void newChat()}>
            <Plus size={18} />
          </button>
        </div>
      ) : null}

      <main className="main">
        {mobile && view !== "chat" ? (
          <header className="topbar">
            <div className="topbar-left">
              <button type="button" className="ghost-icon" title="会话列表" onClick={() => setSidebar(true)}>
                <Menu size={18} />
              </button>
              <span className="topbar-title">
                {view === "personas" ? "人设" : view === "feedback" ? "反馈" : view === "images" ? "图像" : "视频"}
              </span>
            </div>
          </header>
        ) : null}
        {kept.images ? (
          <div className="view-keep" hidden={view !== "images"}>
            <ImageStudio quota={imageQuotaView} onUsed={refreshMediaQuota} />
          </div>
        ) : null}
        {kept.videos ? (
          <div className="view-keep" hidden={view !== "videos"}>
            <VideoStudio quota={videoQuota} onUsed={refreshMediaQuota} />
          </div>
        ) : null}
        {view === "personas" ? (
          <PersonasPage
            onChange={(list) => {
              setPersonas(list);
              void listConversations().then(setConversations);
            }}
          />
        ) : view === "feedback" ? (
          <FeedbackPage desktopMode={settings.desktopMode} />
        ) : null}
        <div className="view-keep" hidden={view !== "chat"}>
            <header className="topbar">
              <div className="topbar-left">
                {mobile ? (
                  <button type="button" className="ghost-icon" title="会话列表" onClick={() => setSidebar(true)}>
                    <Menu size={18} />
                  </button>
                ) : null}
                <span className="topbar-title">{current?.title ?? "新对话"}</span>
                {current && settings.desktopMode ? (
                  <select
                    className="select"
                    value={current.mode}
                    onChange={async (e) => {
                      const mode = e.target.value as "chat" | "agent";
                      const next = await patchConversation(current.id, { mode });
                      setConversations((list) => list.map((c) => (c.id === next.id ? next : c)));
                    }}
                  >
                    <option value="chat">Chat</option>
                    {entitlement?.allowAgent ? <option value="agent">Agent</option> : null}
                  </select>
                ) : null}
                {current ? (
                  <select
                    className="select"
                    title="加载人设"
                    value={current.persona_id ?? ""}
                    onChange={async (e) => {
                      const persona_id = e.target.value || null;
                      const next = await patchConversation(current.id, { persona_id });
                      setConversations((list) => list.map((c) => (c.id === next.id ? next : c)));
                      await openConv(current.id);
                    }}
                  >
                    <option value="">无人设</option>
                    {personas.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              {settings.desktopMode && agentLayout ? (
              <div className="topbar-right">
                <FolderOpen size={14} />
                <span className="path" title={workspaceRoot || settings.workspaceRoot}>
                  {currentWorkspace?.name || (workspaceRoot || settings.workspaceRoot || "").split(/[\\/]/).filter(Boolean).pop()}
                </span>
                {currentWorkspace && currentWorkspace.agents > 1 ? (
                  <span className="badge" title="这个工作区下的 Agent 数">
                    {currentWorkspace.agents} 个 Agent
                  </span>
                ) : null}
                {git ? (
                  <span className="badge git" title={`分支 ${git.branch}${git.changed ? ` · ${git.changed} 个文件有改动` : " · 干净"}`}>
                    <GitBranch size={11} /> {git.branch}
                    {git.changed ? <span className="git-dirty">{git.changed}</span> : null}
                  </span>
                ) : null}
                {skills.length ? (
                  <button
                    type="button"
                    className="badge"
                    title={`工作区技能：${skills.join(", ")}`}
                    onClick={() => {
                      if (currentWorkspace) setGuideWs(currentWorkspace);
                    }}
                  >
                    Skills {skills.length}
                  </button>
                ) : null}
                <select
                  className="select approval"
                  title={APPROVAL_MODES.find((m) => m.id === (settings.approvalMode ?? "suggest"))?.hint}
                  value={settings.approvalMode ?? "suggest"}
                  onChange={(e) => void setApproval(e.target.value as ApprovalMode)}
                >
                  {APPROVAL_MODES.map((m) => (
                    <option key={m.id} value={m.id} title={m.hint}>
                      {m.label}
                    </option>
                  ))}
                </select>
                {current?.workspace_id ? (
                  <button
                    className="btn"
                    style={{ fontSize: 12 }}
                    title="换掉这个工作区的目录，它下面所有 Agent 都会跟着切"
                    onClick={() => void changeWorkspaceRoot(current.workspace_id!)}
                  >
                    换目录
                  </button>
                ) : null}
              </div>
              ) : null}
            </header>
            <div className={`workspace ${agentLayout ? "agent" : "chat"}${chatEmpty ? " is-empty" : ""}`}>
              <section className="chat-col">
                {current?.goal ? (
                  <div className="conv-goal" title={current.goal}>
                    <span className="conv-goal-label">目标</span>
                    <span className="conv-goal-text">{current.goal}</span>
                    <button type="button" className="conv-goal-clear" onClick={() => currentId && void setConvGoal(currentId, "")}>
                      清除
                    </button>
                  </div>
                ) : null}
                <ChatTranscript
                  desktopMode={settings.desktopMode}
                  agentMode={agentLayout}
                  workspaceName={currentWorkspace?.name || (workspaceRoot || settings.workspaceRoot || "").split(/[\\/]/).filter(Boolean).pop()}
                  downloadUrl={settings.desktopDownloadUrl}
                  messages={messages}
                  streaming={streaming}
                  thinking={thinking}
                  busy={busy}
                  tools={tools}
                  plan={plan}
                  usage={usage}
                  turnUsage={currentId ? (turnUsageByConv[currentId]?.last ?? null) : null}
                  usageTotal={currentId ? (turnUsageByConv[currentId]?.total ?? null) : null}
                  runMeta={currentId ? (runMeta[currentId] ?? null) : null}
                  onUndoLast={currentId ? () => void undoRound(currentId) : undefined}
                  media={media}
                  diffs={shownDiffs}
                  pendingCommands={commands}
                  pendingQuestions={questions}
                  pendingPlans={plans}
                  gitSetup={gitSetup}
                  onCommandDone={(cmdId) => {
                    if (!currentId) return;
                    setLive((m) => {
                      const s = m[currentId];
                      if (!s) return m;
                      return { ...m, [currentId]: { ...s, commands: s.commands.filter((c) => c.id !== cmdId) } };
                    });
                  }}
                  onQuestionDone={(qid) => {
                    if (!currentId) return;
                    setLive((m) => {
                      const s = m[currentId];
                      if (!s) return m;
                      return { ...m, [currentId]: { ...s, questions: s.questions.filter((q) => q.id !== qid) } };
                    });
                  }}
                  onPlanDone={(pid) => {
                    if (!currentId) return;
                    setLive((m) => {
                      const s = m[currentId];
                      if (!s) return m;
                      return { ...m, [currentId]: { ...s, plans: s.plans.filter((p) => p.id !== pid) } };
                    });
                  }}
                  onGitSetupDone={() => {
                    if (!currentId) return;
                    setLive((m) => {
                      const s = m[currentId];
                      if (!s) return m;
                      return { ...m, [currentId]: { ...s, gitSetup: null } };
                    });
                  }}
                  onAlwaysAllowCommands={(command) => rememberCommand(command)}
                  onRestoreMessage={(m) => setRestoreTarget(m)}
                  onRefreshDiffs={() => {
                    if (!currentId) return;
                    const id = currentId;
                    void (async () => {
                      const detail = await getConversation(id);
                      const rows = detail.diffs as DiffRow[];
                      setDiffs(rows);
                      setLive((m) => (m[id] ? { ...m, [id]: { ...m[id]!, diffs: rows } } : m));
                      if (settings.desktopMode) await reloadWorkspace(id).catch(() => {});
                    })();
                  }}
                  onRegenerate={() => void regenerate()}
                  onEditMessage={(m) => void editMessage(m)}
                  onError={setError}
                />
                {!settings.desktopMode && entitlement && !entitlement.allowChat && messages.length > 0 ? (
                  <DesktopPromo downloadUrl={settings.desktopDownloadUrl} />
                ) : null}
                <Composer
                  busy={busy}
                  agentMode={agentLayout}
                  planMode={Boolean(current?.plan_mode)}
                  onPlanMode={(active) => void setPlanMode(active)}
                  models={current ? modelOptions : undefined}
                  model={current?.model || settings.chatModel}
                  imageSupport={settings.modelCaps?.[current?.model || settings.chatModel]?.supportsImages}
                  onModel={(model) => void setConvModel(model)}
                  workspaceRoot={workspaceRoot || currentWorkspace?.root || settings.workspaceRoot || ""}
                  conversationId={currentId || undefined}
                  files={agentLayout ? tree : undefined}
                  draft={draft}
                  queued={currentId ? (queues[currentId] ?? []) : []}
                  onDraftConsumed={() => setDraft(undefined)}
                  onError={setError}
                  onLocalNotice={(id, text) => {
                    if (id) pushLocalNotice(id, text);
                  }}
                  onClearConversation={(id) => void clearConversationForSlash(id)}
                  onNewConversation={(id) => void newConversationForSlash(id)}
                  onModelForConversation={(id, model) => void setConvModelForSlash(id, model)}
                  onCompactConversation={(id) => void compactConversationForSlash(id)}
                  onUndoConversation={(id) => void undoRound(id)}
                  onGoalForConversation={(id, goal) => void setConvGoal(id, goal)}
                  truncated={currentId ? Boolean(truncatedConvs[currentId]) : false}
                  interrupted={currentId ? Boolean(abortedConvs[currentId]) : false}
                  onContinue={() => {
                    if (!currentId) return;
                    const text = truncatedConvs[currentId]
                      ? "继续，从上次中断的地方接着写，不要重复已经输出的内容。"
                      : "继续，接着刚才被中断的地方做下去，已经完成的部分不要重做。";
                    void handleSend(text, [], { conversationId: currentId });
                  }}
                  disabled={
                    (!settings.desktopMode && entitlement != null && !entitlement.allowChat) ||
                    (!settings.desktopMode && dailyChat?.remaining === 0)
                  }
                  placeholder={
                    occupier
                      ? `「${occupier.title}」也在这个目录运行，可以并行；同一文件的写入会排队`
                      : !settings.desktopMode && dailyChat?.remaining === 0
                      ? "今日次数已用完，请明天再来或使用付费桌面版"
                      : !settings.desktopMode && entitlement && !entitlement.allowChat
                        ? "试用次数已用完，请使用付费桌面版"
                          : agentLayout
                          ? "描述要改的东西，@ 可以带上文件或符号"
                          : "给 Agnes 发消息"
                  }
                  onSend={(t, atts) => void handleSend(t, atts)}
                  onQueue={(t, atts) => {
                    if (!currentId) {
                      void handleSend(t, atts);
                      return;
                    }
                    queueFollowUp(currentId, t, atts);
                  }}
                  onUnqueue={(qid) => {
                    if (currentId) removeQueued(currentId, qid);
                  }}
                  onParallel={() => {
                    if (currentId) void startParallel(currentId);
                  }}
                  onStop={() => void handleStop()}
                />
                {chatEmpty ? (
                  <PromptChips
                    agentMode={agentLayout}
                    desktopMode={settings.desktopMode}
                    downloadUrl={settings.desktopDownloadUrl}
                    onPick={(t) => setDraft(t)}
                  />
                ) : null}
                {info ? (
                  <div className="hint" onClick={() => setInfo("")} role="button" title="点击关闭">
                    {info}
                  </div>
                ) : null}
                {error ? (
                  <div className="error" onClick={() => setError("")} role="button" title="点击关闭">
                    {error}
                  </div>
                ) : null}
              </section>
              {agentLayout && !mobile ? (
                <SidePanel
                  diffs={shownDiffs}
                  tree={tree}
                  terminal={terminal}
                  openFile={openFile}
                  onOpenFile={async (node) => {
                    if (node.type !== "file") return;
                    try {
                      setOpenFile(await getWorkspaceFile(node.path, currentId || undefined));
                    } catch {
                      setOpenFile({ path: node.path, content: "(无法作为文本打开)" });
                    }
                  }}
                  onRefresh={() => {
                    if (!currentId) return;
                    void (async () => {
                      const detail = await getConversation(currentId);
                      const rows = detail.diffs as DiffRow[];
                      setDiffs(rows);
                      setLive((m) => (m[currentId] ? { ...m, [currentId]: { ...m[currentId]!, diffs: rows } } : m));
                      await reloadWorkspace(currentId).catch(() => {});
                    })();
                  }}
                  onError={setError}
                />
              ) : null}
            </div>
          </div>
      </main>
      {settingsOpen && settings ? (
        <SettingsPage
          settings={settings}
          onChange={(next) => {
            setSettings(next);
            // 删掉 provider 时服务端会把用它的对话改回默认模型，列表跟着刷新
            void listConversations().then(setConversations).catch(() => {});
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {guideWs ? <SkillsPanel workspace={guideWs} onClose={() => setGuideWs(null)} /> : null}
      {restoreTarget ? (
        <div className="modal-backdrop" onClick={() => setRestoreTarget(null)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>回退到这条消息之前的文件</h3>
            <p>
              会撤销这条消息之后、这个对话里 Agnes 自动提交的改动。聊天记录留着。别的对话和你自己的提交不动。工作区若还有未提交的改动，会拒绝回退。
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setRestoreTarget(null)}>
                取消
              </button>
              <button className="btn btn-danger" onClick={() => void restoreFiles()}>
                回退文件
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmWs ? (
        <div className="modal-backdrop" onClick={() => setConfirmWs(null)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>移除工作区「{confirmWs.name}」</h3>
            <p>
              它下面有 <b>{confirmWs.agents}</b> 个 Agent，会连同对话记录、待确认的改动一起删除。
              <br />
              磁盘上的项目文件不会动。
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmWs(null)}>
                取消
              </button>
              <button className="btn btn-danger" onClick={() => void reallyRemoveWorkspace(confirmWs)}>
                连同 {confirmWs.agents} 个 Agent 一起移除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NavBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button className={`nav-btn ${active ? "active" : ""}`} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}
