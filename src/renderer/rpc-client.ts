/**
 * rpc-client.ts — 封装 window.omp 的发送与事件订阅（多进程版）。
 *
 * 多进程下每个 omp 命令都要带 sessionPath，主进程据此路由到该会话的进程。
 * readSessionMessages 走磁盘（不经 omp 进程），故不带 sessionPath。
 */

import type {
  AvailableModelsData,
  LoginProvidersData,
  RpcCommand,
  RpcImage,
  RpcResponse,
  RpcSessionState,
  AgentMessage,
  ThinkingLevel,
  SlashCommand,
} from '../shared/rpc-types';
import type { WorkspacesFile, ApprovalMode, AcquireOptions } from '../shared/ipc-channels';
import type { FormDataRecord } from '../shared/html-form-parser';

async function send<T>(sessionPath: string, cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse<T>> {
  // 主进程把 RPC 层错误（omp 错误帧 / not online 等）包成 { __rpcError } 信封返回，
  // 避免 Electron 对 ipcMain.handle 的 rejection 打堆栈日志；这里拆包还原为 throw。
  const resp = (await window.omp.send<T>(sessionPath, cmd, timeoutMs)) as RpcResponse<T> & { __rpcError?: string };
  if (resp && typeof resp === 'object' && typeof resp.__rpcError === 'string') {
    throw new Error(resp.__rpcError);
  }
  return resp;
}

export const rpc = {
  getState: (sp: string, timeoutMs?: number) => send<RpcSessionState>(sp, { type: 'get_state' }, timeoutMs),
  getAvailableModels: (sp: string) => send<AvailableModelsData>(sp, { type: 'get_available_models' }),
  getAvailableCommands: (sp: string) => send<{ commands?: SlashCommand[] }>(sp, { type: 'get_available_commands' }),
  getMessages: (sp: string) => send<{ messages: AgentMessage[] }>(sp, { type: 'get_messages' }),
  /** 走磁盘读历史，不经 omp 进程 */
  readSessionMessages: (path: string) => window.omp.readSessionMessages(path),
  getLoginProviders: (sp: string) => send<LoginProvidersData>(sp, { type: 'get_login_providers' }),
  getSessionStats: (sp: string) => send<{ totalTokens?: number; totalCost?: number; messageCount?: number }>(sp, { type: 'get_session_stats' }),

  prompt: (sp: string, message: string, images?: RpcImage[]) => {
    const cmd = images && images.length ? { type: 'prompt', message, images } : { type: 'prompt', message };
    return send(sp, cmd);
  },
  /** 引导：当前 tool 完成后立即按新方向继续（mid-run 中断，OMP 源码注释确认）。 */
  steer: (sp: string, message: string, images?: RpcImage[]) =>
    send(sp, images && images.length ? { type: 'steer', message, images } : { type: 'steer', message }),
  /** 排队：把消息追加到当前会话末尾，等当前 agent turn 跑完后处理（不打断当前 tool/t）。 */
  followUp: (sp: string, message: string, images?: RpcImage[]) =>
    send(sp, images && images.length ? { type: 'follow_up', message, images } : { type: 'follow_up', message }),
  abort: (sp: string) => send(sp, { type: 'abort' }),
  /** omp 18.6.3+：中止当前回合，并把排队中的 steer / follow-up 退回给客户端输入框（含附件） */
  abortAndRestoreQueue: (sp: string) =>
    send<{ steering?: Array<string | { text?: string; message?: string }>; followUp?: Array<string | { text?: string; message?: string }> }>(
      sp,
      { type: 'abort_and_restore_queue' },
    ),
  /** omp 18.4.4+：撤销单条排队中的 steer / follow-up 消息 */
  removeQueuedMessage: (
    sp: string,
    params: { queue?: 'steering' | 'followUp' | 'follow_up'; index?: number; text?: string },
  ) => send<{ removed?: boolean; text?: string; imagesDropped?: boolean }>(sp, { type: 'remove_queued_message', ...params }),
  newSession: (sp: string) => send(sp, { type: 'new_session' }),
  setModel: (sp: string, provider: string, modelId: string) =>
    send(sp, { type: 'set_model', provider, modelId }),
  switchSession: (sp: string, sessionPath: string, override?: { provider: string; modelId: string }) =>
    send(sp, { type: 'switch_session', sessionPath, ...(override ?? {}) } as RpcCommand),
  openSession: (sp: string, sessionPath: string, override?: { provider: string; modelId: string }) =>
    send(sp, { type: 'open_session', sessionPath, ...(override ?? {}) } as RpcCommand),
  setSessionName: (sp: string, name: string) => send(sp, { type: 'set_session_name', name }),
  login: (sp: string, provider: string) => send(sp, { type: 'login', provider }),
  /** omp 18.7.0+：查询可登出账号与执行登出 */
  getLogoutAccounts: (sp: string) =>
    send<{ accounts?: Array<{ provider: string; accountId?: string; label?: string }> }>(sp, { type: 'get_logout_accounts' }),
  logout: (sp: string, provider: string, accountId?: string) =>
    send(sp, { type: 'logout', provider, ...(accountId ? { accountId } : {}) }),
  setThinkingLevel: (sp: string, level: ThinkingLevel) => send(sp, { type: 'set_thinking_level', level }),
  cycleThinkingLevel: (sp: string) => send(sp, { type: 'cycle_thinking_level' }),
  getAvailableThinkingLevels: (sp: string) =>
    send<{ levels?: ThinkingLevel[] }>(sp, { type: 'get_available_thinking_levels' }),
  /** omp 18.2.1+ / 18.6.3+：Fast / Slow 模式开关 */
  setFastMode: (sp: string, enabled: boolean) => send(sp, { type: 'set_fast_mode', enabled }),
  setSlowMode: (sp: string, enabled: boolean) => send(sp, { type: 'set_slow_mode', enabled }),
  /** omp 18.4.5+ / 18.13.2+：事件流过滤与 delta 增量流模式（events 必填：null=不过滤事件类型） */
  setEventFilter: (
    sp: string,
    filter: { events?: string[] | null; messageUpdates?: 'full' | 'delta'; includeSubagentEvents?: boolean; [k: string]: unknown },
  ) =>
    send(sp, { type: 'set_event_filter', events: filter.events ?? null, ...filter } as RpcCommand),
  /** omp 18.14.1+：探测哪些 session 正被其它 omp 进程持有租约 */
  getSessionLease: (sp: string, sessionIds: string[]) =>
    send<{ held: string[]; unknown: string[] }>(sp, { type: 'get_session_lease', sessionIds }),
  exportHtml: (sp: string, path?: string) => send(sp, { type: 'export_html', path } as RpcCommand),
  branch: (sp: string, entryId?: string) => send(sp, { type: 'branch', entryId } as RpcCommand),
  /** omp 18.4.11+ / 18.13.2+：会话树导航、Fork 与标签 */
  fork: (sp: string, entryId?: string) =>
    send<{ sessionFile?: string; sessionPath?: string; sessionId?: string }>(sp, { type: 'fork', ...(entryId ? { entryId } : {}) }),
  navigateTree: (sp: string, entryId: string, summarize?: boolean) =>
    send<{ editorText?: string; cancelled?: boolean }>(sp, { type: 'navigate_tree', entryId, ...(summarize !== undefined ? { summarize } : {}) }),
  setLabel: (sp: string, entryId: string, label?: string) =>
    send(sp, { type: 'set_label', entryId, ...(label !== undefined ? { label } : {}) }),
  getEntries: (sp: string, since?: string) => send(sp, { type: 'get_entries', ...(since ? { since } : {}) } as RpcCommand),
  getTree: (sp: string) => send(sp, { type: 'get_tree' } as RpcCommand),
  /** omp 18.6.3+：/btw 侧边问答流 */
  btw: (sp: string, message: string, topicId?: string, images?: RpcImage[]) =>
    send<{ topicId?: string }>(sp, {
      type: 'btw',
      message,
      ...(topicId ? { topicId } : {}),
      ...(images && images.length ? { images } : {}),
    }),
  btwCancel: (sp: string, topicId?: string) => send(sp, { type: 'btw_cancel', ...(topicId ? { topicId } : {}) }),
  getBtwHistory: (sp: string) => send<{ records?: unknown[] }>(sp, { type: 'get_btw_history' }),
  setTodos: (sp: string, todos: unknown) => send(sp, { type: 'set_todos', todos } as RpcCommand),

  /** 应答 UI 请求（路由到该 UI 请求来源的会话进程）。支持 omp 19.1.0+ form 表单提交 data。 */
  respondUI: (
    sessionPath: string,
    resp: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean; timedOut?: boolean; always?: boolean; data?: FormDataRecord },
  ) =>
    window.omp.send(sessionPath, { type: 'extension_ui_response', ...resp } as RpcCommand),

  /** 应答并出队（UI 请求闭环）。
   *  返回 Promise：成功才出队；失败时 reject，交由调用方（PermissionModal）弹错提示，
   *  且保持弹窗不关闭，让用户重新进入该会话后可重试/关闭。 */
  respondUIAndDequeue: (
    sessionPath: string,
    resp: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean; timedOut?: boolean; always?: boolean; data?: FormDataRecord },
  ) =>
    window.omp.send(sessionPath, { type: 'extension_ui_response', ...resp } as RpcCommand)
      .then(() => {
        void import('./store').then(({ useApp }) => useApp.getState().dequeueUi(resp.id));
      }),

  // ---- 进程池 ----
  acquire: (sessionPath: string, cwd: string, approvalMode?: ApprovalMode, opts?: AcquireOptions) =>
    window.omp.acquire(sessionPath, cwd, approvalMode, opts),
  newSessionForCwd: (tempKey: string, cwd: string, approvalMode?: ApprovalMode) =>
    window.omp.newSessionForCwd(tempKey, cwd, approvalMode),
  release: (sessionPath: string) => window.omp.release(sessionPath),
  renameKey: (oldKey: string, newKey: string) => window.omp.renameKey(oldKey, newKey),

  // ---- M5: 工作空间 ----
  getWorkspaces: () => window.omp.getWorkspaces(),
  saveWorkspaces: (file: WorkspacesFile) => window.omp.saveWorkspaces(file),
  openDirDialog: (defaultPath?: string) => window.omp.openDirDialog(defaultPath),
};
