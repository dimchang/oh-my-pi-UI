/**
 * ipc-channels.ts — 渲染进程 ↔ 主进程 IPC 通道名与载荷类型
 */

import type { OmpFrame, RpcCommand, AgentMessage, ReplayMessage } from './rpc-types';

export const IPC = {
  // renderer → main (invoke/handle)
  RpcSend: 'rpc:send',              // (sessionPath: string, cmd: RpcCommand) => Promise<RpcResponse> — 路由到该会话的进程
  OmpAcquire: 'omp:acquire',        // (sessionPath: string, cwd: string, approvalMode?: ApprovalMode) => Promise<void> — 懒拉起该会话的进程（带 -c 续接）
  OmpNewSession: 'omp:new-session',  // (cwd: string, approvalMode?: ApprovalMode) => Promise<{ sessionPath: string }> — 新建会话（spawn 不带 -c），返回新 sessionPath
  OmpRelease: 'omp:release',        // (sessionPath: string) => Promise<void> — 主动淘汰该会话的进程
  OmpRenameKey: 'omp:rename-key',    // (oldKey: string, newKey: string) => Promise<void> — 新进程落盘后把临时 key 换成真实 sessionPath
  SessionList: 'session:list', // (cwd?: string) => Promise<SessionSummary[]>
  SessionDelete: 'session:delete', // (path: string) => Promise<void>
  SessionMessages: 'session:messages', // (path: string) => Promise<AgentMessage[]>
  SessionUserEntries: 'session:user-entries', // (path: string) => Promise<{id:string;text:string}[]> — 分叉用，取 user entry id + 文本
  GetOmpInfo: 'omp:info', // () => Promise<{path:string; version:string}>
  OpenExternal: 'shell:open-external', // (url: string) => Promise<void>
  ClipboardWriteText: 'clipboard:write-text', // (text: string) => Promise<void> — 写系统剪贴板
  ShowItemInFolder: 'shell:show-item-in-folder', // (fullPath: string) => Promise<void> — 在文件管理器中定位文件
  ShowSaveDialog: 'dialog:save', // (defaultPath?: string) => Promise<string | null>
  ListFiles: 'fs:list-files', // (dirPath: string) => Promise<FileEntry[]>
  RendererReady: 'renderer:ready', // () => void — 渲染进程就绪（多进程下不再直接起 omp，仅通知）

  // M5: 工作空间（按目录归类管理会话）
  WorkspacesGet: 'workspaces:get', // () => Promise<WorkspacesFile>
  WorkspacesSave: 'workspaces:save', // (file: WorkspacesFile) => Promise<void>
  DialogOpenDir: 'dialog:open-dir', // (defaultPath?: string) => Promise<string | null>

  // 模型配置：读写 omp 原生配置文件 ~/.omp/agent/models.yml
  OmpModelsRead: 'omp:models-read', // () => Promise<OmpModelsConfig>
  OmpModelsWriteProvider: 'omp:models-write-provider', // (id: string, cfg: OmpProviderConfig) => Promise<void>
  OmpModelsDeleteProvider: 'omp:models-delete-provider', // (id: string) => Promise<void>

  // 自定义标题栏窗口控制（Windows frameless 模式）
  WindowMinimize: 'window:minimize', // () => Promise<void>
  WindowMaximize: 'window:maximize', // () => Promise<void>
  WindowClose: 'window:close', // () => Promise<void>
  WindowIsMaximized: 'window:is-maximized', // () => Promise<boolean>
  WindowMaximizedChange: 'window:maximized-change', // (isMaximized: boolean)

  // 自定义标题栏菜单动作（需要主进程配合的项）
  MenuReload: 'menu:reload', // () => Promise<void>
  MenuForceReload: 'menu:force-reload', // () => Promise<void>
  MenuToggleDevTools: 'menu:toggle-devtools', // () => Promise<void>
  MenuResetZoom: 'menu:reset-zoom', // () => Promise<void>
  MenuZoomIn: 'menu:zoom-in', // () => Promise<void>
  MenuZoomOut: 'menu:zoom-out', // () => Promise<void>
  MenuToggleFullscreen: 'menu:toggle-fullscreen', // () => Promise<void>
  MenuShowAbout: 'menu:show-about', // () => Promise<void>

  // main → renderer (webContents.send)
  RpcEvent: 'rpc:event', // (frame: OmpFrame & { __sessionPath: string }) — 帧带会话标记，renderer 按此路由
  RpcReady: 'rpc:ready', // (sessionPath: string) — 某会话的进程 ready
  OmpExit: 'omp:exit', // ({ sessionPath: string; code: number | null }) — 某会话进程退出
  OmpStderr: 'omp:stderr', // ({ sessionPath: string; line: string })
  OmpNotFound: 'omp:not-found', // (message: string) — omp 未找到时通知渲染进程
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** 文件树条目 */
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtime: number;
}

/** 侧栏会话条目（扫盘只读首行得到） */
export interface SessionSummary {
  /** .jsonl 文件绝对路径，用于 switch_session */
  path: string;
  id: string;
  cwd: string;
  title: string;
  /** 文件 mtime（ms） */
  mtime: number;
}

/** omp 权限模式（对应启动参数 `--approval-mode`，spawn 时生效）。
 *  - yolo：所有工具调用自动批准，不弹窗（信任任务时用）。
 *  - write：读/写工具自动执行，仅执行类（bash/浏览器/ssh/task）弹窗确认（默认）。
 *  - always-ask：每次工具调用都弹窗确认。 */
export type ApprovalMode = 'yolo' | 'write' | 'always-ask';

/** 工作空间 = 一个目录 + 自定义显示名（用户可重命名） */
export interface Workspace {
  /** 稳定 id（用 cwd 派生，保证同名目录同一 id） */
  id: string;
  /** 目录绝对路径 */
  cwd: string;
  /** 自定义显示名（默认 = basename(cwd)，可被用户改名） */
  displayName: string;
  /** 列表里是否折叠 */
  collapsed: boolean;
  /** 创建时间（ms） */
  createdAt: number;
  /** 该工作空间使用的 omp 权限模式（不填则默认 'write'）。切换工作空间时随之生效。 */
  approvalMode?: ApprovalMode;
}

/** 持久化到 userData/workspaces.json 的完整文件结构 */
export interface WorkspacesFile {
  /** 版本号，便于未来迁移 */
  version: 1;
  /** 工作空间列表（顺序即侧栏显示顺序） */
  workspaces: Workspace[];
  /** 当前选中的工作空间 id（用于状态栏显示 + 默认 newSession 的目标） */
  currentId: string | null;
  /** 已归档（收起到底部折叠区）的工作空间。可恢复回任务区，或彻底删除（删磁盘 JSONL）。 */
  archived?: Workspace[];
  /** 用户主动彻底删除过的 cwd 列表（小写形式）。
   *  启动自动补全工作空间时跳过这些路径，避免删了又自动复活。 */
  removedCwds?: string[];
  /** 用户上次选中的模型（omp 进程重启后会回到默认模型，启动时按此恢复）。
   *  存的是用户选择本身（provider+id），避免与 omp 内部 default 混淆。 */
  lastModel?: { provider: string; id: string; name?: string };
  /** 模型启用白名单（key = `${provider}/${modelId}`）。
   *  undefined 或空数组 = 未配置过 → ModelPicker 显示全部模型；
   *  非空 = 只显示白名单里的模型（当前正在用的模型始终显示，避免"选中的被藏"）。 */
  enabledModels?: string[];
}

// ---- 模型配置：omp 原生 ~/.omp/agent/models.yml ----

/** models.yml 里 provider 下单个模型的定义（自定义 provider 手填模型时用，字段与 omp ModelDefinition 对齐，只保留 GUI 需要的） */
export interface OmpModelDefinition {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  [k: string]: unknown;
}

/** models.yml 的 providers.<id> 结构（对齐 omp 17.x models-config-schema，GUI 只读写关心的字段，未知字段透传保留） */
export interface OmpProviderConfig {
  /** 显示名 */
  name?: string;
  baseUrl?: string;
  /** api 协议类型，如 openai-completions / anthropic-messages / openrouter … */
  api?: string;
  /** 明文 API Key（omp 官方支持的存储方式，启动时读入内存） */
  apiKey?: string;
  /** 鉴权方式：apiKey（默认）/ none / oauth */
  auth?: 'apiKey' | 'none' | 'oauth';
  /** 自动发现模型：openai-models-list = GET {baseUrl}/models */
  discovery?: { type: string; [k: string]: unknown };
  /** 手动声明的模型列表（可选，与 discovery 二选一或并存） */
  models?: OmpModelDefinition[];
  [k: string]: unknown;
}

/** models.yml 顶层结构 */
export interface OmpModelsConfig {
  providers?: Record<string, OmpProviderConfig>;
  [k: string]: unknown;
}

/** preload 暴露给 window.omp 的 API 形状 */
export interface OmpApi {
  /** 运行平台，用于 renderer 判断是否需要绘制自定义标题栏等 */
  platform: 'win32' | 'darwin' | 'linux' | string;
  send(sessionPath: string, cmd: RpcCommand): Promise<unknown>;
  /** 懒拉起某会话的进程（带 -c 续接历史）。已在线则 no-op。 */
  acquire(sessionPath: string, cwd: string, approvalMode?: ApprovalMode): Promise<void>;
  /** 新建会话：spawn 不带 -c，返回新 sessionPath（主进程 listSessions 解析最新）。 */
  newSessionForCwd(cwd: string, approvalMode?: ApprovalMode): Promise<{ sessionPath: string }>;
  /** 主动淘汰某会话的进程（释放资源，会话历史保留在磁盘）。 */
  release(sessionPath: string): Promise<void>;
  /** 新进程落盘后把临时 key 换成真实 sessionPath（listSessions 解析出的）。 */
  renameKey(oldKey: string, newKey: string): Promise<void>;
  listSessions(cwd?: string): Promise<SessionSummary[]>;
  deleteSession(path: string): Promise<void>;
  /** 从磁盘读 session JSONL 消息历史（切换看历史不中断当前生成时用，绕过 omp current 限制） */
  readSessionMessages(path: string): Promise<ReplayMessage[]>;
  /** 读 session JSONL 中所有 user 消息的 entry id + 文本（分叉用） */
  getSessionUserEntries(path: string): Promise<{ id: string; text: string }[]>;
  getOmpInfo(): Promise<{ path: string; version: string }>;
  openExternal(url: string): Promise<void>;
  /** 写系统剪贴板（用 electron clipboard，规避 renderer navigator.clipboard 的安全上下文限制） */
  copyText(text: string): Promise<void>;
  /** 在系统文件管理器中定位并高亮指定文件（Windows 资源管理器 / macOS Finder） */
  showItemInFolder(fullPath: string): Promise<void>;
  showSaveDialog(defaultPath?: string): Promise<string | null>;
  listFiles(dirPath: string): Promise<FileEntry[]>;
  /** 帧订阅：每帧带 __sessionPath 标记属于哪个会话（renderer 按此路由到对应缓冲） */
  onEvent(cb: (frame: OmpFrame & { __sessionPath?: string }) => void): () => void;
  /** 某会话进程 ready */
  onReady(cb: (sessionPath: string) => void): () => void;
  /** 某会话进程退出（含 LRU 淘汰、崩溃） */
  onExit(cb: (payload: { sessionPath: string; code: number | null }) => void): () => void;
  /** 某会话进程的 stderr 行 */
  onStderr(cb: (payload: { sessionPath: string; line: string }) => void): () => void;
  onNotFound(cb: (message: string) => void): () => void;
  /** 通知主进程 renderer 就绪（多进程下不再直接起 omp，仅标记可响应 acquire） */
  notifyReady(initialCwd?: string): Promise<void>;

  // M5: 工作空间
  getWorkspaces(): Promise<WorkspacesFile>;
  saveWorkspaces(file: WorkspacesFile): Promise<void>;
  openDirDialog(defaultPath?: string): Promise<string | null>;

  // 模型配置：读写 omp 原生 ~/.omp/agent/models.yml
  readModelsConfig(): Promise<OmpModelsConfig>;
  writeOmpProvider(id: string, cfg: OmpProviderConfig): Promise<void>;
  deleteOmpProvider(id: string): Promise<void>;

  // 自定义标题栏窗口控制（Windows frameless 模式）
  minimizeWindow(): Promise<void>;
  maximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximizedChange(cb: (isMaximized: boolean) => void): () => void;

  // 自定义标题栏菜单动作
  menuReload(): Promise<void>;
  menuForceReload(): Promise<void>;
  menuToggleDevTools(): Promise<void>;
  menuResetZoom(): Promise<void>;
  menuZoomIn(): Promise<void>;
  menuZoomOut(): Promise<void>;
  menuToggleFullscreen(): Promise<void>;
  menuShowAbout(): Promise<void>;
}
