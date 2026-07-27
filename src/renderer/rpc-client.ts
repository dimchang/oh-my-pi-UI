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
  RpcResponse,
  RpcSessionState,
  AgentMessage,
  ThinkingLevel,
  SlashCommand,
} from '../shared/rpc-types';
import type { WorkspacesFile, ApprovalMode } from '../shared/ipc-channels';

async function send<T>(sessionPath: string, cmd: RpcCommand): Promise<RpcResponse<T>> {
  const resp = (await window.omp.send(sessionPath, cmd)) as RpcResponse<T>;
  return resp;
}

export const rpc = {
  getState: (sp: string) => send<RpcSessionState>(sp, { type: 'get_state' }),
  getAvailableModels: (sp: string) => send<AvailableModelsData>(sp, { type: 'get_available_models' }),
  getAvailableCommands: (sp: string) => send<{ commands?: SlashCommand[] }>(sp, { type: 'get_available_commands' }),
  getMessages: (sp: string) => send<{ messages: AgentMessage[] }>(sp, { type: 'get_messages' }),
  /** 走磁盘读历史，不经 omp 进程 */
  readSessionMessages: (path: string) => window.omp.readSessionMessages(path),
  getLoginProviders: (sp: string) => send<LoginProvidersData>(sp, { type: 'get_login_providers' }),
  getSessionStats: (sp: string) => send<{ totalTokens?: number; totalCost?: number; messageCount?: number }>(sp, { type: 'get_session_stats' }),

  prompt: (sp: string, message: string) => send(sp, { type: 'prompt', message }),
  /** 引导：当前 tool 完成后立即按新方向继续（mid-run 中断，OMP 源码注释确认）。 */
  steer: (sp: string, message: string) => send(sp, { type: 'steer', message }),
  /** 排队：把消息追加到当前会话末尾，等当前 agent turn 跑完后处理（不打断当前 tool/t）。 */
  followUp: (sp: string, message: string) => send(sp, { type: 'follow_up', message }),
  abort: (sp: string) => send(sp, { type: 'abort' }),
  newSession: (sp: string) => send(sp, { type: 'new_session' }),
  setModel: (sp: string, provider: string, modelId: string) =>
    send(sp, { type: 'set_model', provider, modelId }),
  switchSession: (sp: string, sessionPath: string) => send(sp, { type: 'switch_session', sessionPath } as RpcCommand),
  setSessionName: (sp: string, name: string) => send(sp, { type: 'set_session_name', name }),
  login: (sp: string, provider: string) => send(sp, { type: 'login', provider }),
  setThinkingLevel: (sp: string, level: ThinkingLevel) => send(sp, { type: 'set_thinking_level', level }),
  cycleThinkingLevel: (sp: string) => send(sp, { type: 'cycle_thinking_level' }),
  exportHtml: (sp: string, path?: string) => send(sp, { type: 'export_html', path } as RpcCommand),
  branch: (sp: string, entryId?: string) => send(sp, { type: 'branch', entryId } as RpcCommand),
  setTodos: (sp: string, todos: unknown) => send(sp, { type: 'set_todos', todos } as RpcCommand),

  /** 应答 UI 请求（路由到该 UI 请求来源的会话进程）。 */
  respondUI: (sessionPath: string, resp: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean; always?: boolean }) =>
    window.omp.send(sessionPath, { type: 'extension_ui_response', ...resp } as RpcCommand),

  /** 应答并出队（UI 请求闭环）。
   *  返回 Promise：成功才出队；失败时 reject，交由调用方（PermissionModal）弹错提示，
   *  且保持弹窗不关闭，让用户重新进入该会话后可重试/关闭。 */
  respondUIAndDequeue: (sessionPath: string, resp: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean; always?: boolean }) =>
    window.omp.send(sessionPath, { type: 'extension_ui_response', ...resp } as RpcCommand)
      .then(() => {
        void import('./store').then(({ useApp }) => useApp.getState().dequeueUi(resp.id));
      }),

  // ---- 进程池 ----
  acquire: (sessionPath: string, cwd: string, approvalMode?: ApprovalMode) =>
    window.omp.acquire(sessionPath, cwd, approvalMode),
  newSessionForCwd: (cwd: string, approvalMode?: ApprovalMode) =>
    window.omp.newSessionForCwd(cwd, approvalMode),
  release: (sessionPath: string) => window.omp.release(sessionPath),
  renameKey: (oldKey: string, newKey: string) => window.omp.renameKey(oldKey, newKey),

  // ---- M5: 工作空间 ----
  getWorkspaces: () => window.omp.getWorkspaces(),
  saveWorkspaces: (file: WorkspacesFile) => window.omp.saveWorkspaces(file),
  openDirDialog: (defaultPath?: string) => window.omp.openDirDialog(defaultPath),
};
