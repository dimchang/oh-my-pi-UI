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
import type { SessionSummary, Workspace, WorkspacesFile, ApprovalMode, AppearanceConfig, HookFileConfig, CustomCssConfig, AutomationTask } from '../shared/ipc-channels';
import type { SkillInfo } from '../shared/ipc-channels';
import { ompStat } from './diagnostics';
import { cwdKey, pathsEqual, modelKey } from './utils/path-key';
import { buildThemeCSS, getThemePreset } from './themes';
import { extractDiff, extractChangeSummary } from './components/DiffView';

export type PartKind = 'text' | 'thinking' | 'tool';

export interface ToolPart {
  kind: 'tool';
  toolCallId: string;
  toolName: string;
  status: 'running' | 'done' | 'error';
  args?: unknown;
  result?: unknown;
  /** 流式输出文本（omp 的 partialResult.content[] 里 type=text 的累积拼合）。 */
  partial?: string;
  /** omp 对该次工具调用的一句话意图（tool_execution_start.intent），语言不固定。
   *  task/hub/bash 都带；回答"在等什么"的直接信号。 */
  intent?: string;
}

/** 子智能体（omp `task` 工具派生的 agent 作业）在 UI 侧的状态快照。
 *  数据源：tool_execution_update|task 的 partialResult.details.progress[]（运行中，约 150ms 一帧）、
 *  async-result 消息的 details.jobs[] + content 内 <task-result> 标签（终态）。
 *  实测 progress 项有两套字段组合，resolvedModel/contextTokens/contextWindow 可能缺失 → 全部可选。 */
export interface SubagentJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  agent?: string;
  agentSource?: string;
  assignment?: string;
  /** 派发这批子智能体时的意图（取自所属 tool_execution_start.intent）。 */
  intent?: string;
  /** 首次在 UI 见到的时间（omp 的 durationMs 只在终态才有值，运行中恒为 0）。 */
  startedAt: number;
  durationMs?: number;
  resolvedModel?: string;
  modelRole?: string;
  toolCount?: number;
  tokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  errorText?: string;
  /** 由 args.tasks[].name 猜出的占位条目。omp 会给撞名的 job 自动改名（实测 `CrossName-2`），
   *  故占位 id 未必是真 id —— 真实帧一到就转正，若真 id 是它的 `-N` 变体则淘汰。 */
  provisional?: boolean;
}

export interface TextPart {
  kind: 'text';
  text: string;
  /** 过程说明（中间叙述）：该文本块在 content[] 里排在首个 toolCall 之前。
   *  实测 1554 条 assistant 消息：371 条"文本在工具前"（均为中间叙述）、0 条"文本在工具后"、
   *  19 条"纯文本无工具"（最终回答）。故以 content[] 源顺序判定，渲染时默认折叠。
   *  判定必须在解析源顺序时完成 —— mergeContentAndTools 会把全部 text 移到 tool 卡之后，
   *  渲染顺序已丢失原始位置（详见 ChatView 折叠渲染）。 */
  narration?: boolean;
}
export interface ThinkingPart { kind: 'thinking'; text: string; }

export type MessagePart = TextPart | ThinkingPart | ToolPart;

/** 已附加到对话的文件（发送时把绝对路径拼进 prompt，让 agent 用文件读取工具按需读取）。
 *  区分于普通文本：附件只持有路径引用，UI 以芯片展示，agent 真正读取由 omp 工具完成。 */
export interface Attachment {
  /** 文件绝对路径 */
  path: string;
  /** 文件名（basename） */
  name: string;
  /** 字节大小（可选，仅用于展示） */
  size?: number;
  /** 附件类型：image 走缩略图预览，file 走文件芯片。可选——渲染侧以 isImageFile(name) 为准，kind 仅作可选加速。 */
  kind?: 'file' | 'image';
}

/** 按扩展名判定文件是否为图片（用于附件缩略图分支）。覆盖常见位图与 svg。
 *  注意：gif/svg 虽为图片也按此判定，缩略图统一走 readImageAsDataUrl（不依赖浏览器原生 <img> file://）。 */
export function isImageFile(name: string): boolean {
  const e = (name || '').toLowerCase().split('.').pop() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(e);
}

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
  /** 墙钟时间（epoch ms）：user=本地发送时刻；assistant=omp 该次模型请求的开始时刻
   *  （JSONL 实测 timestamp 字段，历史回放可重建）。回合「开始→结束·总用时」时间线据此计算。 */
  timestamp?: number;
  parts: MessagePart[];
  streaming?: boolean;
  /** 用量：totalTokens 是**该次请求的上下文总量**（input+cacheRead+output，不可跨请求累加）；
   *  outputTokens/reasoningTokens 是本次生成量（可跨请求求和，回合摘要行用）；duration 为该请求耗时。 */
  usage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    duration?: number;
  };
  /** stopReason==='error' 时的错误信息（模型 404/限流等） */
  error?: string;
  /** true=该用户消息来自 steer（引导），UI 用 distinct 样式 + 标记渲染 */
  steered?: boolean;
  /** true=该用户消息来自 follow_up（排队），UI 用 distinct 样式 + 标记渲染 */
  queued?: boolean;
  /** 随消息附带的文件（历史消息中点击可在系统应用/文件管理器打开） */
  attachments?: Attachment[];
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
  /** 流式看门狗：该会话最近一次收到 omp 帧的时间（ms epoch）。
   *  背景（实证 session 01a02a7c）：omp 工具执行无超时，eval 挂死 9h38m 期间不发任何帧，
   *  isStreaming 永远 true、UI 永远"生成中"。看门狗据此判定疑似卡死。 */
  lastFrameAt?: number;
  /** 流式看门狗：判定卡死的起始时间（=触发时距最后帧已超阈值的时刻标记）。
   *  任意新帧到达即清除（applyAgentEvent 统一写 undefined）；仅提示，不自动中断。 */
  stuckSince?: number;
}

interface AppState {
  ready: boolean;
  ompExited: number | null | false;
  isStreaming: boolean;
  /** 用户已点停止、正在等 omp 响应 abort（防止重复点击） */
  isAborting: boolean;
  /** 正在新建会话（spawn 在途）。InputBox 据此冻结输入——2026-09-14 修复 P0-2 双保险：
   *  即使指针切换存在遗漏的时序分支，也不会在新建期间把消息投给旧会话。 */
  creatingSession: boolean;
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
  /** 已安装技能（技能页网格）：来自主进程扫描（含已停用项），enabled 反映 config.yml */
  skills: SkillInfo[];
  sessions: SessionSummary[];
  /** 会话显示名覆盖层（host 侧，不依赖 omp 写盘）：sessionPath -> 用户自定义名。
   *  持久化到 workspaces.json，UI 优先用覆盖名显示；与"项目重命名"同思路（覆盖层，不改 JSONL 本身）。 */
  sessionNames: Record<string, string>;
  currentSessionPath?: string;
  uiQueue: UiRequest[]; // extension_ui_request 待应答队列（单队列顺序展示）
  /** per-session 工具级"始终允许"缓存：key = `${sessionPath}::${toolName.toLowerCase()}`，命中即自动放行。
   *  仅 confirm 类请求生效；值恒为 true（拒绝不缓存，避免误伤）。见 handleUiRequest 自动放行逻辑。 */
  permAllow: Record<string, boolean>;
  stderrTail: string[];

  // M4: 增强状态
  todoPhases: TodoPhase[];
  /** 右栏"子智能体"面板数据：omp `task` 工具派生的后台 agent 作业。
   *  只收 task 型（不含 bash 型后台 job）；由 tool_execution_update / async-result 累积，
   *  单调合并（终态不被运行态覆盖）。切会话或新建会话时清空。 */
  subagents: SubagentJob[];
  /** subagents 最后一次被 omp 帧刷新的时间（Date.now()）。主 agent 空闲时 omp 不再推子智能体
   *  进度，面板据此提示数据滞后，避免"运行中"数字被误读。 */
  subagentsAt: number;
  isCompacting: boolean;
  isRetrying: boolean;
  retryInfo: string;
  /** `isRetrying` 归属的会话 path（null = 没有进行中的重试气泡）。见 RETRY_WORK_FRAME_TYPES 注释。 */
  retrySessionPath: string | null;
  /** 最近一次 `auto_retry_start` 的时间戳（兜底过期判定用，0=无）。 */
  retryStartedAt: number;
  compactionInfo: string;
  sessionStats?: { totalTokens?: number; totalCost?: number; messageCount?: number };
  /** 右栏 Diff 面板内容：从 tool_execution_end 结果中提取的 unified diff 列表。 */
  diffs: Array<{ toolName: string; diff: string }>;
  /** 右栏标签：off|files|diff|todo|jobs */
  rightPanel: 'off' | 'files' | 'todo' | 'diff' | 'jobs';
  /** 主工作区视图：chat=对话，skills=技能/插件面板，automation=定时任务面板 */
  mainView: 'chat' | 'skills' | 'automation';
  setMainView(v: 'chat' | 'skills' | 'automation'): void;

  // ---- 定时任务（automations）----
  /** 任务列表（主进程 automations.json 的 tasks，触发/扣账后由事件刷新） */
  automations: AutomationTask[];
  setAutomations(tasks: AutomationTask[]): void;

  // ---- 配置页 ----
  /** 配置页是否打开（全屏 overlay） */
  settingsOpen: boolean;
  /** 配置页左侧当前选中标签 */
  settingsTab: 'system' | 'agent' | 'context' | 'model';
  setSettingsOpen(v: boolean): void;
  setSettingsTab(tab: 'system' | 'agent' | 'context' | 'model'): void;
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
  /** 乐观插入临时会话占位（__new_ 开头）：新会话首条消息 agent_end 才落盘 .jsonl，
   *  在此之前先在侧栏显示占位条目，避免"等 LLM 回复完才出现"。 */
  upsertSessionPlaceholder(path: string, cwd: string): void;
  setSkills(list: SkillInfo[]): void;
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
  /** 全局兜底模型：新会话（lastModelMap 无记录）进程拉起时按此恢复。
   *  会话自身的选择以 lastModelMap 为准（会话间隔离）。 */
  lastModel?: { provider: string; id: string; name?: string };
  /** 各会话用户最后选中的模型（key = sessionPath）。会话间互相隔离，
   *  B 会话切模型不影响 A 会话。持久化到 workspaces.json。 */
  lastModelMap: Record<string, { provider: string; id: string; name?: string }>;
  /** 侧栏状态点「有结果未查看」：后台会话 agent_end 时打标，选中查看后清除。
   *  运行时态，不持久化（重启后从干净状态开始）。 */
  unreadSessions: Record<string, boolean>;
  /** 侧栏状态点「出错」：后台会话 message_end 带 stopReason==='error' 时记录错误文本。
   *  运行时态，不持久化；选中查看后清除。 */
  sessionErrors: Record<string, string>;
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
  /** 记录某会话用户选的 model：写 lastModelMap[sessionPath]（会话隔离）+ 全局 lastModel 兜底，
   *  同时触发持久化。sessionPath 必须显式传入（调用点持有快照，禁内部重读指针）。 */
  setLastModelForSession(sessionPath: string, m: { provider: string; id: string; name?: string }): void;
  /** tempKey→realPath 迁移时同步迁移该会话的模型记录（同 sessionNames 的迁移语义）。 */
  migrateLastModelKey(from: string, to: string): void;
  /** 删除会话时清理其模型记录，防 workspaces.json 无限膨胀。 */
  removeLastModelKey(sessionPath: string): void;
  /** 清除某会话的侧栏状态点标记（选中查看 / 删除会话时调用）。 */
  clearSessionStatus(sessionPath: string): void;
  /** tempKey→realPath 迁移时同步迁移侧栏状态点标记（同 migrateLastModelKey 语义）。 */
  migrateSessionStatus(from: string, to: string): void;
  /** 新增/更新工作空间。**不改变当前选中** —— 「发现/更新一个工作区」与「聚焦它」是两件事
   *  （2026-09-12 幽灵工作区事故：reconcile 自动补全会走到这里，隐式切换会劫持用户的当前焦点）。
   *  需要聚焦请显式调 setCurrentWorkspaceId（用户主动入口 onAddWorkspace 已补）。 */
  upsertWorkspace(ws: Workspace): void;
  /** 归档：从任务区移到归档区（保留 cwd/displayName） */
  archiveWorkspace(id: string): void;
  /** 恢复：从归档区移回任务区 */
  restoreWorkspace(id: string): void;
  /** 彻底删除归档项：从归档区移除，并记录 cwd 到 removedCwds（防自动补全复活） */
  deleteArchivedWorkspace(id: string): void;
  renameWorkspace(id: string, displayName: string): void;
  /** 会话重命名（host 侧覆盖层，不依赖 omp 写盘）：写入 sessionNames 并持久化。 */
  renameSession(path: string, name: string): void;
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
  /** 追加用户消息气泡。sessionPath 显式传入（2026-09-14 修复：内部重读 currentSessionPath
   *  会与 onSend 持有的快照失配——两次 await 之间指针切换会让气泡与 prompt 进不同会话）。 */
  appendUserMessage(text: string, opts?: { steered?: boolean; queued?: boolean; attachments?: Attachment[] }, sessionPath?: string): void;
  resetChat(): void;
  // 进程池状态
  /** 部分更新某会话的进程状态（合并写入） */
  setProcState(sessionPath: string, partial: Partial<ProcState>): void;
  /** 确保某会话的 omp 进程在线：已在线直接返回 true；否则按需懒拉起（静默失败返回 false）。
   *  用于"仅浏览历史不拉起进程"后，需要进程能力（输入/模型列表/思考档位等）时再拉起。 */
  ensureOnline(sessionPath: string): Promise<boolean>;

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


/** AgentMessage.usage → UI usage。原始 Usage 里 totalTokens 是「上下文总量」（逐请求重复计数），
 *  output/reasoningTokens 才是可累加的生成量 —— 回合摘要按后者求和（见 utils/turn-view.ts）。 */
function toUsage(msg: AgentMessage): ChatMessage['usage'] {
  const u = msg.usage;
  if (!u) return undefined;
  return {
    totalTokens: u.totalTokens,
    inputTokens: u.input,
    outputTokens: u.output,
    reasoningTokens: u.reasoningTokens,
    duration: msg.duration,
  };
}

/** 把 omp 的全量 content[] 映射为 UI parts（text/thinking）。
 *  实测 content type 有：text / output_text（assistant 正文）/ thinking / toolCall。
 *  output_text 与 text 同义，toolCall 由 tool_execution_* 事件单独建卡，此处跳过。
 *  相邻 thinking 合并为一个 part，避免渲染出多个"思考过程"折叠块。 */
function contentToParts(msg: AgentMessage): MessagePart[] {
  const content = msg.content ?? [];
  // 该消息是否含 toolCall：含 ⇒ 其中的文本块全是过程说明（中间叙述），渲染时默认折叠。
  // 实测本项目全部会话 1554 条 assistant 消息：371 条"文本 + toolCall"（文本恒在 toolCall 之前）、
  // 0 条"文本在 toolCall 之后"、19 条"纯文本无 toolCall"（=最终回答）。
  // 判定必须在此处（源内容层）完成：mergeContentAndTools 会把全部 text 移到 tool 卡之后，
  // 渲染顺序丢失原始位置；历史回放也只走 contentToParts，不经 merge。
  const hasToolCall = content.some((c) => (c as { type?: string }).type === 'toolCall');
  const parts: MessagePart[] = [];
  for (const c of content) {
    const cc = c as { type?: string; text?: string; thinking?: string };
    const t = cc.type;
    if (t === 'text' || t === 'output_text') {
      if (cc.text) parts.push({ kind: 'text', text: cc.text, narration: hasToolCall || undefined });
    } else if (t === 'thinking') {
      if (cc.thinking) {
        const last = parts[parts.length - 1];
        if (last && last.kind === 'thinking') {
          last.text += '\n' + cc.thinking;
        } else {
          parts.push({ kind: 'thinking', text: cc.thinking });
        }
      }
    }
  }
  return parts;
}

/** 将 content-derived parts 与已存在的 tool parts 合并，保持合理顺序：
 *  thinking 在前 → tool 卡在中 → text/output 在后。避免 message_update 重建 parts 时把 tool 卡弄丢。 */
function mergeContentAndTools(contentParts: MessagePart[], toolParts: ToolPart[]): MessagePart[] {
  if (toolParts.length === 0) return contentParts;
  const thinking: MessagePart[] = [];
  const text: MessagePart[] = [];
  for (const p of contentParts) {
    if (p.kind === 'thinking') thinking.push(p);
    else text.push(p);
  }
  return [...thinking, ...toolParts, ...text];
}


/** 连接状态三色：红=未连接/已退出，绿=就绪，黄=进行中。
 *  输入框权限按钮旁的大号状态胶囊与底部状态栏共用同一份判定，避免两处逻辑漂移。 */
export type ConnTone = 'red' | 'green' | 'yellow';

/** 判定连接状态所需的最小状态切片。 */
export type ConnSnapshot = Pick<
  AppState,
  | 'ready'
  | 'ompExited'
  | 'isStreaming'
  | 'isCompacting'
  | 'isRetrying'
  | 'currentSessionPath'
  | 'procStateMap'
>;

/** 当前会话绑定的 omp 进程状态（无会话/尚未拉起时为 undefined）。 */
export function connProc(s: ConnSnapshot): ProcState | undefined {
  return s.currentSessionPath ? s.procStateMap[s.currentSessionPath] : undefined;
}

/** omp 退出码：number=已退出（0 也是退出，不可用 truthy 判断）、null=未退出。 */
export function connExitCode(s: ConnSnapshot): number | null {
  return typeof s.ompExited === 'number' ? s.ompExited : null;
}

/** 疑似卡死分钟数，0=正常（stuckSince 由 App 定时扫描写入，任意新帧清除）。 */
export function connStuckMinutes(s: ConnSnapshot): number {
  const ps = connProc(s);
  return s.currentSessionPath && ps?.isStreaming && ps.stuckSince
    ? Math.max(1, Math.round((Date.now() - ps.stuckSince) / 60000))
    : 0;
}

/** 连接状态三色（喂给输入框状态胶囊与状态栏圆点）。 */
export function connTone(s: ConnSnapshot): ConnTone {
  const ps = connProc(s);
  if (!s.currentSessionPath) return 'red';
  if (connExitCode(s) !== null) return 'red';
  if (!ps || ps.status === 'offline' || ps.status === 'evicted') return 'red';
  if (ps.status === 'spawning') return 'yellow';
  const busy = s.isStreaming || s.isCompacting || s.isRetrying || connStuckMinutes(s) > 0;
  return s.ready && !busy ? 'green' : 'yellow';
}

/** 状态一句话说明（状态胶囊文字与 title）。 */
export function connDetail(s: ConnSnapshot): string {
  const ps = connProc(s);
  const exit = connExitCode(s);
  if (!s.currentSessionPath) return '未连接（发送时自动连接）';
  if (exit !== null) return `omp 已退出 (${exit})`;
  if (!ps || ps.status === 'offline' || ps.status === 'evicted') return '未连接（输入时自动连接）';
  if (ps.status === 'spawning') return '连接中';
  if (s.isCompacting) return '压缩中';
  if (s.isRetrying) return '重试中';
  const stuck = connStuckMinutes(s);
  if (stuck > 0) return `疑似卡死（${stuck} 分钟无响应）`;
  if (s.isStreaming) return '运行中（生成中）';
  return s.ready ? '就绪' : '连接中';
}

// ---- 侧栏会话状态点（2026-09-16）----
// 橙=运行中（该会话进程正在流式生成）；红=出错或等待用户确认；绿=有结果未查看。
export type SessionDot = 'red' | 'orange' | 'green';

/** 判定状态点所需的最小状态切片。 */
export interface SessionDotSnapshot {
  procStateMap: Record<string, ProcState>;
  unreadSessions: Record<string, boolean>;
  sessionErrors: Record<string, string>;
  uiQueue: UiRequest[];
}

/** 会话状态点标题（侧栏 tooltip）。 */
export const SESSION_DOT_TITLES: Record<SessionDot, string> = {
  red: '出错或等待确认',
  orange: '运行中',
  green: '有新结果未查看',
};

/** 纯函数：给定会话 path 与状态切片，返回应显示的状态点颜色（无则 null）。
 *  优先级：红（出错/待确认）> 橙（运行中）> 绿（未读结果）。
 *  等待确认 = uiQueue 里有 sessionPath 指向该会话的待应答请求（confirm/select/input/editor）。 */
export function sessionDotStatus(sessionPath: string, snap: SessionDotSnapshot): SessionDot | null {
  if (snap.sessionErrors[sessionPath]) return 'red';
  if (snap.uiQueue.some((q) => q.sessionPath === sessionPath)) return 'red';
  if (snap.procStateMap[sessionPath]?.isStreaming) return 'orange';
  if (snap.unreadSessions[sessionPath]) return 'green';
  return null;
}

/** 流式状态对账判定（纯函数，2026-09-16 橙点常亮修复）。
 *  背景：omp 的 agent 循环异常/中止路径（帧收集器 FG.fail）**不补发 agent_end 帧**，
 *  帧流戛然而止 → 渲染层 procStateMap.isStreaming 永久卡 true（实证 session 01a0a638
 *  工作早已完成但侧栏橙点常亮，直到用户点回该会话）。
 *  omp 内部 isStreaming（rpc get_state 返回）是权威真值。当满足：
 *    1) 本侧镜像仍标记 streaming；2) omp 报已结束（isStreaming === false，严格判 false，
 *    undefined 视为未知不动）；3) RPC 往返期间无新帧到达（lastFrameAt <= sentAt——
 *    有新帧说明帧流是权威，可能已 agent_end 或新回合已 agent_start，不覆写）
 *  时，应以 omp 为准重置本侧镜像。 */
export function shouldHealStuckStreaming(
  ps: ProcState | undefined,
  ompIsStreaming: boolean | undefined,
  sentAt: number,
): boolean {
  return !!ps?.isStreaming && ompIsStreaming === false && (ps.lastFrameAt ?? 0) <= sentAt;
}

// ---- 重试气泡终结判定（2026-09-17「重试中 (1/10)… 常亮」修复）----
// 背景：omp 的 `auto_retry_end` **不保证送达** —— 与 agent_end 属同一类契约缺口
// （对照上方 shouldHealStuckStreaming 的取证结论）。grep omp 18.0.4 内嵌源码（bun --compile 产物）实证：
//   成功路径：auto_retry_end 只从 onAssistantSettledSuccessfully 发出，前置两道门
//             `if (!IX(e)) return;`（IX 要求 stopReason 非 error/aborted 且 content 含可见块）
//             和 `if (this.#s === 0) return;`；任一不满足就直接返回，**不补发**。
//   失败路径：多处 `if (this.#s > 1) { emit }` 之后才 `#s = 0` —— 首次重试（#s===1）失败时
//             同样静默归零，**不补发**。
// 实测（session 01a0ab4b-66c0-750d-b8e0-0e3a01775714，omp 18.0.4，用户断网触发）：
//   omp 日志 01:39:36 `agent turn ended with provider error`（socket closed）→ UI 显示
//   「重试中 (1/10)…」→ 01:39:55 起同一回合正常恢复、后续多轮对话全部 stopReason=stop，
//   但结束帧始终没到 → 气泡永久常亮。
//
// 判定原则：**重试只发生在"静默退避等待"期**。因此该会话一旦出现任何「正在干活」的帧，
// 就说明 omp 已经越过退避阶段（成功续跑或被新的 auto_retry_start 重新点亮），重试已终结。
// 刻意排除 message_end / agent_end：失败那一次尝试的收尾帧可能晚于 auto_retry_start 到达，
// 把它们算作"干活"会在正常退避期间误清气泡。
export const RETRY_WORK_FRAME_TYPES: ReadonlySet<string> = new Set([
  'agent_start', // 新回合（含重试续跑）开始
  'message_start', // 新的 assistant 消息开始流式
  'message_update', // 模型正在产出 token
  'tool_execution_start', // 工具开始执行
  'tool_execution_end', // 工具执行结束
]);

/** 兜底过期阈值：连续这么久没收到任何「干活」帧也没收到新的 auto_retry_start，认定结束帧丢失。 */
export const RETRY_STALE_MS = 10 * 60 * 1000;

/** 重试气泡过期判定（纯函数）：超阈值仍未收到终结信号 → 强制清除。
 *  lastStartAt 每次 `auto_retry_start` 刷新，所以正常的多轮退避重试不会被误清。 */
export function shouldClearStaleRetry(
  isRetrying: boolean,
  lastStartAt: number,
  now: number,
): boolean {
  return isRetrying && lastStartAt > 0 && now - lastStartAt >= RETRY_STALE_MS;
}

// ---- 帧诊断环形日志（2026-09-13「回复不显示」排查配套）----
// 每帧记一条：type / sessionPath / isDisplay / 缓冲与显示长度；帧处理抛错时记 err。
// 再次复现「agent 已回复但 UI 不显示」时，DevTools Console 读 window.__ompDiag：
//   - display=false 连片出现 → 帧路由键与 currentSessionPath 失配（08-02 同类 bug）
//   - 有 err → 帧处理抛异常，该帧丢失
//   - buf 前进而 msgs 不变 → 显示数组失步（agent_end 自愈应已兜住，若仍现说明自愈失效）
export interface FrameDiagEntry {
  t: number;
  type: string;
  sp: string;
  display: boolean;
  buf?: number;
  msgs?: number;
  err?: string;
}
const FRAME_DIAG_CAP = 600;
const frameDiag: FrameDiagEntry[] = [];
(globalThis as { __ompDiag?: FrameDiagEntry[] }).__ompDiag = frameDiag;
function pushFrameDiag(e: FrameDiagEntry): void {
  // 帧计数供诊断模块对照 renders 使用（区分「帧太多」与「render 自己空转」）
  ompStat.frames++;
  frameDiag.push(e);
  if (frameDiag.length > FRAME_DIAG_CAP) frameDiag.splice(0, frameDiag.length - FRAME_DIAG_CAP);
}

// issue 10：persistWorkspaces 去抖。多次高频触发时只在静默窗口后写一次，
// 且 flush 时读取最新 store 状态，避免用旧数据覆盖新数据。
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  ompExited: false,
  isStreaming: false,
  isAborting: false,
  creatingSession: false,
  messages: [],
  sessionsMap: {},
  procStateMap: {},
  toasts: [],
  slashCommands: [],
  skills: [],
  sessions: [],
  sessionNames: {},
  uiQueue: [],
  permAllow: {},
  stderrTail: [],
  todoPhases: [],
  subagents: [],
  subagentsAt: 0,
  isCompacting: false,
  isRetrying: false,
  retryInfo: '',
  retrySessionPath: null,
  retryStartedAt: 0,
  compactionInfo: '',
  rightPanel: 'off',
  diffs: [],
  mainView: 'chat',
  automations: [],
  settingsOpen: false,
  settingsTab: 'model',
  enabledModels: undefined,
  systemPrompt: undefined,
  appearance: undefined,
  inputBehavior: 'guide',

  setReady: (v) => set({ ready: v }),
  setMainView: (v) => set({ mainView: v }),
  setAutomations: (tasks) => set({ automations: tasks }),
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
      // 必须用真实的全部模型 key 初始化、再剔除本次取消的 key（只禁用那一个），
      // 否则若 allKeys 为空会把白名单初始化成 [] → 所有模型被禁用且 UI 上像"全消失"（issue #4）。
      // 当 allKeys 为空（如模型尚在加载、调用方未传入）时跳过本次操作，保持"显示全部"，避免误伤。
      if (!allKeys || allKeys.length === 0) return;
      next = allKeys.filter((k) => k !== key);
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
  setOmpExited: (code) =>
    set((s) => {
      // code === null 表示 omp 已上线/恢复，仅清全局流式标志，不动 per-session 状态
      if (code === null) {
        return { ompExited: null, isStreaming: false, isAborting: false };
      }
      // issue 20: omp 进程已退出，所有会话绑定的进程一并失效。重置 per-session procState，
      // 避免 acquireSession 误判某会话仍在线而复用已退出的进程。
      const procStateMap: Record<string, ProcState> = {};
      for (const [k, v] of Object.entries(s.procStateMap)) {
        procStateMap[k] = { ...v, status: 'offline', isStreaming: false, isAborting: false };
      }
      return { ompExited: code, isStreaming: false, isAborting: false, procStateMap };
    }),
  setStreaming: (v) => set({ isStreaming: v }),
  setAborting: (v) => set({ isAborting: v }),
  setState: (partial) => set(partial),
  pushStderr: (line) =>
    set((s) => ({ stderrTail: [...s.stderrTail.slice(-199), line] })),

  setSessions: (list) =>
    set((s) => {
      // 保留尚未落盘的临时会话占位（__new_ 开头）：占位在首条消息提交时插入，而 omp 要到
      // 该回合的 .jsonl 落盘后才会被扫盘扫到，期间若直接覆盖会让刚出现在侧栏的条目闪一下
      // 消失。占位在 migrateTempSession 时由真实 path 替换 / 移除（见 App.tsx）。
      const placeholders = s.sessions.filter(
        (x) => x.path.startsWith('__new_') && !list.some((y) => y.path === x.path),
      );
      if (placeholders.length === 0) return { sessions: list };
      return { sessions: [...list, ...placeholders] };
    }),
  upsertSessionPlaceholder: (path, cwd) =>
    set((s) => {
      if (!path.startsWith('__new_')) return {};
      // 已存在占位（如重入）则不重复插入
      if (s.sessions.some((x) => x.path === path)) return {};
      const placeholder: SessionSummary = {
        path,
        id: path,
        cwd,
        // 2026-09-17 起本方法只在「首条消息提交」时被调用（App.tsx autoNameTempSession），
        // 调用方保证 sessionNames[path] 已经写好名字；兜底值也不再是「新会话」——
        // 侧栏不允许出现任何形式的临时标题。
        title: s.sessionNames[path] ?? '（未命名会话）',
        mtime: Date.now(),
        cwdExists: true, // 占位会话的 cwd 刚由用户选定/当前工作区给出，必然有效
      };
      return { sessions: [...s.sessions, placeholder] };
    }),
  setSkills: (list) => set({ skills: list }),
  setCurrentSessionPath: (p) => {
    // 选中即视为「已查看」：清掉该会话的侧栏未读/错误标记（绿/红点）
    const cleared: Partial<AppState> = {};
    if (p) {
      const s = get();
      if (s.unreadSessions[p] || s.sessionErrors[p]) {
        const unreadSessions = { ...s.unreadSessions };
        const sessionErrors = { ...s.sessionErrors };
        delete unreadSessions[p];
        delete sessionErrors[p];
        cleared.unreadSessions = unreadSessions;
        cleared.sessionErrors = sessionErrors;
      }
    }
    set({
      currentSessionPath: p,
      todoPhases: [],
      diffs: [],
      subagents: [],
      subagentsAt: 0,
      // 重试气泡是「切走前那个会话」的临时进度提示：切会话即清。
      // 否则 omp 漏发结束帧时会串到新会话上常亮（气泡归属只对当前显示会话记录，
      // 回到原会话时若重试仍在进行，omp 每轮退避都会重发 start 帧，气泡会自然恢复）。
      isRetrying: false,
      retryInfo: '',
      retrySessionPath: null,
      retryStartedAt: 0,
      ...cleared,
    });
  },

  // M5: 工作空间
  workspaces: [],
  archived: [],
  currentWorkspaceId: null,
  workspacesLoaded: false,
  removedCwds: [],
  lastModel: undefined,
  lastModelMap: {},
  unreadSessions: {},
  sessionErrors: {},
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
      lastModelMap: file.lastModelMap ?? {},
      enabledModels: migratedEnabledModels,
      systemPrompt: file.systemPrompt,
      appearance: migratedAppearance,
      hooks: file.hooks,
      inputBehavior: file.inputBehavior ?? 'guide',
      sessionNames: file.sessionNames ?? {},
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

  setLastModelForSession: (sessionPath, m) => {
    set((s) => ({ lastModel: m, lastModelMap: { ...s.lastModelMap, [sessionPath]: m } }));
    // 写回磁盘
    get().persistWorkspaces();
  },

  migrateLastModelKey: (from, to) => {
    const s = get();
    const m = s.lastModelMap[from];
    if (!m) return;
    const next = { ...s.lastModelMap };
    delete next[from];
    if (!next[to]) next[to] = m;
    set({ lastModelMap: next });
    get().persistWorkspaces();
  },

  removeLastModelKey: (sessionPath) => {
    const s = get();
    if (!s.lastModelMap[sessionPath]) return;
    const next = { ...s.lastModelMap };
    delete next[sessionPath];
    set({ lastModelMap: next });
    get().persistWorkspaces();
  },

  clearSessionStatus: (sessionPath) =>
    set((s) => {
      if (!s.unreadSessions[sessionPath] && !s.sessionErrors[sessionPath]) return s;
      const unreadSessions = { ...s.unreadSessions };
      const sessionErrors = { ...s.sessionErrors };
      delete unreadSessions[sessionPath];
      delete sessionErrors[sessionPath];
      return { unreadSessions, sessionErrors };
    }),

  migrateSessionStatus: (from, to) =>
    set((s) => {
      const unread = s.unreadSessions[from];
      const err = s.sessionErrors[from];
      if (unread === undefined && err === undefined) return s;
      const unreadSessions = { ...s.unreadSessions };
      const sessionErrors = { ...s.sessionErrors };
      delete unreadSessions[from];
      delete sessionErrors[from];
      if (unread) unreadSessions[to] = true;
      if (err) sessionErrors[to] = err;
      return { unreadSessions, sessionErrors };
    }),

  upsertWorkspace: (ws) =>
    set((s) => {
      const idx = s.workspaces.findIndex((w) => w.id === ws.id);
      const next = idx >= 0
        ? s.workspaces.map((w, i) => (i === idx ? { ...w, ...ws } : w))
        : [...s.workspaces, ws];
      // 不再隐式改 currentWorkspaceId —— 「发现/更新一个工作区」与「聚焦它」是两件事。
      // 需要聚焦的入口（onAddWorkspace）已显式调 setCurrentWorkspaceId。
      return { workspaces: next };
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

  renameSession: (path, name) => {
    set((s) => ({ sessionNames: { ...s.sessionNames, [path]: name } }));
    // 持久化到 workspaces.json（迁移 __new_ 临时 key 时 store 也会同步 key）
    get().persistWorkspaces();
  },

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
    // issue 10：并发/高频写入去抖。多次触发时仅在静默 120ms 后写一次，
    // 且 flush 时读取最新 store 状态构建 file，避免用旧数据覆盖新数据。
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      // 测试环境（node）无 window：防抖定时器可能在测试文件结束后才触发，
      // 此时 rpc-client 的 window.omp 不存在，静默跳过持久化（避免 unhandled rejection）
      if (typeof window === 'undefined') return;
      const s = get();
      const file: WorkspacesFile = {
        version: 1,
        workspaces: s.workspaces,
        currentId: s.currentWorkspaceId,
        archived: s.archived,
        removedCwds: s.removedCwds,
        lastModel: s.lastModel,
        lastModelMap: s.lastModelMap,
        enabledModels: s.enabledModels,
        systemPrompt: s.systemPrompt,
        appearance: s.appearance,
        hooks: s.hooks,
        inputBehavior: s.inputBehavior,
        sessionNames: s.sessionNames,
      };
      // 动态 import 避免循环依赖（rpc-client 也 import store）
      void import('./rpc-client').then(({ rpc }) => {
        void rpc.saveWorkspaces(file).catch((e) =>
          get().pushToast(`保存工作空间配置失败：${e instanceof Error ? e.message : String(e)}`, 'error'),
        );
      });
    }, 120);
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
    // 没有当前会话时不创建 key='' 的幽灵条目（issue 12）
    if (!path) return;
    const sessionsMap = { ...st.sessionsMap, [path]: [] };
    const procStateMap = {
      ...st.procStateMap,
      [path]: { status: 'online' as const, isStreaming: false, isAborting: false },
    };
    set({ sessionsMap, procStateMap, messages: [], isStreaming: false, isAborting: false, subagents: [], subagentsAt: 0 });
  },

  ensureOnline: async (sessionPath) => {
    const s = get();
    if (!sessionPath) return false;
    const ps = s.procStateMap[sessionPath];
    if (ps?.status === 'online') return true;
    // temp 会话进程离线（被杀/淘汰/退出）时绝不直接 acquire：
    // tempKey 在磁盘上不存在，acquire 会全新 spawn 出第二个 .jsonl
    // （实证 2026-09-14 bet_zp：输入框聚焦 ensureOnline(tempKey) 裂出 01a0a048）。
    // 留给 onSend 的 resolveSessionKey 先迁移到落盘 realPath 再 acquire。
    if (sessionPath.startsWith('__new_')) return false;
    const session = s.sessions.find((x) => x.path === sessionPath);
    const ws = session && s.workspaces.find((w) => cwdKey(w.cwd) === cwdKey(session.cwd));
    const cwd = ws?.cwd ?? session?.cwd;
    if (!cwd) return false;
    const mode = ws?.approvalMode ?? 'write';
    try {
      await window.omp.acquire(sessionPath, cwd, mode);
      return true;
    } catch {
      return false;
    }
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
    // 竞态守卫（2026-09-13「回复不显示」排查配套）：记下读盘起始时刻的帧活跃时间。
    // 读盘期间若该会话有新帧落地，磁盘快照必然过时（omp 在 agent_end 才 flush JSONL），
    // 此时用快照覆盖 buffer 会把已流式显示的内容回滚/抹掉。配合下方 buffer 非空检查：
    //   - buffer 已有内容（实时流已写入）且读盘期间有新帧 / 仍在流式 → 放弃覆盖，buffer 为准
    //   - buffer 为空（首览/冷启动）→ 照常落盘快照（否则无历史可显示）
    const readStartFrameAt = get().procStateMap[path]?.lastFrameAt ?? 0;
    void import('./rpc-client').then(({ rpc }) => {
      return rpc.readSessionMessages(path).then((msgs) => {
        if (epoch !== loadEpoch) return; // 已被更新的加载取代，丢弃旧结果
        const stNow = get();
        const psNow = stNow.procStateMap[path];
        const existing = stNow.sessionsMap[path];
        const framesArrivedDuringRead = (psNow?.lastFrameAt ?? 0) > readStartFrameAt || Boolean(psNow?.isStreaming);
        if (existing && existing.length > 0 && framesArrivedDuringRead) {
          pushFrameDiag({ t: Date.now(), type: 'loadSessionMessages.skipStale', sp: path, display: path === stNow.currentSessionPath, buf: existing.length });
          return; // 快照已过时：实时 buffer 更新，覆盖会丢 in-flight 消息
        }
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
            usage: toUsage(m),
            error: errorText,
            timestamp: m.timestamp,
            // 历史回放标记重建（2026-07-27 probe-followup.mjs v3 实测确认）：
            //   - steer（引导）：omp 在 JSONL 内层 message 持久化 "steering":true → 可重建 steered。
            //   - follow_up（排队）：omp 在 JSONL 上**不打任何标记**（message 与普通 prompt 逐字节相同），
            //     故 queued 无法仅从磁盘重建；重载后排队消息会渲染成普通"你"消息（仅丢小标签，内容无损）。
            //     这是 omp 的落盘限制，非本映射遗漏——有意不映射 queued（详见 MEMORY.md 关键约束 #4）。
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

  appendUserMessage: (text, opts, sessionPath) => {
    const st = get();
    // 优先用调用方显式传入的 sessionPath（onSend/onGuide/onQueue 的快照）；
    // 未传时才退回 currentSessionPath（兼容旧调用点）。
    const path = sessionPath ?? st.currentSessionPath ?? '';
    const userMsg: ChatMessage = {
      id: `u${Date.now()}_${userSeq++}`,
      role: 'user',
      timestamp: Date.now(),
      parts: [{ kind: 'text', text }],
      streaming: false,
      steered: opts?.steered ?? false,
      queued: opts?.queued ?? false,
      attachments: opts?.attachments ?? [],
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
    // 流式看门狗：任何经此分发的帧都算"进程活跃"信号（高频帧如 message_update 足以覆盖正常生成期）
    const now = Date.now();    // 多进程：每帧带 __sessionPath 标记属于哪个会话，直接按此路由到对应缓冲槽。
    // 不再依赖 ompCurrentPath 猜测（那是单进程时代的 hack）。
    const rawTargetPath = (frame.__sessionPath as string | undefined) ?? '';
    if (!rawTargetPath) return; // 无会话标记的帧丢弃（不应发生）
    // sessionsMap 的 key 始终用原始格式（与 loadSessionMessages/appendUserMessage 一致），
    // 仅在 isDisplay 比较时归一化（__sessionPath 可能含 \ 而 currentSessionPath 含 /）。
    const isDisplay = pathsEqual(rawTargetPath, s.currentSessionPath ?? '');
    // 该帧是否属于"正在显示重试气泡的那个会话"（重试终结信号按会话判定，避免串台）
    const retryOwned = !!s.retrySessionPath && pathsEqual(s.retrySessionPath, rawTargetPath);
    // 兜底：重试气泡超期未收到任何终结信号（omp 结束帧丢失）→ 强制清除，防止永久常亮
    if (shouldClearStaleRetry(s.isRetrying, s.retryStartedAt, now)) {
      set({ isRetrying: false, retryInfo: '', retrySessionPath: null, retryStartedAt: 0 });
      pushFrameDiag({ t: now, type: 'retry-stale-cleared', sp: s.retrySessionPath ?? '', display: false });
    }
    // per-session 流式状态（后台会话独立维护，不污染全局 isStreaming）
    let procStreaming = s.procStateMap[rawTargetPath]?.isStreaming ?? false;
    let procAborting = s.procStateMap[rawTargetPath]?.isAborting ?? false;
    const type = frame.type as string;

    // 惰性复制：仅当真正要修改 buffer 时才复制原数组，避免每个事件都复制。
    let buffer: ChatMessage[] | null = null;
    const getBuf = (): ChatMessage[] =>
      (buffer ??= s.sessionsMap[rawTargetPath] ? [...s.sessionsMap[rawTargetPath]] : []);
    let bufferTouched = false;
    // 侧栏状态点（2026-09-16）：后台会话回合结束 → 绿点「有结果未查看」；
    // 后台会话模型请求失败 → 红点「出错」（错误文本存 sessionErrors）。
    // 当前正在显示的会话不打标（用户正看着，无需提醒）。
    let markUnread = false;
    let markErrorText: string | undefined;

    try {
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
        // 后台会话回合完成 → 未读绿点；当前显示会话不标（用户正在看）
        if (!isDisplay) markUnread = true;
        break;
      }
      case 'message_start': {
        const msg = frame.message as AgentMessage;
        if (!msg) break;
        if (msg.role === 'user') break; // user 消息由本地输入 push
        if (msg.role === 'toolResult') break; // 工具输出由 tool_execution_* 建折叠 ToolCard，这里跳过避免整段文本刷屏
        // omp 的系统通知（async-result 等）以 role='custom' 落地：不进气泡，
        // 只把后台 task job 的终态同步到子智能体面板（message_end 同样跳过）
        if (msg.role === 'custom') {
          if (isDisplay && msg.customType === 'async-result') {
            const merged = syncSubagentsFromAsyncResult(msg, get().subagents);
            if (merged) set({ subagents: merged, subagentsAt: now });
          }
          break;
        }
        getBuf().push({ id: nid(), role: msg.role, parts: contentToParts(msg), streaming: true, timestamp: msg.timestamp ?? now });
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
            const toolParts = m.parts.filter((p): p is ToolPart => p.kind === 'tool');
            buf[i] = { ...m, parts: mergeContentAndTools(contentToParts(msg), toolParts) };
            bufferTouched = true;
            break;
          }
        }
        break;
      }
      case 'message_end': {
        const msg = frame.message as AgentMessage;
        if (!msg || msg.role === 'toolResult' || msg.role === 'custom') break; // 同上：系统通知/工具输出都不落文本消息
        const isError = msg.stopReason === 'error';
        const errorText = isError
          ? (msg.errorMessage ?? `请求失败${msg.errorStatus ? ` (${msg.errorStatus})` : ''}`)
          : undefined;
        // 后台会话模型请求失败 → 红点标记（错误文本入 sessionErrors）；当前显示会话不打标
        if (errorText && !isDisplay) markErrorText = errorText;
        const buf = getBuf();
        let matched = false;
        for (let i = buf.length - 1; i >= 0; i--) {
          const m = buf[i];
          if (m && m.role === msg.role && (m.streaming || msg.role === 'user')) {
            const toolParts = m.parts.filter((p): p is ToolPart => p.kind === 'tool');
            let parts = mergeContentAndTools(contentToParts(msg), toolParts);
            if (parts.length === 0 && errorText) {
              parts = [{ kind: 'text', text: `⚠️ **模型请求失败**\n\n${errorText}\n\n请检查模型是否可用（右上角切换模型），或查看 .temp/omp-stderr-*.log。` }];
            }
            buf[i] = {
              ...m,
              parts,
              streaming: false,
              usage: toUsage(msg),
              error: errorText,
              timestamp: m.timestamp ?? msg.timestamp ?? now,
            };
            matched = true;
            bufferTouched = true;
            break;
          }
        }
        // 兜底（2026-09-13）：正常流中 assistant 消息必有 message_start 建卡（streaming=true）。
        // 若 message_start 丢失/被跳过，这里原本会静默丢弃整条回复（最终回答直接消失）。
        // 改为按 finalized 消息直接追加 —— 宁可罕见场景多一条消息，也不丢最终回答。
        // 只对 assistant 兜底：user 消息由本地输入先建，omp 的回显帧再追加会重复。
        if (!matched && msg.role === 'assistant') {
          const parts = mergeContentAndTools(contentToParts(msg), []);
          if (parts.length > 0 || errorText) {
            buf.push({
              id: nid(),
              role: msg.role,
              parts: parts.length > 0
                ? parts
                : [{ kind: 'text', text: `⚠️ **模型请求失败**\n\n${errorText}` }],
              streaming: false,
              usage: toUsage(msg),
              error: errorText,
              timestamp: msg.timestamp ?? now,
            });
            bufferTouched = true;
          }
        }
        break;
      }
      case 'tool_execution_start': {
        const toolCallId = (frame.toolCallId as string) ?? nid();
        const toolName = (frame.toolName as string) ?? (frame.name as string) ?? 'tool';
        const args = frame.args;
        const intent = asStr(frame.intent);
        const part = { kind: 'tool', toolCallId, toolName, status: 'running', args, intent } as ToolPart;
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
        // 新一批 task 派发：用 agent 指定的 name 预建条目（含 intent），让面板在首个 progress
        // 帧之前就有内容。只补空缺、绝不改既有条目 —— omp 的 job id 全局唯一且永不重用
        // （实测重派同名 job 会被改名为 `X-2`），故撞名即意味这里的 name 是错的，
        // 真正的条目稍后由 progress 帧带来；覆盖只会毁掉既有条目的 startedAt/intent。
        if (isDisplay && toolName === 'task') {
          const known = new Set(get().subagents.map((j) => j.id));
          const fresh = primeSubagentsFromTaskArgs(args, intent).filter((j) => !known.has(j.id));
          if (fresh.length) set({ subagents: [...get().subagents, ...fresh], subagentsAt: now });
        }
        break;
      }
      case 'tool_execution_update': {
        const toolCallId = frame.toolCallId as string;
        const toolName = (frame.toolName as string) ?? (frame.name as string) ?? 'tool';
        const partialResult = frame.partialResult;
        const buf = getBuf();
        buffer = updateToolInBuffer(buf, toolCallId, (p) => ({
          ...p,
          // partialResult 实测恒为 object（文本在 content[] 里），旧代码按 string 拼接 → partial 恒为空
          partial: partialTextOf(partialResult) || p.partial,
        }));
        bufferTouched = true;
        // 子智能体进度：task 推 details.progress[]，hub 推 details.jobs[]（后者带真实 status）
        if (isDisplay) {
          const incoming = toolName === 'task'
            ? subagentsFromProgress(partialResult)
            : toolName === 'hub' ? subagentsFromJobs(asObj(partialResult)?.details) : [];
          if (incoming.length) set({ subagents: mergeSubagents(get().subagents, incoming), subagentsAt: now });
        }
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
        // 提取 diff 到右栏面板（仅当前显示会话）
        if (isDisplay && !isError) {
          const toolName = (frame.toolName as string) ?? (frame.name as string) ?? 'tool';
          let diffText = extractDiff(result);
          // 兜底：Write 等工具的 result 不是 unified diff 格式时，
          // 从 result + args 生成变更摘要（至少显示"改了哪个文件"）
          if (!diffText) {
            // 从 buffer 中找该工具的 args（tool_execution_start 时存入）
            const toolPart = buf.flatMap((m) => m.parts).find(
              (p) => p.kind === 'tool' && p.toolCallId === toolCallId,
            ) as ToolPart | undefined;
            diffText = extractChangeSummary(result, toolName, toolPart?.args);
          }
          if (diffText) {
            const curDiffs = get().diffs;
            set({ diffs: [...curDiffs.slice(-19), { toolName, diff: diffText }] });
          }
        }
        // omp 把待办建模成 "todo" 工具：当前显示会话时，把结构化结果同步到全局 Todo 面板
        if (isDisplay && (frame.toolName === 'todo' || frame.name === 'todo')) {
          const phases = normalizeTodoPhases(result);
          if (phases) set({ todoPhases: phases });
        }
        // 子智能体终态：只采信 hub 的 result.details.jobs[]（带 status/durationMs/resolvedModel）。
        // task 自身的 end 帧是派发瞬间的启动快照（progress 全 pending、results 为空）→ 必须忽略。
        if (isDisplay && (frame.toolName === 'hub' || frame.name === 'hub')) {
          const jobs = subagentsFromJobs(asObj(result)?.details);
          if (jobs.length) set({ subagents: mergeSubagents(get().subagents, jobs), subagentsAt: now });
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
          set({
            isRetrying: true,
            retryInfo: `重试中 (${attempt}/${max})…`,
            retrySessionPath: rawTargetPath,
            retryStartedAt: now,
          });
        }
        return;
      }
      case 'auto_retry_end': {
        // 只终结归属自己的那一份（多会话并发时不会误清别人的气泡）
        if (!s.retrySessionPath || pathsEqual(s.retrySessionPath, rawTargetPath)) {
          set({ isRetrying: false, retryInfo: '', retrySessionPath: null, retryStartedAt: 0 });
        }
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
        [rawTargetPath]: {
          ...(s.procStateMap[rawTargetPath] ?? { status: 'online' as const, isStreaming: false, isAborting: false }),
          status: 'online' as const,
          isStreaming: procStreaming,
          isAborting: procAborting,
          // 看门狗：刷新活跃时间；有新帧即解除卡死标记（恢复活跃 = 警报自动消除）
          lastFrameAt: now,
          stuckSince: undefined,
        } as ProcState,
      },
    };
    if (markUnread) {
      updates.unreadSessions = { ...s.unreadSessions, [rawTargetPath]: true };
    }
    if (markErrorText) {
      updates.sessionErrors = { ...s.sessionErrors, [rawTargetPath]: markErrorText };
    }
    // 重试气泡终结：该会话出现了「正在干活」的帧 → omp 已越过退避重试阶段（见 RETRY_WORK_FRAME_TYPES）。
    // 这是 auto_retry_end 丢失时的主要兜底，保证气泡不会跨回合常亮。
    if (retryOwned && RETRY_WORK_FRAME_TYPES.has(type)) {
      updates.isRetrying = false;
      updates.retryInfo = '';
      updates.retrySessionPath = null;
      updates.retryStartedAt = 0;
    }
    if (bufferTouched) {
      updates.sessionsMap = { ...s.sessionsMap, [rawTargetPath]: buffer! };
      if (isDisplay) updates.messages = buffer!;
    }
    if (isDisplay) {
      // 显示的就是在跑的会话：同步全局 isStreaming/isAborting 供 ChatView/InputBox
      updates.isStreaming = procStreaming;
      updates.isAborting = procAborting;
    }
    // 自愈（2026-09-13「agent 已回复但 UI 不显示」bug）：回合终点强制把显示数组对齐到会话缓冲。
    // 无论中间哪个环节（路由失配 / 异步读盘覆盖 / 丢失更新）导致 messages 落后于 sessionsMap，
    // agent_end 时 omp 已 flush JSONL、buffer 必含完整回合 —— 以 buffer 为准同步显示，
    // 用户不再需要"再发一条消息才能看到上一条回复"。
    if (type === 'agent_end' && isDisplay) {
      const finalBuf = updates.sessionsMap?.[rawTargetPath] ?? s.sessionsMap[rawTargetPath];
      if (finalBuf) updates.messages = finalBuf;
    }
    set(updates);
    pushFrameDiag({
      t: now,
      type,
      sp: rawTargetPath,
      display: isDisplay,
      buf: (updates.sessionsMap?.[rawTargetPath] ?? s.sessionsMap[rawTargetPath])?.length,
      msgs: isDisplay ? get().messages.length : undefined,
    });
    } catch (err) {
      // 帧处理抛异常：记入诊断日志（该帧丢失可见化），不中断后续帧处理。
      pushFrameDiag({
        t: now,
        type,
        sp: rawTargetPath,
        display: isDisplay,
        err: err instanceof Error ? err.message : String(err),
      });
      console.error('[omp-frame-error]', type, err);
    }
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

// ---- 子智能体（omp `task` 工具派生的 agent 作业）归一化 ----
// 三个数据源形状各异，全部逐字段 typeof 守卫（strict + noUncheckedIndexedAccess）：
//  1) tool_execution_update|task 的 partialResult.details.progress[]：约 150ms 一帧，运行中主力
//  2) hub 的 details.jobs[]（update / end 都有）：带真实 status/durationMs
//  3) async-result（custom 消息）的 details.jobs[]（键名是 jobId）+ content 里的 <task-result status>
// 注：task 自己的 tool_execution_end 在派发瞬间就到达，progress 全是启动快照，终态不能从那里取。

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** omp 的 partialResult 恒为 object（实测 150/150 帧），进度文本在 content[] 里。
 *  content 是**累积**语义（非增量）→ 调用方直接整体替换，不要字符串拼接。 */
function partialTextOf(partialResult: unknown): string {
  const content = asObj(partialResult)?.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content) {
    const cc = asObj(c);
    if (cc && cc.type === 'text') out += asStr(cc.text) ?? '';
  }
  return out;
}

/** omp 的真实状态词表 —— `<task-result status>` 只取 4 值：completed / `failed (exit N)` /
 *  cancelled / merge failed（omp 源码 `#X` 实测），progress 另见 aborted。全部覆盖，
 *  未知值才退 pending（hub 的 jobs 项有实测无 status 的情况）。 */
function subagentStatus(v: unknown): SubagentJob['status'] {
  if (v === 'pending' || v === 'running' || v === 'completed' || v === 'failed' || v === 'cancelled') return v;
  if (v === 'done') return 'completed';
  if (typeof v === 'string') {
    if (/^(failed|error|merge failed)/i.test(v)) return 'failed';
    if (/^(aborted|cancel)/i.test(v)) return 'cancelled';
  }
  return 'pending';
}

/** 状态单调推进用：终态不可被回退（hub 快照可能仍是 running，而本地已知 completed）。 */
const SUBAGENT_RANK: Record<SubagentJob['status'], number> = {
  pending: 0, running: 1, completed: 2, failed: 2, cancelled: 2,
};

/** 归一化单条 job/progress 记录。id 取 `id`（progress/hub）或 `jobId`（async-result）；无 id 的直接丢弃。 */
function toSubagentJob(raw: unknown): SubagentJob | null {
  const o = asObj(raw);
  if (!o) return null;
  const id = asStr(o.id) ?? asStr(o.jobId);
  if (!id) return null;
  return {
    id,
    status: subagentStatus(o.status),
    agent: asStr(o.agent),
    agentSource: asStr(o.agentSource),
    assignment: asStr(o.assignment),
    startedAt: Date.now(),
    durationMs: asNum(o.durationMs),
    resolvedModel: asStr(o.resolvedModel),
    modelRole: asStr(o.modelRole),
    toolCount: asNum(o.toolCount),
    tokens: asNum(o.tokens),
    contextTokens: asNum(o.contextTokens),
    contextWindow: asNum(o.contextWindow),
    errorText: asStr(o.errorText),
  };
}

/** tool_execution_update|task：progress[] 本身就是 task 专用（项里没有 type 字段）。 */
function subagentsFromProgress(partialResult: unknown): SubagentJob[] {
  const progress = asObj(asObj(partialResult)?.details)?.progress;
  if (!Array.isArray(progress)) return [];
  const out: SubagentJob[] = [];
  for (const p of progress) {
    const job = toSubagentJob(p);
    if (job) out.push(job);
  }
  return out;
}

/** hub / async-result 的 details.jobs[]：混有 bash 型后台 job → 必须筛 type==='task'（用户决策：只报子智能体）。 */
function subagentsFromJobs(details: unknown): SubagentJob[] {
  const jobs = asObj(details)?.jobs;
  if (!Array.isArray(jobs)) return [];
  const out: SubagentJob[] = [];
  for (const j of jobs) {
    if (asObj(j)?.type !== 'task') continue;
    const job = toSubagentJob(j);
    if (job) out.push(job);
  }
  return out;
}

/** `task` 工具的 args.tasks[]（{agent,name,task}）→ 预建 pending 条目。
 *  顺带把本次派发的 intent 写进条目（回答用户"在等什么"的直接信号，语言不固定，原样展示）。 */
function primeSubagentsFromTaskArgs(args: unknown, intent?: string): SubagentJob[] {
  const tasks = asObj(args)?.tasks;
  if (!Array.isArray(tasks)) return [];
  const out: SubagentJob[] = [];
  for (const t of tasks) {
    const o = asObj(t);
    const id = asStr(o?.name);
    if (!id) continue;
    out.push({
      id,
      status: 'pending',
      agent: asStr(o?.agent),
      assignment: asStr(o?.task),
      intent,
      startedAt: Date.now(),
      provisional: true,
    });
  }
  return out;
}

/** async-result 的 content 里每个 job 一段 `<task-result id="X" agent="Y" status="Z">`。
 *  jobs[] 项不带 status（实测），真实终态只能从这里取。 */
const TASK_RESULT_RE = /<task-result\s+id="([^"]+)"\s+agent="([^"]*)"\s+status="([^"]*)"/g;

function taskResultStatuses(msg: AgentMessage): Map<string, { agent?: string; raw: string }> {
  const out = new Map<string, { agent?: string; raw: string }>();
  const raw: unknown = msg.content;
  const text = typeof raw === 'string'
    ? raw
    : Array.isArray(raw)
      ? raw.map((c) => asStr(asObj(c)?.text) ?? '').join('\n')
      : '';
  if (!text) return out;
  for (const m of text.matchAll(TASK_RESULT_RE)) {
    const id = m[1];
    if (!id) continue;
    out.set(id, { agent: m[2] || undefined, raw: m[3] ?? '' });
  }
  return out;
}

/** async-result：后台 task job 真正完成时才推的一条 custom 消息（落在下一个 agent_start 之后）。
 *  返回合并后的完整列表；无可用内容时返回 null（调用方据此跳过 set）。 */
function syncSubagentsFromAsyncResult(msg: AgentMessage, prev: SubagentJob[]): SubagentJob[] | null {
  const incoming = subagentsFromJobs(msg.details);
  if (!incoming.length) return null;
  const statuses = taskResultStatuses(msg);
  for (const j of incoming) {
    const st = statuses.get(j.id);
    if (!st) continue;
    j.agent ??= st.agent;
    j.status = subagentStatus(st.raw);
    // 非完成态都留原文："failed (exit 1)" / "cancelled" / "merge failed"，比裸状态有信息量
    if (j.status !== 'completed') j.errorText = st.raw;
  }
  return mergeSubagents(prev, incoming);
}

/** 按 id 合并：状态单调推进（终态不被回退），缺失字段保留旧值，已有条目保留原 startedAt。
 *  入参恒为帧数据（真实 id），据此淘汰被改名的占位条目。 */
function mergeSubagents(prev: SubagentJob[], incoming: SubagentJob[]): SubagentJob[] {
  const byId = new Map(prev.map((j) => [j.id, j]));
  const superseded = new Set<string>();
  for (const inc of incoming) {
    for (const old of prev) {
      if (old.provisional && old.status === 'pending' && inc.id.startsWith(`${old.id}-`)) superseded.add(old.id);
    }
  }
  for (const inc of incoming) {
    const old = byId.get(inc.id);
    if (!old) {
      byId.set(inc.id, inc);
      continue;
    }
    byId.set(inc.id, {
      id: inc.id,
      status: SUBAGENT_RANK[inc.status] >= SUBAGENT_RANK[old.status] ? inc.status : old.status,
      agent: inc.agent ?? old.agent,
      agentSource: inc.agentSource ?? old.agentSource,
      assignment: inc.assignment ?? old.assignment,
      intent: inc.intent ?? old.intent,
      startedAt: old.startedAt,
      durationMs: inc.durationMs || old.durationMs, // 运行中恒为 0，取有值的一侧
      resolvedModel: inc.resolvedModel ?? old.resolvedModel,
      modelRole: inc.modelRole ?? old.modelRole,
      toolCount: inc.toolCount ?? old.toolCount,
      tokens: inc.tokens ?? old.tokens,
      contextTokens: inc.contextTokens ?? old.contextTokens,
      contextWindow: inc.contextWindow ?? old.contextWindow,
      errorText: inc.errorText ?? old.errorText,
      provisional: undefined,
    });
  }
  for (const id of superseded) byId.delete(id);
  return [...byId.values()];
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
