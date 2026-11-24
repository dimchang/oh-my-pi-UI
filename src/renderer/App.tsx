import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  useApp,
  type UiRequest,
  type Attachment,
  type ToastOptions,
  toolNameOf,
  isImageFile,
  shouldHealStuckStreaming,
  shouldHealFromDisk,
  resolveDesiredSessionModel,
  reportCrashInterrupt,
  pushCrashInterruptToast,
  SESSION_STALL_MS,
} from './store';
import { isCrashAbortedMessage, lastUserTextFromChat, CRASH_RECOVER_TOAST } from './utils/crash-interrupt';
import { rpc } from './rpc-client';
import { ChatView } from './components/ChatView';
import { SkillsPanel } from './components/SkillsPanel';
import { InputBox } from './components/InputBox';
import { WorkspaceList } from './components/WorkspaceList';
import { Icon } from './components/Icon';
import { StatusBar } from './components/StatusBar';
import { PermissionModal } from './components/PermissionModal';
import { FileTree } from './components/FileTree';
import { TitleBar } from './components/TitleBar';
import { TodoPanel } from './components/TodoPanel';
import { JobPanel } from './components/JobPanel';
import { DiffView } from './components/DiffView';
import { SettingsPanel } from './components/SettingsPanel';
import { AutomationPanel } from './components/AutomationPanel';
import { cwdKey, makeWorkspaceId, basename, pathsEqual } from './utils/path-key';
import { planWorkspaceReconcile } from './utils/workspace-reconcile';
import { stripDataUrlPrefix } from './utils/image-data-url';
import {
  TEMP_KEY_PREFIX,
  UNNAMED_SESSION,
  LEGACY_TEMP_TITLE,
  deriveSessionName,
} from './utils/temp-session';
import { applyAppearance } from './store';
import type { OmpFrame, RpcExtensionUIRequest, RpcImage, AvailableCommandsUpdateFrame, RpcSessionState, TodoPhase, ModelInfo, SlashCommand } from '../shared/rpc-types';
import type { SessionSummary, Workspace, ApprovalMode, AutomationTask, AutomationRun } from '../shared/ipc-channels';

export default function App(): React.ReactElement {
  const ready = useApp((s) => s.ready);
  const exited = useApp((s) => s.ompExited);
  const uiQueue = useApp((s) => s.uiQueue);
  const rightPanel = useApp((s) => s.rightPanel);
  const mainView = useApp((s) => s.mainView);
  const toasts = useApp((s) => s.toasts);

  // 任务栏闪动提醒（0.5.23，0.5.26 改常闪）：uiQueue 有待应答请求（confirm/select/input/editor，
  // 即需要用户决策/审批）且窗口未聚焦 → 闪动任务栏图标；用户切回窗口或请求处理完 → 停止。
  // Windows FlashWindowEx 只闪固定次数后转常亮，所以挂 4s 定时器不断重触发，实现
  // 「一直闪到用户点回窗口为止」。主进程 focus 事件另有 flashFrame(false) 兜底。
  const needAttention = uiQueue.length > 0;
  useEffect(() => {
    const syncFlash = (): void => {
      const want = useApp.getState().uiQueue.length > 0 && !document.hasFocus();
      void window.omp.flashWindow(want).catch(() => undefined);
    };
    syncFlash();
    window.addEventListener('focus', syncFlash);
    window.addEventListener('blur', syncFlash);
    // 窗口聚焦时定时器只发 flash=false（幂等、代价可忽略），不额外做分支清理
    const timer = window.setInterval(syncFlash, 4000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', syncFlash);
      window.removeEventListener('blur', syncFlash);
    };
  }, [needAttention]);

  // 全局 toast 改为走 store（pushToast 在 rpc-client / PermissionModal 等任意组件可用）。
  const pushToast = useCallback((text: string, level = 'info', opts?: ToastOptions) => {
    useApp.getState().pushToast(text, level, opts);
  }, []);

  const togglePanel = useCallback((panel: 'files' | 'todo' | 'diff' | 'jobs') => {
    const st = useApp.getState();
    st.setState({ rightPanel: st.rightPanel === panel ? 'off' : panel });
  }, []);

  /** 刷新某会话进程的状态栏（model/thinkingLevel/contextUsage 等）。
   *  多进程下这些是 per-session 的，所以必须带 sessionPath 路由。 */
  const refreshState = useCallback((sessionPath?: string): Promise<void> => {
    const sp = sessionPath ?? useApp.getState().currentSessionPath;
    if (!sp) return Promise.resolve();
    // 会话统计（tokens/费用/消息数）与 get_state 并行拉取；
    // 仅当返回时该会话仍是当前显示会话才写入，避免切会话后串数据。
    void rpc.getSessionStats(sp).then((sr) => {
      if (sr.success && sr.data && sp === useApp.getState().currentSessionPath) {
        useApp.getState().setState({ sessionStats: sr.data });
      }
    }).catch(() => undefined);
    const sentAt = Date.now();
    return rpc.getState(sp).then((r) => {
      if (r.success && r.data) {
        const d = r.data as RpcSessionState;
        const isCurrent = sp === useApp.getState().currentSessionPath;
        // 该会话进程的真实模型存进 per-session 快照（无论是否当前显示会话都记）：
        // 切回它时能立刻回显自己的模型，不用等这次 get_state 往返（2026-10-25）。
        if (d.model) useApp.getState().setSessionModel(sp, d.model);
        // tempKey → 真实 sessionFile 绑定（omp ready 即有值，文件可能还没落盘）。
        // 有它才能：侧栏不出现「假占位 + 真文件」两条、进程淘汰后 -r 续接到自己而不是裂文件。
        const sf = (r.data as { sessionFile?: unknown }).sessionFile;
        if (sp.startsWith(TEMP_KEY_PREFIX) && typeof sf === 'string') {
          useApp.getState().bindTempRealPath(sp, sf);
        }
        useApp.getState().setState({
          ...(isCurrent ? {
            model: d.model,
            thinkingLevel: d.thinkingLevel,
            contextUsage: d.contextUsage,
            tokensPerSecond: d.tokensPerSecond,
            sessionId: d.sessionId,
            todoPhases: d.todoPhases ?? [],
            isCompacting: d.isCompacting ?? false,
          } : {}),
          // isStreaming/isAborting 仍由 procStateMap 驱动；但若镜像与 omp 真值漂移
          // （agent_end 帧丢失），下面立即校正——选中即对账，不等 30s 看门狗。
        });
        // 流式状态对账（2026-09-16 橙点常亮修复）：omp 报已结束而本侧镜像仍 streaming
        // → 以 omp 为准重置（含新鲜度守卫，见 shouldHealStuckStreaming）。
        const stNow = useApp.getState();
        if (shouldHealStuckStreaming(stNow.procStateMap[sp], d.isStreaming, sentAt)) {
          stNow.setProcState(sp, { isStreaming: false, isAborting: false, stuckSince: undefined });
          if (sp === useApp.getState().currentSessionPath) {
            useApp.getState().setState({ isStreaming: false, isAborting: false });
          }
        }
        // 注意：这里**不做** lastModel 自动恢复——refreshState 的触发点很多（切会话/
        // agent_end/轮询），任何一次触发都会把别的会话选的模型覆盖到本会话上
        // （2026-09-16 串模型事故）。恢复只在进程拉起时做，见 restoreSessionModel。
      }
    }).catch(() => undefined);
  }, []);

  const refreshSessions = useCallback((): Promise<void> => {
    return window.omp.listSessions()
      .then((list) => {
        useApp.getState().setSessions(list);
        // 扫盘后对账（2026-09-17）：已提交过消息的 temp 占位，若 omp 自报的落盘路径
        // （get_state.sessionFile）已经出现在扫盘结果里，就立刻迁移，不必等 agent_end——
        // omp 在首条消息生成期间就开始写盘，中间任何一次额外扫盘（切工作区 / 删别的会话）
        // 都会让占位与真实条目在侧栏同时出现，看起来就是两条重复会话。
        // 判据必须落在「真实文件确实已经可见」上：真实文件还不可见就迁移，会话会从侧栏
        // 消失，比重复更糟。也正因为如此不用「同 cwd 最新会话」这种猜法（同目录下若另有
        // 会话正在写盘会误判）。进程离线时 getState 失败 → 交给 onExit / agent_end 路径。
        // migrateRef 转调以避开与 migrateTempSession 的声明顺序依赖。
        for (const p of useApp.getState().sessions) {
          if (!p.path.startsWith(TEMP_KEY_PREFIX)) continue;
          if (!tempSubmittedKeys.current.has(p.path)) continue;
          if (migratingTempKeys.current.has(p.path)) continue;
          void rpc
            .getState(p.path)
            .then(async (r) => {
              // 2026-10-25：绑定优先。进程已被淘汰（getState 失败）时绑定仍在，
              // 用它判断"真实文件是否已可见"，不必依赖一个已经死掉的进程。
              const bound = useApp.getState().tempRealPath[p.path];
              let sf: string | undefined;
              if (r.success && r.data) {
                const raw = (r.data as { sessionFile?: unknown }).sessionFile;
                if (typeof raw === 'string' && !raw.startsWith(TEMP_KEY_PREFIX)) {
                  sf = raw;
                  useApp.getState().bindTempRealPath(p.path, raw);
                }
              }
              if (!sf) sf = bound;
              if (!sf) return;
              // 判据仍是「真实文件确实已经可见」：先看本轮扫盘结果，再由磁盘兜一次
              // （扫盘读 header 有延迟/被截断时，文件其实已经在了）。
              let visible = list.some((x) => x.path === sf);
              if (!visible) {
                const tail = await window.omp.sessionTail(sf).catch(() => null);
                visible = !!tail;
              }
              if (!visible) return;
              void migrateRef.current(p.path);
            })
            .catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, []);

  /** 进程 (re)spawn 后恢复该会话**自己**的模型选择。
   *
   *  取值规则见 store 的 resolveDesiredSessionModel（纯函数可单测）：
   *   - lastModelMap[sp] 有记录 → 用记录；
   *   - 无记录的**新会话**（__new_ tempKey）→ 回退全局 lastModel，满足「新开会话跟最后一次
   *     选的模型走」；
   *   - 无记录的**老会话** → 什么都不做（返回 undefined）。omp -c/-r 续接会话文件时已按
   *     model_change 恢复出它自己的模型，此时再拿全局 lastModel 去覆盖 = 用别的会话刚选的
   *     模型改掉本会话（2026-10-25「会话1模型被改成 GLM」根因）。
   *  无记录的老会话顺手把 omp 自报的模型记为基准（seedSessionModel，不写全局 lastModel）。
   *
   *  只在 onReady 调用——进程退出/淘汰重拉后 omp 会回到 config 默认模型，这是唯一需要
   *  恢复的时机。refreshState（切会话/agent_end 等高频触发点）绝不调它。
   *
   *  返回 Promise：发送路径（onSend 等）在 acquire 后 await 它，保证**首条消息**就用
   *  本会话该用的模型，而不是抢在 set_model 之前用默认模型跑出去。 */
  const restoreSessionModel = useCallback((sessionPath: string): Promise<void> => {
    const st = useApp.getState();
    const desired = resolveDesiredSessionModel(
      sessionPath,
      st.lastModelMap,
      st.lastModel,
      // 新建（未提交）会话 → 沿用最后一次选的模型；老会话无记录时绝不回退，见纯函数注释
      !!st.uncommittedSessions[sessionPath] || sessionPath.startsWith(TEMP_KEY_PREFIX),
    );
    return rpc.getState(sessionPath).then((r) => {
      if (!r.success || !r.data) return;
      const d = r.data as RpcSessionState;
      // 进程 ready 时就把 tempKey 绑到真实 sessionFile（见 store.tempRealPath 注释）
      const sf = (r.data as { sessionFile?: unknown }).sessionFile;
      if (sessionPath.startsWith(TEMP_KEY_PREFIX) && typeof sf === 'string') {
        useApp.getState().bindTempRealPath(sessionPath, sf);
      }
      if (!desired) {
        // 老会话：信任 omp 从会话文件恢复的模型，只把它记成本会话基准
        if (d.model) {
          const stNow = useApp.getState();
          stNow.setSessionModel(sessionPath, d.model);
          const m = { provider: d.model.provider, id: d.model.id, name: d.model.name };
          if (!stNow.lastModelMap[sessionPath]) stNow.seedSessionModel(sessionPath, m);
        }
        return;
      }
      // 落定后把模型写进该会话的记录（若还没有）：否则下次进程重起时它"没有记录"，
      // 只能吃 omp 的 config 默认模型——实证默认模型可能是已下线的（space-bunny-alpha
      // 在 OpenRouter 已 404），用户就会看到"模型莫名变了 + 请求失败"。
      const remember = (m: { provider: string; id: string; name?: string }): void => {
        const now = useApp.getState();
        if (!now.lastModelMap[sessionPath]) now.seedSessionModel(sessionPath, m);
      };
      if (d.model && d.model.provider === desired.provider && d.model.id === desired.id) {
        useApp.getState().setSessionModel(sessionPath, d.model);
        remember({ provider: d.model.provider, id: d.model.id, name: d.model.name });
        return;
      }
      return rpc.setModel(sessionPath, desired.provider, desired.id).then((sr) => {
        if (!sr.success || !sr.data) return;
        const mm = sr.data as ModelInfo;
        useApp.getState().setSessionModel(sessionPath, mm);
        remember({ provider: mm.provider, id: mm.id, name: mm.name });
        if (sessionPath === useApp.getState().currentSessionPath) {
          useApp.getState().setState({ model: mm });
        }
      }).catch(() => undefined);
    }).catch(() => undefined);
  }, []);

  /** 进程 ready 时的模型恢复在途表：发送路径 await 它，避免首条 prompt 用错模型。
   *  正常情况（进程早已 ready）表里没有条目，await 立即返回，无额外延迟。 */
  const pendingModelRestore = useRef<Map<string, Promise<void>>>(new Map());
  const awaitModelRestore = useCallback((sessionPath: string): Promise<void> => {
    const p = pendingModelRestore.current.get(sessionPath);
    if (!p) return Promise.resolve();
    // 兜底超时：进程卡死时不能让发送永远挂着
    return Promise.race([p, new Promise<void>((r) => setTimeout(r, 4000))]);
  }, []);

  /** 拉取某会话进程的可用技能 / 命令列表。
   *  若首次返回空（omp 刚 ready 可能尚未注册完命令），自动延迟重试一次。 */
  const refreshCommands = useCallback((sessionPath: string, retry = true): void => {
    // 会话进程已不在线（被 LRU 淘汰 / 退出 / 尚未拉起）→ 不盲发命令，避免主进程抛
    // "omp process not online"（渲染层状态由 OmpExit 事件同步为 offline）；
    // 重新拉起后 onReady 会再次调用本函数拉取命令列表。
    if (useApp.getState().procStateMap[sessionPath]?.status !== 'online') return;
    void rpc.getAvailableCommands(sessionPath).then((r) => {
      if (r.success && r.data) {
        const cmds = r.data.commands;
        if (Array.isArray(cmds) && cmds.length > 0) {
          useApp.getState().setState({ slashCommands: cmds as SlashCommand[] });
          return;
        }
      }
      // 返回空 / 失败：延迟重试一次（omp 刚 ready 时命令可能尚未全部注册）
      if (retry) {
        setTimeout(() => refreshCommands(sessionPath, false), 1500);
      }
    }).catch(() => {
      if (retry) {
        setTimeout(() => refreshCommands(sessionPath, false), 1500);
      }
    });
  }, []);

  /** 迁移中的 temp key 集合（并发保护）：同一 __new_ 会话的多次 agent_end 只处理一次。 */
  const migratingTempKeys = useRef<Set<string>>(new Set());
  /** 「主动重启会话进程」标记（切权限模式用）：命中的 onExit 只做状态复位，
   *  跳过 temp 丢弃/迁移与崩溃自愈——那是给意外退出的，主动重启后的重拉由发起方负责。
   *  否则 temp 会话会被 discardTempSession 删掉占位，随后 acquire 变成给死 key 起进程。 */
  const selfRestartKeys = useRef<Set<string>>(new Set());
  /** 已被某个 temp key 认领的真实 path（防止同工作空间多个 temp 抢同一个最新落盘会话）。 */
  const claimedRealPaths = useRef<Set<string>>(new Set());
  /** 新建会话前已知的真实 session path 快照。
   *  tempKey→realPath 迁移时不再靠 mtime 猜，而是找同 cwd 下"本次新建之后才出现"的真实 path。 */
  const knownSessionPathsBeforeNew = useRef<Set<string>>(new Set());
  /** 落盘竞态重试：agent_end 帧可能先于 .jsonl 落盘可见到达，扫盘扫不到真实 path。
   *  记录每个 temp 的重试次数与定时器，有限次延迟重试（实证：单轮对话时迁移失败后
   *  再无下一次 agent_end，占位永久残留 → "新会话"与真实会话重复）。 */
  const migrateRetryCount = useRef<Map<string, number>>(new Map());
  const migrateRetryTimers = useRef<Map<string, number>>(new Map());
  /** migrateTempSession 自引用（重试调度用），定义后回填。 */
  const migrateRef = useRef<(tempPath?: string) => void | Promise<void>>(() => undefined);
  /** 已提交过消息的 temp 会话（2026-09-14 修复 P0-4：收窄空 temp 静默丢弃判据）。
   *  旧判据只看「渲染层缓冲为空」，但错投场景（消息发去了别的会话）下缓冲也为空，
   *  会让用户实际用过的 temp 会话被 onSelectSession 静默清掉。
   *  onSend/onGuide/onQueue 成功 append 后记入；discardTempSession / 迁移成功后清除。 */
  const tempSubmittedKeys = useRef<Set<string>>(new Set());
  /** 该会话**提交过消息**的永久标记（key 随 rekey 迁移，丢弃/删除时清理）。
   *
   *  为什么要和 store.uncommittedSessions 并存：后者在 commitSession 时就被清掉，是"是否
   *  还是空的新会话"的唯一判据；一旦某条路径漏了 commit（历史上就漏过），进程退出时就会
   *  把有内容的会话当空会话清掉。这里作为**只增不减**的兜底：只要提交过一次，任何自动
   *  清理路径都必须放行（2026-10-25 事故：01a17150 的会话就是这样被误清的）。 */
  const committedKeys = useRef<Set<string>>(new Set());

  /** tempKey → 新建时选定的 cwd。2026-09-17 起侧栏占位改到「首条消息提交」时才创建（见
   *  autoNameTempSession），那一刻已经离开 doNewSession 作用域，需要把 cwd 带过来。
   *  不用 currentWorkspace() 反推：用户完全可以在新建后切到别的工作区再回来发消息。 */
  const tempCwdRef = useRef<Map<string, string>>(new Map());

  /** 把某会话在 store / refs / 主进程进程池里的 **key** 从 `cur` 换成 `realPath`。
   *
   *  这不是"迁移 temp 会话"专用：凡是 omp 分配给会话的真实 `sessionFile` 与 UI 当前
   *  使用的 key 不一致时都用它（新建会话 spawn 后立刻采用真实 id、temp 占位落盘迁移、
   *  未提交新会话进程被淘汰后重新分配 id）。集中在一处，避免每加一个 sidecar 就漏迁一个
   *  （历史上漏迁 automationRuns / uiQueue 各踩过一次）。
   *
   *  `realPath` 已出现在扫盘结果 → 旧条目直接移除（由真实条目接管）；
   *  还没有（.jsonl 等首条消息才创建）→ 旧条目**改名保留**，否则侧栏会闪一下空掉。 */
  const applySessionRekey = useCallback((cur: string, realPath: string): void => {
    if (!cur || !realPath || cur === realPath) return;
    const st = useApp.getState();
    claimedRealPaths.current.add(realPath);
    knownSessionPathsBeforeNew.current.add(realPath);
    tempSubmittedKeys.current.delete(cur);
    // 「提交过消息」标记跟随换 key；待恢复模型也一起搬（否则 awaitModelRestore 找不到旧 key）
    if (committedKeys.current.delete(cur)) committedKeys.current.add(realPath);
    const restoringModel = pendingModelRestore.current.get(cur);
    if (restoringModel) {
      pendingModelRestore.current.delete(cur);
      pendingModelRestore.current.set(realPath, restoringModel);
    }
    // 新建会话的 cwd 跟着 key 走（autoNameTempSession / 上架条目都要用）
    const cwd = tempCwdRef.current.get(cur);
    if (cwd) { tempCwdRef.current.delete(cur); tempCwdRef.current.set(realPath, cwd); }
    // 定时任务执行记录（0.5.21）：agent_end 记成功 / onExit 记失败都按 key 查映射
    const autoRun = automationRuns.current.get(cur);
    if (autoRun) {
      automationRuns.current.delete(cur);
      automationRuns.current.set(realPath, { ...autoRun, sessionPath: realPath });
    }
    const buf = st.sessionsMap[cur];
    const ps = st.procStateMap[cur];
    const sessionsMap = { ...st.sessionsMap };
    delete sessionsMap[cur];
    if (buf) sessionsMap[realPath] = buf;
    const procStateMap = { ...st.procStateMap };
    delete procStateMap[cur];
    if (ps) procStateMap[realPath] = ps;
    // pending UI 请求（工具确认弹窗等）也带着旧 key：不重定向会指向已离线的旧进程 →
    // 用户点确认报 "omp process not online"（主进程 renameKey 已同步迁 pin）。
    const uiQueue = st.uiQueue.map((q) =>
      q.sessionPath === cur ? { ...q, sessionPath: realPath } : q,
    );
    const sessionNames = { ...st.sessionNames };
    const renamed = sessionNames[cur];
    delete sessionNames[cur];
    if (renamed && !sessionNames[realPath]) sessionNames[realPath] = renamed;
    // 「始终允许」缓存（key = `${sessionPath}::tool`）跟随迁移，否则落盘后同一工具又弹确认
    const permAllow: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(st.permAllow)) {
      permAllow[k.startsWith(`${cur}::`) ? `${realPath}${k.slice(cur.length)}` : k] = v;
    }
    const realAlreadyListed = st.sessions.some((x) => x.path === realPath);
    const sessions = realAlreadyListed
      ? st.sessions.filter((x) => x.path !== cur)
      : st.sessions.map((x) => (x.path === cur
          ? { ...x, path: realPath, id: realPath, mtime: Date.now() }
          : x));
    st.setState({
      sessionsMap,
      procStateMap,
      uiQueue,
      sessions,
      sessionNames,
      permAllow,
      // 仅当换 key 的是当前会话才切换显示；后台会话的换 key 不打扰用户正在看的会话
      ...(st.currentSessionPath === cur ? { currentSessionPath: realPath } : {}),
    });
    if (!realAlreadyListed) useApp.getState().markPendingLocalSession(realPath);
    // 各种 sidecar 跟随换 key
    useApp.getState().migrateLastModelKey(cur, realPath);
    useApp.getState().migrateComposerDraft(cur, realPath);
    useApp.getState().migrateSessionStatus(cur, realPath);
    useApp.getState().migrateUncommitted(cur, realPath);
    // 绑定不再需要（key 本身已是真实 path）：留着会让 setSessions 把这条真文件当
    // "已被占位覆盖"而隐藏掉
    useApp.getState().migrateTempRealPath(cur, realPath);
    void rpc.renameKey(cur, realPath).catch(() => undefined);
  }, []);

  /** spawn 之后把 key 换成 omp 分配的真实 sessionFile（幂等；只处理"新建未提交"的会话）。
   *
   *  探针实证（omp 18.3.2）：进程 ready 后 `get_state` 立刻返回真实 `sessionFile`，而
   *  .jsonl 要等首条消息才创建。这里 spawn 完就采用真实 id，好处：
   *   ① 侧栏/指针从第一步就是真实 id，不会再出现 `__new_xxx` 这种假条目；
   *   ② 用户不会看到 id 从"假"跳成"真"；
   *   ③ 进程被淘汰后重新拉起时若 omp 分配了新 id（旧文件从未存在），条目也跟着改到新 id，
   *      不会出现"侧栏 id 与落盘文件不一致"。 */
  /** 同一 key 的 adopt 并发去重。onReady、新建会话、定时任务可能同时 adopt 同一个 tempKey：
   *  先完成的那条会 renameKey，后到的再发 getState 就拿到 "not online" → 循环 3 次后**返回
   *  已失效的 tempKey**，调用方随后任何 RPC 都会报 "omp process not online for session:
   *  __new_xxx"（2026-11-10 定时任务整周失败的直接原因）。共享同一个 Promise 后，所有
   *  并发调用拿到同一个结果。 */
  const adoptInFlight = useRef<Map<string, Promise<string>>>(new Map());

  const adoptRealSessionId = useCallback((key: string): Promise<string> => {
    // 只接管「渲染层新建会话」的 __new_ key：
    //  · 真实 sessionPath 由 omp 自己 -r resume，get_state 必然回同一路径（adopt 无事可做）；
    //  · 飞书/微信桥用的是 __feishu_ / __wecom_ 临时 key，桥在 agent_end 时自己 migrate。
    //    渲染层越权 rename 会把池 entry 抢到真实路径上 → 桥后续 send(临时 key) 报
    //    "not online"，还会让它 acquire 出一个新 .jsonl（会话裂开）。
    if (!key || !key.startsWith(TEMP_KEY_PREFIX)) return Promise.resolve(key);
    const running = adoptInFlight.current.get(key);
    if (running) return running;
    const task = (async (): Promise<string> => {
      for (let i = 0; i < 3; i += 1) {
        const r = await rpc.getState(key).catch(() => null);
        const sf = r && r.success && r.data
          ? (r.data as { sessionFile?: unknown }).sessionFile
          : undefined;
        if (typeof sf === 'string' && sf.length > 0) {
          // 用路径规范化比较：omp 可能回大小写/分隔符不同的同一路径，直接字符串比较会误判成
          // "需要换 key"，导致条目 path 反复抖
          if (pathsEqual(sf, key)) return key; // 已对齐，无需重试
          if (!sf.startsWith(TEMP_KEY_PREFIX)) {
            useApp.getState().bindTempRealPath(key, sf);
            applySessionRekey(key, sf);
            // 返回前确认主进程池已换 key：applySessionRekey 内部那条 renameKey 是
            // fire-and-forget，紧接着发 prompt/set_model 时若它还没到主进程就会再次
            // "not online"（对同一对 key 重复调用是幂等 no-op）。
            await rpc.renameKey(key, sf).catch(() => undefined);
            return sf;
          }
        }
        await new Promise((res) => setTimeout(res, 300));
      }
      return key;
    })().finally(() => { adoptInFlight.current.delete(key); });
    adoptInFlight.current.set(key, task);
    return task;
  }, [applySessionRekey]);

  /** 新会话首条消息 agent_end 后 omp 才落盘 .jsonl。此时把临时 key（__new_ 开头）
   *  迁移成真实文件 path：缓冲/procState 迁移 + 通知主进程 renameKey。
   *  关键：omp 在**收到首条消息前不创建文件**（probe 实证 2026-10-25：spawn 后
   *  get_state 就有 sessionFile，但文件要到 prompt 时才出现），所以 temp 占位的迁移
   *  时机只能落在「提交之后 / 扫盘能看到文件之后」。
   *
   * issue（用户实测）：旧实现只迁移 currentSessionPath——若首条消息跑完前用户切走了
   * 当前会话，agent_end 时 cur 已不是 __new_，迁移被跳过且永不重试 → 侧栏同时出现
   * "新会话"占位 + 真实标题两条目（内容相同）。现改为：
   *   1) 优先迁移事件指定的 tempPath（agent_end 帧自带 __sessionPath，与会话是否在显示无关）；
   *   2) 兜底清扫所有残留的 __new_ 占位；
   *   3) cwd 取占位条目自带的 x.cwd（不再依赖"当前工作空间"——切走后也不失准）；
   *   4) claimedRealPaths 防止多个 temp 认领同一个真实 path。 */
  const migrateTempSession = useCallback(async (tempPath?: string) => {
    const st = useApp.getState();
    // 组装待迁移目标：指定优先，兜底扫残留
    const targets = new Set<string>();
    if (tempPath && tempPath.startsWith('__new_')) targets.add(tempPath);
    else if (st.currentSessionPath?.startsWith('__new_')) targets.add(st.currentSessionPath);
    for (const p of Object.keys(st.procStateMap)) {
      if (p.startsWith('__new_')) targets.add(p);
    }
    // sessions 里的残留占位仅在本运行周期有 procState 时才纳入（防止把上次崩溃遗留的
    // 陈旧占位错误认领到当前工作空间最新的真实会话上）
    for (const p of st.sessions) {
      if (p.path.startsWith('__new_') && st.procStateMap[p.path]) targets.add(p.path);
    }
    for (const cur of targets) {
      if (!cur || !cur.startsWith('__new_')) continue;
      // 并发保护：已在迁移中则跳过，避免重复 setState / renameKey
      if (migratingTempKeys.current.has(cur)) continue;
      migratingTempKeys.current.add(cur);
      const done = () => migratingTempKeys.current.delete(cur);
      // cwd 优先取占位条目自带值（切走当前工作空间后仍准确），退回当前工作空间
      const wsCwd = st.sessions.find((x) => x.path === cur)?.cwd;
      const cwd = wsCwd ?? st.currentWorkspace()?.cwd;
      if (!cwd) { done(); continue; }
      // 真实 path 解析（2026-09-14 修复）：优先用 omp 自报的 sessionFile —— rpc get_state
      // 返回该字段，探针 E3 验证其准确（omp spawn 时即分配好落盘路径）。
      // 旧实现纯靠「新建前快照 + mtime 最新」扫盘猜测，存在误迁到旧会话的风险；
      // 扫盘匹配仅在进程离线 / 取不到 sessionFile 时兜底。
      // 真实 path 解析优先级（2026-10-25 加绑定层）：
      //   ① 该 tempKey 已绑定过真实 sessionFile（get_state 权威值，进程死了也还在）；
      //   ② 此刻 get_state 现拿（进程在线时权威，顺便补绑定）；
      //   ③ 扫盘候选（最后兜底，只在前两条都没有时用——它会"猜"，容易认领错会话）。
      let realPath: string | undefined = useApp.getState().tempRealPath[cur];
      try {
        const r = await rpc.getState(cur);
        if (r.success && r.data) {
          const sf = (r.data as { sessionFile?: unknown }).sessionFile;
          if (typeof sf === 'string' && sf.length > 0 && !sf.startsWith('__new_')) {
            realPath = sf;
            useApp.getState().bindTempRealPath(cur, sf);
          }
        }
      } catch { /* 进程离线 → 用上面的已有绑定，再退回扫盘兜底 */ }
      if (realPath && claimedRealPaths.current.has(realPath)) realPath = undefined;
      if (!realPath) {
        const candidates = st.sessions
          .filter((x) =>
            cwdKey(x.cwd) === cwdKey(cwd)
            && x.path !== cur
            && !knownSessionPathsBeforeNew.current.has(x.path)
            && !claimedRealPaths.current.has(x.path))
          .sort((a, b) => b.mtime - a.mtime);
        realPath = candidates[0]?.path;
      }
      if (!realPath) {
        // 落盘竞态：扫盘时真实 .jsonl 还不可见。安排有限次延迟重试（1.2s × 8 ≈ 10s），
        // 成功或超限后停止；重试前确认目标仍存在（切走时可能已被 discard 清理）。
        done();
        const tries = (migrateRetryCount.current.get(cur) ?? 0) + 1;
        if (tries <= 8) {
          migrateRetryCount.current.set(cur, tries);
          const prev = migrateRetryTimers.current.get(cur);
          if (prev) window.clearTimeout(prev);
          const timer = window.setTimeout(() => {
            migrateRetryCount.current.delete(cur);
            migrateRetryTimers.current.delete(cur);
            const stNow = useApp.getState();
            if (stNow.sessions.some((x) => x.path === cur) || stNow.procStateMap[cur]) {
              // 先重新扫盘（落盘可能刚完成），再迁移
              void refreshSessions()
                .catch(() => undefined)
                .then(() => migrateRef.current(cur));
            }
          }, 1200);
          migrateRetryTimers.current.set(cur, timer);
        }
        continue;
      }
      // 找到了：清理该 temp 的重试状态
      migrateRetryCount.current.delete(cur);
      const pendingTimer = migrateRetryTimers.current.get(cur);
      if (pendingTimer) { window.clearTimeout(pendingTimer); migrateRetryTimers.current.delete(cur); }
      applySessionRekey(cur, realPath);
      done();
    }
  }, [applySessionRekey]);
  // 回填自引用，供落盘竞态重试调度
  migrateRef.current = migrateTempSession;

  /** 新建会话的「乐观选中」（同步，spawn 前调用）：切指针 + 清缓冲。
   *  2026-09-14 串台修复：旧实现 await spawn 完成后才切 currentSessionPath，存在 ~2.8s
   *  空窗期（实测 2524~2951ms），期间输入框可用而指针仍指旧会话 → 回车把 prompt 真实发给
   *  旧会话进程。现在指针在 spawn 前就切走，空窗期不存在。
   *  2026-09-17：这里**不再**往侧栏插占位条目——占位改由首条消息提交时创建（那时名字已就位），
   *  所以回车前侧栏不会出现任何新条目，也就永远不会有「新会话」这种临时标题与真实标题并存。 */
  const resolveAndSelectNewSession = useCallback((newSessionPath: string): void => {
    useApp.getState().setCurrentSessionPath(newSessionPath);
    useApp.getState().resetChat();
    // 新会话统计从零开始，先清掉旧会话残留（refreshState 会重新拉取）
    useApp.getState().setState({ sessionStats: undefined, contextUsage: undefined, tokensPerSecond: undefined });
  }, []);

  /** 加载 workspaces 文件并补全"扫盘发现的但 store 里没有"的工作空间。 */
  const loadAndReconcileWorkspaces = useCallback((): void => {
    void window.omp.getWorkspaces().then(({ file, staleCwds }) => {
      useApp.getState().setWorkspacesFile(file);
      // 恢复上次的外观配置（主题预设 / 背景色 / 字体 / 字号 / 配色模式）
      applyAppearance(useApp.getState().appearance);
      const st = useApp.getState();
      // 清理上一运行周期残留的 temp 记忆（2026-09-17）：`__new_` 是内存态 key，磁盘上不可能
      // 有对应 .jsonl，重启后永远用不到。不清就会随「提交首条消息后没等落盘就退出应用」
      // 逐次累积（覆盖名落 sessionNames、切过的模型落 lastModelMap）。
      const staleNames = Object.keys(st.sessionNames).filter((k) => k.startsWith(TEMP_KEY_PREFIX));
      const staleModels = Object.keys(st.lastModelMap).filter((k) => k.startsWith(TEMP_KEY_PREFIX));
      if (staleNames.length > 0 || staleModels.length > 0) {
        const sessionNames = { ...st.sessionNames };
        for (const k of staleNames) delete sessionNames[k];
        const lastModelMap = { ...st.lastModelMap };
        for (const k of staleModels) delete lastModelMap[k];
        useApp.getState().setState({ sessionNames, lastModelMap });
        useApp.getState().persistWorkspaces();
      }
      // 判定全部收敛到纯函数 planWorkspaceReconcile（可单测）：
      //  - 幽灵防护：会话 cwd 已消失（cwdExists=false）→ 绝不自动造工作区；
      //  - currentId 失效回退：指向已消失目录 → 切到第一个可用工作区并明确提示。
      // 时序（两次调用分工不同，结构不可挪动，详见 plan-ghost-workspace-fix.md）：
      //  - mount 时（workspacesLoaded 置真前）跑第一次：sessions 为空 → 只做 currentId 回退；
      //  - refreshSessions 之后跑第二次：sessions 已带 cwdExists → 幽灵防护在这里生效。
      const plan = planWorkspaceReconcile({
        sessions: st.sessions,
        workspaces: st.workspaces,
        archived: st.archived,
        removedCwds: st.removedCwds,
        staleCwds,
        currentId: st.currentWorkspaceId,
      });
      for (const ws of plan.toAdd) {
        useApp.getState().upsertWorkspace(ws);
      }
      if (plan.nextCurrentId !== st.currentWorkspaceId) {
        useApp.getState().setCurrentWorkspaceId(plan.nextCurrentId);
        const fb = plan.nextCurrentId
          ? useApp.getState().workspaces.find((w) => w.id === plan.nextCurrentId)
          : null;
        pushToast(
          fb
            ? `上次的工作区目录不存在，已切换到「${fb.displayName}」`
            : '上次的工作区目录不存在，请重新打开一个文件夹',
          'error',
        );
      }
      if (plan.changed) useApp.getState().persistWorkspaces();
    }).catch(() => undefined);
  }, [pushToast]);

  // ---- omp 帧订阅（多进程：每帧带 __sessionPath 路由）----
  useEffect(() => {
    const offEvent = window.omp.onEvent((frame: OmpFrame & { __sessionPath?: string }) => {
      const f = frame as { type?: string; __sessionPath?: string };
      const sp = f.__sessionPath;
      const st = useApp.getState();

      if (f.type === 'extension_ui_request') {
        const req = frame as RpcExtensionUIRequest & { __sessionPath?: string };
        handleUiRequest(req, st, pushToast);
        return;
      }
      // 0.5.39：omp resume 时补写的 aborted 终止帧若走帧流下发也要识别。
      // 常规路径是它只落盘（不发帧），由 loadSessionMessages 的 detectCrashInterrupt 覆盖。
      // 这里不 return —— 终止帧仍需照常进 applyAgentEvent 收尾。
      if (f.type === 'message_end' && sp) {
        const m = (frame as { message?: { stopReason?: string; errorMessage?: string } }).message;
        if (m && isCrashAbortedMessage(m)) {
          reportCrashInterrupt(sp, { source: 'aborted', detail: m.errorMessage });
        }
      }
      if (f.type === 'available_commands_update') {
        st.setState({ slashCommands: (frame as AvailableCommandsUpdateFrame).commands ?? [] });
        return;
      }
      if (f.type === 'notice') {
        const n = frame as { message?: string; level?: string };
        if (n.message) {
          // 抑制 omp 启动时的 MCP 挂载噪声：通知消息以 `xd://` 开头说明是 omp 内部扩展协议
          // （如 `xd://: mounted mcp__node_repl_js, mcp__node_repl_js_add_node_module_dir, ...`），
          // 属于每次启动都会刷的运行时注册日志，对用户无意义，弹窗只会污染视线。直接丢弃。
          if (/^xd:\/\//i.test(n.message)) return;
          // omp 18.2.1+（§2.3）：会话存储停止接受写入（磁盘满/文件被锁/盘被移除）时
          // 以 error notice 上报。这是致命错误——除 toast 外标记会话红点，让用户能从侧栏定位。
          if (n.level === 'error' && sp) {
            useApp.getState().markSessionError(sp, n.message);
          }
          pushToast(n.message, n.level ?? 'info');
        }
        return;
      }
      if (f.type === 'thinking_level_changed') {
        const t = frame as { thinkingLevel?: import('../shared/rpc-types').ThinkingLevel };
        if (t.thinkingLevel && sp === useApp.getState().currentSessionPath) {
          st.setState({ thinkingLevel: t.thinkingLevel });
        }
        return;
      }
      // 聊天流事件：按 __sessionPath 路由到对应会话缓冲
      st.applyAgentEvent(frame as Record<string, unknown>);
      if (f.type === 'agent_end') {
        // omp 在 agent_end 时 flush 完整 JSONL，重新扫盘；新会话此时才落盘，迁移 tempKey→realPath。
        // 传入帧自带的 __sessionPath：即使该会话不是当前显示会话（用户已切走），也能正确迁移。
        void refreshSessions().then(() => migrateTempSession(sp));
        // 定时任务执行完成（agent_end = 该次 agent run 正常收尾）→ 回写成功记录
        const autoRun = sp ? automationRuns.current.get(sp) : undefined;
        if (autoRun) {
          automationRuns.current.delete(sp!);
          void window.omp.recordAutomationRun({
            ...autoRun,
            finishedAt: Date.now(),
            status: 'success',
            sessionPath: sp,
          }).catch(() => undefined);
          useApp.getState().pushToast(`✅ 定时任务「${autoRun.taskName}」已完成`, 'info');
        }
        // 仅当 agent_end 来自当前显示会话，才刷新状态栏
        if (sp && sp === useApp.getState().currentSessionPath) {
          void refreshState(sp);
        }
      }
    });

    const offReady = window.omp.onReady((sessionPath: string) => {
      // 首次任意进程 ready → 解除"正在连接"遮罩
      useApp.getState().setReady(true);
      useApp.getState().setOmpExited(null);
      useApp.getState().setProcState(sessionPath, { status: 'online' });
      // ready 的处理顺序（2026-10-25 事故修正）：
      //   ① 先把 key 对齐成 omp 分配的真实 sessionFile；
      //   ② 再用**新 key** 恢复该会话自己的模型。
      // 顺序反了会致命：adopt 的 rpc.renameKey 之后，restore 里发往旧 key 的 set_model
      // 会以 "omp process not online" 失败 → 新会话停在 omp 默认模型（实证：默认模型
      // space-bunny-alpha 在 OpenRouter 已 404，用户看到"模型变了 + 请求失败"）。
      const adopting = adoptRealSessionId(sessionPath);
      const restoring = adopting
        .then((realKey) => restoreSessionModel(realKey))
        .finally(() => {
          // 只清理指向同一 Promise 的条目（换 key 后可能挂在 realKey 上）
          for (const [k, v] of pendingModelRestore.current) {
            if (v === restoring) pendingModelRestore.current.delete(k);
          }
        });
      pendingModelRestore.current.set(sessionPath, restoring);
      // 若 ready 的是当前显示会话，刷新状态栏 + 加载历史
      if (sessionPath === useApp.getState().currentSessionPath) {
        void refreshState(sessionPath).then(() => {
          const st = useApp.getState();
          const resumed = st.sessions.find((x) => x.id === st.sessionId);
          if (resumed && resumed.path === sessionPath) {
            st.loadSessionMessages(resumed.path);
          }
        });
      }
      refreshCommands(sessionPath);
    });

    const offExit = window.omp.onExit(({ sessionPath, code }) => {
      // 定时任务会话进程退出且尚未收到 agent_end → 记失败（正常完成的在 agent_end 已删映射）
      const autoRun = automationRuns.current.get(sessionPath);
      if (autoRun) {
        automationRuns.current.delete(sessionPath);
        void window.omp.recordAutomationRun({
          ...autoRun,
          finishedAt: Date.now(),
          status: 'error',
          error: `会话进程退出 (code=${code ?? 'null'})，任务未正常完成`,
          sessionPath,
        }).catch(() => undefined);
        useApp.getState().pushToast(`⚠️ 定时任务「${autoRun.taskName}」异常中止`, 'error');
      }
      // 0.5.39 / 0.5.40：进程崩溃导致上一轮中断 → 立刻上报（右下角红色 toast + 侧栏红点）。
      // 判据：进程真的退出了（code===null 是池淘汰，不算）、不是切权限模式的主动重启、
      // 且退出时该会话确实还在跑一个 turn（isStreaming）。必须在 clearSessionProc 清状态前取快照。
      const psBefore = useApp.getState().procStateMap[sessionPath];
      const selfRestart = selfRestartKeys.current.has(sessionPath);
      if (code !== null && !selfRestart && psBefore?.isStreaming) {
        reportCrashInterrupt(sessionPath, { source: 'exit', detail: `退出码 ${code}` });
      }
      // 0.5.21：清理逻辑提取为 clearSessionProc（reconcile/healFromDisk 失联路径复用）
      clearSessionProc(sessionPath, { exitedCode: code });
      // 主动重启（切权限模式）触发的退出：跳过下面的 temp 丢弃/迁移与崩溃自愈，
      // 由发起方 acquire 新权限模式的进程（否则 temp 占位会被 discardTempSession 删掉）。
      if (selfRestartKeys.current.delete(sessionPath)) return;
      // 「新建未提交」会话进程退出（LRU 淘汰 / 崩溃 / 权限切换）：
      // **只有确实没留下任何东西**才丢（无消息、无草稿、从没提交过）；
      // 否则一律走下面的通用流程（可能是崩溃 → 自动恢复），绝不能在这里清掉用户的内容。
      // 2026-10-25 事故：abort 后进程退出，此处把它当"空会话"清掉，连磁盘文件一起删了。
      const stx0 = useApp.getState();
      if (stx0.uncommittedSessions[sessionPath] && !committedKeys.current.has(sessionPath)) {
        const dft = stx0.composerDrafts[sessionPath];
        const hasDraft = !!dft && (dft.text.trim() !== '' || dft.attachments.length > 0);
        const hasMsgs = (stx0.sessionsMap[sessionPath]?.length ?? 0) > 0;
        if (!hasMsgs && !hasDraft && !tempSubmittedKeys.current.has(sessionPath)) {
          discardNewSession(sessionPath);
          return;
        }
      }
      // temp 会话进程退出（含 evict 的 code=null，如权限切换/池淘汰）：先迁移再考虑恢复。
      // 旧实现只在 code!==0 时走迁移 → evict 路径下 tempKey 永不迁移，指针滞留死 key，
      // 之后 ensureOnline/acquire(tempKey) 对一个磁盘上不存在的 key 全新 spawn →
      // 一个用户会话裂成两个 .jsonl（实证 2026-09-14 bet_zp：01a0a046 被杀后 spawn 出 01a0a048）。
      if (sessionPath.startsWith(TEMP_KEY_PREFIX)) {
        // 从未提交过消息的 temp 不可能落盘（omp 只在收到 prompt 后才写 .jsonl）：直接丢弃。
        // 走迁移反而有风险——扫盘兜底判据无法区分「哪个新会话是它的」，可能把指针认领到
        // 同 cwd 里的别的会话上（2026-09-17）。
        if (!tempSubmittedKeys.current.has(sessionPath)) {
          discardNewSession(sessionPath);
          return;
        }
        void refreshSessions()
          .then(() => migrateTempSession(sessionPath))
          .then(() => {
            const st2 = useApp.getState();
            // 已迁移：指针/缓冲已切到真实 path，后续 acquire(-r) 完整续接，无需更多动作
            if (!st2.procStateMap[sessionPath]) return;
            // 确实没落盘（用户从未发消息）：上下文本就不存在，仅清占位。
            // 不再对 tempKey respawn —— 那会凭空造出一个孤儿 .jsonl。
            discardNewSession(sessionPath);
          });
        return;
      }
      // 自动恢复：非正常退出（code !== 0）且非用户主动 release，延迟后尝试重新拉起。
      // 避免崩溃后用户必须手动切换再切回才能继续。
      if (code !== 0 && code !== null) {
        const st = useApp.getState();
        const ws = st.workspaces.find((w) => st.sessions.some((s) => s.path === sessionPath && cwdKey(s.cwd) === cwdKey(w.cwd)));
        // 兜底：新建会话在侧栏还没有条目（未提交/刚创建）时 sessions 里查不到 →
        // 用 tempCwdRef（rekey 时已迁到真实 key）拿 cwd，否则崩溃后不会自动恢复。
        const cwd = ws?.cwd ?? tempCwdRef.current.get(sessionPath) ?? st.currentWorkspace()?.cwd;
        if (cwd) {
          const approvalMode = ws?.approvalMode ?? 'yolo';
          setTimeout(() => {
            // 仅当该会话仍处于 offline 状态时才恢复（避免用户已手动操作）
            const psNow = useApp.getState().procStateMap[sessionPath];
            if (psNow?.status !== 'offline') return;
            void rpc.acquire(sessionPath, cwd, approvalMode)
              .then(() => {
                const stNow = useApp.getState();
                // 0.5.39 / 0.5.40：不能只说「已自动恢复」——用户会以为被中断的那一轮会自动接着跑。
                // 崩溃中断时把右下角那条红色 toast 的文案更新成「已重连但不会自动继续」，
                // 仍带「重发上一条」；同会话旧 toast 会被替换，不会叠两条。
                const crashed = !!stNow.crashInterrupted[sessionPath];
                if (crashed) pushCrashInterruptToast(sessionPath, CRASH_RECOVER_TOAST);
                else stNow.pushToast('会话进程已自动恢复', 'info');
                // 如果恢复的是当前显示会话，清除退出标记
                if (sessionPath === stNow.currentSessionPath) {
                  stNow.setOmpExited(null);
                }
              })
              .catch(() => {
                // 恢复失败不弹错：右下角红色 toast + 侧栏红点已指明需要重新发送，
                // 用户手动切换会话会再触发 acquire。
              });
          }, 2000);
        }
      }
    });

    const offStderr = window.omp.onStderr(({ line }) => {
      useApp.getState().pushStderr(line);
    });

    return () => { offEvent(); offReady(); offExit(); offStderr(); };
  }, [pushToast, refreshState, refreshSessions, refreshCommands, restoreSessionModel, migrateTempSession, adoptRealSessionId]);

  // 渲染进程挂载：加载 workspaces，完成后通知主进程 renderer 就绪（多进程下主进程不再直接起 omp）
  const workspacesLoaded = useApp((s) => s.workspacesLoaded);
  useEffect(() => {
    loadAndReconcileWorkspaces();
  }, [loadAndReconcileWorkspaces]);
  useEffect(() => {
    if (workspacesLoaded) {
      // issue 85: notifyReady 不再传 initialCwd（主进程 handler 为 no-op，pool 按需 lazy acquire）
      void window.omp.notifyReady();
      // 启动即拉取磁盘技能清单：侧栏"技能"卡片计数与技能页同源。
      // 此前卡片在 skills 未加载时回退到 slashCommands（omp 运行时挂载命令，含内置/插件技能），
      // 导致卡片显示 13、点进技能页磁盘扫描只有 8 的不一致（issue 用户实测）。
      void window.omp.skillsList()
        .then((list) => useApp.getState().setSkills(list))
        .catch(() => undefined); // 主进程不可用等静默，SkillsPanel 挂载时会再刷
    }
  }, [workspacesLoaded]);


  // ---- 键盘快捷键 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 't') {
        // 模型未知（会话未拉起 / get_state 未返回）时不拦截：
        // 与 ThinkingPicker 一致——有模型就允许循环（哪怕 omp 没给 thinking 元数据）。
        if (!useApp.getState().model) return;
        e.preventDefault();
        const sp = useApp.getState().currentSessionPath;
        if (sp) void rpc.cycleThinkingLevel(sp).catch(() => undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- 用户操作 ----
  /** 发送/引导/排队前的会话 key 解析：temp 会话若进程已离线（被杀/淘汰/退出），
   *  先尝试迁移到已落盘的真实 .jsonl——否则 acquire(tempKey) 会因 tempKey 在磁盘上
   *  不存在而全新 spawn，一个用户会话裂成两个（实证 2026-09-14 bet_zp）。
   *  进程在线或确实未落盘时原样返回。 */
  const resolveSessionKey = useCallback(async (sp: string): Promise<string> => {
    if (!sp.startsWith(TEMP_KEY_PREFIX)) return sp;
    if (useApp.getState().procStateMap[sp]?.status === 'online') return sp;
    // 2026-10-25：tempKey 已绑定真实 sessionFile 且磁盘上已有该文件 → 先迁移到真实 path。
    // 之后 acquire 会带 -r 续接自己的会话；不迁移的话 acquire(tempKey) 会**全新 spawn**，
    // omp 分配一个全新 sessionId（用户实证：__new_x 继续对话后 id 变成第三个 01a17143，
    // 内容裂在两个 .jsonl 里）。
    const bound = useApp.getState().tempRealPath[sp];
    if (bound) {
      const tail = await window.omp.sessionTail(bound).catch(() => null);
      if (tail) {
        await refreshSessions();
        await migrateTempSession(sp);
        const after = useApp.getState();
        // 迁移成功会让绑定消失（key 已变成真实 path）
        if (!(sp in after.tempRealPath)) return bound;
      }
    }
    // 从未提交过消息的 temp 不可能已落盘（omp 只在收到 prompt 后才写 .jsonl）：此时迁移
    // 只会把指针挪到别的路径上，随后上架的侧栏条目反而失去归属，还可能靠扫盘兜底误认领
    // 同 cwd 里的其它新会话。这种情况按原 key 继续 acquire 即可（2026-09-17）。
    if (!tempSubmittedKeys.current.has(sp)) return sp;
    // 进程离线：落盘过的 temp 会话（首条消息后 omp 即流式写盘，无需等 agent_end）
    // 一定已能被扫盘看到。migrateTempSession 会把指针/缓冲/pool key 全部迁到真实 path。
    await refreshSessions();
    await migrateTempSession(sp);
    const now = useApp.getState();
    // 迁移成功：返回真实 path（acquire 会带 -r 续接，上下文完整）
    if (!now.procStateMap[sp] && now.currentSessionPath) return now.currentSessionPath;
    return sp;
  }, [refreshSessions, migrateTempSession]);

  /** 新会话首条消息提交时的「取名 + 上架」：先按输入首行（退回附件名）生成会话名，写入
   *  host 侧覆盖层 sessionNames，再把占位条目插进侧栏——顺序保证侧栏里出现的第一个状态
   *  就已经是「有名字的会话」，全程不会出现「新会话」这种临时标题（2026-09-17 需求）。
   *  调用点在 onSend/onGuide/onQueue 的 rpc.acquire 之后、rpc.prompt 之前：名字先于 prompt
   *  生效，用户看到条目时消息尚未发给 LLM。temp→real 迁移时 migrateTempSession 会把覆盖名
   *  一并迁到真实 path（持久化不丢）。
   *  判据见 utils/temp-session.deriveSessionName（与主进程 titleFallback 同源）；用户已手动
   *  命名（覆盖层存在且不是占位/兜底值）时不覆盖，但条目仍要上架。 */
  const autoNameTempSession = useCallback((key: string, text: string, attachments?: Attachment[]) => {
    // 只给「新建未提交」的会话自动取名（key 可能已经是真实 sessionFile，不再是 __new_）
    if (!useApp.getState().uncommittedSessions[key]) return;
    const st = useApp.getState();
    const existing = st.sessionNames[key];
    const alreadyNamed = !!existing && existing !== LEGACY_TEMP_TITLE && existing !== UNNAMED_SESSION;
    if (!alreadyNamed) {
      st.renameSession(key, deriveSessionName(text, attachments?.[0]?.name));
    }
    // 上架：名字写完之后，条目才出现在侧栏（先取名，后出现）
    const cwd = tempCwdRef.current.get(key);
    if (cwd) useApp.getState().upsertSessionPlaceholder(key, cwd);
  }, []);

  /** 新会话「有草稿即上架」（2026-10-25 bug 3 修复）。
   *
   *  此前占位只在「提交首条消息」时创建：用户在全新会话里打字、还没回车就切走，
   *  侧栏里根本没有这条会话 —— 观感就是「新会话不见了」，而且再也点不回去（草稿还在
   *  store 里但无从进入）。现在草稿一变就在侧栏把条目建出来，名字取草稿首行（与提交时
   *  同一套 deriveSessionName，提交那一刻 autoNameTempSession 见已有名字不会再覆盖）；
   *  草稿被清空且从未提交过 → 条目一并撤掉，不留空壳。
   *
   *  监听 store 而不是在 InputBox 里加回调：草稿可能被多处写入（粘贴、回填、发送失败
   *  回滚），这里统一兜住。 */
  // 自动派生的会话名（key = tempKey）：只有名字还是"我们自动取的那一版"时才允许随着
  // 用户继续输入更新；用户手动改过的名字绝不覆盖。
  const autoDerivedNames = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const off = useApp.subscribe((state, prev) => {
      if (state.composerDrafts === prev.composerDrafts) return;
      const sp = state.currentSessionPath;
      // 只有「新建未提交」的会话才需要草稿上架（用户打了一半就跑，条目不能丢）
      if (!sp || !state.uncommittedSessions[sp]) return;
      const draft = state.composerDrafts[sp];
      const hasContent = !!draft && (draft.text.trim() !== '' || draft.attachments.length > 0);
      const listed = state.sessions.some((x) => x.path === sp);
      // 已在迁移/丢弃流程中或已提交过消息：交给原有路径处理，别在这里插/删条目
      if (tempSubmittedKeys.current.has(sp) || (state.sessionsMap[sp]?.length ?? 0) > 0) return;
      if (hasContent && !listed) {
        const cwd = tempCwdRef.current.get(sp);
        if (!cwd) return;
        // 微任务里执行：subscribe 回调内直接 setState 会重入本订阅
        queueMicrotask(() => {
          const st = useApp.getState();
          // 不做「必须仍是当前会话」的判断：用户打完字立刻切走，恰恰就是最需要这条
          // 侧栏条目的场景（否则草稿留着却无从点回去）。
          if (!tempCwdRef.current.has(sp)) return; // temp key 已丢弃
          // 名字跟输入一起长：首行还没打完时 deriveSessionName 会返回兜底名，
          // 用户继续输入就该更新成真正的首行（仅当名字仍是自动派生的那一版）。
          const derived = deriveSessionName(draft!.text, draft!.attachments[0]?.name);
          const cur = st.sessionNames[sp];
          const prevAuto = autoDerivedNames.current.get(sp);
          if (!cur || cur === prevAuto || cur === UNNAMED_SESSION) {
            if (cur !== derived) st.renameSession(sp, derived);
            autoDerivedNames.current.set(sp, derived);
          }
          st.upsertSessionPlaceholder(sp, tempCwdRef.current.get(sp) ?? cwd);
        });
      } else if (!hasContent && listed) {
        queueMicrotask(() => {
          const st = useApp.getState();
          if (tempSubmittedKeys.current.has(sp)) return; // 期间已提交，交给迁移路径
          st.setState({ sessions: st.sessions.filter((x) => x.path !== sp) });
        });
      }
    });
    return off;
  }, []);

  const onSend = useCallback((text: string, attachments?: Attachment[]) => {
    const st = useApp.getState();
    let sp = st.currentSessionPath;
    if (!sp) {
      pushToast('请先选择一个会话', 'error');
      return;
    }
    const cwd = st.currentWorkspace()?.cwd ?? '';
    const approvalMode = st.currentWorkspace()?.approvalMode ?? 'yolo';
    // 图片始终通过 prompt.images 内联发送（与原生 OMP 行为一致）。
    // omp 运行时会自动处理：视觉模型直接看图；纯文本 orchestrator 则通过 vision 角色
    // 预处理生成图片描述注入上下文（image-attachment-description 帧）。
    // 关键：images 必须是「图片对象数组」(RpcImage)，裸字符串数组会被 OMP 当文本透传。
    // 更进一步：对象须带 blob:sha256: URI（经 omp blob 入库）才能触发 vision 路由，
    // 等同原生 OMP 的 @image.png 入库机制（见 probe-blob*.mjs / probe-img-shapes.mjs 实测）。
    const promptText = buildPromptWithAttachments(text, attachments);
    // 提交瞬间就「上架」（同步，在任何 await 之前）：新会话一提交就必须在侧栏有名字，
    // 否则用户在 acquire/prompt 的 await 窗口里切走 → 会话既看不见、也再回不去，
    // 要等落盘扫盘才出现（2026-10-25 bug 3）。同时打「提交中」标记，防止切走时被
    // onSelectSession 当成空的新会话丢弃。
    if (sp.startsWith(TEMP_KEY_PREFIX)) tempSubmittedKeys.current.add(sp);
    if (useApp.getState().uncommittedSessions[sp]) autoNameTempSession(sp, text, attachments);
    const doSend = async () => {
      const imageRefs = await collectImageRefs(attachments, (name) =>
        pushToast(`图片 ${name} 读取失败，已跳过`, 'error'),
      );
      // temp key 进程若已离线：先迁移到落盘的 realPath，避免 acquire(tempKey) 全新
      // spawn 裂出第二个会话（2026-09-14 bet_zp 事故根因）。
      let key = await resolveSessionKey(sp!);
      await rpc.acquire(key, cwd, approvalMode);
      // 新建会话若刚被重新拉起（旧 id 的文件从未存在），omp 会分配新的 sessionFile：
      // 把条目/指针改到新 id 上，避免"侧栏 id 与实际落盘文件不一致"。
      key = await adoptRealSessionId(key);
      // 刚 spawn 的进程模型恢复可能还在途：等它落地再 prompt，否则首条消息会跑在
      // config 默认模型（通常是别处刚选过的那个）上。
      await awaitModelRestore(key);
      // 显式传 key（2026-09-14 修复 P0-3）：appendUserMessage 内部不再重读 currentSessionPath，
      // 杜绝两次 await 之间指针切换导致「气泡进 X、prompt 进 Y」。
      useApp.getState().appendUserMessage(text, { attachments }, key);
      if (key.startsWith('__new_')) tempSubmittedKeys.current.add(key);
      autoNameTempSession(key, text, attachments);
      // 消息已进缓冲 = 该会话不再是"空的新会话"（切走时不该被丢弃）
      useApp.getState().commitSession(key);
      committedKeys.current.add(key);
      await rpc.prompt(key, promptText, imageRefs);
      refreshSessions();
    };
    void doSend().catch((err) => {
      // 发送失败：正文还回该会话草稿（InputBox 提交时已清空），用户不必重打。
      // 也没必要让会话保持「已提交」——空 temp 交回切走时的清理逻辑。
      const stNow = useApp.getState();
      if (!(stNow.composerDrafts[sp!]?.text ?? '').trim()) stNow.setComposerText(sp!, text);
      if (!(stNow.sessionsMap[sp!]?.length ?? 0)) tempSubmittedKeys.current.delete(sp!);
      pushToast(`发送失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    });
  }, [pushToast, refreshSessions, resolveSessionKey, autoNameTempSession]);

  /** 0.5.39 / 0.5.40：重发上一条用户消息（仅文本，附件需重新添加）。
   *  右下角红色 toast 的按钮入口；只作用于当前显示会话，避免串台。 */
  const resendLast = useCallback((sessionPath?: string) => {
    const st = useApp.getState();
    const path = sessionPath ?? st.currentSessionPath ?? '';
    if (!path) return;
    if (path !== st.currentSessionPath) {
      st.pushToast('请先切回该会话，再点「重发上一条」', 'warning');
      return;
    }
    const text = (
      st.crashInterrupted[path]?.lastUserText
      ?? lastUserTextFromChat(st.sessionsMap[path] ?? [])
    ).trim();
    if (!text) {
      st.pushToast('没找到可重发的上一条消息，请手动输入', 'warning');
      return;
    }
    st.clearCrashInterrupted(path);
    onSend(text);
  }, [onSend]);

  /** Help 菜单 "Stats" 子项：等同于在当前会话输入 /stats 并提交。 */
  useEffect(() => {
    const off = window.omp.onMenuStats(() => onSend('/stats'));
    return off;
  }, [onSend]);

  /** 引导（steer mid-run）：生成中途按 Enter → omp 在当前 tool 完成后立即按新方向继续，
   *  跳过剩余 tool 队列，再走一次模型。空闲时同 onSend 的效果。 */
  const onGuide = useCallback((text: string, attachments?: Attachment[]) => {
    const st = useApp.getState();
    let sp = st.currentSessionPath;
    if (!sp) {
      pushToast('请先选择一个会话', 'error');
      return;
    }
    const cwd = st.currentWorkspace()?.cwd ?? '';
    const approvalMode = st.currentWorkspace()?.approvalMode ?? 'yolo';
    const promptText = buildPromptWithAttachments(text, attachments);
    // 同步上架 + 提交中标记（同 onSend，见那里的注释）
    if (sp.startsWith(TEMP_KEY_PREFIX)) tempSubmittedKeys.current.add(sp);
    if (useApp.getState().uncommittedSessions[sp]) autoNameTempSession(sp, text, attachments);
    const doGuide = async () => {
      const imageRefs = await collectImageRefs(attachments, (name) =>
        pushToast(`图片 ${name} 读取失败，已跳过`, 'error'),
      );
      // 同 onSend：temp key 进程离线时先迁移到落盘 realPath，避免分裂
      let key = await resolveSessionKey(sp!);
      await rpc.acquire(key, cwd, approvalMode);
      key = await adoptRealSessionId(key);
      await awaitModelRestore(key);
      useApp.getState().appendUserMessage(text, { steered: true, attachments }, key);
      if (key.startsWith('__new_')) tempSubmittedKeys.current.add(key);
      autoNameTempSession(key, text, attachments);
      useApp.getState().commitSession(key);
      committedKeys.current.add(key);
      await rpc.steer(key, promptText, imageRefs);
      refreshSessions();
    };
    void doGuide().catch((err) => {
      const stNow = useApp.getState();
      if (!(stNow.composerDrafts[sp!]?.text ?? '').trim()) stNow.setComposerText(sp!, text);
      if (!(stNow.sessionsMap[sp!]?.length ?? 0)) tempSubmittedKeys.current.delete(sp!);
      pushToast(`引导失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    });
  }, [pushToast, refreshSessions, resolveSessionKey, autoNameTempSession]);

  /** 排队（follow_up）：等当前 agent turn 跑完再处理（不打断当前 tool/t）。 */
  const onQueue = useCallback((text: string, attachments?: Attachment[]) => {
    const st = useApp.getState();
    let sp = st.currentSessionPath;
    if (!sp) {
      pushToast('请先选择一个会话', 'error');
      return;
    }
    const cwd = st.currentWorkspace()?.cwd ?? '';
    const approvalMode = st.currentWorkspace()?.approvalMode ?? 'yolo';
    const promptText = buildPromptWithAttachments(text, attachments);
    // 同步上架 + 提交中标记（同 onSend，见那里的注释）
    if (sp.startsWith(TEMP_KEY_PREFIX)) tempSubmittedKeys.current.add(sp);
    if (useApp.getState().uncommittedSessions[sp]) autoNameTempSession(sp, text, attachments);
    const doQueue = async () => {
      const imageRefs = await collectImageRefs(attachments, (name) =>
        pushToast(`图片 ${name} 读取失败，已跳过`, 'error'),
      );
      // 同 onSend：temp key 进程离线时先迁移到落盘 realPath，避免分裂
      let key = await resolveSessionKey(sp!);
      await rpc.acquire(key, cwd, approvalMode);
      key = await adoptRealSessionId(key);
      await awaitModelRestore(key);
      // 显式传 key（同 onSend，P0-3）：气泡与 follow_up 目标必须同一会话
      useApp.getState().appendUserMessage(text, { queued: true, attachments }, key);
      if (key.startsWith('__new_')) tempSubmittedKeys.current.add(key);
      autoNameTempSession(key, text, attachments);
      useApp.getState().commitSession(key);
      committedKeys.current.add(key);
      await rpc.followUp(key, promptText, imageRefs);
      refreshSessions();
    };
    void doQueue().catch((err) => {
      const stNow = useApp.getState();
      if (!(stNow.composerDrafts[sp!]?.text ?? '').trim()) stNow.setComposerText(sp!, text);
      if (!(stNow.sessionsMap[sp!]?.length ?? 0)) tempSubmittedKeys.current.delete(sp!);
      pushToast(`排队失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    });
  }, [pushToast, refreshSessions, resolveSessionKey, autoNameTempSession]);

  // 中止当前 agent 轮
  const onAbort = useCallback(() => {
    const st = useApp.getState();
    const sp = st.currentSessionPath;
    if (!sp) return;
    // 改用 per-session 状态机制：设置当前会话 procState，并按需同步全局状态供 UI 显示
    st.setProcState(sp, { isAborting: true, isStreaming: false });
    if (sp === st.currentSessionPath) st.setState({ isAborting: true, isStreaming: false });
    void rpc.abort(sp)
      .then(() => {
        setTimeout(() => {
          const stNow = useApp.getState();
          const ps = stNow.procStateMap[sp];
          if (ps?.isAborting) {
            stNow.setProcState(sp, { isAborting: false });
            if (sp === stNow.currentSessionPath) stNow.setState({ isAborting: false });
          }
        }, 3000);
      })
      .catch(() => {
        const stNow = useApp.getState();
        stNow.setProcState(sp, { isAborting: false });
        if (sp === stNow.currentSessionPath) stNow.setState({ isAborting: false });
      });
  }, []);

  // ---- 流式看门狗：检测"生成中但长时间无任何帧"的疑似卡死会话 + 流式状态对账自愈 ----
  // 背景（实证 session 01a02a7c）：omp 工具执行无超时，eval 挂死 9h38m 期间不发任何帧，
  // UI 的 isStreaming 只认 agent_end，于是永远显示"生成中"。
  // 背景 2（2026-09-16 实证 session 01a0a638，橙点常亮）：omp 的 agent 循环异常/中止路径
  // **不补发 agent_end 帧**（二进制内嵌源码：FG.fail 只 reject），回合结束后帧流戛然而止，
  // procStateMap.isStreaming 卡 true → 侧栏橙点不灭。
  // 这里每 30s 扫描 procStateMap：
  //   - 静默超阈值（10min）：先做 P1 磁盘对账（jsonl 尾部 stop 收尾 → turn 必然已完结，
  //     自愈不依赖 omp RPC——0.5.21，01a0cc6c 事故：exit 丢失 + RPC 失败双向盲区）；
  //   - 在线会话：向 omp get_state 对账。omp 报已结束 → 重置本侧镜像（橙点解除）；
  //     对账失败 → 计数，连续 3 次（或 not online 即刻）按失联清理；omp 仍在跑且
  //     静默 >= STUCK_AFTER_MS → 标记 stuckSince + toast 警告（每轮只提示一次）。
  //   - 恢复收帧时 applyAgentEvent 会刷新 lastFrameAt 并清 stuckSince → 自动解除
  // 阈值取 10 分钟：正常长工具调用（bash/网页抓取）可能合法静默数分钟。
  useEffect(() => {
    const STUCK_AFTER_MS = 10 * 60 * 1000;
    const timer = window.setInterval(() => {
      const st = useApp.getState();
      const now = Date.now();
      for (const [path, ps] of Object.entries(st.procStateMap)) {
        if (!ps.isStreaming) continue;
        const silentMs = now - (ps.lastFrameAt ?? 0);
        if (ps.status === 'online') {
          // 在线：以 omp 内部 isStreaming 为权威真值对账（自愈/挂死提示都由此触发）
          void reconcileStreamingState(path, STUCK_AFTER_MS);
        } else {
          // 非 online（spawning 等过渡态）：退回纯静默判定
          if (!ps.lastFrameAt) continue;
          if (silentMs >= STUCK_AFTER_MS && !ps.stuckSince) {
            st.setProcState(path, { stuckSince: ps.lastFrameAt });
            const label = path.split(/[\\/]/).pop() ?? path;
            st.pushToast(
              `⚠️ 会话 ${label} 已 ${Math.round(silentMs / 60000)} 分钟无任何响应，疑似卡死（工具可能挂死）。可点输入框停止按钮强制中断。`,
              'warning',
            );
          }
        }
        // P1 磁盘对账（0.5.21）：与 RPC 对账并行——RPC 挂死/失联时它也能独立自愈
        if (silentMs >= STUCK_AFTER_MS) void healFromDisk(path);
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  /** 新建会话防重入：StrictMode/双击/重复点击会让 acquireNew 并发拉起两个 omp 进程、
   *  产生两个 temp key——其中一个永远等不到消息、无法落盘迁移，成为孤儿占位
   *  （实证 2026-08-24 23:15:37/:47 双 spawn，后续引发切死进程后误开全新 .jsonl）。 */
  const creatingSession = useRef(false);

  const onNewSession = useCallback(async (cwd?: string): Promise<boolean> => {
    if (creatingSession.current) {
      pushToast('已在新建会话中，请稍候', 'info');
      return false;
    }
    creatingSession.current = true;
    // 同步到 store（P0-2 双保险）：InputBox 在此期间冻结输入，即使还有别的时序分支，
    // 也不会把消息投给旧会话。
    useApp.getState().setState({ creatingSession: true });
    try {
      // doNewSession 声明在本函数之后（const TDZ），不能进依赖数组；
      // 它是稳定 useCallback（依赖 pushToast / resolveAndSelectNewSession 均稳定），闭包不会过期。
      return await doNewSession(cwd);
    } finally {
      creatingSession.current = false;
      useApp.getState().setState({ creatingSession: false });
    }
  }, [pushToast]);

  const doNewSession = useCallback(async (cwd?: string): Promise<boolean> => {
    useApp.getState().setMainView('chat');
    const st = useApp.getState();
    // 2026-09-17：占位不再在新建时插入，未提交的空 temp 在侧栏完全不可见——连点两次
    // 「新建会话」就会留下一个既看不见、也删不掉的进程（旧实现的残留占位至少还能手动删）。
    // 这里主动丢弃：只丢「从未提交过消息」的，已提交的留给 agent_end 正常迁移。
    const stale = st.currentSessionPath;
    // 同上：有草稿的会话（用户写了一半）不丢，留给用户切回去继续写
    const staleDraft = stale ? st.composerDrafts[stale] : undefined;
    const staleHasDraft = !!staleDraft
      && (staleDraft.text.trim() !== '' || staleDraft.attachments.length > 0);
    if (stale && st.uncommittedSessions[stale] && !tempSubmittedKeys.current.has(stale)
        && !staleHasDraft) {
      discardNewSession(stale);
    }
    const targetCwd = cwd ?? st.currentWorkspace()?.cwd;
    if (!targetCwd) {
      pushToast('请先选择或新建一个工作空间', 'error');
      return false;
    }
    const targetMode = st.workspaces.find((w) => cwdKey(w.cwd) === cwdKey(targetCwd))?.approvalMode ?? 'yolo';
    const target = st.workspaces.find((w) => cwdKey(w.cwd) === cwdKey(targetCwd));
    if (target && st.currentWorkspaceId !== target.id) {
      st.setCurrentWorkspaceId(target.id);
      st.persistWorkspaces();
    }
    // tempKey 渲染层生成（替代旧实现"主进程 spawn 完才返回 path 再切指针"）：
    // 先切指针 + 占位，再 await spawn —— 空窗期不存在，期间发送的消息会正确路由到
    // tempKey 进程（pool.acquire 对在途 spawning 的同 key 会复用同一个 pending promise）。
    const tempKey = TEMP_KEY_PREFIX + randomUUID();
    // 侧栏占位要到首条消息提交时才创建，那时已经离开本函数作用域 —— cwd 先记下来
    tempCwdRef.current.set(tempKey, targetCwd);
    // 「新建未提交」标记：spawn 后 key 会立刻换成真实 sessionFile，标记跟着迁移
    useApp.getState().markUncommitted(tempKey);
    const prevSessionPath = st.currentSessionPath;
    // 先快照当前已知真实 path，tempKey→realPath 迁移时用它识别真正的新会话（兜底路径），避免误迁到旧会话。
    knownSessionPathsBeforeNew.current = new Set(
      st.sessions.map((s) => s.path).filter((p) => !p.startsWith(TEMP_KEY_PREFIX)),
    );
    resolveAndSelectNewSession(tempKey);
    let adoptedKey = tempKey;
    try {
      pushToast('正在新建会话…', 'info');
      // 多进程：spawn 不带 -c（新 .jsonl），tempKey 已在上方先行选中
      await rpc.newSessionForCwd(tempKey, targetCwd, targetMode);
      useApp.getState().setProcState(tempKey, { status: 'online' });
      // spawn 完立刻采用 omp 分配的真实 sessionFile（探针实证 ready 即可拿到，文件稍后才建）：
      // 侧栏和指针从第一步就是真实 id，永远不会出现 __new_xxx 假条目、也不会再"id 跳变"。
      adoptedKey = await adoptRealSessionId(tempKey);
      // adopt 换了 key 之后按新 key 应用模型（新会话沿用最后一次选的模型）：
      // onReady 里那条链可能还挂在新 spawn 的旧 key 上，这里串一次保证落定。
      await restoreSessionModel(adoptedKey);
      await refreshSessions();
      await refreshState(adoptedKey);
      return true;
    } catch (e) {
      // spawn 期间用户已离开并丢弃了该新会话（discardNewSession 会清 tempCwdRef，pool 随之中止 spawn）：
      // 属预期取消，占位与指针已处理完毕，不回滚、不报错
      if (!tempCwdRef.current.has(adoptedKey) && !tempCwdRef.current.has(tempKey)) return false;
      // spawn 失败：清占位 + 回滚指针，避免留下一个没有进程的僵尸会话。
      // discardNewSession 声明在本函数之后（const TDZ），不能进依赖数组；其依赖
      // 稳定（refs + rpc），闭包捕获首个 render 的实例，行为一致。
      discardNewSession(adoptedKey);
      if (adoptedKey !== tempKey) discardNewSession(tempKey);
      if (!useApp.getState().currentSessionPath && prevSessionPath && !prevSessionPath.startsWith('__new_')) {
        useApp.getState().setCurrentSessionPath(prevSessionPath);
        useApp.getState().loadSessionMessages(prevSessionPath);
      }
      pushToast(`新建会话失败：${e instanceof Error ? e.message : String(e)}`, 'error');
      return false;
    }
  }, [pushToast, resolveAndSelectNewSession, refreshSessions, refreshState, adoptRealSessionId, restoreSessionModel]);

  // 启动时加载会话列表，初始化首个显示会话（取 currentWorkspace 下 mtime 最大者，懒 acquire）
  useEffect(() => {
    if (!workspacesLoaded) return;
    void refreshSessions().then(() => {
      loadAndReconcileWorkspaces();
      const st = useApp.getState();
      const cwd = st.currentWorkspace()?.cwd;
      if (!cwd) {
        // 无可用工作区（首次启动 / 全部目录失效 / 被清空）：明确引导，绝不静默卡死。
        // 目录失效的 currentId 已由 loadAndReconcileWorkspaces 预切回退；这里只兜"一个可用都没有"。
        pushToast('还没有可用的工作区，请点击侧栏「打开文件夹」选择一个目录', 'info');
        return;
      }
      // P1 护栏（2026-09-14 修复）：仅当当前没有任何选中会话时才自动选 mtime 最新会话。
      // 旧实现无条件抢指针——用户已进入某个（新）会话时会被强行切回旧会话。
      if (st.currentSessionPath) return;
      const newest = st.sessions
        .filter((x) => cwdKey(x.cwd) === cwdKey(cwd))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (newest) {
        st.setCurrentSessionPath(newest.path);
        st.loadSessionMessages(newest.path);
        // 懒拉起该会话的进程（带 -c 续接历史）。
        // 失败只 toast，不级联换工作区重试 —— 对有效 cwd 的失败大概率是 omp 瞬时问题
        // （二进制缺失/端口占用），盲目换工作区会在错误目录偷偷新建会话。
        const approvalMode = st.currentWorkspace()?.approvalMode ?? 'yolo';
        void rpc.acquire(newest.path, cwd, approvalMode).catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          // spawn 中途被主动释放/重载（pool evict 中止 spawn）属预期，不报错
          if (/spawn aborted/.test(msg)) return;
          pushToast(`拉起会话失败：${msg}`, 'error');
        });
      } else {
        // 当前工作空间没有任何会话（例如用户手动清空了 .omp/agent/sessions）：
        // 必须新建一个会话并拉起进程，否则 ready 永远不会变 true，UI 会卡死。
        void onNewSession(cwd);
      }
    });
  }, [workspacesLoaded, refreshSessions, pushToast, onNewSession]);

  /** 丢弃「新建后从未提交过消息」的会话（2026-10-25 起 key 可能是真实 sessionFile，
   *  不再只是 `__new_` 占位）：用户新建会话、没发消息就走了。
   *  磁盘上一般还没有 .jsonl（omp 要等首条消息才创建），但收到过写操作时可能已有空文件
   *  → 用 deleteSession 一并删掉（内部吞 ENOENT，不存在也安全），避免留下打不开的空会话。
   *  返回是否丢弃的正是当前会话。 */
  /** store/refs 层"忘掉这个会话"：条目、缓冲、进程状态、覆盖名、草稿、模型记录、
   *  未读/错误标记、tempKey 绑定与各种内部 refs 全部清掉。返回它是否正是当前会话。
   *  **不碰磁盘** —— 删盘是另一层的事（见 deleteSessionEverywhere）。 */
  const forgetSession = useCallback((path: string): boolean => {
    const st = useApp.getState();
    const sessionsMap = { ...st.sessionsMap };
    delete sessionsMap[path];
    const procStateMap = { ...st.procStateMap };
    delete procStateMap[path];
    const sessionNames = { ...st.sessionNames };
    delete sessionNames[path];
    const uiQueue = st.uiQueue.filter((q) => q.sessionPath !== path);
    const sessions = st.sessions.filter((x) => x.path !== path);
    const uncommittedSessions = { ...st.uncommittedSessions };
    delete uncommittedSessions[path];
    const pendingLocalSessions = { ...st.pendingLocalSessions };
    delete pendingLocalSessions[path];
    // 清理并发保护 / 快照集合里残留的 key，避免污染后续新建会话
    migratingTempKeys.current.delete(path);
    knownSessionPathsBeforeNew.current.delete(path);
    tempSubmittedKeys.current.delete(path);
    tempCwdRef.current.delete(path);
    committedKeys.current.delete(path);
    const wasCurrent = st.currentSessionPath === path;
    useApp.getState().setState({
      sessionsMap,
      procStateMap,
      sessionNames,
      uiQueue,
      sessions,
      uncommittedSessions,
      pendingLocalSessions,
      ...(wasCurrent ? { currentSessionPath: undefined, messages: [], isStreaming: false, isAborting: false } : {}),
    });
    useApp.getState().removeLastModelKey(path);
    useApp.getState().clearComposerDraft(path);
    useApp.getState().unbindTempRealPath(path);
    useApp.getState().clearSessionStatus(path);
    return wasCurrent;
  }, []);

  /** 自动清理「新建后从未提交过消息」的会话（用户新建后什么都没做就走开了）。
   *  **绝不删盘**：omp 只在 turn 结束时才 flush，进程退出前文件里可能已有用户内容；
   *  自动路径一旦删盘就会抹掉真实数据（2026-10-25 事故：01a17150 被删）。
   *  返回是否丢弃的正是当前会话；守卫不满足时返回 false 且**不做任何事**。 */
  const discardNewSession = useCallback((path: string): boolean => {
    if (!path) return false;
    const st0 = useApp.getState();
    if (!path.startsWith(TEMP_KEY_PREFIX) && !st0.uncommittedSessions[path]) return false;
    // 提交过消息的会话，任何"空会话清理"路径都不得触碰（committedKeys 只增不减，
    // 不依赖 commitSession 的调用时序）
    if (!path.startsWith(TEMP_KEY_PREFIX) && committedKeys.current.has(path)) return false;
    // §2.3：收到过致命 error notice（如写盘失败）→ transcript 可能未落盘，保留给用户处理
    if (st0.sessionErrors[path]) return false;
    void rpc.release(path).catch(() => undefined);
    return forgetSession(path);
  }, [rpc, forgetSession]);

  /** 用户**明确删除**（右键菜单）的统一入口：墓碑防复活 → 释放进程 → 删磁盘文件 →
   *  清 store → 重新扫盘 → 必要时切换当前会话。
   *
   *  2026-10-25 修复「右键删除删不掉」：旧实现两个分支各自为政——未提交分支静默失败、
   *  已提交分支删完文件后又被 pendingLocalSessions/uncommittedSessions 的"保留规则"
   *  扫回来（条目看起来还在）。现在统一走这里，且删除失败会明确 toast。 */
  /** onSelectSession 的转发（它声明在本函数之后，直接引用会撞 TDZ；删除后需要切会话）。 */
  const selectSessionRef = useRef<(s: SessionSummary) => void>(() => undefined);
  const deleteSessionEverywhere = useCallback(async (path: string): Promise<void> => {
    if (!path) return;
    const wasCurrent = useApp.getState().currentSessionPath === path;
    // ① 先立墓碑：删除是异步的（进程退出可能 flush、扫盘可能抢先），不抑制就会"删了又回来"
    useApp.getState().suppressSession(path, 5 * 60_000);
    // ② 杀进程（避免 omp 退出时把文件又 flush 回来）——await 到死透再删盘
    await rpc.release(path).catch(() => undefined);
    // ③ 删磁盘文件（不存在也没关系；失败要告诉用户，不能静默）
    if (!path.startsWith(TEMP_KEY_PREFIX)) {
      try {
        await window.omp.deleteSession(path);
      } catch (e) {
        useApp.getState().pushToast(
          `删除会话文件失败：${e instanceof Error ? e.message : String(e)}`,
          'error',
        );
      }
    }
    // ④ 清 store
    forgetSession(path);
    // ⑤ 重新扫盘（墓碑生效，不会再被扫回来）
    await refreshSessions();
    // ⑥ 当前会话被删 → 切到最近的其他会话
    if (wasCurrent && !useApp.getState().currentSessionPath) {
      const st = useApp.getState();
      const nx = st.sessions
        .filter((x) => !x.path.startsWith(TEMP_KEY_PREFIX) && !st.uncommittedSessions[x.path])
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (nx) selectSessionRef.current(nx);
      else void onNewSession(st.currentWorkspace()?.cwd);
    }
  }, [rpc, forgetSession, refreshSessions, onNewSession]);

  // ---- 定时任务执行 ----
  // 分工：主进程 ticker 只判「何时到期」（发 AutomationTrigger），实际执行在这里——
  // 复用手动发消息的全链路（tempKey 新会话 → prompt → agent_end 落盘迁移），保证
  // 会话生命周期与手动操作完全同构，不另造一套后台执行机制。
  /** 执行中的定时任务会话（tempKey → 记录元数据）：agent_end 成功 / 进程退出失败时回写记录。 */
  const automationRuns = useRef<Map<string, AutomationRun>>(new Map());

  const runAutomationTask = useCallback(async (task: AutomationTask): Promise<void> => {
    const st = useApp.getState();
    if (!task.cwd || !task.prompt.trim()) return;
    const startedAt = Date.now();
    const run: AutomationRun = {
      id: `ar${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      taskId: task.id,
      taskName: task.name,
      startedAt,
      status: 'running',
    };
    const tempKey = TEMP_KEY_PREFIX + randomUUID();
    automationRuns.current.set(tempKey, run);
    st.pushToast(`⏰ 定时任务「${task.name}」已触发`, 'info');
    void window.omp.recordAutomationRun(run).catch(() => undefined);
    /** 清执行记录：**按 run.id 找**，不能只按 tempKey 删。spawn 之后的 adopt 会把 key 换成
     *  真实 sessionPath，只删旧 key 会留下孤儿条目 —— 之后进程被 LRU 淘汰时 onExit 又按新
     *  key 命中它，额外记一条「会话进程退出」(code=null)：10-25~11-08 那批假报就是这么来的。 */
    const forgetRun = (): void => {
      for (const [k, v] of automationRuns.current) {
        if (v.id === run.id) automationRuns.current.delete(k);
      }
    };
    // 会话 key：spawn ready 后会被 adopt 换成 omp 分配的真实 sessionFile。
    // **后续任何 RPC 都必须用这个 key** —— 继续用 tempKey 会以
    // "omp process not online for session: __new_xxx" 失败（2026-11-10 实证）。
    let key = tempKey;
    try {
      tempCwdRef.current.set(tempKey, task.cwd);
      // 预播种任务模型到 lastModelMap（只写 map 不动全局兜底）：新会话进程 ready 时
      // restoreSessionModel 对无记录会话会回退全局 lastModel，若后于下方 setModel 执行
      // 就会把任务指定模型覆盖成别的模型（2026-09-23 自动化任务跑成 hy3 的根因）。
      // 播种后恢复的即任务模型，任何时序下结果一致；后续 rpc.setModel 幂等保留。
      if (task.model?.provider && task.model?.id) {
        useApp.getState().seedSessionModel(tempKey, task.model);
      }
      await rpc.newSessionForCwd(tempKey, task.cwd, task.approvalMode ?? 'yolo');
      useApp.getState().setProcState(tempKey, { status: 'online' });
      // 「已提交」标记同步打（覆盖下面所有 await 窗口）：adopt 期间进程若退出，
      // onExit 不能把这个会话当成「从没提交过的空会话」清掉。
      tempSubmittedKeys.current.add(tempKey);
      // 关键：ready 后 omp 的 sessionFile 已确定，onReady 也在并发 adopt。这里必须等 key
      // 落定再发 set_model / prompt。旧实现全程用 tempKey，adopt 一旦先完成，后续 RPC 就打
      // 到已被 renameKey 换掉的旧 key 上——进程明明在线却报 "not online"，任务一个 turn
      // 都没跑（实证：omp 日志只有启动行、会话 .jsonl 从未创建）。
      key = await adoptRealSessionId(tempKey);
      // 等 onReady 那条模型恢复链落定，否则首条消息会跑在 omp config 默认模型上。
      await awaitModelRestore(key);
      useApp.getState().appendUserMessage(task.prompt, {}, key);
      // 先命名再上架：侧栏出现的第一个状态就是有名字的会话（与手动发送同序）
      useApp.getState().renameSession(key, task.name);
      useApp.getState().upsertSessionPlaceholder(key, task.cwd);
      // 任务会话一旦提交就不该被「空会话清理」误伤（committedKeys 只增不减）
      committedKeys.current.add(key);
      if (key.startsWith(TEMP_KEY_PREFIX)) tempSubmittedKeys.current.add(key);
      if (task.model?.provider && task.model?.id) {
        await rpc.setModel(key, task.model.provider, task.model.id).catch(() => undefined);
      }
      await rpc.prompt(key, task.prompt);
      void refreshSessions();
    } catch (e) {
      forgetRun();
      const failed: AutomationRun = {
        ...run,
        finishedAt: Date.now(),
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
        sessionPath: key,
      };
      void window.omp.recordAutomationRun(failed).catch(() => undefined);
      useApp.getState().pushToast(`定时任务「${task.name}」执行失败：${failed.error}`, 'error');
      // 放掉这个会话的进程：失败时它通常是一个一个 turn 都没跑过的空进程，留着只会白占
      // 进程池位置（池只有 5 个）→ 后续任务再 LRU 淘汰别的空闲进程 → 连环 code=null 假报。
      // tempKey 走 discardNewSession（干净移除条目，绝不删盘）；已 adopt 成真实路径的只
      // 放进程、保留条目 —— 万一 prompt 已送达并落了内容，留给用户自己判断。
      if (key.startsWith(TEMP_KEY_PREFIX)) discardNewSession(key);
      else void rpc.release(key).catch(() => undefined);
    }
  }, [refreshSessions, adoptRealSessionId, awaitModelRestore, discardNewSession]);

  // 触发订阅 + 主进程侧文件变更（到期扣账/过期停用）同步
  useEffect(() => {
    const offTrigger = window.omp.onAutomationTrigger((task) => { void runAutomationTask(task); });
    const offChanged = window.omp.onAutomationChanged((file) => {
      useApp.getState().setAutomations(file.tasks);
    });
    return () => { offTrigger(); offChanged(); };
  }, [runAutomationTask]);

  // 启动时加载任务列表（侧栏卡片计数 + 面板显示）
  useEffect(() => {
    void window.omp.getAutomations()
      .then((f) => useApp.getState().setAutomations(f.tasks))
      .catch(() => undefined);
  }, []);

  const onSelectSession = useCallback((s: SessionSummary) => {
    useApp.getState().setMainView('chat');
    const st = useApp.getState();
    const cur = st.currentSessionPath;
    // 切走时：若当前是"用户还没发过消息的空 temp 占位会话"，自动丢弃，避免留下删不掉的僵尸会话。
    // 判据（2026-09-14 收窄）：缓冲为空 **且** 从未提交过消息（tempSubmittedKeys）——
    // 只看缓冲为空会在错投场景下把用户实际用过的 temp 会话误清。
    // （正在生成中的 temp 会话缓冲非空，不会命中此分支，等 agent_end 由 migrateTempSession 正常迁移。）
    // 判据再加一条（2026-10-25）：**有未发送草稿的 temp 会话绝不丢弃**——用户在新会话里
    // 打了字还没发就切走，草稿要留着，切回来继续写（草稿按会话隔离存在 store 里）。
    const curDraft = cur ? st.composerDrafts[cur] : undefined;
    const curHasDraft = !!curDraft && (curDraft.text.trim() !== '' || curDraft.attachments.length > 0);
    // 「空的新会话」判据：uncommittedSessions（新建后从未提交消息）+ 缓冲为空 + 无草稿 +
    // 没有正在提交（tempSubmittedKeys 在提交瞬间同步打标，覆盖 acquire/prompt 的 await 窗口）。
    if (cur && st.uncommittedSessions[cur] && cur !== s.path
        && !(st.sessionsMap[cur]?.length) && !tempSubmittedKeys.current.has(cur)
        && !curHasDraft) {
      discardNewSession(cur);
    }
    const targetKey = cwdKey(s.cwd);
    const targetWs = st.workspaces.find((w) => cwdKey(w.cwd) === targetKey);
    if (targetWs && st.currentWorkspaceId !== targetWs.id) {
      st.setCurrentWorkspaceId(targetWs.id);
      st.persistWorkspaces();
      if (targetWs.collapsed) st.toggleWorkspaceCollapsed(targetWs.id);
    }
    // 多进程：切会话 = 切显示指针，**不切任何进程的 current**。
    // 各会话独立进程，互不中断。显示该会话缓冲（或磁盘历史），同步全局 isStreaming。
    useApp.getState().setCurrentSessionPath(s.path);
    const stNow = useApp.getState();
    const ps = stNow.procStateMap[s.path];
    // 模型按会话回显（2026-10-25）：优先用该会话进程真实的模型快照，其次用它的持久化记录；
    // 都没有就是 undefined（在线会话由下面的 refreshState 拉真值）。
    // **绝不**沿用全局 model —— 那正是「B 会话切了 GLM，A 会话显示也变成 GLM」的来源。
    const ownModel = stNow.sessionModels[s.path]
      ?? stNow.lastModelMap[s.path]
      ?? undefined;
    useApp.getState().setState({
      messages: stNow.sessionsMap[s.path] ?? [],
      model: ownModel as ModelInfo | undefined,
      isStreaming: ps?.isStreaming ?? false,
      isAborting: ps?.isAborting ?? false,
      // 切会话时清 ompExited（新会话未退出）
      ompExited: false,
      // 清掉上一会话的统计/窗口用量，避免在新会话状态栏上串数据；
      // 新值由 refreshState（在线立即 / 懒拉起后 onReady）重新拉取。
      sessionStats: undefined,
      contextUsage: undefined,
      tokensPerSecond: undefined,
    });
    // 若该会话从未缓冲过，从磁盘读历史
    if (!stNow.sessionsMap[s.path]) {
      useApp.getState().loadSessionMessages(s.path);
    }
    if (ps?.status === 'online') {
      // 已在线：刷新状态栏（model/thinking 等可能与其他会话不同）
      void refreshState(s.path);
      refreshCommands(s.path);
    } else {
      // 仅浏览历史：**不立刻拉起 omp 进程**（issue: 连续点不同会话会触发
      // "进程池已满且所有会话都在等待用户确认" 且白白占用进程）。
      // 等用户真正输入/发送时，由 InputBox 聚焦 / ensureOnline / onSend 按需懒拉起。
      // 清掉上一会话残留的状态栏数据，避免串数据（新值在拉起后由 refreshState 填充）。
      // 会话进程未起：保留按会话回显的模型（ownModel），清掉其余运行时数据，
      // 避免把上一个会话的统计/用量显示到本会话上。
      useApp.getState().setState({
        thinkingLevel: undefined,
        contextUsage: undefined,
        tokensPerSecond: undefined,
        sessionStats: undefined,
      });
    }
  }, [pushToast, refreshState, refreshCommands, discardNewSession]);
  // 回填转发（deleteSessionEverywhere 声明在前，避免 TDZ）
  selectSessionRef.current = onSelectSession;

  const onDeleteSession = useCallback((s: SessionSummary) => {
    // 右键删除：不再区分"未提交/已提交"两条分支（旧实现两条都出过问题：未提交分支静默
    // 失败、已提交分支删完又被保留规则扫回来）。统一走 deleteSessionEverywhere。
    void deleteSessionEverywhere(s.path);
  }, [deleteSessionEverywhere]);

  // ---- 会话右键操作（透传给 SessionList）----
  // 会话重命名：用自绘 modal 输入（Electron 渲染进程不支持 window.prompt，会直接抛错中断）；
  // 改名写入宿主侧覆盖层 sessionNames（持久化到 workspaces.json），不依赖 omp 子进程，
  // 因此即使会话进程离线也能立即生效（与"项目重命名"同思路）。
  const [renameSessionTarget, setRenameSessionTarget] = useState<SessionSummary | null>(null);
  const [renameSessionValue, setRenameSessionValue] = useState('');
  /** 切权限模式时「会话正在生成 → 是否立即重启进程」的待确认项。 */
  const [pendingModeRestart, setPendingModeRestart] = useState<
    { mode: ApprovalMode; sessionPath: string; label: string } | null
  >(null);
  const onRenameSession = useCallback((s: SessionSummary) => {
    setRenameSessionTarget(s);
    setRenameSessionValue(useApp.getState().sessionNames[s.path] ?? s.title);
  }, []);
  const submitSessionRename = useCallback(() => {
    if (!renameSessionTarget) return;
    const name = renameSessionValue.trim();
    const prev = useApp.getState().sessionNames[renameSessionTarget.path] ?? renameSessionTarget.title;
    if (name && name !== prev) {
      useApp.getState().renameSession(renameSessionTarget.path, name);
    }
    setRenameSessionTarget(null);
    setRenameSessionValue('');
  }, [renameSessionTarget, renameSessionValue]);

  const onBranchSession = useCallback((s: SessionSummary) => {
    useApp.getState().setMainView('chat');
    void window.omp.getSessionUserEntries(s.path).then((entries) => {
      if (entries.length === 0) {
        pushToast('该会话没有可用的分叉点（无 user 消息）', 'error');
        return;
      }
      const entryId = entries[entries.length - 1]?.id;
      if (!entryId) {
        pushToast('该会话没有可用的分叉点（无 user 消息）', 'error');
        return;
      }
      const approvalMode = useApp.getState().workspaces.find((w) => cwdKey(w.cwd) === cwdKey(s.cwd))?.approvalMode ?? 'yolo';
      // 拉起该会话的进程（branch 作用于该进程的 current = s.path），不调 switchSession
      void rpc.acquire(s.path, s.cwd, approvalMode).then(() => {
        void rpc.branch(s.path, entryId).then((r) => {
          if (r.success && r.data) {
            const d = r.data as { text?: string; cancelled?: boolean };
            if (d.cancelled) { pushToast('分叉已取消', 'info'); return; }
            if (d.text) useApp.getState().setDraftInput(d.text);
            useApp.getState().setCurrentSessionPath(s.path);
            void refreshSessions();
            useApp.getState().loadSessionMessages(s.path);
            pushToast('分叉成功，可编辑消息后重新发送', 'info');
          } else {
            pushToast(`分叉失败：${r.error ?? '未知错误'}`, 'error');
          }
        }).catch((e) => pushToast(`分叉失败：${e instanceof Error ? e.message : String(e)}`, 'error'));
      }).catch((e) => pushToast(`分叉失败：${e instanceof Error ? e.message : String(e)}`, 'error'));
    }).catch((e) => pushToast(`分叉失败：${e instanceof Error ? e.message : String(e)}`, 'error'));
  }, [pushToast, refreshSessions]);

  const onCopySessionId = useCallback((s: SessionSummary) => {
    void window.omp.copyText(s.id)
      .then(() => pushToast(`已复制 Session ID：${s.id}`, 'info'))
      .catch(() => pushToast('复制失败', 'error'));
  }, [pushToast]);

  const onOpenSessionDir = useCallback((s: SessionSummary) => {
    // temp 占位（__new_ 开头）在磁盘上没有真实文件：showItemInFolder 会退化成
    // openPath(dirname('.')) → "Windows 找不到文件 ."。改为打开其所属工作空间目录。
    const target = s.path.startsWith('__new_') ? s.cwd : s.path;
    void window.omp.showItemInFolder(target)
      .catch((e) => pushToast(`打开目录失败：${e instanceof Error ? e.message : String(e)}`, 'error'));
  }, [pushToast]);

  const onExportSession = useCallback(async (s: SessionSummary) => {
    try {
      const savePath = await window.omp.showSaveDialog(`${s.title.replace(/[/\\?%*:|"<>]/g, '_')}.html`);
      if (!savePath) return;
      const approvalMode = useApp.getState().workspaces.find((w) => cwdKey(w.cwd) === cwdKey(s.cwd))?.approvalMode ?? 'yolo';
      // 拉起该会话进程，export_html 作用于该进程的 current = s.path
      await rpc.acquire(s.path, s.cwd, approvalMode);
      const r = await rpc.exportHtml(s.path, savePath);
      if (r.success) {
        const d = r.data as { path?: string } | undefined;
        pushToast(`已导出: ${d?.path ?? savePath}`, 'info');
      } else {
        pushToast(`导出失败: ${r.error ?? '未知错误'}`, 'error');
      }
    } catch (e) {
      pushToast(`导出失败: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }, [pushToast]);

  // ---- M5: 工作空间操作 ----
  const onSelectWorkspace = useCallback((ws: Workspace) => {
    const st = useApp.getState();
    st.setCurrentWorkspaceId(ws.id);
    st.persistWorkspaces();
    // 多进程：不再 restart omp。切工作空间只是 UI 高亮 + 刷新会话列表。
    // 该工作空间下的会话按需 lazy acquire（用户点会话时拉起，各自独立进程）。
    refreshSessions();
  }, [refreshSessions]);

  // 切换当前工作空间的权限模式。
  // 关键约束：`--approval-mode` 是 omp 的 **spawn 参数**，没有运行时命令，所以「切了立刻生效」
  // 只能靠重启该会话进程。策略（v0.5.30）：
  //   · 会话空闲（进程在线且未在生成）→ 立即 release + acquire，切完即生效；
  //   · 会话正在生成/思考 → 先弹确认（中断回合有代价），用户同意才重启；不同意则只持久化，
  //     等该进程下次重生（切走被 LRU 淘汰 / 崩溃自愈 / 重启 App）时生效；
  //   · 进程不在线 → 只持久化，下次 acquire 时自然用新模式。
  // 仍不做「release 该工作空间全部在线进程」：那会把其他会话正在跑的回合拦腰杀断，
  // 还会把未迁移的 temp 会话杀成孤儿指针（实证 2026-09-14 bet_zp 会话裂成两个 .jsonl）。
  const applyApprovalModeRestart = useCallback(async (sessionPath: string, mode: ApprovalMode): Promise<void> => {
    const st = useApp.getState();
    const cwd = st.sessions.find((s) => s.path === sessionPath)?.cwd ?? st.currentWorkspace()?.cwd;
    if (!cwd) {
      pushToast(`权限模式已记录；取不到本会话目录，重启 App 后生效`, 'warning');
      return;
    }
    selfRestartKeys.current.add(sessionPath);
    // 兜底：5s 内没收到该会话的 onExit（release 异常等）就清标记，避免吞掉下一次意外退出。
    const purge = window.setTimeout(() => selfRestartKeys.current.delete(sessionPath), 5000);
    try {
      await rpc.release(sessionPath);
      await rpc.acquire(sessionPath, cwd, mode);
      pushToast(`权限模式「${approvalModeLabel(mode)}」已生效（本会话进程已重启）`, 'info');
    } catch (e) {
      selfRestartKeys.current.delete(sessionPath);
      window.clearTimeout(purge);
      pushToast(
        `权限模式已记录，但重启本会话进程失败：${e instanceof Error ? e.message : String(e)}（下次拉起生效）`,
        'error',
      );
    }
  }, [pushToast]);

  const onChangeApprovalMode = useCallback((mode: ApprovalMode) => {
    const st = useApp.getState();
    const ws = st.currentWorkspace();
    if (!ws) return;
    st.setWorkspaceApprovalMode(ws.id, mode);
    const label = approvalModeLabel(mode);
    const sp = st.currentSessionPath;
    const ps = sp ? st.procStateMap[sp] : undefined;
    if (!sp || ps?.status !== 'online') {
      pushToast(`权限模式已切换为「${label}」，对之后拉起的会话进程生效`, 'info');
      return;
    }
    if (ps.isStreaming || st.uiQueue.some((q) => q.sessionPath && pathsEqual(q.sessionPath, sp))) {
      // 正在生成 / 有待应答的权限确认：不打断，交给用户决定（确认框在下方渲染）
      setPendingModeRestart({ mode, sessionPath: sp, label });
      return;
    }
    void applyApprovalModeRestart(sp, mode);
  }, [pushToast, applyApprovalModeRestart]);

  const onAddWorkspace = useCallback((cwd: string) => {
    const id = makeWorkspaceId(cwd);
    const st = useApp.getState();
    if (st.workspaces.some((w) => w.id === id)) {
      const existing = st.workspaces.find((w) => w.id === id)!;
      onSelectWorkspace(existing);
      return;
    }
    if (st.archived.some((w) => w.id === id)) {
      st.restoreWorkspace(id);
    } else {
      st.upsertWorkspace({
        id,
        cwd,
        displayName: basename(cwd),
        collapsed: false,
        createdAt: Date.now(),
        approvalMode: 'yolo',
      });
      // upsertWorkspace 不再隐式聚焦（幽灵工作区事故修复）—— 用户主动添加必须显式聚焦
      st.setCurrentWorkspaceId(id);
    }
    st.persistWorkspaces();
    void onNewSession(cwd);
  }, [onSelectWorkspace, onNewSession]);

  const onRenameWorkspace = useCallback((ws: Workspace, newName: string) => {
    useApp.getState().renameWorkspace(ws.id, newName);
    useApp.getState().persistWorkspaces();
  }, []);

  const onArchiveWorkspace = useCallback((ws: Workspace) => {
    const st = useApp.getState();
    st.archiveWorkspace(ws.id);
    st.persistWorkspaces();
    const cur = st.currentWorkspace();
    if (cur) {
      onSelectWorkspace(cur);
    } else {
      pushToast('已归档最后一个工作空间', 'info');
    }
  }, [onSelectWorkspace, pushToast]);

  const onRestoreWorkspace = useCallback((ws: Workspace) => {
    const st = useApp.getState();
    st.restoreWorkspace(ws.id);
    st.persistWorkspaces();
    onSelectWorkspace(ws);
  }, [onSelectWorkspace, pushToast]);

  const onDeleteArchivedWorkspace = useCallback(async (ws: Workspace) => {
    try {
      const sessions = await window.omp.listSessions(ws.cwd);
      for (const s of sessions) {
        await rpc.release(s.path).catch(() => undefined);
        await window.omp.deleteSession(s.path).catch(() => undefined);
        useApp.getState().removeLastModelKey(s.path);
        useApp.getState().clearSessionStatus(s.path);
      }
    } catch {
      /* 列表失败也无妨，继续删除归档记录 */
    }
    const st = useApp.getState();
    st.deleteArchivedWorkspace(ws.id);
    st.persistWorkspaces();
    void refreshSessions();
    pushToast(`已彻底删除「${ws.displayName}」及其会话记录`, 'info');
  }, [pushToast, refreshSessions]);

  const onToggleCollapsed = useCallback((ws: Workspace) => {
    useApp.getState().toggleWorkspaceCollapsed(ws.id);
    useApp.getState().persistWorkspaces();
  }, []);

  const currentUi = uiQueue[0];
  const currentSessionPath = useApp((s) => s.currentSessionPath);
  const sessions = useApp((s) => s.sessions);
  // 顶栏标题 = 当前会话名（优先用宿主侧覆盖名，否则用扫盘得到的 title）
  const currentSessionTitle = useApp(
    (s) => s.sessionNames[s.currentSessionPath ?? ''] ?? s.sessions.find((x) => x.path === s.currentSessionPath)?.title ?? null,
  );

  const showTitleBar = IS_WIN32;
  /** 「正在连接 omp…」遮罩是否已被用户关闭 */
  const [connectOverlayDismissed, setConnectOverlayDismissed] = useState(false);

  return (
    <div className={`app ${showTitleBar ? 'custom-titlebar' : ''}`}>
      {showTitleBar && <TitleBar />}
      <div className="app-body">
        <WorkspaceList
          allSessions={sessions}
          currentSessionPath={currentSessionPath}
          onSelectWorkspace={onSelectWorkspace}
          onAddWorkspace={onAddWorkspace}
          onRenameWorkspace={onRenameWorkspace}
          onArchiveWorkspace={onArchiveWorkspace}
          onRestoreWorkspace={onRestoreWorkspace}
          onDeleteArchivedWorkspace={onDeleteArchivedWorkspace}
          onToggleCollapsed={onToggleCollapsed}
          onSelectSession={onSelectSession}
          onRenameSession={onRenameSession}
          onBranchSession={onBranchSession}
          onExportSession={onExportSession}
          onDeleteSession={onDeleteSession}
          onCopySessionId={onCopySessionId}
          onOpenSessionDir={onOpenSessionDir}
          onNewSession={onNewSession}
        />
        <div className="main">
        <div className="topbar">
          <span className="topbar-title">{currentSessionTitle ?? ''}</span>
          <div className="topbar-actions">
            <button
              className={`icon-btn ${rightPanel === 'files' ? 'active' : ''}`}
              onClick={() => togglePanel('files')}
              title="文件树"
            >
              <Icon name="folder" size={16} />
            </button>
            <button
              className={`icon-btn ${rightPanel === 'todo' ? 'active' : ''}`}
              onClick={() => togglePanel('todo')}
              title="Todo 列表"
            >
              <Icon name="todo" size={16} />
            </button>
            <button
              className={`icon-btn ${rightPanel === 'diff' ? 'active' : ''}`}
              onClick={() => togglePanel('diff')}
              title="Diff 视图"
            >
              <Icon name="diff" size={16} />
            </button>
            <button
              className={`icon-btn ${rightPanel === 'jobs' ? 'active' : ''}`}
              onClick={() => togglePanel('jobs')}
              title="子智能体"
            >
              <Icon name="robot" size={16} />
            </button>
          </div>
        </div>
        {mainView === 'skills' ? (
          <SkillsPanel />
        ) : mainView === 'automation' ? (
          <AutomationPanel onRunTask={(t) => void runAutomationTask(t)} />
        ) : (
          <>
            <ChatView />
            <InputBox onSend={onSend} onGuide={onGuide} onQueue={onQueue} onAbort={onAbort} onChangeApprovalMode={onChangeApprovalMode} />
            <StatusBar />
          </>
        )}
      </div>

      {/* 右栏面板 */}
      {rightPanel !== 'off' && (
        <div className="right-panel">
          {rightPanel === 'files' && (() => {
            const wd = getWorkDir();
            // 无 workspace / 取不到 cwd 时避免 listFiles('')，改为提示
            return wd ? <FileTree cwd={wd} /> : <div className="panel-empty">请先选择工作空间</div>;
          })()}
          {rightPanel === 'todo' && <TodoPanel />}
          {rightPanel === 'diff' && <DiffPanel />}
          {rightPanel === 'jobs' && <JobPanel />}
        </div>
      )}
      </div>

      <SettingsPanel />

      {currentUi && (
        <PermissionModal
          req={currentUi}
          key={currentUi.id}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}${t.action ? ' toast-actionable' : ''}`}>
            <span className="toast-text">{t.text}</span>
            {/* 0.5.39 / 0.5.40：崩溃中断的 sticky toast 带「重发上一条」。后台会话不给按钮，避免串台。 */}
            {t.action === 'resend' && (!t.sessionPath || pathsEqual(t.sessionPath, currentSessionPath ?? '')) && (
              <button
                className="toast-resend"
                title="重新发送最后一条用户消息（仅文本）"
                onClick={() => {
                  resendLast(t.sessionPath);
                  useApp.getState().dismissToast(t.id);
                }}
              >
                重发上一条
              </button>
            )}
            <button
              className="toast-close"
              title="关闭"
              onClick={() => {
                // 关掉崩溃提醒只抑制「再弹 toast」，侧栏红点保留到用户重发/发送新消息。
                if (t.action === 'resend' && t.sessionPath) useApp.getState().dismissCrashToast(t.sessionPath);
                else useApp.getState().dismissToast(t.id);
              }}
            >×</button>
          </div>
        ))}
      </div>

      {!ready && exited === false && !connectOverlayDismissed && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">正在连接 omp…</div>
            <div className="modal-message">等待首个会话进程拉起（ready）。若长时间无响应，请检查 omp 路径配置。</div>
            {/* 进程按需懒拉起：无工作区（首次启动）/ 拉起失败时不会有 ready，遮罩必须可关闭，
                否则侧栏「新建工作空间」与设置入口全被挡住，界面永久锁死 */}
            <div className="modal-actions">
              <button className="btn" onClick={() => setConnectOverlayDismissed(true)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 切权限模式确认：会话正在生成时，重启进程 = 中断当前回合，必须让用户决定 */}
      {pendingModeRestart && (
        <div className="modal-overlay" onMouseDown={() => setPendingModeRestart(null)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-title">切换权限模式：{pendingModeRestart.label}</div>
            <div className="modal-message">
              本会话正在生成中。权限模式是 omp 的启动参数，需要重启该会话进程才能生效。
              {'\n\n'}立即重启本会话进程以生效？（会中断正在生成的回合）
            </div>
            <div className="modal-actions">
              <button
                className="btn"
                onClick={() => {
                  const p = pendingModeRestart;
                  setPendingModeRestart(null);
                  pushToast(
                    `权限模式已切换为「${p.label}」；本会话仍在旧模式下运行，该进程下次重启后生效`,
                    'info',
                  );
                }}
              >
                稍后（不中断）
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const p = pendingModeRestart;
                  setPendingModeRestart(null);
                  void applyApprovalModeRestart(p.sessionPath, p.mode);
                }}
              >
                立即重启
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 会话重命名 modal（替代 window.prompt：Electron 渲染进程不支持 prompt） */}
      {renameSessionTarget && (
        <div className="modal-overlay" onMouseDown={() => { setRenameSessionTarget(null); setRenameSessionValue(''); }}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => {
            if (e.key === 'Escape' && !e.nativeEvent.isComposing) { setRenameSessionTarget(null); setRenameSessionValue(''); }
          }}>
            <div className="modal-title">重命名会话</div>
            <input
              type="text"
              autoFocus
              value={renameSessionValue}
              onChange={(e) => setRenameSessionValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return; // 输入法组字中的 Enter/Esc 交给输入法
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submitSessionRename(); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenameSessionTarget(null); setRenameSessionValue(''); }
              }}
            />
            <div className="modal-actions">
              <button className="btn" onClick={() => { setRenameSessionTarget(null); setRenameSessionValue(''); }}>取消</button>
              <button className="btn btn-primary" onClick={submitSessionRename}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 是否 Windows（模块级常量，避免每次 render 都访问 window.omp.platform）。 */
const IS_WIN32 = window.omp?.platform === 'win32';

/** 权限模式的展示名（toast / 确认框 / 选择器共用同一套措辞）。 */
function approvalModeLabel(mode: ApprovalMode): string {
  return mode === 'yolo' ? 'YOLO · 全自动' : mode === 'always-ask' ? 'Always Ask · 每次询问' : 'Write';
}

/** 渲染层生成 tempKey（新建会话先切指针再 spawn 用）。crypto.randomUUID 在非安全上下文
 *  可能缺失，兜底一个足够防碰撞的组合（同毫秒 + 两段随机）。 */
const randomUUID = (): string =>
  globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

/** Diff 右栏面板：展示从 tool_execution_end 提取的 unified diff 列表。 */
const DiffPanel: React.FC = () => {
  const diffs = useApp((s) => s.diffs);
  if (diffs.length === 0) {
    return <div className="panel-empty">暂无 Diff（工具执行产生的文件修改会显示在这里）</div>;
  }
  return (
    <div className="diff-panel">
      <div className="panel-header">Diff 视图 ({diffs.length})</div>
      <div className="diff-panel-scroll">
        {diffs.map((d, i) => (
          <details key={i} className="diff-block" open={i === diffs.length - 1}>
            <summary>{d.toolName}</summary>
            <DiffView diff={d.diff} />
          </details>
        ))}
      </div>
    </div>
  );
};

/** 获取当前工作目录。从 store 的 currentWorkspace() 拿；空则用 cwdProcess 兜底。 */
/** 把非图片附件的绝对路径拼进发给 omp 的 prompt（agent 用其文件读取工具按需读取）。
 *  UI 里消息正文保持用户原文本、附件以芯片展示，不污染正文可读性。
 *  仅当文本为空（纯附件消息）时，prompt 退化为附件列表本身。
 *  图片类附件统一走 prompt.images 内联发送（不塞路径），避免 inspect_image 慢/abort。 */
function buildPromptWithAttachments(text: string, atts?: Attachment[]): string {
  const fileAtts = (atts ?? []).filter((a) => a.kind !== 'image' && !isImageFile(a.name));
  if (fileAtts.length === 0) return text;
  const lines = fileAtts.map((a) => `- ${a.path}`).join('\n');
  const block = `Attached files (absolute paths, read them as needed):\n${lines}`;
  return text ? `${text}\n\n${block}` : block;
}

/** 收集图片类附件，转成 rpc-ui 要求的「图片对象数组」(RpcImage) 用于 prompt.images 内联。
 *  关键：omp 的 ImageContent.data 契约是「裸 base64」（不带 data: 前缀，与原生 OMP 一致）。
 *  所以 readImageAsDataUrl 返回的 data:image/...;base64,... 必须先去掉前缀再发给 omp：
 *  若带前缀，omp 侧 Buffer.from(data,'base64') 会把 "data:image/png;base64," 连同真实
 *  base64 一起解码（其中 '/' 是合法 base64 字符）→ 得到损坏字节 → blob 入库为垃圾、
 *  vision 描述失败（"[Image description unavailable]"）、inspect_image 报
 *  "only supports PNG, JPEG, GIF, and WEBP"、agent 只能退化成 bash 瞎折腾。
 *  readImageAsDataUrl 已有完整安防校验（白名单 + realpath 防逃逸），可直接复用。
 *  0.5.27：**不再兜底 path 形式**。omp 18.3.2 的 rpc 层对 {type:'image',path} 不加载文件、
 *  直接透传进 content，请求构建时在图片处理缓存键处崩（"undefined is not an object
 *  (evaluating 'e.data.length')"，实证 session 01a10c7a：path 形式 100% 复现、data 形式正常）。
 *  读失败的图片跳过并通过 onSkipped 上报（toast 提示），绝不发 path 形式给 omp。 */
async function collectImageRefs(atts?: Attachment[], onSkipped?: (name: string) => void): Promise<RpcImage[]> {
  if (!atts) return [];
  const imgs = atts.filter((a) => a.kind === 'image' || isImageFile(a.name));
  const out: RpcImage[] = [];
  for (const a of imgs) {
    const mimeType = imageMimeFromName(a.name);
    try {
      const { dataUrl } = await window.omp.readImageAsDataUrl(a.path);
      // 只发裸 base64（去掉 data:image/...;base64, 前缀），与原生 OMP 一致
      out.push({ type: 'image', data: stripDataUrlPrefix(dataUrl), mimeType });
    } catch (err) {
      // 读取失败：跳过该图并提示，禁止退回 path 形式（omp 18.3.2 会崩，见上方注释）
      console.warn('图片读取失败，已跳过:', a.path, err);
      onSkipped?.(a.name);
    }
  }
  return out;
}

/** 由文件名扩展名推断图片 MIME（默认 image/png）。 */
function imageMimeFromName(name: string): string {
  const ext = (name.split('.').pop() || 'png').toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
  };
  return map[ext] ?? 'image/png';
}

/** 获取当前工作目录。从 store 的 currentWorkspace() 拿；空则用 cwdProcess 兜底。 */
function getWorkDir(): string {
  const ws = useApp.getState().currentWorkspace();
  if (ws?.cwd) return ws.cwd;
  return cwdProcess.cwd?.() ?? '';
}

/** 会话进程失联/退出的公共清理（0.5.21 提取自 onExit，01a0cc6c 事故）。
 *  只做「状态复位 + 当前会话遮罩」：**不含** tempKey 迁移与自动 respawn——
 *  失联清理不自动重拉进程（会凭空造进程），下次 prompt 走既有 acquire 路径即可自愈。 */
function clearSessionProc(sessionPath: string, opts?: { exitedCode?: number | null }): void {
  useApp.getState().setProcState(sessionPath, {
    status: 'offline',
    isStreaming: false,
    isAborting: false,
    stuckSince: undefined,
    reconFailCount: 0,
  });
  if (sessionPath === useApp.getState().currentSessionPath) {
    useApp.getState().setOmpExited(opts?.exitedCode ?? null);
  }
}

/** 流式状态对账失败计数（0.5.21）。连续达阈 → 判定进程失联并清理。
 *  背景（实证 01a0cc6c 卡「运行中」25h）：exit 事件丢失后，对账每 30s 静默失败一次，
 *  旧代码 catch{} 直接 return —— 失败必须被计数并最终收敛到清理动作。 */
const RECON_MAX_FAILS = 3;
function markReconFail(sessionPath: string, reason: string): void {
  const st = useApp.getState();
  const count = (st.procStateMap[sessionPath]?.reconFailCount ?? 0) + 1;
  st.setProcState(sessionPath, { reconFailCount: count });
  if (count >= RECON_MAX_FAILS) {
    clearSessionProc(sessionPath);
    const label = sessionPath.split(/[\\/]/).pop() ?? sessionPath;
    st.pushToast(`会话「${label}」进程已失联（连续 ${count} 次对账失败：${reason}），发送消息将自动重连`, 'warning');
  }
}

/** P1 磁盘对账自愈（0.5.21）：不依赖 omp RPC。静默超阈值时读 jsonl 尾部，
 *  尾部最后一条 assistant 消息 stopReason==='stop' 且 mtime 已停滞 → turn 在服务端
 *  必然已完结（omp 只在 agent_end flush JSONL），按完结清理并重载历史。
 *  **顺序关键**：必须先清 isStreaming 再 loadSessionMessages——loadSessionMessages 的
 *  竞态守卫在 isStreaming=true 时会丢弃磁盘快照（store.ts），顺序颠倒本自愈一行效果都没有。 */
async function healFromDisk(sessionPath: string): Promise<void> {
  try {
    const st = useApp.getState();
    if (!st.procStateMap[sessionPath]?.isStreaming) return;
    const tail = await window.omp.sessionTail(sessionPath);
    // RPC 往返期间状态可能已变（agent_end 修复 / onExit / 上一轮自愈），用最新态再判一次
    const st2 = useApp.getState();
    if (!shouldHealFromDisk(st2.procStateMap[sessionPath], tail ?? undefined)) return;
    st2.setProcState(sessionPath, { isStreaming: false, isAborting: false, stuckSince: undefined });
    if (sessionPath === st2.currentSessionPath) {
      st2.setState({ isStreaming: false, isAborting: false });
    }
    st2.loadSessionMessages(sessionPath);
    const label = sessionPath.split(/[\\/]/).pop() ?? sessionPath;
    st2.pushToast(`会话「${label}」的回合已在后台完成（磁盘对账自愈），已重载历史`, 'info');
  } catch {
    /* 磁盘读取失败：下一轮看门狗重试 */
  }
}

/** 流式状态对账自愈（2026-09-16 橙点常亮修复）。
 *  omp 的 agent 循环异常/中止路径不补发 agent_end 帧 → 本侧 procStateMap.isStreaming 卡 true，
 *  侧栏橙点不灭（实证 session 01a0a638）。以 omp 内部 isStreaming（get_state）为权威真值：
 *  不一致且 RPC 往返期间无新帧到达时重置本侧镜像；omp 确实仍在跑且静默超阈值才提示疑似卡死。
 *  0.5.21（01a0cc6c 事故）：catch / !success 不再静默 return——
 *    - 错误含 `not online`：主进程池里已无该进程（exit 在主进程侧发生过但事件丢失）→ 权威死亡证据，立即清理；
 *    - 其余失败（超时/异常）：计数，连续 RECON_MAX_FAILS 次 → 按失联清理；
 *    - 对账用 3s 短超时：默认 5min 超时下僵死进程会让 pending 随 30s 看门狗无限堆积。 */
async function reconcileStreamingState(sessionPath: string, stuckAfterMs: number): Promise<void> {
  const sentAt = Date.now();
  try {
    const r = await rpc.getState(sessionPath, 3000);
    if (!r.success) {
      markReconFail(sessionPath, 'rpc-failed');
      return;
    }
    const d = r.data as RpcSessionState;
    const stNow = useApp.getState();
    const psNow = stNow.procStateMap[sessionPath];
    // 已被 agent_end / onExit / healFromDisk 修正 → 无需对账
    if (!psNow?.isStreaming) return;
    // RPC 往返期间有新帧到达 → 帧流是权威，不覆写（可能已 agent_end 或新回合已 agent_start）
    if ((psNow.lastFrameAt ?? 0) > sentAt) return;
    if (d.isStreaming === false) {
      // omp 内部已结束、帧流丢了 agent_end → 以 omp 为准重置镜像，橙点解除
      stNow.setProcState(sessionPath, { isStreaming: false, isAborting: false, stuckSince: undefined, reconFailCount: 0 });
      if (pathsEqual(sessionPath, stNow.currentSessionPath ?? '')) {
        stNow.setState({ isStreaming: false, isAborting: false });
      }
      return;
    }
    // omp 仍在跑：静默超阈值 → 疑似工具挂死，提示一次（stuckSince 任意新帧自动清除）
    const silentMs = Date.now() - (psNow.lastFrameAt ?? 0);
    const patch: { reconFailCount: number; stuckSince?: number } = { reconFailCount: 0 };
    if (silentMs >= stuckAfterMs && !psNow.stuckSince) {
      patch.stuckSince = psNow.lastFrameAt;
      const label = sessionPath.split(/[\\/]/).pop() ?? sessionPath;
      stNow.pushToast(
        `⚠️ 会话 ${label} 已 ${Math.round(silentMs / 60000)} 分钟无任何响应，疑似卡死（工具可能挂死）。可点输入框停止按钮强制中断。`,
        'warning',
      );
    }
    stNow.setProcState(sessionPath, patch);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not online')) {
      // 进程已不在池：权威死亡证据（exit 在主进程发生过、事件丢失），立即清理，不必等计数
      clearSessionProc(sessionPath);
      const label = sessionPath.split(/[\\/]/).pop() ?? sessionPath;
      useApp.getState().pushToast(`会话「${label}」进程已失联，发送消息将自动重连`, 'warning');
      return;
    }
    markReconFail(sessionPath, msg.slice(0, 80));
  }
}

/** 处理 extension_ui_request：需应答的入队（带 __sessionPath），单向的直接执行，cancel 的关对应 */
function handleUiRequest(
  req: RpcExtensionUIRequest & { __sessionPath?: string },
  st: ReturnType<typeof useApp.getState>,
  pushToast: (t: string, l?: string) => void,
): void {
  const method = req.method;

  if (method === 'notify') {
    pushToast(req.text ?? req.message ?? '', req.level ?? 'info');
    return;
  }
  if (method === 'setWidget' || method === 'setTitle' || method === 'setStatus' || method === 'set_editor_text') {
    return;
  }
  if (method === 'open_url') {
    // open_url 原实现直接打开并自动放行（confirmed:true），用户无法审查 URL，存在钓鱼/恶意下载风险。
    // 改为入队 confirm 请求，让用户审核 URL 后再决定是否打开（issue #5）。
    // 通过 raw.__openUrl 把待打开链接带给 PermissionModal，用户批准后才真正打开。
    const url = req.launchUrl ?? req.url;
    if (!url) return;
    const ui = toUiRequest(req);
    st.enqueueUi({
      ...ui,
      method: 'confirm',
      title: ui.title ?? '打开外部链接',
      message: `是否打开以下外部链接？\n\n${url}`,
      raw: { ...req, __openUrl: url, __sessionPath: req.__sessionPath },
    });
    return;
  }
  if (method === 'cancel') {
    const target = req.targetId ?? req.id;
    st.dequeueUi(target);
    st.dequeueUi(req.id);
    return;
  }

  if (method === 'confirm' || method === 'select' || method === 'input' || method === 'editor') {
    // confirm 类：先查 per-session 工具级"始终允许"缓存，命中则宿主侧自动放行（不弹窗）。
    // select/input/editor 需要用户主动输入，不走自动放行。
    if (method === 'confirm') {
      const ui = toUiRequest(req);
      const tool = toolNameOf(ui);
      const sp = req.__sessionPath;
      // sessionPath 为空时不走 auto-approve，避免 isPermAllowed 创建全局共享(() 的 perm 缓存条目
      if (tool && sp && st.isPermAllowed(sp, tool)) {
        void Promise.resolve(rpc.respondUI(sp, { id: req.id, confirmed: true }))
          .catch(() => pushToast(`自动放行「${tool}」失败`, 'error'));
        return;
      }
    }
    st.enqueueUi(toUiRequest(req));
    return;
  }
}

function toUiRequest(req: RpcExtensionUIRequest & { __sessionPath?: string }): UiRequest {
  return {
    id: req.id,
    method: req.method,
    title: req.title,
    message: req.message,
    prompt: req.prompt,
    options: req.options,
    defaultValue: req.defaultValue,
    placeholder: req.placeholder,
    url: req.url,
    launchUrl: req.launchUrl,
    text: req.text,
    level: req.level,
    targetId: req.targetId,
    sessionPath: req.__sessionPath,
    raw: req,
  };
}

// cwd polyfill for renderer（重命名以避免遮蔽 Node 全局 process）
const cwdProcess = { cwd: () => { try { return (window as unknown as { __CWD__?: string }).__CWD__ ?? ''; } catch { return ''; } } };
