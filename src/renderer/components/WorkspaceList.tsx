import React, { useMemo, useState } from 'react';
import { useApp } from '../store';
import { SessionList } from './SessionList';
import { cwdKey } from '../utils/path-key';
import type { SessionSummary, Workspace } from '../../shared/ipc-channels';

/** 把右键菜单定位 clamp 到视口内，避免溢出屏幕（估算菜单尺寸做兜底） */
function clampMenuPos(x: number, y: number): { left: number; top: number } {
  const estW = 180;
  const estH = 180;
  return {
    left: Math.max(0, Math.min(x, window.innerWidth - estW)),
    top: Math.max(0, Math.min(y, window.innerHeight - estH)),
  };
}

interface WorkspaceMenuState {
  ws: Workspace;
  x: number;
  y: number;
}

export const WorkspaceList: React.FC<{
  // 数据
  allSessions: SessionSummary[];
  currentSessionPath?: string;
  // 工作空间 CRUD
  onSelectWorkspace: (ws: Workspace) => void;
  onAddWorkspace: (cwd: string) => void;
  onRenameWorkspace: (ws: Workspace, newName: string) => void;
  onArchiveWorkspace: (ws: Workspace) => void;
  onRestoreWorkspace: (ws: Workspace) => void;
  onDeleteArchivedWorkspace: (ws: Workspace) => void;
  onToggleCollapsed: (ws: Workspace) => void;
  // 会话操作（透传给 SessionList）
  onSelectSession: (s: SessionSummary) => void;
  onRenameSession: (s: SessionSummary) => void;
  onBranchSession: (s: SessionSummary) => void;
  onExportSession: (s: SessionSummary) => void;
  onDeleteSession: (s: SessionSummary) => void;
  onCopySessionId: (s: SessionSummary) => void;
  onOpenSessionDir: (s: SessionSummary) => void;
  // 新会话（带 cwd）
  onNewSession: (cwd: string) => void;
}> = ({
  allSessions,
  currentSessionPath,
  onSelectWorkspace,
  onAddWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onRestoreWorkspace,
  onDeleteArchivedWorkspace,
  onToggleCollapsed,
  onSelectSession,
  onRenameSession,
  onBranchSession,
  onExportSession,
  onDeleteSession,
  onCopySessionId,
  onOpenSessionDir,
  onNewSession,
}) => {
  const workspaces = useApp((s) => s.workspaces);
  const archived = useApp((s) => s.archived);
  const currentWorkspaceId = useApp((s) => s.currentWorkspaceId);
  // 已加载的 omp 命令（含 skills / 插件来源）—— 仅用于技能卡片计数
  const slashCommands = useApp((s) => s.slashCommands);
  // 主工作区当前视图（chat | skills）—— 技能卡片激活态
  const mainView = useApp((s) => s.mainView);
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<WorkspaceMenuState | null>(null);
  const [renameTarget, setRenameTarget] = useState<Workspace | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [archiveExpanded, setArchiveExpanded] = useState(false);
  const [deleteArchivedTarget, setDeleteArchivedTarget] = useState<Workspace | null>(null);
  const closeMenu = () => setMenu(null);

  React.useEffect(() => {
    if (!menu) return;
    const onDoc = () => closeMenu();
    // 用 click 而不是 mousedown：mousedown 阶段就会 setMenu(null) 卸载菜单，
    // 后续 click 事件的目标已不在 React 树中，ctx-item 的 onClick 无法触发。
    // 改用 click 后，React 先派发 ctx-item.onClick，document 后关闭菜单。
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [menu]);

  // 过滤：按 displayName 大小写不敏感匹配
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((w) => w.displayName.toLowerCase().includes(q));
  }, [workspaces, search]);

  // 按工作空间分组的会话
  // key 用 cwd 的归一化形式（\ → /，小写，去尾斜杠），与 makeWorkspaceId/cwdKey 同源，
  // 避免 Windows 上 D:\code\foo / D:/code/foo / d:\code\foo\ 不命中。
  // 每组会话内部按 mtime 倒序（最近访问在前）。
  const sessionsByWs = useMemo(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const s of allSessions) {
      const key = cwdKey(s.cwd);
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => b.mtime - a.mtime);
    }
    return map;
  }, [allSessions]);

  // 工作空间（任务）按「其下会话的最近访问时间」倒序排列：
  // 最近有活动的任务排在最前；无会话的任务用 createdAt 兜底并沉底。
  // 注意：sessionsByWs 的 key 是 cwdKey(cwd)，而 ws.id 也等于 cwdKey(ws.cwd)
  // （见 store.setWorkspacesFile 迁移）。这里显式用 cwdKey(ws.cwd) 查找，
  // 不依赖「ws.id === cwdKey(ws.cwd)」这个隐式契约，避免后续 id 规则变化时漏命中。
  const sortedWorkspaces = useMemo(() => {
    const lastActive = (ws: Workspace): number => {
      const arr = sessionsByWs.get(cwdKey(ws.cwd));
      if (arr && arr.length > 0 && arr[0]) return arr[0].mtime; // 组内已按 mtime 倒序，取首个即最近
      return ws.createdAt ?? 0;
    };
    return [...filtered].sort((a, b) => lastActive(b) - lastActive(a));
  }, [filtered, sessionsByWs]);

  const handleAddByDialog = async () => {
    try {
      const cwd = await window.omp.openDirDialog();
      if (cwd) onAddWorkspace(cwd);
    } catch {
      // 取消选择或对话框失败时静默忽略
    }
  };

  const handleRename = (ws: Workspace) => {
    closeMenu();
    setRenameTarget(ws);
    setRenameValue(ws.displayName);
  };

  const submitRename = () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (name && name !== renameTarget.displayName) {
      onRenameWorkspace(renameTarget, name);
    }
    setRenameTarget(null);
    setRenameValue('');
  };

  const handleArchive = (ws: Workspace) => {
    closeMenu();
    onArchiveWorkspace(ws);
  };

  const handleOpenInExplorer = async (ws: Workspace) => {
    closeMenu();
    // 复用 openExternal 打开本地路径（Windows 资源管理器 / macOS Finder）
    await window.omp.openExternal(ws.cwd).catch(() => undefined);
  };

  const handleNewSession = (ws: Workspace) => {
    closeMenu();
    // 如果目标工作空间是折叠的，先展开（否则新建的会话看不见）；
    // onNewSession 内部会把 ws 设为 current，展开后用户立刻能看到新会话。
    if (ws.collapsed) onToggleCollapsed(ws);
    onNewSession(ws.cwd);
  };

  return (
    <div className="sidebar">
      {/* 技能卡片（侧栏顶部）：点击切换到右侧主工作区的技能/插件面板 */}
      <button
        className={`skill-card ${mainView === 'skills' ? 'active' : ''}`}
        onClick={() => useApp.getState().setMainView('skills')}
        title="查看 omp 已安装的技能与插件"
      >
        <span className="skill-card-icon">🧩</span>
        <span className="skill-card-label">技能</span>
        <span className="skill-card-count">
          {slashCommands.filter((c) => c.source === 'skill').length}
        </span>
      </button>

      {/* 搜索框 */}
      <div className="sidebar-search">
        <input
          className="search-input"
          type="text"
          placeholder="搜索工作空间"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* 工作空间列表 */}
      <div className="workspace-list">
        {sortedWorkspaces.length === 0 ? (
          <div className="sidebar-empty">
            {workspaces.length === 0 ? '暂无工作空间' : '没有匹配的工作空间'}
          </div>
        ) : (
          sortedWorkspaces.map((ws) => {
            const isCurrent = ws.id === currentWorkspaceId;
            const isCollapsed = ws.collapsed;
            const wsSessions = sessionsByWs.get(cwdKey(ws.cwd)) ?? [];
            return (
              <div key={ws.id} className={`workspace ${isCurrent ? 'current' : ''}`}>
                <div
                  className="workspace-header"
                  onClick={() => {
                    // 点击 header 语义：
                    // - 非 current：切到该工作空间 + 强制展开（避免点两次才看到会话列表）
                    // - current：折叠/展开切换
                    if (isCurrent) {
                      onToggleCollapsed(ws);
                    } else {
                      onSelectWorkspace(ws);
                      if (isCollapsed) onToggleCollapsed(ws);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ ws, x: e.clientX, y: e.clientY });
                  }}
                  title={ws.cwd}
                >
                  <span
                    className={`workspace-toggle ${isCollapsed ? 'collapsed' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleCollapsed(ws);
                    }}
                    title={isCollapsed ? '展开' : '折叠'}
                  >
                    ▸
                  </span>
                  <span className="workspace-icon">📁</span>
                  <span className="workspace-name">{ws.displayName}</span>
                  <span
                    className="workspace-menu-trigger"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenu({ ws, x: e.clientX, y: e.clientY });
                    }}
                    title="更多"
                  >
                    ⋯
                  </span>
                </div>
                {!isCollapsed && (
                  <div className="workspace-body">
                    <SessionList
                      sessions={wsSessions}
                      currentPath={isCurrent ? currentSessionPath : undefined}
                      onSelect={onSelectSession}
                      onRename={onRenameSession}
                      onBranch={onBranchSession}
                      onExport={onExportSession}
                      onDelete={onDeleteSession}
                      onCopyId={onCopySessionId}
                      onOpenDir={onOpenSessionDir}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 底部按钮 */}
      <div className="sidebar-footer">
        <button className="btn btn-block sidebar-footer-btn" onClick={handleAddByDialog}>
          + 新建工作空间
        </button>
      </div>

      {/* 归档区（默认折叠） */}
      {archived.length > 0 && (
        <div className="archive-section">
          <div
            className="archive-header"
            onClick={() => setArchiveExpanded((e) => !e)}
            title="已归档的工作空间"
          >
            <span className={`workspace-toggle ${archiveExpanded ? '' : 'collapsed'}`}>▸</span>
            <span className="archive-title">归档区</span>
            <span className="archive-count">{archived.length}</span>
          </div>
          {archiveExpanded && (
            <div className="archive-list">
              {archived.map((ws) => (
                <div key={ws.id} className="archive-item" title={ws.cwd}>
                  <span className="archive-name">{ws.displayName}</span>
                  <div className="archive-actions">
                    <button
                      className="btn btn-sm"
                      onClick={() => onRestoreWorkspace(ws)}
                      title="恢复到任务区"
                    >恢复</button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setDeleteArchivedTarget(ws)}
                      title="彻底删除（含磁盘会话记录）"
                    >删除</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {menu && (
        <div
          className="ctx-menu"
          style={{ ...clampMenuPos(menu.x, menu.y), position: 'fixed' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ctx-item" onClick={() => handleNewSession(menu.ws)}>新建会话</div>
          <div className="ctx-item" onClick={() => handleRename(menu.ws)}>重命名</div>
          <div className="ctx-item" onClick={() => handleOpenInExplorer(menu.ws)}>在文件管理器中打开</div>
          <div className="ctx-sep" />
          <div className="ctx-item" onClick={() => handleArchive(menu.ws)}>归档</div>
        </div>
      )}

      {renameTarget && (
        <div className="modal-overlay" onMouseDown={() => { setRenameTarget(null); setRenameValue(''); }}>
          {/* Enter/Escape 在主输入框里处理（见 input.onKeyDown）；此处只在焦点落在按钮等非输入框时响应 Escape */}
          <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => {
            if (e.key === 'Escape') { setRenameTarget(null); setRenameValue(''); }
          }}>
            <div className="modal-title">重命名工作空间</div>
            <input
              type="text"
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                // 把 Enter/Escape 处理移入输入框，避免被 input 的 stopPropagation 吞掉
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submitRename(); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenameTarget(null); setRenameValue(''); }
              }}
            />
            <div className="modal-actions">
              <button className="btn" onClick={() => { setRenameTarget(null); setRenameValue(''); }}>取消</button>
              <button className="btn btn-primary" onClick={submitRename}>确定</button>
            </div>
          </div>
        </div>
      )}

      {deleteArchivedTarget && (
        <div className="modal-overlay" onMouseDown={() => setDeleteArchivedTarget(null)}>
          {/* 删除确认：Enter 不触发删除（只允许点击按钮），避免误删；Escape 关闭 */}
          <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => {
            if (e.key === 'Escape') setDeleteArchivedTarget(null);
          }}>
            <div className="modal-title">彻底删除</div>
            <div className="modal-message">
              {`将彻底删除「${deleteArchivedTarget.displayName}」及其所有会话记录（磁盘文件），此操作不可恢复。`}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setDeleteArchivedTarget(null)}>取消</button>
              <button
                className="btn btn-danger"
                onClick={() => { onDeleteArchivedWorkspace(deleteArchivedTarget); setDeleteArchivedTarget(null); }}
              >彻底删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
