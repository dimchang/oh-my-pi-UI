/**
 * rpc-types.ts — oh-my-pi RPC 协议类型（NDJSON over stdio）
 *
 * 来源：本机实测抓帧（见 kimi_plan.md §0.3 / M1.0）+ omp 仓库 rpc-types.ts。
 * 同步版本：omp v17（bun shim，C:\Users\<user>\.bun\bin\omp.exe）。
 *
 * 实测要点（2026-07-21，<REPO_ROOT>）：
 * - prompt 的用户文本字段是 `message`，不是 `text`/`content`/`input`（实测 text/content/input 均报
 *   "undefined is not an object (evaluating 'W.trimStart')"，唯 `message` success:true）。
 * - message_update 每帧都携带全量 message（content[] 已是累计结果），UI 直接取全量渲染即可，
 *   不必自己累加 delta；assistantMessageEvent.delta 仅作可选的打字机效果。
 * - 未知帧 type / 未知 extension_ui_request.method 必须容忍，不得抛错（启动即推 setWidget）。
 */

// ---------------------------------------------------------------------------
// 基础：内容块（message.content[] 的元素）
// ---------------------------------------------------------------------------

export interface TextContent {
  type: 'text';
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface ToolCallContent {
  type: 'tool_call';
  id?: string;
  name?: string;
  arguments?: unknown;
  [k: string]: unknown;
}

/** 工具结果块（历史消息里 tool 角色消息的 content） */
export interface ToolResultContent {
  type: 'tool_result';
  toolCallId?: string;
  content?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

export type MessageContent =
  | TextContent
  | ThinkingContent
  | ToolCallContent
  | ToolResultContent
  | { type: string; [k: string]: unknown }; // 兜底：未知 content 类型不崩

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoningTokens?: number;
  cost: UsageCost;
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool' | (string & {});
  content: MessageContent[];
  attribution?: string;
  timestamp?: number;
  // assistant 附加
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  responseId?: string;
  duration?: number;
  ttft?: number;
  // 模型/请求错误（实测：stopReason:'error' 时 content 为空，错误信息在这些字段）
  errorStatus?: number;
  errorId?: number | string;
  errorMessage?: string;
  // issue 91: 未知字段收进显式 extra，替代宽松索引签名（避免所有属性访问退化为 unknown）
  extra?: Record<string, unknown>;
  /** 由 steer 命令产生的用户消息会带此标记（message_start / agent_end.messages 均可见）。
   *  UI 据此把"改写方向"与普通 prompt 区分渲染。 */
  steering?: boolean;
}

/** 历史回放消息：AgentMessage 基础上，由 readSessionMessages 附加工具调用参数，
 *  使磁盘加载的 toolResult 能重建出带参数摘要的 ToolCard（而非混入正文当大标题）。 */
export interface ReplayMessage extends AgentMessage {
  /** 来自匹配到的 tool_execution_start 帧的 args（如 read 的 path） */
  replayArgs?: unknown;
  // issue 91: 收紧索引签名后，回放 toolResult 需显式声明这两个字段（原先靠 [k:string]:unknown 隐式携带）
  toolCallId?: string;
  toolName?: string;
}

// ---------------------------------------------------------------------------
// client → omp：命令帧
// ---------------------------------------------------------------------------

export interface RpcCommandBase {
  id?: string;
  // issue 40: branded 写法，避免 `string` 吸收字面量联合导致 RpcCommand 判别联合失效
  type: string & {};
}

export interface PromptCommand extends RpcCommandBase {
  type: 'prompt';
  /** 用户输入文本（实测字段名为 message） */
  message: string;
}

/** steer：引导当前 agent 轮次（mid-run 中断）。
 *  实测（probe-steer.mjs / probe-steer-v5.mjs）：
 *  - 字段名同 prompt 用 `message`（`text` 报 "i.startsWith" 错误）。
 *  - omp 源码注释：\"Queue a steering message to interrupt the agent mid-run.
 *    Delivered after current tool execution, skips remaining tools.\"
 *  - 生成中途发送：当前 tool 完成后立即投递 + 跳过剩余 tool + 走一次模型处理，**不打断当前 tool**。
 *  - 空闲时发送：起一个新 user 轮，消息带 `steering:true` 标记（区别于普通 prompt）。
 *  帧流里 user 消息会带 `steering:true`（message_start / agent_end.messages），UI 据此区分渲染。 */
export interface SteerCommand extends RpcCommandBase {
  type: 'steer';
  /** 引导文本（字段名同 prompt：message） */
  message: string;
}

/** follow_up：把消息追加到当前会话末尾，等当前 agent turn 跑完后处理（不打断、不 mid-run 介入）。
 *  字段名同 prompt：message。空闲时等价于普通 prompt。 */
export interface FollowUpCommand extends RpcCommandBase {
  type: 'follow_up';
  message: string;
}

export interface SetModelCommand extends RpcCommandBase {
  type: 'set_model';
  provider: string;
  modelId: string;
}

export interface SwitchSessionCommand extends RpcCommandBase {
  type: 'switch_session';
  /** 实测 + 源码权威（rpc-types.ts L75）：字段名是 sessionPath。
   *  值可为 .jsonl 绝对路径（正/反斜杠均可）或裸 sessionId，均 success。 */
  sessionPath: string;
}

export interface SetSessionNameCommand extends RpcCommandBase {
  type: 'set_session_name';
  name: string;
}

export interface LoginCommand extends RpcCommandBase {
  type: 'login';
  provider: string;
}

export interface SetThinkingLevelCommand extends RpcCommandBase {
  type: 'set_thinking_level';
  level: ThinkingLevel;
}

export interface ExtensionUIResponseCommand extends RpcCommandBase {
  type: 'extension_ui_response';
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
}

export type RpcCommand =
  | PromptCommand
  | SteerCommand
  | FollowUpCommand
  | SetModelCommand
  | SwitchSessionCommand
  | SetSessionNameCommand
  | LoginCommand
  | SetThinkingLevelCommand
  | ExtensionUIResponseCommand
  | RpcCommandBase; // 其余简单命令：{type:'get_state'|'abort'|'new_session'|...}

// ---------------------------------------------------------------------------
// omp → client：响应帧
// ---------------------------------------------------------------------------

export interface RpcResponse<T = unknown> {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// omp → client：AgentSessionEvent（驱动聊天流）
// ---------------------------------------------------------------------------

/** message_update 里的流式增量事件（可选，用于打字机效果） */
export interface AssistantMessageEvent {
  type:
    | 'thinking_start' | 'thinking_delta' | 'thinking_end'
    | 'text_start' | 'text_delta' | 'text_end'
    | 'toolcall_start' | 'toolcall_delta' | 'toolcall_end'
    | string;
  contentIndex: number;
  delta?: string;
  content?: string;
  partial?: AgentMessage;
}

export interface AgentStartEvent { type: 'agent_start'; }
export interface AgentEndEvent { type: 'agent_end'; messages: AgentMessage[]; }
export interface TurnStartEvent { type: 'turn_start'; }
export interface TurnEndEvent { type: 'turn_end'; message: AgentMessage; toolResults?: unknown[]; }

export interface MessageStartEvent { type: 'message_start'; message: AgentMessage; }
export interface MessageUpdateEvent {
  type: 'message_update';
  assistantMessageEvent?: AssistantMessageEvent;
  message: AgentMessage; // 全量累计消息（渲染以此为准）
}
export interface MessageEndEvent { type: 'message_end'; message: AgentMessage; }

/** 工具执行事件（M2 实测补全字段） */
export interface ToolExecutionStartEvent {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName?: string;
  name?: string;
  args?: unknown;
  [k: string]: unknown;
}
export interface ToolExecutionUpdateEvent {
  type: 'tool_execution_update';
  toolCallId: string;
  partialResult?: unknown;
  [k: string]: unknown;
}
export interface ToolExecutionEndEvent {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName?: string;
  result?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

export interface NoticeEvent { type: 'notice'; message?: string; level?: string; [k: string]: unknown; }
/** 实测帧：{"type":"thinking_level_changed","thinkingLevel":"low"} —— 字段是 thinkingLevel */
export interface ThinkingLevelChangedEvent { type: 'thinking_level_changed'; thinkingLevel?: ThinkingLevel; [k: string]: unknown; }

export type AgentSessionEvent =
  | AgentStartEvent | AgentEndEvent | TurnStartEvent | TurnEndEvent
  | MessageStartEvent | MessageUpdateEvent | MessageEndEvent
  | ToolExecutionStartEvent | ToolExecutionUpdateEvent | ToolExecutionEndEvent
  | NoticeEvent | ThinkingLevelChangedEvent
  | { type: string; [k: string]: unknown }; // 兜底：auto_compaction_*/auto_retry_*/todo_* 等

// ---------------------------------------------------------------------------
// omp → client：extension_ui_request（权限/选项/OAuth/通知）
// ---------------------------------------------------------------------------

export type ExtensionUIMethod =
  | 'confirm' | 'select' | 'input' | 'editor' | 'cancel'   // 需应答
  | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text' // 单向
  | 'open_url'                                            // OAuth
  | string;                                               // 兜底

export interface ExtensionUIOption {
  value: string;
  label?: string;
  description?: string;
}

/** omp 的 extension_ui_request.options 实际是字符串数组（"Approve" / "Deny"），
 *  但 type schema 早期定义成了对象。兼容两种形态：碰到 string 就当作 label=value。 */
export type ExtensionUIOptionItem = string | ExtensionUIOption;

export interface RpcExtensionUIRequest {
  type: 'extension_ui_request';
  id: string;
  method: ExtensionUIMethod;
  title?: string;
  message?: string;
  prompt?: string;
  options?: ExtensionUIOptionItem[];
  defaultValue?: string;
  placeholder?: string;
  // open_url
  url?: string;
  launchUrl?: string;
  // notify / setStatus / setWidget / setTitle
  text?: string;
  level?: 'info' | 'warning' | 'error' | string;
  statusKey?: string;
  widgetKey?: string;
  // cancel
  targetId?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// omp → client：其他系统帧
// ---------------------------------------------------------------------------

export interface ReadyFrame { type: 'ready'; }

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description?: string;
  source?: string;
  input?: { hint?: string };
  subcommands?: SlashCommand[];
}
export interface AvailableCommandsUpdateFrame {
  type: 'available_commands_update';
  commands: SlashCommand[];
}

/** 任意 omp→client 帧的联合兜底 */
export type OmpFrame =
  | ReadyFrame
  | RpcResponse
  | AgentSessionEvent
  | RpcExtensionUIRequest
  | AvailableCommandsUpdateFrame
  // issue 40: 兜底成员的 type 用 branded 写法，避免 `string` 吸收字面量联合导致判别失效
  | { type: string & {}; [k: string]: unknown };

// ---------------------------------------------------------------------------
// get_state 的 data（实测字段）
// ---------------------------------------------------------------------------

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 实测：{mode:'effort', efforts:['minimal','low','medium','high']}。
   *  efforts 是该模型实际支持的 thinking 档位——UI 只应让用户选这些，
   *  否则 omp 会 clamp 回有效值（表现为"切高档自动弹回"）。 */
  thinking?: { mode?: string; efforts?: ThinkingLevel[]; [k: string]: unknown };
  [k: string]: unknown;
}

export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export interface TodoItem { content: string; status?: string; [k: string]: unknown; }
export interface TodoPhase { phase: string; items?: TodoItem[]; [k: string]: unknown; }

export interface RpcSessionState {
  model?: ModelInfo;
  thinkingLevel?: ThinkingLevel;
  isStreaming: boolean;
  isCompacting?: boolean;
  sessionId?: string;
  messageCount?: number;
  queuedMessageCount?: number;
  todoPhases?: TodoPhase[];
  contextUsage?: ContextUsage;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// get_available_models / get_login_providers 的 data
// ---------------------------------------------------------------------------

export interface AvailableModelsData {
  models: ModelInfo[];
  [k: string]: unknown;
}

export interface LoginProvider {
  id: string;
  name?: string;
  type?: string;
  loggedIn?: boolean;
  [k: string]: unknown;
}
export interface LoginProvidersData {
  providers: LoginProvider[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// SessionHeader（会话 JSONL 首行，M3 扫盘只读这一行）
// ---------------------------------------------------------------------------

export interface SessionHeader {
  type?: string; // 通常 'session_header' 或缺省
  id: string;
  cwd: string;
  title?: string;
  parentSession?: string;
  timestamp?: number;
  version?: number;
  [k: string]: unknown;
}
