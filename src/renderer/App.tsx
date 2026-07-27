import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, type UiRequest, toolNameOf } from './store';
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
import { SettingsPanel } from './components/SettingsPanel';
import { cwdKey, makeWorkspaceId, basename } from './utils/path-key';
import { applyAppearance } from './store';
import type { OmpFrame, RpcExtensionUIRequest, AvailableCommandsUpdateFrame, RpcSessionState, TodoPhase, ModelInfo, SlashCommand } from '../shared/rpc-types';
import type { SessionSummary, Workspace, ApprovalMode } from '../shared/ipc-channels';

export default function App(): React.ReactElement {
  const ready = useApp((s) => s.ready);
  const exited = useApp((s) => s.ompExited);
  const uiQueue = useApp((s) => s.uiQueue);
  const rightPanel = useApp((s) => s.rightPanel);
  const mainView = useApp((s) => s.mainView);
  const toasts = useApp((s) => s.toasts);

  // 全局 toast 改为走 store（pushToast 在 rpc-client / PermissionModal 等任意组件可用）。
  const pushToast = useCallback((text: string, level = 'info') => {
    useApp.getState().pushToast(text, level);
  }, []);

  const togglePanel = useCallback((panel: 'files' | 'todo') => {
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
    return rpc.getState(sp).then((r) => {
      if (r.success && r.data) {
        const d = r.data as RpcSessionState;
        const isCurrent = sp === useApp.getState().currentSessionPath;
        useApp.getState().setState({
          ...(isCurrent ? {
            model: d.model,
            thinkingLevel: d.thinkingLevel,
            contextUsage: d.contextUsage,
            sessionId: d.sessionId,
            todoPhases: d.todoPhases ?? [],
            isCompacting: d.isCompacting ?? false,
          } : {}),
          // isStreaming/isAborting 改由 procStateMap 驱动，这里不覆写
        });
        // 持久化的 lastModel 跟 omp 当前 model 不一致 → 自动恢复
        const last = useApp.getState().lastModel;
        if (last && (!d.model || d.model.provider !== last.provider || d.model.id !== last.id)) {
          void rpc.setModel(sp, last.provider, last.id).then((sr) => {
            if (sr.success && sr.data && sp === useApp.getState().currentSessionPath) {
              useApp.getState().setState({ model: sr.data as ModelInfo });
            }
          }).catch(() => undefined);
        }
      }
    }).catch(() => undefined);
  }, []);

  const refreshSessions = useCallback((): Promise<void> => {
    return window.omp.listSessions()
      .then((list) => useApp.getState().setSessions(list))
      .catch(() => undefined);
  }, []);

  /** 拉取某会话进程的可用技能 / 命令列表。 */
  const refreshCommands = useCallback((sessionPath: string): void => {
    void rpc.getAvailableCommands(sessionPath).then((r) => {
      if (r.success && r.data) {
        const cmds = r.data.commands;
        if (Array.isArray(cmds) && cmds.length > 0) {
          useApp.getState().setState({ slashCommands: cmds as SlashCommand[] });
        }
      }
    }).catch(() => undefined);
  }, []);

  /** 迁移中的 temp key 集合（并发保护）：同一 __new_ 会话的多次 agent_end 只处理一次。 */
  const migratingTempKeys = useRef<Set<string>>(new Set());

  /** 新会话首条消息 agent_end 后 omp 才落盘 .jsonl。此时把临时 key（__new_ 开头）
   *  迁移成真实文件 path：缓冲/procState 迁移 + 通知主进程 renameKey。
   *  关键：omp 进程运行期间不写文件，只有首条消息完成后才落盘（probe 实测）。 */
  const migrateTempSession = useCallback(() => {
    const st = useApp.getState();
    const cur = st.currentSessionPath;
    if (!cur || !cur.startsWith('__new_')) return;
    // 并发保护：已在迁移中则跳过，避免重复 setState / renameKey
    if (migratingTempKeys.current.has(cur)) return;
    migratingTempKeys.current.add(cur);
    const done = () => migratingTempKeys.current.delete(cur);
    const cwd = st.currentWorkspace()?.cwd;
    if (!cwd) { done(); return; }
    const newest = st.sessions
      .filter((x) => cwdKey(x.cwd) === cwdKey(cwd))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest || newest.path === cur) { done(); return; }
    const buf = st.sessionsMap[cur];
    const ps = st.procStateMap[cur];
    const sessionsMap = { ...st.sessionsMap };
    delete sessionsMap[cur];
    if (buf) sessionsMap[newest.path] = buf;
    const procStateMap = { ...st.procStateMap };
    delete procStateMap[cur];
    if (ps) procStateMap[newest.path] = ps;
    // 关键：pending UI 请求（如工具确认弹窗）也带着旧 __new_ temp key，
    // 若不重定向会指向已离线的旧进程 → 用户点确认报 "omp process not online"。
    // 这里把 uiQueue 里 sessionPath===cur 的请求一并改到真实 path（主进程 renameKey 已同步迁移 pin）。
    const uiQueue = st.uiQueue.map((q) =>
      q.sessionPath === cur ? { ...q, sessionPath: newest.path } : q,
    );
    st.setState({ sessionsMap, procStateMap, currentSessionPath: newest.path, uiQueue });
    void rpc.renameKey(cur, newest.path).then(done, done);
  }, []);

  /** 新建会话后：设为 current + 清缓冲 + 刷新列表/状态。newSessionForCwd 已返回新 path。 */
  const resolveAndSelectNewSession = useCallback(async (newSessionPath: string): Promise<void> => {
    useApp.getState().setCurrentSessionPath(newSessionPath);
    useApp.getState().setProcState(newSessionPath, { status: 'online' });
    useApp.getState().resetChat();
    // 新会话统计从零开始，先清掉旧会话残留（refreshState 会重新拉取）
    useApp.getState().setState({ sessionStats: undefined, contextUsage: undefined });
    await refreshSessions();
    await refreshState(newSessionPath);
  }, [refreshSessions, refreshState]);

  /** 加载 workspaces 文件并补全"扫盘发现的但 store 里没有"的工作空间。 */
  const loadAndReconcileWorkspaces = useCallback((): void => {
    void window.omp.getWorkspaces().then((file) => {
      useApp.getState().setWorkspacesFile(file);
      // 恢复上次的外观配置（主题预设 / 背景色 / 字体 / 字号 / 配色模式）
      applyAppearance(useApp.getState().appearance);
      const st = useApp.getState();
      const sessions = st.sessions;
      const existingCwds = new Set(st.workspaces.map((w) => cwdKey(w.cwd)));
      const archivedCwds = new Set(st.archived.map((w) => cwdKey(w.cwd)));
      const removed = new Set(st.removedCwds.map(cwdKey));
      let dirty = false;
      for (const s of sessions) {
        const key = cwdKey(s.cwd);
        if (existingCwds.has(key)) continue;
        if (archivedCwds.has(key) || removed.has(key)) continue;
        useApp.getState().upsertWorkspace({
          id: key,
          cwd: s.cwd,
          displayName: basename(s.cwd),
          collapsed: false,
          createdAt: Date.now(),
        });
        existingCwds.add(key);
        dirty = true;
      }
      if (dirty) useApp.getState().persistWorkspaces();
    }).catch(() => undefined);
  }, []);

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
      if (f.type === 'available_commands_update') {
        st.setState({ slashCommands: (frame as AvailableCommandsUpdateFrame).commands ?? [] });
        return;
      }
      if (f.type === 'notice') {
        const n = frame as { message?: string; level?: string };
        if (n.message) pushToast(n.message, n.level ?? 'info');
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
        // omp 在 agent_end 时 flush 完整 JSONL，重新扫盘；新会话此时才落盘，迁移 tempKey→realPath
        void refreshSessions().then(() => migrateTempSession());
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
      useApp.getState().setProcState(sessionPath, { status: 'offline', isStreaming: false, isAborting: false });
      // 仅当退出的是当前显示会话，弹"已退出"遮罩
      if (sessionPath === useApp.getState().currentSessionPath) {
        useApp.getState().setOmpExited(code);
      }
    });

    const offStderr = window.omp.onStderr(({ line }) => {
      useApp.getState().pushStderr(line);
    });

    return () => { offEvent(); offReady(); offExit(); offStderr(); };
  }, [pushToast, refreshState, refreshSessions, refreshCommands, migrateTempSession]);

  // 渲染进程挂载：加载 workspaces，完成后通知主进程 renderer 就绪（多进程下主进程不再直接起 omp）
  const workspacesLoaded = useApp((s) => s.workspacesLoaded);
  useEffect(() => {
    loadAndReconcileWorkspaces();
  }, [loadAndReconcileWorkspaces]);
  useEffect(() => {
    if (workspacesLoaded) {
      // issue 85: notifyReady 不再传 initialCwd（主进程 handler 为 no-op，pool 按需 lazy acquire）
      void window.omp.notifyReady();
    }
  }, [workspacesLoaded]);


  // ---- 键盘快捷键 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 't') {
        e.preventDefault();
        const sp = useApp.getState().currentSessionPath;
        if (sp) void rpc.cycleThinkingLevel(sp).catch(() => undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- 用户操作 ----
  const onSend = useCallback((text: string) => {
    const st = useApp.getState();
    const sp = st.currentSessionPath;
    if (!sp) {
      pushToast('请先选择一个会话', 'error');
      return;
    }
    const cwd = st.currentWorkspace()?.cwd ?? '';
    const approvalMode = st.currentWorkspace()?.approvalMode ?? 'write';
    const doSend = async () => {
      // 懒拉起该会话的进程（带 -c 续接）。已在线则 no-op。**不影响其他会话**。
      await rpc.acquire(sp, cwd, approvalMode);
      useApp.getState().appendUserMessage(text);
      await rpc.prompt(sp, text);
      refreshSessions();
    };
    void doSend().catch((err) =>
      pushToast(`发送失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    );
  }, [pushToast, refreshSessions]);

  /** 引导（steer mid-run）：生成中途按 Enter → omp 在当前 tool 完成后立即按新方向继续，
   *  跳过剩余 tool 队列，再走一次模型。空闲时同 onSend 的效果。 */
  const onGuide = useCallback((text: string) => {
    const st = useApp.getState();
    const sp = st.currentSessionPath;
    if (!sp) {
      pushToast('请先选择一个会话', 'error');
      return;
    }
    const cwd = st.currentWorkspace()?.cwd ?? '';
    const approvalMode = st.currentWorkspace()?.approvalMode ?? 'write';
    const doGuide = async () => {
      await rpc.acquire(sp, cwd, approvalMode);
      useApp.getState().appendUserMessage(text, { steered: true });
      await rpc.steer(sp, text);
      refreshSessions();
    };
    void doGuide().catch((err) =>
      pushToast(`引导失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    );
  }, [pushToast, refreshSessions]);

  /** 排队（follow_up）：等当前 agent turn 跑完再处理（不打断当前 tool/t）。 */
  const onQueue = useCallback((text: string) => {
    const st = useApp.getState();
    const sp = st.currentSessionPath;
    if (!sp) {
      pushToast('请先选择一个会话', 'error');
      return;
    }
    const cwd = st.currentWorkspace()?.cwd ?? '';
    const approvalMode = st.currentWorkspace()?.approvalMode ?? 'write';
    const doQueue = async () => {
      await rpc.acquire(sp, cwd, approvalMode);
      useApp.getState().appendUserMessage(text, { queued: true });
      await rpc.followUp(sp, text);
      refreshSessions();
    };
    void doQueue().catch((err) =>
      pushToast(`排队失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    );
  }, [pushToast, refreshSessions]);

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

  const onNewSession = useCallback(async (cwd?: string) => {
    useApp.getState().setMainView('chat');
    const st = useApp.getState();
    const targetCwd = cwd ?? st.currentWorkspace()?.cwd;
    if (!targetCwd) {
      pushToast('请先选择或新建一个工作空间', 'error');
      return;
    }
    const targetMode = st.workspaces.find((w) => cwdKey(w.cwd) === cwdKey(targetCwd))?.approvalMode ?? 'write';
    const target = st.workspaces.find((w) => cwdKey(w.cwd) === cwdKey(targetCwd));
    if (target && st.currentWorkspaceId !== target.id) {
      st.setCurrentWorkspaceId(target.id);
      st.persistWorkspaces();
    }
    try {
      pushToast('正在新建会话…', 'info');
      // 多进程：spawn 不带 -c（新 .jsonl），主进程 listSessions 解析新 path 返回
      const { sessionPath } = await rpc.newSessionForCwd(targetCwd, targetMode);
      await resolveAndSelectNewSession(sessionPath);
    } catch (e) {
      pushToast(`新建会话失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }, [pushToast, resolveAndSelectNewSession]);

  // 启动时加载会话列表，初始化首个显示会话（取 currentWorkspace 下 mtime 最大者，懒 acquire）
  useEffect(() => {
    if (!workspacesLoaded) return;
    void refreshSessions().then(() => {
      loadAndReconcileWorkspaces();
      const st = useApp.getState();
      const cwd = st.currentWorkspace()?.cwd;
      if (cwd) {
        const newest = st.sessions
          .filter((x) => cwdKey(x.cwd) === cwdKey(cwd))
          .sort((a, b) => b.mtime - a.mtime)[0];
        if (newest) {
          st.setCurrentSessionPath(newest.path);
          st.loadSessionMessages(newest.path);
          // 懒拉起该会话的进程（带 -c 续接历史）
          const approvalMode = st.currentWorkspace()?.approvalMode ?? 'write';
          void rpc.acquire(newest.path, cwd, approvalMode).catch((e) =>
            pushToast(`拉起会话失败：${e instanceof Error ? e.message : String(e)}`, 'error')
          );
        } else {
          // 当前工作空间没有任何会话（例如用户手动清空了 .omp/agent/sessions）：
          // 必须新建一个会话并拉起进程，否则 ready 永远不会变 true，UI 会卡死。
          void onNewSession(cwd);
        }
      }
    });
  }, [workspacesLoaded, refreshSessions, pushToast, onNewSession]);

  const onSelectSession = useCallback((s: SessionSummary) => {
    useApp.getState().setMainView('chat');
    const st = useApp.getState();
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
    useApp.getState().setState({
      messages: stNow.sessionsMap[s.path] ?? [],
      isStreaming: ps?.isStreaming ?? false,
      isAborting: ps?.isAborting ?? false,
      // 切会话时清 ompExited（新会话未退出）
      ompExited: false,
      // 清掉上一会话的统计/窗口用量，避免在新会话状态栏上串数据；
      // 新值由 refreshState（在线立即 / 懒拉起后 onReady）重新拉取。
      sessionStats: undefined,
      contextUsage: undefined,
    });
    // 若该会话从未缓冲过，从磁盘读历史
    if (!stNow.sessionsMap[s.path]) {
      useApp.getState().loadSessionMessages(s.path);
    }
    // 若进程未在线，懒拉起（带 -c 续接，用户切来即续接，不必等发消息）
    if (!ps || ps.status !== 'online') {
      const approvalMode = targetWs?.approvalMode ?? 'write';
      void rpc.acquire(s.path, s.cwd, approvalMode).catch((e) =>
        pushToast(`拉起会话失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      );
    } else if (s.path === useApp.getState().currentSessionPath) {
      // 已在线：刷新状态栏（model/thinking 等可能与其他会话不同）
      void refreshState(s.path);
    }
  }, [pushToast, refreshState]);

  const onDeleteSession = useCallback((s: SessionSummary) => {
    // 删除会话：先释放该会话的进程（避免占用池），再删磁盘文件
    void rpc.release(s.path).catch(() => undefined);
    void window.omp.deleteSession(s.path).then(refreshSessions).catch(() => undefined);
  }, [refreshSessions]);

  // ---- 会话右键操作（透传给 SessionList）----
  const onRenameSession = useCallback((s: SessionSummary) => {
    const name = window.prompt('新名称', s.title);
    if (name && name.trim()) {
      // 始终用被右键的会话 s.path，而非 currentSessionPath，避免改错对象
      void rpc.setSessionName(s.path, name.trim()).then(() => {
        refreshSessions();
      }).catch(() => undefined);
    }
  }, [refreshSessions]);

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
      const approvalMode = useApp.getState().workspaces.find((w) => cwdKey(w.cwd) === cwdKey(s.cwd))?.approvalMode ?? 'write';
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
    void window.omp.showItemInFolder(s.path)
      .catch((e) => pushToast(`打开目录失败：${e instanceof Error ? e.message : String(e)}`, 'error'));
  }, [pushToast]);

  const onExportSession = useCallback(async (s: SessionSummary) => {
    try {
      const savePath = await window.omp.showSaveDialog(`${s.title.replace(/[/\\?%*:|"<>]/g, '_')}.html`);
      if (!savePath) return;
      const approvalMode = useApp.getState().workspaces.find((w) => cwdKey(w.cwd) === cwdKey(s.cwd))?.approvalMode ?? 'write';
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

  // 切换当前工作空间的权限模式：持久化 + release 该工作空间所有在线进程（下次 acquire 用新 mode spawn）。
  const onChangeApprovalMode = useCallback((mode: ApprovalMode) => {
    const st = useApp.getState();
    const ws = st.currentWorkspace();
    if (!ws) return;
    st.setWorkspaceApprovalMode(ws.id, mode);
    const label = mode === 'yolo' ? 'YOLO · 全自动' : mode === 'always-ask' ? 'Always Ask · 每次询问' : 'Write · 默认';
    pushToast(`权限模式已切换为「${label}」，新会话生效`, 'info');
    // release 该工作空间下所有在线进程，下次 acquire 用新 mode spawn
    for (const s of st.sessions) {
      if (cwdKey(s.cwd) === cwdKey(ws.cwd)) {
        const ps = st.procStateMap[s.path];
        if (ps && ps.status === 'online') {
          void rpc.release(s.path).catch(() => undefined);
          st.setProcState(s.path, { status: 'offline' });
        }
      }
    }
  }, [pushToast]);

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
        approvalMode: 'write',
      });
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
  // 顶栏标题 = 当前会话名（而非硬编码「OMP · Codex」）
  const currentSessionTitle = useApp(
    (s) => s.sessions.find((x) => x.path === s.currentSessionPath)?.title ?? null,
  );

  const showTitleBar = IS_WIN32;

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
          <span className="topbar-title">{currentSessionTitle ?? '新会话'}</span>
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
          </div>
        </div>
        {mainView === 'skills' ? (
          <SkillsPanel />
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
          <div key={t.id} className={`toast ${t.level}`}>{t.text}</div>
        ))}
      </div>

      {exited !== false && exited !== null && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">当前会话进程已退出</div>
            <div className="modal-message">该会话的 omp 子进程退出（退出码 {exited}）。切换到其他会话可继续，或重新进入该会话会自动重新拉起。</div>
          </div>
        </div>
      )}
      {!ready && exited === false && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">正在连接 omp…</div>
            <div className="modal-message">等待首个会话进程拉起（ready）。若长时间无响应，请检查 omp 路径配置。</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 是否 Windows（模块级常量，避免每次 render 都访问 window.omp.platform）。 */
const IS_WIN32 = window.omp?.platform === 'win32';

/** 获取当前工作目录。从 store 的 currentWorkspace() 拿；空则用 cwdProcess 兜底。 */
function getWorkDir(): string {
  const ws = useApp.getState().currentWorkspace();
  if (ws?.cwd) return ws.cwd;
  return cwdProcess.cwd?.() ?? '';
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
    // open_url 是单向通知，不应入队弹窗（无法自动清除）；直接打开并自动放行应答。
    const url = req.launchUrl ?? req.url;
    if (url) void window.omp.openExternal(url);
    const sp = req.__sessionPath;
    if (sp) void Promise.resolve(rpc.respondUI(sp, { id: req.id, confirmed: true }))
      .catch(() => pushToast(`打开链接放行失败`, 'error'));
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
