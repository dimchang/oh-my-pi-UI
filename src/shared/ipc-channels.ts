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
  SessionMessages: 'session:messages', // (path: string) => Promise<ReplayMessage[]>
  SessionUserEntries: 'session:user-entries', // (path: string) => Promise<{id:string;text:string}[]> — 分叉用，取 user entry id + 文本
  GetOmpInfo: 'omp:info', // () => Promise<{path:string; version:string}>
  OpenExternal: 'shell:open-external', // (url: string) => Promise<void>
  OpenInBrowser: 'shell:open-in-browser', // (browser: 'chrome'|'edge', url: string) => Promise<void> — 用指定浏览器打开链接（找不到时回退系统默认）
  ClipboardWriteText: 'clipboard:write-text', // (text: string) => Promise<void> — 写系统剪贴板
  ShowItemInFolder: 'shell:show-item-in-folder', // (fullPath: string) => Promise<void> — 在文件管理器中定位文件
  ShowSaveDialog: 'dialog:save', // (defaultPath?: string) => Promise<string | null>
  ListFiles: 'fs:list-files', // (dirPath: string) => Promise<FileEntry[]>
  RendererReady: 'renderer:ready', // () => void — 渲染进程就绪（多进程下不再直接起 omp，仅通知）

  // 技能（Skills）管理：扫描安装目录 + 读写 ~/.omp/agent/config.yml 的 skills.* 配置
  SkillsList: 'skills:list', // () => Promise<SkillInfo[]> — 扫描已安装技能（含已停用），enabled 来自 config.yml skills.ignoredSkills
  SkillsDetail: 'skills:detail', // (name: string) => Promise<SkillDetail> — 读 SKILL.md（front-matter + 正文）用于详情页
  SkillsSetEnabled: 'skills:set-enabled', // (name: string, enabled: boolean) => Promise<SkillInfo[]> — 启停技能（改 config.yml skills.ignoredSkills）
  SkillsUninstall: 'skills:uninstall', // (name: string) => Promise<{ ok: boolean; moved: string[]; error?: string }> — 卸载（移到 skills-trash）

  // M5: 工作空间（按目录归类管理会话）
  WorkspacesGet: 'workspaces:get', // () => Promise<WorkspacesFile>
  WorkspacesSave: 'workspaces:save', // (file: WorkspacesFile) => Promise<void>
  DialogOpenDir: 'dialog:open-dir', // (defaultPath?: string) => Promise<string | null>
  DialogOpenFiles: 'dialog:open-files', // (defaultPath?: string) => Promise<PickedFile[] | null> — 多选文件，返回绝对路径 + 名称 + 大小

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
  MenuStatsClick: 'menu:stats-click', // () => Promise<void> — 渲染进程 → 主进程：标题栏 Help 菜单 Stats 项点击
  MenuStats: 'menu:stats', // (void) — 主进程 → 渲染：触发当前会话发送 /stats

  // main → renderer (webContents.send)
  RpcEvent: 'rpc:event', // (frame: OmpFrame & { __sessionPath: string }) — 帧带会话标记，renderer 按此路由
  RpcReady: 'rpc:ready', // (sessionPath: string) — 某会话的进程 ready
  OmpExit: 'omp:exit', // ({ sessionPath: string; code: number | null }) — 某会话进程退出
  OmpStderr: 'omp:stderr', // ({ sessionPath: string; line: string })
  OmpNotFound: 'omp:not-found', // (message: string) — omp 未找到时通知渲染进程

  // 钩子（Hooks）管理
  OmpPickHookFiles: 'omp:pick-hook-files', // () => Promise<string[] | null> — 选择钩子 .ts 文件（多选）
  OmpParseHookFiles: 'omp:parse-hook-files', // (paths: string[]) => Promise<HookFileInfo[]> — 静态解析钩子文件导出/事件

  // 自定义 CSS 导入
  OmpPickCssFile: 'omp:pick-css-file', // () => Promise<string | null> — 选择 .css 文件（单选）
  OmpReadCssFile: 'omp:read-css-file', // (path: string) => Promise<{ content: string; error?: string }> — 读取 CSS 文件内容
  OmpSyncCustomCss: 'omp:sync-custom-css', // (list: CustomCssConfig[]) => Promise<{ error?: string }> — 同步自定义 CSS 到 styles.css

  // 上下文文件（AGENTS.md / SYSTEM.md / APPEND_SYSTEM.md / RULES.md）读写
  ContextFileRead: 'context:read', // (filePath: string) => Promise<string> — 读取上下文文件（不存在返回空串）
  ContextFileWrite: 'context:write', // (filePath: string, content: string) => Promise<void> — 写入上下文文件（自动创建目录）

  // 图片：粘贴/拖拽落盘 + 读取为 data URL（聊天框贴图功能）
  SavePastedImage: 'image:save-pasted', // (data: ArrayBuffer, ext: string) => Promise<PastedImageResult> — 存剪贴板/拖拽图片到 userData/pasted-images
  ReadImageAsDataUrl: 'image:read-as-dataurl', // (filePath: string) => Promise<ImageDataUrlResult> — 读图片为 data URL（白名单防本地文件泄露）
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** 粘贴/拖拽图片落盘结果（主进程存盘后回传渲染进程，渲染进程按 Attachment 使用） */
export interface PastedImageResult {
  /** 文件绝对路径（userData/pasted-images/...） */
  path: string;
  /** 文件名（basename） */
  name: string;
  /** 字节大小 */
  size: number;
}

/** 读取图片为 data URL 的结果 */
export interface ImageDataUrlResult {
  /** 形如 `data:image/png;base64,....` 的可直接用于 <img src> 的字符串 */
  dataUrl: string;
}

/** 技能条目（技能页卡片用） */
export interface SkillInfo {
  /** 技能名（如 agentmail，不带 skill: 前缀） */
  name: string;
  /** SKILL.md front-matter 里的 description */
  description?: string;
  /** 是否启用（= 不在 config.yml skills.ignoredSkills 里） */
  enabled: boolean;
  /** 技能目录（SKILL.md 所在目录；扫描到才给，用于详情/卸载） */
  path?: string;
  /** 技能来源（agents / claude / codex / custom，可空） */
  source?: string;
}

/** 技能详情（点卡片后展示，对应 SKILL.md 内容） */
export interface SkillDetail {
  name: string;
  description?: string;
  enabled: boolean;
  /** SKILL.md 所在目录（扫描到才给） */
  path?: string;
  /** SKILL.md 正文（去掉 front-matter 后的 Markdown） */
  body?: string;
  /** front-matter 元数据键值（name/description/agent_created 等） */
  metadata?: Record<string, unknown>;
}

/** 文件选择结果（主进程 stat 后回传：绝对路径 + 名称 + 字节数） */
export interface PickedFile {
  /** 文件绝对路径 */
  path: string;
  /** 文件名（basename） */
  name: string;
  /** 字节大小 */
  size: number;
}

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

/** 外观（系统风格）配置：由设置页写入，applyAppearance 注入为 :root 上的 CSS 变量。 */
export interface AppearanceConfig {
  /** 主题预设 id（内置 themes.ts，如 eucalyptus/claude/breeze…；留空=默认 Apple 蓝主题） */
  theme?: string;
  /** 配色模式：system=跟随系统；light=浅色；dark=深色 */
  mode?: 'system' | 'light' | 'dark';
  /** 主字体（CSS font-family 字符串；留空=用主题默认） */
  fontFamily?: string;
  /** 字号（px） */
  fontSize?: number;
  /** 背景颜色（任意 CSS 颜色；留空=用主题默认） */
  bgColor?: string;
  /** 强调色（任意 CSS 颜色；留空=用主题默认） */
  accentColor?: string;
  /** 用户从 .css 文件导入的自定义样式（可多份，按顺序注入到 <head>，覆盖默认主题）。 */
  customCss?: CustomCssConfig[];
}

/** 用户导入的自定义 CSS 配置（持久化到 workspaces.json，并通过 syncCustomCss 写入 styles.css）。
 *  - embed：把源文件内容直接写入 styles.css 尾部；
 *  - link：在 styles.css 顶部插入 @import url("file://...")。
 *  禁用/移除时同步从 styles.css 中删除对应区块。 */
export interface CustomCssConfig {
  /** 唯一标识（用于在 styles.css 中标记区块） */
  id: string;
  /** 源文件绝对路径 */
  path: string;
  /** 导入方式：embed=内容写入 styles.css；link=styles.css 通过 @import 链接该文件 */
  mode: 'embed' | 'link';
  /** 是否启用（关闭时 styles.css 中不会保留该区块） */
  enabled: boolean;
  /** 展示名（一般是文件名 basename） */
  name?: string;
  /** @deprecated 旧版 embed 模式将内容保存在配置里；新版已迁移到 styles.css，此字段保留仅为兼容旧数据。 */
  content?: string;
}

/** 钩子文件解析结果（主进程静态解析后回传渲染进程）。
 *  omp 钩子 = 一个 .ts 文件，含 `export default function (pi: HookAPI) { pi.on(...) }`。
 *  也支持多单元：文件用多个具名导出（export function hookA / export const hookB = ...）。 */
export interface HookFileInfo {
  /** 文件绝对路径 */
  path: string;
  /** 是否有默认导出（omp 钩子入口）。有 → 整文件是一个钩子（fileLevel）。 */
  hasDefault: boolean;
  /** 具名导出的函数/常量名（可能是多个钩子） */
  namedHooks: string[];
  /** 文件里 pi.on("event", ...) 订阅的事件名（仅展示用） */
  events: string[];
  /** 读取/解析失败时的错误信息 */
  error?: string;
}

/** 钩子单元：UI 展示 + 启用开关的最小单位 */
export interface HookUnit {
  /** fileLevel=true 时 = 文件名；否则 = 具名导出名 */
  name: string;
  /** true=整文件默认导出（一个钩子，开关=是否加载该文件）；false=具名导出（多单元之一） */
  fileLevel: boolean;
  /** pi.on 事件名（展示用；多单元文件无法细分到具体单元） */
  events?: string[];
}

/** 一个钩子文件的配置（持久化到 workspaces.json） */
export interface HookFileConfig {
  /** 文件绝对路径 */
  path: string;
  /** 是否启用（master 开关） */
  enabled: boolean;
  /** 解析出的钩子单元（导入时由主进程解析结果填充，存盘保留便于直接渲染） */
  units: HookUnit[];
  /** 多单元文件：被启用的单元名列表（fileLevel 文件忽略）。省略=全部启用。 */
  enabledUnits?: string[];
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
  /** 系统提示词：新建会话时通过 --append-system-prompt 注入到 omp 进程。
   *  仅作用于"新开"的会话（acquireNew），续接/恢复的历史会话不重新注入。 */
  systemPrompt?: string;
  /** 外观（系统风格）配置：配色模式 / 字体 / 字号 / 背景色 / 强调色。 */
  appearance?: AppearanceConfig;
  /** 钩子（Hooks）配置：导入的 .ts 钩子文件列表，含每个文件的启用状态与单元开关。
   *  启动时按启用集合向 omp 进程追加 --hook=<path>（多单元文件会生成过滤后的包装文件）。 */
  hooks?: HookFileConfig[];
  /** 输入框 Enter 默认行为（v0.3.6 简化）：
   *   - 'guide'（默认）Enter = 引导（steer mid-run）：当前 tool 完成后立即按新方向继续，跳过剩余 tool 队列
   *   - 'queue'           Enter = 排队（follow_up）：等当前 agent turn 跑完再处理，不打断当前 tool/t
   *  Shift+Enter 自动取反。undefined 走 'guide' 兜底。
   *  历史遗留：v0.3.5 之前是 \`steerDefault: 'restart' | 'steer'\`（含 abort+prompt 真中断），
   *  v0.3.6 移除\"立即中断\"入口并重命名为本字段，老字段被忽略。 */
  inputBehavior?: 'queue' | 'guide';
  /** 会话显示名覆盖层：sessionPath -> 用户自定义名（host 侧，不依赖 omp 写盘）。
   *  与"项目重命名"同思路——只覆盖 UI 展示，不修改磁盘 JSONL。 */
  sessionNames?: Record<string, string>;
}

// ---- 模型配置：omp 原生 ~/.omp/agent/models.yml ----

/** models.yml 里 provider 下单个模型的定义（自定义 provider 手填模型时用，字段与 omp ModelDefinition 对齐，只保留 GUI 需要的） */
export interface OmpModelDefinition {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  // issue 90: 用显式 extra 字段收集未知字段，替代过度宽松的 [k:string]:unknown 索引签名
  // （索引签名会让所有属性访问退化为 unknown 且无法捕获 typo）
  extra?: Record<string, unknown>;
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
  // issue 90: 未知字段收进显式 extra，替代宽松索引签名（写回时展开）
  extra?: Record<string, unknown>;
}

/** models.yml 顶层结构 */
export interface OmpModelsConfig {
  providers?: Record<string, OmpProviderConfig>;
  // issue 16: 移除宽松索引签名 [k: string]: unknown，改为显式键；
  // 顶层未知键不再被任意访问，类型检查能捕获拼写错误。
}

/** preload 暴露给 window.omp 的 API 形状 */
export interface OmpApi {
  /** 运行平台，用于 renderer 判断是否需要绘制自定义标题栏等 */
  platform: 'win32' | 'darwin' | 'linux' | string;
  // issue 18: 泛型化返回类型，调用方可声明期望的响应类型（如 send<MyData>(...)），
  // 不再强制 any/unknown 断言；preload 实现返回 Promise<any> 可安全赋给 Promise<T>。
  send<T = unknown>(sessionPath: string, cmd: RpcCommand): Promise<T>;
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
  /** 用指定外部浏览器打开链接（chrome / edge）；该浏览器找不到时回退系统默认浏览器 */
  openInBrowser(browser: 'chrome' | 'edge', url: string): Promise<void>;
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
  /** 通知主进程 renderer 就绪（issue 85：handler 为无参 no-op，不再接收 initialCwd 死参） */
  notifyReady(): Promise<void>;

  // M5: 工作空间
  getWorkspaces(): Promise<WorkspacesFile>;
  saveWorkspaces(file: WorkspacesFile): Promise<void>;
  openDirDialog(defaultPath?: string): Promise<string | null>;
  /** 弹出文件选择框（多选），返回选中文件的绝对路径 + 名称 + 大小；取消返回 null */
  pickFiles(defaultPath?: string): Promise<PickedFile[] | null>;

  // 模型配置：读写 omp 原生 ~/.omp/agent/models.yml
  readModelsConfig(): Promise<OmpModelsConfig>;
  writeOmpProvider(id: string, cfg: OmpProviderConfig): Promise<void>;
  deleteOmpProvider(id: string): Promise<void>;

  // 技能（Skills）管理
  skillsList(): Promise<SkillInfo[]>;
  skillsDetail(name: string): Promise<SkillDetail>;
  skillsSetEnabled(name: string, enabled: boolean): Promise<SkillInfo[]>;
  skillsUninstall(name: string): Promise<{ ok: boolean; moved: string[]; error?: string }>;

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
  /** 标题栏 Help 菜单 "Stats" 项点击 → 主进程转发为 MenuStats 事件 */
  menuStats(): Promise<void>;
  /** 订阅 Help 菜单 "Stats" 项点击（主进程 → 渲染），触发后渲染进程向当前会话发送 /stats */
  onMenuStats(cb: () => void): () => void;

  // 钩子（Hooks）管理
  pickHookFiles(): Promise<string[] | null>;
  parseHookFiles(paths: string[]): Promise<HookFileInfo[]>;

  // 自定义 CSS 导入
  /** 弹出文件选择框选一个 .css 文件，返回绝对路径（取消返回 null） */
  pickCssFile(): Promise<string | null>;
  /** 读取指定 CSS 文件内容 */
  readCssFile(path: string): Promise<{ content: string; error?: string }>;
  /** 把当前自定义 CSS 列表同步到 styles.css（embed=写入内容；link=顶部 @import；禁用项移除） */
  syncCustomCss(list: CustomCssConfig[]): Promise<{ error?: string }>;

  // 上下文文件读写（AGENTS.md / SYSTEM.md / APPEND_SYSTEM.md / RULES.md）
  /** 读取上下文文件（不存在返回空串） */
  readContextFile(filePath: string): Promise<string>;
  /** 写入上下文文件（自动创建父目录，空内容则删除文件） */
  writeContextFile(filePath: string, content: string): Promise<void>;

  // 图片：粘贴/拖拽落盘 + 读取为 data URL
  /** 保存粘贴/拖拽的图片到临时目录（userData/pasted-images），返回路径 + 名称 + 大小。
   *  主进程做扩展名白名单 + 10MB 大小校验 + 位图自动 resize（gif/svg 原样）。 */
  savePastedImage(data: ArrayBuffer, ext: string): Promise<PastedImageResult>;
  /** 读取图片文件为 data URL（仅允许 pasted-images/ 或工作区内图片，防本地文件泄露）。失败抛错。 */
  readImageAsDataUrl(filePath: string): Promise<ImageDataUrlResult>;
}
