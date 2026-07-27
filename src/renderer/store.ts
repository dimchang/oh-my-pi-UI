/**
 * store.ts — zustand 全局状态。
 *
 * 渲染数据模型（依据 M1.0 实测事件序列）：
 * - ChatMessage 代表一条 user/assistant 消息；parts 是其 content[] 的 UI 形态。
 * - 流式渲染直接取 message_update.message.content[] 全量（omp 已累计），不必自己拼 delta。
 */

import { create } from 'zustand';
import type {
  AgentMessage,
  ContextUsage,
  ModelInfo,
  SlashCommand,
  ThinkingLevel,
  TodoPhase,
  TodoItem,
} from '../shared/rpc-types';
import type { SessionSummary, Workspace, WorkspacesFile, ApprovalMode, AppearanceConfig, HookFileConfig, CustomCssConfig } from '../shared/ipc-channels';
import { cwdKey, pathsEqual, modelKey } from './utils/path-key';
import { buildThemeCSS, getThemePreset } from './themes';

export type PartKind = 'text' | 'thinking' | 'tool';

export interface ToolPart {
  kind: 'tool';
  toolCallId: string;
  toolName: string;
  status: 'running' | 'done' | 'error';
  args?: unknown;
  result?: unknown;
  partial?: string;
}

export interface TextPart { kind: 'text'; text: string; }
export interface ThinkingPart { kind: 'thinking'; text: string; }

export type MessagePart = TextPart | ThinkingPart | ToolPart;

/**
 * 从 UI 请求里提取工具名，作为"始终允许"缓存的 key。
 * omp 的 confirm 请求把工具名 + 命令塞在 title 里（用 \n 分隔），工具名是第一行。
 * 无法解析时返回 null（此时不启用自动放行）。
 */
export function toolNameOf(req: UiRequest): string | null {
  // 优先读结构化字段：部分 confirm 请求在 raw 上直接带 tool / toolName 字段
  const raw = req.raw as { tool?: unknown; toolName?: unknown } | undefined;
  if (raw) {
    if (typeof raw.tool === 'string' && raw.tool.trim()) return raw.tool.trim();
    if (typeof raw.toolName === 'string' && raw.toolName.trim()) return raw.toolName.trim();
  }
  // 回退：omp 把工具名 + 命令塞进 title 首行（\n 分隔），首行即工具名。
  // 该解析较脆弱（依赖文案格式），仅作为结构化字段缺失时的兜底。
  const text = req.title ?? req.message ?? '';
  const firstLine = text.split('\n')[0]?.trim();
  return firstLine ? firstLine : null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | string;
  parts: MessagePart[];
  streaming?: boolean;
  usage?: { totalTokens?: number; duration?: number };
  /** stopReason==='error' 时的错误信息（模型 404/限流等） */
  error?: string;
  /** true=该用户消息来自 steer（引导），UI 用 distinct 样式 + 标记渲染 */
  steered?: boolean;
  /** true=该用户消息来自 follow_up（排队），UI 用 distinct 样式 + 标记渲染 */
  queued?: boolean;
}

export interface UiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  prompt?: string;
  options?: Array<string | { value: string; label?: string; description?: string }>;
  defaultValue?: string;
  placeholder?: string;
  url?: string;
  launchUrl?: string;
  text?: string;
  level?: string;
  targetId?: string;
  /** UI 请求来源的会话 path（多进程：应答时路由回该会话进程） */
  sessionPath?: string;
  raw: unknown;
}

/** 某会话绑定的 omp 进程状态（多进程池：每会话一进程） */
export interface ProcState {
  status: 'spawning' | 'online' | 'offline' | 'evicted';
  isStreaming: boolean;
  isAborting: boolean;
}

interface AppState {
  ready: boolean;
  ompExited: number | null | false;
  isStreaming: boolean;
  /** 用户已点停止、正在等 omp 响应 abort（防止重复点击） */
  isAborting: boolean;
  messages: ChatMessage[];
  /** per-session 消息缓冲：sessionPath -> ChatMessage[]。
   *  每会话一进程，帧带 __sessionPath 路由到对应缓冲槽，UI 显示 currentSessionPath 的槽。 */
  sessionsMap: Record<string, ChatMessage[]>;
  /** per-session 进程状态：每个会话的 omp 进程在线/流式/中止状态。
   *  全局 isStreaming/isAborting 派生自 currentSessionPath 对应的 ProcState。 */
  procStateMap: Record<string, ProcState>;
  model?: ModelInfo;
  thinkingLevel?: ThinkingLevel;
  contextUsage?: ContextUsage;
  sessionId?: string;
  slashCommands: SlashCommand[];
  sessions: SessionSummary[];
  currentSessionPath?: string;
  uiQueue: UiRequest[]; // extension_ui_request 待应答队列（单队列顺序展示）
  /** per-session 工具级"始终允许"缓存：key = `${sessionPath}::${toolName.toLowerCase()}`，命中即自动放行。
   *  仅 confirm 类请求生效；值恒为 true（拒绝不缓存，避免误伤）。见 handleUiRequest 自动放行逻辑。 */
  permAllow: Record<string, boolean>;
  stderrTail: string[];

  // M4: 增强状态
  todoPhases: TodoPhase[];
  isCompacting: boolean;
  isRetrying: boolean;
  retryInfo: string;
  compactionInfo: string;
  sessionStats?: { totalTokens?: number; totalCost?: number; messageCount?: number };
  /** 右栏标签：off|files|diff|todo */
  rightPanel: 'off' | 'files' | 'todo';
  /** 主工作区视图：chat=对话，skills=技能/插件面板 */
  mainView: 'chat' | 'skills';
  setMainView(v: 'chat' | 'skills'): void;

  // ---- 配置页 ----
  /** 配置页是否打开（全屏 overlay） */
  settingsOpen: boolean;
  /** 配置页左侧当前选中标签 */
  settingsTab: 'system' | 'agent' | 'model';
  setSettingsOpen(v: boolean): void;
  setSettingsTab(tab: 'system' | 'agent' | 'model'): void;
  /** 模型启用白名单（key = `${provider}/${modelId}`）。
   *  undefined/空 = 未配置 → ModelPicker 显示全部；非空 = 只显示白名单内的。 */
  enabledModels?: string[];
  /** 整体替换白名单并持久化 */
  setEnabledModels(list: string[] | undefined): void;
  /** 勾/取消勾一个模型（allKeys = 当前全部模型 key，用于"首次取消勾选"时把白名单初始化为全集再剔除） */
  toggleEnabledModel(key: string, allKeys: string[]): void;

  // ---- 系统提示词 / 外观 ----
  /** 系统提示词：新建会话时注入。改了即持久化。 */
  systemPrompt?: string;
  setSystemPrompt(v: string): void;

  // ---- 输入行为 ----
  /** steer 默认行为（设置→系统配置）：
   *   - 'restart'（默认）Enter = 立即重起（真中断当前 turn，立刻按新方向开 turn，丢已生成 token）。
   *   - 'steer'           Enter = 中途改写 / mid-run 中断（当前 tool 完成后立即按新方向继续，
   *                                                omp 跳过剩余 tool 队列，仍要等当前 tool 跑完 + 走一次模型）。
   *  Shift+Enter 取反（v0.3.5 实测 probe-steer-v5.mjs 确认 steer 具备 mid-run 中断能力
   *   —— omp 源码注释：`Delivered after current tool execution, skips remaining tools`）。
   *  之前 v0.3.3/v0.3.4 错误地认为 steer 不打断当前 turn，已在 v0.3.5 修正。 */
  /** 输入框 Enter 默认行为（系统配置 → 输入行为）：
   *  - 'guide'（默认）= 引导（steer）：生成中途按 Enter → mid-run 介入，当前 tool 完成后立即按新方向继续
   *    （OMP 源码注释：\`Delivered after current tool execution, skips remaining tools.\`）。
   *  - 'queue'         = 排队（follow_up）：等当前 agent turn 跑完再处理，不打断当前 tool/t。
   *  Shift+Enter 自动取反。 */
  inputBehavior: 'queue' | 'guide';
  setInputBehavior(v: 'queue' | 'guide'): void;
  /** 外观（系统风格）配置。改了即持久化并实时应用。 */
  appearance?: AppearanceConfig;
  setAppearance(v: AppearanceConfig): void;
  /** 钩子（Hooks）配置：导入的 .ts 钩子文件列表 + 启用状态。改了即持久化。 */
  hooks?: HookFileConfig[];
  setHooks(v: HookFileConfig[]): void;

  setReady(v: boolean): void;
  setOmpExited(code: number | null): void;
  setStreaming(v: boolean): void;
  setAborting(v: boolean): void;
  setState(partial: Partial<AppState>): void;
  pushStderr(line: string): void;

  // message / event 处理
  applyAgentEvent(frame: Record<string, unknown>): void;
  enqueueUi(req: UiRequest): void;
  dequeueUi(id: string): void;
  /** 写入/读取 per-session 工具级"始终允许"缓存（自动放行用） */
  setPermAllow(sessionPath: string, toolName: string): void;
  isPermAllowed(sessionPath: string, toolName: string): boolean;

  setSessions(list: SessionSummary[]): void;
  setCurrentSessionPath(p?: string): void;

  // M5: 工作空间
  workspaces: Workspace[];
  /** 归档区（收起在侧栏底部，默认折叠） */
  archived: Workspace[];
  currentWorkspaceId: string | null;
  /** 工作空间持久化是否已从主进程加载完成（避免渲染前闪烁） */
  workspacesLoaded: boolean;
  /** 用户主动彻底删除过的 cwd（小写形式）。启动补全时跳过这些路径，避免"删了又复活"。 */
  removedCwds: string[];
  /** 用户上次选中的模型。omp 进程重启后会回到默认，启动时按此自动 setModel 恢复。 */
  lastModel?: { provider: string; id: string; name?: string };
  /** omp 子进程**实际** cwd（来自主进程 OmpCwd 事件）。
   *  这是"是否需要 restart"的唯一可信来源——别用 currentWorkspace() 推断（启动时序错位）。 */
  ompCwd: string | null;
  /** 一次性输入回填文本：非空时 InputBox 消费一次后自动置空。
   *  典型场景：分叉（branch）后 selectedText 回填到输入框让用户编辑后重发。 */
  draftInput?: string;
  setDraftInput(v: string): void;
  setWorkspacesFile(file: WorkspacesFile): void;
  setCurrentWorkspaceId(id: string | null): void;
  /** 记录 omp 实际 cwd（主进程 OmpCwd 事件推过来） */
  setOmpCwd(cwd: string | null): void;
  /** 记录用户选的 model（同时写 lastModel，触发持久化） */
  setLastModel(m: { provider: string; id: string; name?: string }): void;
  /** 新增工作空间（同 cwd 已存在则返回已存在项并切换为 current） */
  upsertWorkspace(ws: Workspace): void;
  /** 归档：从任务区移到归档区（保留 cwd/displayName） */
  archiveWorkspace(id: string): void;
  /** 恢复：从归档区移回任务区 */
  restoreWorkspace(id: string): void;
  /** 彻底删除归档项：从归档区移除，并记录 cwd 到 removedCwds（防自动补全复活） */
  deleteArchivedWorkspace(id: string): void;
  renameWorkspace(id: string, displayName: string): void;
  toggleWorkspaceCollapsed(id: string): void;
  /** 设置某工作空间的 omp 权限模式（同时持久化到 workspaces.json） */
  setWorkspaceApprovalMode(id: string, mode: ApprovalMode): void;
  /** 读取当前工作空间对象（无 currentId 时返回 null） */
  currentWorkspace(): Workspace | null;
  /** 把当前状态写回主进程（防抖由调用方处理） */
  persistWorkspaces(): void;

  // 会话消息：per-session 缓冲
  /** 从磁盘读某会话历史并缓冲 */
  loadSessionMessages(path: string): void;
  /** 往当前显示会话追加一条 user 消息（onSend 用）。opts.steered=true 标记为 steer（改写方向）。 */
  appendUserMessage(text: string, opts?: { steered?: boolean; queued?: boolean }): void;
  resetChat(): void;
  // 进程池状态
  /** 部分更新某会话的进程状态（合并写入） */
  setProcState(sessionPath: string, partial: Partial<ProcState>): void;

  // ---- 轻量全局 toast（供 RPC 失败等场景在任意组件里弹提示）----
  toasts: Array<{ id: number; text: string; level: string }>;
  pushToast(text: string, level?: string): void;
  dismissToast(id: number): void;
}

let seq = 0;
const nid = () => `m${Date.now()}_${seq++}`;
let userSeq = 0;
/**
 * loadSessionMessages 的 epoch：每次调用都自增；callback 拿到结果时若发现 epoch 已不是
 * 自己的（说明用户在等待期间又触发了新的加载），就丢弃本次结果，避免旧回调覆盖新数据。
 */
let loadEpoch = 0;
/** toast 自增 id 计数器：避免 Date.now()+Math.random() 可能的碰撞，且手动关闭后超时回调按 id 过滤无副作用。 */
let toastSeq = 0;

/** 给旧版 customCss 条目生成稳定 id。
 *  使用 FNV-1a 32-bit 哈希 + 多轮混合，碰撞率远低于原先的 h*31。纯函数。 */
function cssId(path: string, mode: string): string {
  const s = `${mode}:${path}`;
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  // 多轮混合进一步降低碰撞
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return `css-${(h >>> 0).toString(16)}`;
}


/** 把 omp 的全量 content[] 映射为 UI parts（text/thinking）。
 *  实测 content type 有：text / output_text（assistant 正文）/ thinking / toolCall。
 *  output_text 与 text 同义，toolCall 由 tool_execution_* 事件单独建卡，此处跳过。 */
function contentToParts(msg: AgentMessage): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const c of msg.content ?? []) {
    const cc = c as { type?: string; text?: string; thinking?: string };
    const t = cc.type;
    if (t === 'text' || t === 'output_text') {
      if (cc.text) parts.push({ kind: 'text', text: cc.text });
    } else if (t === 'thinking') {
      if (cc.thinking) parts.push({ kind: 'thinking', text: cc.thinking });
    }
  }
  return parts;
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  ompExited: false,
  isStreaming: false,
  isAborting: false,
  messages: [],
  sessionsMap: {},
  procStateMap: {},
  toasts: [],
  slashCommands: [],
  sessions: [],
  uiQueue: [],
  permAllow: {},
  stderrTail: [],
  todoPhases: [],
  isCompacting: false,
  isRetrying: false,
  retryInfo: '',
  compactionInfo: '',
  rightPanel: 'off',
  mainView: 'chat',
  settingsOpen: false,
  settingsTab: 'model',
  enabledModels: undefined,
  systemPrompt: undefined,
  appearance: undefined,
  inputBehavior: 'guide',

  setReady: (v) => set({ ready: v }),
  setMainView: (v) => set({ mainView: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),

  /**
   * 白名单语义（v2）：
   *   enabledModels === undefined → 未配置，显示全部模型
   *   enabledModels 为 string[] → 白名单已激活，仅显示数组内的模型（key = provider/id）
   *
   * 注意：从 undefined 首次操作时，不要用 allKeys 初始化巨型数组。
   * 单个 checkbox 取消勾选时设为空数组 []（全部不选），用户再逐个勾选需要的。
   */
  setEnabledModels: (list) => {
    set({ enabledModels: list });
    get().persistWorkspaces();
  },

  toggleEnabledModel: (key, allKeys) => {
    const cur = get().enabledModels;
    let next: string[] | undefined;
    if (cur === undefined) {
      // 首次操作：从"显示全部"切换到白名单模式。
      // 先用 allKeys 初始化全集，再剔除本次取消的 key，避免"首次取消就丢失全部模型"。
      const all = allKeys && allKeys.length ? allKeys : [];
      next = all.filter((k) => k !== key);
    } else {
      // 已在白名单模式：toggle 该 key
      const has = cur.includes(key);
      next = has ? cur.filter((k) => k !== key) : [...cur, key];
    }
    set({ enabledModels: next });
    get().persistWorkspaces();
  },

  // ---- 系统提示词 / 外观 ----
  setSystemPrompt: (v) => {
    set({ systemPrompt: v });
    get().persistWorkspaces();
  },
  setAppearance: (v) => {
    set({ appearance: v });
    applyAppearance(v);
    get().persistWorkspaces();
  },
  setInputBehavior: (v) => {
    set({ inputBehavior: v });
    get().persistWorkspaces();
  },
  setHooks: (v) => {
    set({ hooks: v });
    get().persistWorkspaces();
  },
  setOmpExited: (code) => set({ ompExited: code, isStreaming: false, isAborting: false }),
  setStreaming: (v) => set({ isStreaming: v }),
  setAborting: (v) => set({ isAborting: v }),
  setState: (partial) => set(partial),
  pushStderr: (line) =>
    set((s) => ({ stderrTail: [...s.stderrTail.slice(-199), line] })),

  setSessions: (list) => set({ sessions: list }),
  setCurrentSessionPath: (p) => set({ currentSessionPath: p, todoPhases: [] }),

  // M5: 工作空间
  workspaces: [],
  archived: [],
  currentWorkspaceId: null,
  workspacesLoaded: false,
  removedCwds: [],
  lastModel: undefined,
  ompCwd: null,
  draftInput: undefined,

  setWorkspacesFile: (file) => {
    // ---- 迁移：早期 d4bea22 版本的 workspace.id 是 cwd.toLowerCase() 形式
    // （反斜杠 + 小写，如 d:\code\omp-tauri）。后续 makeWorkspaceId 改成 cwdKey()
    // （正斜杠 + 小写，如 d:/code/omp-tauri），但**没迁移老数据**。
    // 直接后果：WorkspaceList 渲染 sessionsByWs.get(ws.id) 用新 key，老 ws 永远
    // 命中不到自己下面的 session（"该工作空间下暂无会话"）。
    // 这里把所有 ws.id / archived ws.id / currentId 都重算一次，存盘时自然就一致了。
    const migrateWs = (w: Workspace): Workspace =>
      w.id === cwdKey(w.cwd) ? w : { ...w, id: cwdKey(w.cwd) };
    const migratedWorkspaces: Workspace[] = (() => {
      const out: Workspace[] = [];
      const seen = new Set<string>();
      for (const w of file.workspaces.map(migrateWs)) {
        if (seen.has(w.id)) continue; // 迁移后撞 id（极端）就保留第一个
        seen.add(w.id);
        out.push(w);
      }
      return out;
    })();
    const migratedArchived: Workspace[] = (() => {
      const out: Workspace[] = [];
      const seen = new Set<string>();
      for (const w of (file.archived ?? []).map(migrateWs)) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        out.push(w);
      }
      return out;
    })();
    // currentId 也要按"新 id"重定位：可能是老 id、也可能是 cwd 本身
    let migratedCurrentId: string | null = file.currentId;
    if (migratedCurrentId) {
      const cur = migratedCurrentId; // 类型收窄
      const matched = migratedWorkspaces.find(
        (w) => w.id === cur || pathsEqual(w.id, cur),
      );
      migratedCurrentId = matched?.id ?? null;
    }
    // 旧版 customCss 没有 id 字段，补上稳定 id，便于 styles.css 区块管理
    const normalizedCustomCss: CustomCssConfig[] | undefined = (() => {
      const list = file.appearance?.customCss;
      if (!list || list.length === 0) return undefined;
      let changed = false;
      const out = list.map((c) => {
        if (c.id) return c;
        changed = true;
        return { ...c, id: cssId(c.path, c.mode) };
      });
      return changed ? out : list;
    })();
    const migratedAppearance: AppearanceConfig | undefined = normalizedCustomCss
      ? { ...file.appearance, customCss: normalizedCustomCss }
      : file.appearance;
    // 旧版 enabledModels 用 provider/id 的 '/' 分隔（modelKey 改版前写法），
    // 新 modelKey 用 \u0000 分隔；把老 key 规整成新格式，避免升级后白名单“整体消失”。
    const migratedEnabledModels: string[] | undefined = (() => {
      const list = file.enabledModels;
      if (!list) return undefined;
      let changed = false;
      const out = list.map((k) => {
        if (k.includes('\u0000')) return k; // 已是新格式
        const slash = k.indexOf('/');
        if (slash < 0) return k; // 无法识别，保留原值
        changed = true;
        return modelKey({ provider: k.slice(0, slash), id: k.slice(slash + 1) });
      });
      return changed ? out : list;
    })();
    set({
      workspaces: migratedWorkspaces,
      archived: migratedArchived,
      currentWorkspaceId: migratedCurrentId,
      workspacesLoaded: true,
      removedCwds: file.removedCwds ?? [],
      lastModel: file.lastModel,
      enabledModels: migratedEnabledModels,
      systemPrompt: file.systemPrompt,
      appearance: migratedAppearance,
      hooks: file.hooks,
      inputBehavior: file.inputBehavior ?? 'guide',
    });
    // 若发生过迁移（任何 id 改了格式）或 customCss 补上 id，立即写回磁盘
    const dirty =
      migratedWorkspaces.some((w, i) => w.id !== file.workspaces[i]?.id) ||
      migratedArchived.some((w, i) => w.id !== (file.archived ?? [])[i]?.id) ||
      migratedCurrentId !== file.currentId ||
      normalizedCustomCss !== file.appearance?.customCss ||
      migratedEnabledModels !== file.enabledModels;
    if (dirty) get().persistWorkspaces();
  },

  setCurrentWorkspaceId: (id) => set({ currentWorkspaceId: id }),

  setOmpCwd: (cwd) => set({ ompCwd: cwd }),
  setDraftInput: (v) => set({ draftInput: v }),

  setLastModel: (m) => {
    set({ lastModel: m });
    // 写回磁盘
    get().persistWorkspaces();
  },

  upsertWorkspace: (ws) =>
    set((s) => {
      const idx = s.workspaces.findIndex((w) => w.id === ws.id);
      const next = idx >= 0
        ? s.workspaces.map((w, i) => (i === idx ? { ...w, ...ws } : w))
        : [...s.workspaces, ws];
      return { workspaces: next, currentWorkspaceId: ws.id };
    }),

  archiveWorkspace: (id) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === id);
      if (!ws) return s;
      const next = s.workspaces.filter((w) => w.id !== id);
      const newCurrent = s.currentWorkspaceId === id
        ? (next[0]?.id ?? null)
        : s.currentWorkspaceId;
      return {
        workspaces: next,
        archived: [...s.archived, ws],
        currentWorkspaceId: newCurrent,
      };
    }),

  restoreWorkspace: (id) =>
    set((s) => {
      const ws = s.archived.find((w) => w.id === id);
      if (!ws) return s;
      // 从 removedCwds 摘掉（若该 cwd 之前被彻底删过，恢复时重新允许补全/显示）
      const removedCwds = s.removedCwds.filter((c) => c !== ws.cwd.toLowerCase());
      return {
        archived: s.archived.filter((w) => w.id !== id),
        workspaces: [...s.workspaces, ws],
        currentWorkspaceId: ws.id,
        removedCwds,
      };
    }),

  deleteArchivedWorkspace: (id) =>
    set((s) => {
      const ws = s.archived.find((w) => w.id === id);
      if (!ws) return s;
      // 记录"用户主动彻底删过的 cwd"，启动补全时跳过，避免删了又自动复活
      const removedCwds = Array.from(new Set([...s.removedCwds, ws.cwd.toLowerCase()]));
      return {
        archived: s.archived.filter((w) => w.id !== id),
        removedCwds,
      };
    }),

  renameWorkspace: (id, displayName) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, displayName } : w)),
    })),

  toggleWorkspaceCollapsed: (id) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, collapsed: !w.collapsed } : w)),
    })),

  setWorkspaceApprovalMode: (id, mode) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, approvalMode: mode } : w)),
      archived: s.archived.map((w) => (w.id === id ? { ...w, approvalMode: mode } : w)),
    }));
    get().persistWorkspaces();
  },

  currentWorkspace: () => {
    const s = get();
    return s.workspaces.find((w) => w.id === s.currentWorkspaceId) ?? null;
  },

  persistWorkspaces: () => {
    const s = get();
    const file: WorkspacesFile = {
      version: 1,
      workspaces: s.workspaces,
      currentId: s.currentWorkspaceId,
      archived: s.archived,
      removedCwds: s.removedCwds,
      lastModel: s.lastModel,
      enabledModels: s.enabledModels,
      systemPrompt: s.systemPrompt,
      appearance: s.appearance,
      hooks: s.hooks,
      inputBehavior: s.inputBehavior,
    };
    // 动态 import 避免循环依赖（rpc-client 也 import store）
    void import('./rpc-client').then(({ rpc }) => {
      void rpc.saveWorkspaces(file).catch((e) =>
        get().pushToast(`保存工作空间配置失败：${e instanceof Error ? e.message : String(e)}`, 'error'),
      );
    });
  },

  enqueueUi: (req) =>
    set((s) => (s.uiQueue.some((q) => q.id === req.id) ? s : { uiQueue: [...s.uiQueue, req] })),
  dequeueUi: (id) => set((s) => ({ uiQueue: s.uiQueue.filter((q) => q.id !== id) })),

  setPermAllow: (sessionPath, toolName) => {
    const key = `${sessionPath}::${toolName.toLowerCase()}`;
    set((s) => ({ permAllow: { ...s.permAllow, [key]: true } }));
  },
  isPermAllowed: (sessionPath, toolName) => {
    const key = `${sessionPath}::${toolName.toLowerCase()}`;
    return get().permAllow[key] === true;
  },

  resetChat: () => {
    const st = get();
    const path = st.currentSessionPath ?? '';
    const sessionsMap = { ...st.sessionsMap, [path]: [] };
    const procStateMap = {
      ...st.procStateMap,
      [path]: { status: 'online' as const, isStreaming: false, isAborting: false },
    };
    set({ sessionsMap, procStateMap, messages: [], isStreaming: false, isAborting: false });
  },

  setProcState: (sessionPath, partial) =>
    set((s) => ({
      procStateMap: {
        ...s.procStateMap,
        [sessionPath]: {
          ...(s.procStateMap[sessionPath] ?? { status: 'online', isStreaming: false, isAborting: false }),
          ...partial,
        } as ProcState,
      },
    })),

  pushToast: (text, level = 'info') => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, text, level }] }));
    setTimeout(() => {
      // 按 id 精确过滤：手动关闭后此处仍为 no-op，无重复删除副作用
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  loadSessionMessages: (path) => {
    // 从磁盘读历史（进程未拉起时显示磁盘内容）
    // 每次调用递增 epoch；callback 拿到结果时若发现 epoch 已变（说明等待期间又有新加载），
    // 就丢弃，避免把旧结果覆盖到新的 sessionsMap 上（rapid switch 时尤其重要）。
    const epoch = ++loadEpoch;
    void import('./rpc-client').then(({ rpc }) => {
      return rpc.readSessionMessages(path).then((msgs) => {
        if (epoch !== loadEpoch) return; // 已被更新的加载取代，丢弃旧结果
        // 重建消息列表：toolResult 不再混入正文（会被 ReactMarkdown 当成大标题），
        // 而是重建为 ToolPart 走 ToolCard（自带折叠）。其余走 contentToParts。
        const chat: ChatMessage[] = [];
        for (const m of msgs) {
          if (m.role === 'toolResult') {
            // 工具返回结果：构建 ToolPart，追加到最近一条 assistant 消息（与实时流一致）。
            const toolPart: ToolPart = {
              kind: 'tool',
              toolCallId: (m as { toolCallId?: string }).toolCallId ?? nid(),
              toolName: (m as { toolName?: string }).toolName ?? 'tool',
              status: 'done',
              args: (m as { replayArgs?: unknown }).replayArgs,
              result: (m.content ?? [])
                .map((c) => (c as { text?: string }).text ?? '')
                .join(''),
            };
            const last = chat[chat.length - 1];
            if (last && last.role === 'assistant' && !last.streaming) {
              last.parts = [...last.parts, toolPart];
            } else {
              chat.push({ id: nid(), role: 'assistant', parts: [toolPart], streaming: false });
            }
            continue;
          }
          const isError = m.stopReason === 'error';
          const errorText = isError ? (m.errorMessage ?? '请求失败') : undefined;
          let parts = contentToParts(m);
          if (parts.length === 0 && errorText) {
            parts = [{ kind: 'text', text: `⚠️ **模型请求失败**\n\n${errorText}` }];
          }
          chat.push({
            id: nid(),
            role: m.role,
            parts,
            streaming: false,
            usage: m.usage ? { totalTokens: m.usage.totalTokens, duration: m.duration } : undefined,
            error: errorText,
            // 历史回放：用户消息若带 steering 标记（omp 由 steer 产生），渲染为"改写方向"
            steered: m.role === 'user' ? Boolean((m as { steering?: boolean }).steering) : undefined,
          });
        }
        const st = get();
        const sessionsMap = { ...st.sessionsMap, [path]: chat };
        if (path === (st.currentSessionPath ?? '')) {
          set({ sessionsMap, messages: chat });
        } else {
          set({ sessionsMap });
        }
      });
    }).catch((e) =>
      get().pushToast(`读取会话消息失败：${e instanceof Error ? e.message : String(e)}`, 'error'),
    );
  },

  appendUserMessage: (text, opts) => {
    const st = get();
    const path = st.currentSessionPath ?? '';
    const userMsg: ChatMessage = {
      id: `u${Date.now()}_${userSeq++}`,
      role: 'user',
      parts: [{ kind: 'text', text }],
      streaming: false,
      steered: opts?.steered ?? false,
      queued: opts?.queued ?? false,
    };
    const buf = st.sessionsMap[path] ? [...st.sessionsMap[path], userMsg] : [userMsg];
    const sessionsMap = { ...st.sessionsMap, [path]: buf };
    if (path === (st.currentSessionPath ?? '')) {
      set({ sessionsMap, messages: buf });
    } else {
      set({ sessionsMap });
    }
  },

  applyAgentEvent: (frame) => {
    const s = get();
    // 多进程：每帧带 __sessionPath 标记属于哪个会话，直接按此路由到对应缓冲槽。
    // 不再依赖 ompCurrentPath 猜测（那是单进程时代的 hack）。
    const targetPath = (frame.__sessionPath as string | undefined) ?? '';
    if (!targetPath) return; // 无会话标记的帧丢弃（不应发生）
    const isDisplay = targetPath === (s.currentSessionPath ?? '');
    // per-session 流式状态（后台会话独立维护，不污染全局 isStreaming）
    let procStreaming = s.procStateMap[targetPath]?.isStreaming ?? false;
    let procAborting = s.procStateMap[targetPath]?.isAborting ?? false;
    const type = frame.type as string;

    // 惰性复制：仅当真正要修改 buffer 时才复制原数组，避免每个事件都复制。
    let buffer: ChatMessage[] | null = null;
    const getBuf = (): ChatMessage[] =>
      (buffer ??= s.sessionsMap[targetPath] ? [...s.sessionsMap[targetPath]] : []);
    let bufferTouched = false;

    switch (type) {
      case 'agent_start': {
        procStreaming = true;
        // 新一轮任务开始：清空上一轮残留的待办列表（仅当前显示会话）
        if (isDisplay) set({ todoPhases: [] });
        break;
      }
      case 'agent_end': {
        procStreaming = false;
        procAborting = false;
        break;
      }
      case 'message_start': {
        const msg = frame.message as AgentMessage;
        if (!msg) break;
        if (msg.role === 'user') break; // user 消息由本地输入 push
        getBuf().push({ id: nid(), role: msg.role, parts: contentToParts(msg), streaming: true });
        bufferTouched = true;
        break;
      }
      case 'message_update': {
        const msg = frame.message as AgentMessage;
        if (!msg || msg.role !== 'assistant') break;
        const buf = getBuf();
        for (let i = buf.length - 1; i >= 0; i--) {
          const m = buf[i];
          if (m && m.role === 'assistant' && m.streaming) {
            buf[i] = { ...m, parts: contentToParts(msg) };
            bufferTouched = true;
            break;
          }
        }
        break;
      }
      case 'message_end': {
        const msg = frame.message as AgentMessage;
        if (!msg) break;
        const isError = msg.stopReason === 'error';
        const errorText = isError
          ? (msg.errorMessage ?? `请求失败${msg.errorStatus ? ` (${msg.errorStatus})` : ''}`)
          : undefined;
        let parts = contentToParts(msg);
        if (parts.length === 0 && errorText) {
          parts = [{ kind: 'text', text: `⚠️ **模型请求失败**\n\n${errorText}\n\n请检查模型是否可用（右上角切换模型），或查看 .temp/omp-stderr-*.log。` }];
        }
        const buf = getBuf();
        for (let i = buf.length - 1; i >= 0; i--) {
          const m = buf[i];
          if (m && m.role === msg.role && (m.streaming || msg.role === 'user')) {
            buf[i] = {
              ...m,
              parts,
              streaming: false,
              usage: msg.usage ? { totalTokens: msg.usage.totalTokens, duration: msg.duration } : undefined,
              error: errorText,
            };
            bufferTouched = true;
            break;
          }
        }
        break;
      }
      case 'tool_execution_start': {
        const toolCallId = (frame.toolCallId as string) ?? nid();
        const toolName = (frame.toolName as string) ?? (frame.name as string) ?? 'tool';
        const args = frame.args;
        const part = { kind: 'tool', toolCallId, toolName, status: 'running', args } as ToolPart;
        const buf = getBuf();
        let appended = false;
        for (let i = buf.length - 1; i >= 0; i--) {
          const m = buf[i];
          if (m && m.role === 'assistant') {
            buf[i] = { ...m, parts: [...m.parts, part] };
            appended = true;
            break;
          }
        }
        if (!appended) buf.push({ id: nid(), role: 'assistant', parts: [part] });
        bufferTouched = true;
        break;
      }
      case 'tool_execution_update': {
        const toolCallId = frame.toolCallId as string;
        const partial = frame.partialResult;
        const buf = getBuf();
        buffer = updateToolInBuffer(buf, toolCallId, (p) => ({
          ...p,
          partial: typeof partial === 'string' ? (p.partial ?? '') + partial : p.partial,
        }));
        bufferTouched = true;
        break;
      }
      case 'tool_execution_end': {
        const toolCallId = frame.toolCallId as string;
        const isError = Boolean(frame.isError);
        const result = frame.result;
        const buf = getBuf();
        buffer = updateToolInBuffer(buf, toolCallId, (p) => ({
          ...p,
          status: isError ? 'error' : 'done',
          result,
        }));
        bufferTouched = true;
        // omp 把待办建模成 "todo" 工具：当前显示会话时，把结构化结果同步到全局 Todo 面板
        if (isDisplay && (frame.toolName === 'todo' || frame.name === 'todo')) {
          const phases = normalizeTodoPhases(result);
          if (phases) set({ todoPhases: phases });
        }
        break;
      }
      // ---- M4: 压缩 / 重试 / Todo：仅当前显示会话才更新全局 UI 状态（后台会话不污染）----
      case 'auto_compaction_start': {
        if (isDisplay) set({ isCompacting: true, compactionInfo: '压缩上下文中…' });
        return;
      }
      case 'auto_compaction_end': {
        if (isDisplay) set({ isCompacting: false, compactionInfo: '' });
        return;
      }
      case 'auto_retry_start': {
        if (isDisplay) {
          const attempt = (frame.attempt ?? frame.retryCount ?? '?') as number | string;
          const max = (frame.maxAttempts ?? frame.maxRetries ?? '?') as number | string;
          set({ isRetrying: true, retryInfo: `重试中 (${attempt}/${max})…` });
        }
        return;
      }
      case 'auto_retry_end': {
        if (isDisplay) set({ isRetrying: false, retryInfo: '' });
        return;
      }
      case 'todo_reminder': {
        if (isDisplay) {
          const todoPhases = (frame.todoPhases ?? frame.phases) as TodoPhase[] | undefined;
          if (todoPhases) set({ todoPhases });
        }
        return;
      }
      case 'todo_auto_clear': {
        if (isDisplay) set({ todoPhases: [] });
        return;
      }
      default:
        // 未知类型：不复制、不写入，直接返回原引用，避免无谓的 set / 渲染
        return;
    }

    const updates: Partial<AppState> = {
      // 更新该会话的 per-session 进程状态（agent_start/agent_end 会用到）
      procStateMap: {
        ...s.procStateMap,
        [targetPath]: {
          ...(s.procStateMap[targetPath] ?? { status: 'online' as const, isStreaming: false, isAborting: false }),
          status: 'online' as const,
          isStreaming: procStreaming,
          isAborting: procAborting,
        } as ProcState,
      },
    };
    if (bufferTouched) {
      updates.sessionsMap = { ...s.sessionsMap, [targetPath]: buffer! };
      if (isDisplay) updates.messages = buffer!;
    }
    if (isDisplay) {
      // 显示的就是在跑的会话：同步全局 isStreaming/isAborting 供 ChatView/InputBox
      updates.isStreaming = procStreaming;
      updates.isAborting = procAborting;
    }
    set(updates);
  },
}));

function updateToolInBuffer(
  buffer: ChatMessage[],
  toolCallId: string,
  fn: (p: ToolPart) => ToolPart,
): ChatMessage[] {
  return buffer.map((m) => ({
    ...m,
    parts: m.parts.map((p) =>
      p.kind === 'tool' && p.toolCallId === toolCallId ? fn(p) : p,
    ),
  }));
}

/**
 * 从 omp `todo` 工具的 tool_execution_end.result 里提取结构化待办。
 * omp 不吐 todo_reminder 帧（2026-07-26 probe 确认），待办藏在名为 "todo" 的工具里：
 *   result.details = { op, phases: [{ name, tasks: [{ content, status }] }], storage }
 * 归一化成 UI 的 TodoPhase[]（phase<-name, items<-tasks）。无有效数据时返回 null。
 */
function normalizeTodoPhases(result: unknown): TodoPhase[] | null {
  if (!result || typeof result !== 'object') return null;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== 'object') return null;
  const phases = (details as Record<string, unknown>).phases;
  if (!Array.isArray(phases) || phases.length === 0) return null;
  const out: TodoPhase[] = [];
  for (const ph of phases) {
    if (!ph || typeof ph !== 'object') continue;
    const p = ph as Record<string, unknown>;
    const phaseName = typeof p.name === 'string' ? p.name : '';
    const tasks = Array.isArray(p.tasks) ? (p.tasks as unknown[]) : [];
    const items: TodoItem[] = tasks
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((t) => ({
        content: typeof t.content === 'string' ? t.content : String(t.content ?? ''),
        status: typeof t.status === 'string' ? t.status : undefined,
      }));
    out.push({ phase: phaseName, items });
  }
  return out.length ? out : null;
}

/**
 * 把外观配置应用到 :root 上的内联 CSS 变量（最高优先级，覆盖样式表里的主题 token）。
 * 设置页每次改动都会调用；App 启动时也调用一次以恢复上次配置。
 *  - mode：system=移除 data-mode（跟随系统媒体查询）；light/dark=设置 data-mode 属性。
 *  - fontFamily / fontSize / bgColor / accentColor：留空则清除对应变量，回退主题默认。
 */
/**
 * 把选中的主题预设注入到 <head> 的一个专用 <style> 里（覆盖 styles.css 默认 token）。
 * 未选主题（空 id）时移除该 style，回退到 styles.css 内置的默认 Apple 蓝主题。
 * 只注入当前选中的一份，切换主题即整体替换，避免多份堆积。
 */
function applyThemePreset(themeId?: string): void {
  if (typeof document === 'undefined') return;
  const STYLE_ID = 'omp-theme-preset';
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  const preset = themeId ? getThemePreset(themeId) : undefined;
  if (!preset) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = buildThemeCSS(preset);
}

export function applyAppearance(a?: AppearanceConfig | null): void {
  const root = document.documentElement;
  if (!root) return;

  // 主题预设：注入选中主题的 CSS 变量（覆盖 styles.css 默认 token），并设 data-theme
  applyThemePreset(a?.theme);
  if (a?.theme) root.setAttribute('data-theme', a.theme);
  else root.removeAttribute('data-theme');

  if (a?.mode && a.mode !== 'system') root.setAttribute('data-mode', a.mode);
  else root.removeAttribute('data-mode');

  if (a?.fontFamily) root.style.setProperty('--app-font-family', a.fontFamily);
  else root.style.removeProperty('--app-font-family');

  if (a?.fontSize && a.fontSize > 0) {
    root.style.setProperty('--app-font-size', `${a.fontSize}px`);
    root.style.setProperty('--msg-font-size', `${a.fontSize}px`);
  } else {
    root.style.removeProperty('--app-font-size');
    root.style.removeProperty('--msg-font-size');
  }

  if (a?.bgColor) {
    root.style.setProperty('--app-bg', a.bgColor);
    root.style.setProperty('--bg', a.bgColor);
  } else {
    root.style.removeProperty('--app-bg');
    root.style.removeProperty('--bg');
  }

  if (a?.accentColor) {
    root.style.setProperty('--accent', a.accentColor);
    root.style.setProperty('--accent-brand', a.accentColor);
    root.style.setProperty('--accent-main-000', a.accentColor);
    root.style.setProperty('--accent-main-100', a.accentColor);
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-brand');
    root.style.removeProperty('--accent-main-000');
    root.style.removeProperty('--accent-main-100');
  }
}

/**
 * 把用户导入的自定义 CSS 列表同步到 styles.css 源文件。
 * - embed：主进程把源文件内容写入 styles.css 尾部；
 * - link：主进程在 styles.css 顶部插入 @import url("file://...")；
 * - 禁用/不存在的条目会被移除。
 * 启动时调用一次，确保旧数据（或外部改动）与 styles.css 保持一致。
 */
export async function syncCustomCss(list?: CustomCssConfig[] | null): Promise<void> {
  if (typeof window === 'undefined' || !window.omp?.syncCustomCss) return;
  try {
    const r = await window.omp.syncCustomCss(list ?? []);
    if (r?.error) {
      console.error('[syncCustomCss]', r.error);
    }
  } catch (e) {
    console.error('[syncCustomCss]', e);
  }
}
