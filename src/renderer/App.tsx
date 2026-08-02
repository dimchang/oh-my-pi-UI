import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, type UiRequest, type Attachment, toolNameOf, isImageFile } from './store';
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
import { DiffView } from './components/DiffView';
import { SettingsPanel } from './components/SettingsPanel';
import { cwdKey, makeWorkspaceId, basename } from './utils/path-key';
import { stripDataUrlPrefix } from './utils/image-data-url';
import { applyAppearance } from './store';
import type { OmpFrame, RpcExtensionUIRequest, RpcImage, AvailableCommandsUpdateFrame, RpcSessionState, TodoPhase, ModelInfo, SlashCommand } from '../shared/rpc-types';
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

  const togglePanel = useCallback((panel: 'files' | 'todo' | 'diff') => {
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
  /** 新建会话前已知的真实 session path 快照。
   *  tempKey→realPath 迁移时不再靠 mtime 猜，而是找同 cwd 下"本次新建之后才出现"的真实 path。 */
  const knownSessionPathsBeforeNew = useRef<Set<string>>(new Set());

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
    // 用"新建前快照"找真正刚落盘的新会话，而不是靠 mtime 猜（否则首条消息 agent_end 前可能命中旧会话）。
    const candidates = st.sessions
      .filter((x) => cwdKey(x.cwd) === cwdKey(cwd) && x.path !== cur && !knownSessionPathsBeforeNew.current.has(x.path))
      .sort((a, b) => b.mtime - a.mtime);
    const newest = candidates[0];
    if (!newest || newest.path === cur) { done(); return; }
    knownSessionPathsBeforeNew.current.add(newest.path);
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
        if (n.message) {
          // 抑制 omp 启动时的 MCP 挂载噪声：通知消息以 `xd://` 开头说明是 omp 内部扩展协议
          // （如 `xd://: mounted mcp__node_repl_js, mcp__node_repl_js_add_node_module_dir, ...`），
          // 属于每次启动都会刷的运行时注册日志，对用户无意义，弹窗只会污染视线。直接丢弃。
          if (/^xd:\/\//i.test(n.message)) return;
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
      // 仅当退出的是当前显示会话，弹“已退出”遮罩
      if (sessionPath === useApp.getState().currentSessionPath) {
        useApp.getState().setOmpExited(code);
      }
      // 自动恢复：非正常退出（code !== 0）且非用户主动 release，延迟后尝试重新拉起。
      // 避免崩溃后用户必须手动切换再切回才能继续。
      if (code !== 0 && code !== null) {
        const st = useApp.getState();
        const ws = st.workspaces.find((w) => st.sessions.some((s) => s.path === sessionPath && cwdKey(s.cwd) === cwdKey(w.cwd)));
        const cwd = ws?.cwd;
        if (cwd) {
          const approvalMode = ws?.approvalMode ?? 'write';
          setTimeout(() => {
            // 仅当该会话仍处于 offline 状态时才恢复（避免用户已手动操作）
            const ps = useApp.getState().procStateMap[sessionPath];
            if (ps?.status === 'offline') {
              void rpc.acquire(sessionPath, cwd, approvalMode)
                .then(() => {
                  useApp.getState().pushToast(`会话进程已自动恢复`, 'info');
                  // 如果恢复的是当前显示会话，清除退出遮罩
                  if (sessionPath === useApp.getState().currentSessionPath) {
                    useApp.getState().setOmpExited(null);
                  }
                })
                .catch(() => {
                  // 恢复失败不弹错，用户可手动切换触发重试
                });
            }
          }, 2000);
        }
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
  const onSend = useCallback((text: string, attachments?: Attachment[]) => {
    const st = useApp.getState();
    let sp = st.currentSessionPath;
    if (!sp) {
      pushToast('请先选择一个会话', 'error');
      return;
    }
    const cwd = st.currentWorkspace()?.cwd ?? '';
    const approvalMode = st.currentWorkspace()?.approvalMode ?? 'write';
    // 图片始终通过 prompt.images 内联发送（与原生 OMP 行为一致）。
    // omp 运行时会自动处理：视觉模型直接看图；纯文本 orchestrator 则通过 vision 角色
    // 预处理生成图片描述注入上下文（image-attachment-description 帧）。
    // 关键：images 必须是「图片对象数组」(RpcImage)，裸字符串数组会被 OMP 当文本透传。
    // 更进一步：对象须带 blob:sha256: URI（经 omp blob 入库）才能触发 vision 路由，
    // 等同原生 OMP 的 @image.png 入库机制（见 probe-blob*.mjs / probe-img-shapes.mjs 实测）。
    const promptText = buildPromptWithAttachments(text, attachments);
    const doSend = async () => {
      const imageRefs = await collectImageRefs(attachments);
      // temp key 会话直接发给它绑定的进程即可；agent_end 时 migrateTempSession 会正确迁移到真实 path。
      // 不在发送前做 mtime 猜测式迁移——那会在真实 .jsonl 落盘前误迁到旧会话（issue: 新会话输入串到旧会话）。
      await rpc.acquire(sp!, cwd, approvalMode);
      useApp.getState().appendUserMessage(text, { attachments });
      await rpc.prompt(sp!, promptText, imageRefs);
      refreshSessions();
    };
    void doSend().catch((err) =>
      pushToast(`发送失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    );
  }, [pushToast, refreshSessions]);

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
    const approvalMode = st.currentWorkspace()?.approvalMode ?? 'write';
    const promptText = buildPromptWithAttachments(text, attachments);
    const doGuide = async () => {
      const imageRefs = await collectImageRefs(attachments);
      // 同 onSend：temp key 不提前迁移，避免误迁到旧会话
      await rpc.acquire(sp!, cwd, approvalMode);
      useApp.getState().appendUserMessage(text, { steered: true, attachments });
      await rpc.steer(sp!, promptText, imageRefs);
      refreshSessions();
    };
    void doGuide().catch((err) =>
      pushToast(`引导失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    );
  }, [pushToast, refreshSessions]);

  /** 排队（follow_up）：等当前 agent turn 跑完再处理（不打断当前 tool/t）。 */
  const onQueue = useCallback((text: string, attachments?: Attachment[]) => {
    const st = useApp.getState();
    let sp = st.currentSessionPath;
    if (!sp) {
      pushToast('请先选择一个会话', 'error');
      return;
    }
    const cwd = st.currentWorkspace()?.cwd ?? '';
    const approvalMode = st.currentWorkspace()?.approvalMode ?? 'write';
    const promptText = buildPromptWithAttachments(text, attachments);
    const doQueue = async () => {
      const imageRefs = await collectImageRefs(attachments);
      // 同 onSend：temp key 不提前迁移，避免误迁到旧会话
      await rpc.acquire(sp!, cwd, approvalMode);
      useApp.getState().appendUserMessage(text, { queued: true, attachments });
      await rpc.followUp(sp!, promptText, imageRefs);
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
      // 先快照当前已知真实 path，tempKey→realPath 迁移时用它识别真正的新会话，避免误迁到旧会话。
      knownSessionPathsBeforeNew.current = new Set(
        st.sessions.map((s) => s.path).filter((p) => !p.startsWith('__new_')),
      );
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
    if (ps?.status === 'online') {
      // 已在线：刷新状态栏（model/thinking 等可能与其他会话不同）
      void refreshState(s.path);
      refreshCommands(s.path);
    } else {
      // 仅浏览历史：**不立刻拉起 omp 进程**（issue: 连续点不同会话会触发
      // "进程池已满且所有会话都在等待用户确认" 且白白占用进程）。
      // 等用户真正输入/发送时，由 InputBox 聚焦 / ensureOnline / onSend 按需懒拉起。
      // 清掉上一会话残留的状态栏数据，避免串数据（新值在拉起后由 refreshState 填充）。
      useApp.getState().setState({
        model: undefined,
        thinkingLevel: undefined,
        contextUsage: undefined,
        sessionStats: undefined,
      });
    }
  }, [pushToast, refreshState, refreshCommands]);

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
          // 先等待 release 成功，再置 offline；release 失败则保持 online，
          // 避免「状态已是 offline 但进程实际仍在线」的不同步（issue 11）
          void rpc.release(s.path)
            .then(() => st.setProcState(s.path, { status: 'offline' }))
            .catch(() => undefined);
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
            <button
              className={`icon-btn ${rightPanel === 'diff' ? 'active' : ''}`}
              onClick={() => togglePanel('diff')}
              title="Diff 视图"
            >
              <Icon name="diff" size={16} />
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
          {rightPanel === 'diff' && <DiffPanel />}
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
 *  readImageAsDataUrl 已有完整安防校验（白名单路径 + realpath 防逃逸），可直接复用。
 *  失败则退回 path 对象（OMP 自行读文件内联，等同原生行为）。 */
async function collectImageRefs(atts?: Attachment[]): Promise<RpcImage[]> {
  if (!atts) return [];
  const imgs = atts.filter((a) => a.kind === 'image' || isImageFile(a.name));
  const out: RpcImage[] = [];
  for (const a of imgs) {
    const mimeType = imageMimeFromName(a.name);
    try {
      const { dataUrl } = await window.omp.readImageAsDataUrl(a.path);
      // 只发裸 base64（去掉 data:image/...;base64, 前缀），与原生 OMP 一致
      out.push({ type: 'image', data: stripDataUrlPrefix(dataUrl), mimeType });
    } catch {
      out.push({ type: 'image', path: a.path, mimeType });
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
