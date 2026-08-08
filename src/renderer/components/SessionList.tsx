import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../store';
import type { SessionSummary } from '../../shared/ipc-channels';

function relTime(mtime: number): string {
  const diff = Date.now() - mtime;
  if (diff < 0) return '刚刚'; // mtime 来自未来（时钟回拨/时区）→ 显示刚刚，避免负数
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(mtime).toLocaleDateString();
}

/** 把右键菜单定位 clamp 到视口内，避免溢出屏幕 */
function clampMenuPos(x: number, y: number): { left: number; top: number } {
  const estW = 180;
  const estH = 200;
  return {
    left: Math.max(0, Math.min(x, window.innerWidth - estW)),
    top: Math.max(0, Math.min(y, window.innerHeight - estH)),
  };
}

/** 纯展示型会话列表（接收 sessions 和 currentPath，由父组件 WorkspaceList 提供数据）
 *  M5 重构：从原本自带数据获取的版本改为只渲染列表 */
export const SessionList: React.FC<{
  sessions: SessionSummary[];
  currentPath?: string;
  onSelect: (s: SessionSummary) => void;
  onRename: (s: SessionSummary) => void;
  onBranch: (s: SessionSummary) => void;
  onExport: (s: SessionSummary) => void;
  onDelete: (s: SessionSummary) => void;
  /** 复制 session id（debug 用） */
  onCopyId: (s: SessionSummary) => void;
  /** 在文件管理器中打开 session 所在目录 */
  onOpenDir: (s: SessionSummary) => void;
}> = ({ sessions, currentPath, onSelect, onRename, onBranch, onExport, onDelete, onCopyId, onOpenDir }) => {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; session: SessionSummary } | null>(null);
  const closeMenu = () => setCtxMenu(null);
  // 会话显示名覆盖层（host 侧重命名），优先于扫盘得到的 title
  const sessionNames = useApp((s) => s.sessionNames);

  // 任一右键菜单打开时，通过自定义事件通知其他菜单关闭（解决多菜单重叠）
  const openMenu = (menu: NonNullable<typeof ctxMenu>) => {
    document.dispatchEvent(new CustomEvent('omp:ctxmenu-open'));
    setCtxMenu(menu);
  };

  React.useEffect(() => {
    if (!ctxMenu) return;
    const onDoc = () => closeMenu();
    const onOtherMenu = () => closeMenu();
    // 用 click 而不是 mousedown：避免 mousedown 提前关闭菜单导致 ctx-item 的 onClick 永不触发
    document.addEventListener('click', onDoc);
    document.addEventListener('omp:ctxmenu-open', onOtherMenu);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('omp:ctxmenu-open', onOtherMenu);
    };
  }, [ctxMenu]);

  if (sessions.length === 0) {
    return <div className="sidebar-empty">该工作空间下暂无会话</div>;
  }

  return (
    <>
      {sessions.map((s) => (
        <div
          key={s.path}
          className={`session-item ${currentPath === s.path ? 'active' : ''}`}
          onClick={() => onSelect(s)}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu({ x: e.clientX, y: e.clientY, session: s });
          }}
          title={s.path}
        >
          <div className="session-title">{sessionNames[s.path] ?? s.title}</div>
          <div className="session-time">{relTime(s.mtime)}</div>
        </div>
      ))}

      {ctxMenu && createPortal(
        <div
          className="ctx-menu"
          style={{ ...clampMenuPos(ctxMenu.x, ctxMenu.y), position: 'fixed' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ctx-item" onClick={() => { closeMenu(); onRename(ctxMenu.session); }}>重命名</div>
          <div className="ctx-item" onClick={() => { closeMenu(); onBranch(ctxMenu.session); }}>分叉</div>
          <div className="ctx-item" onClick={() => { closeMenu(); onExport(ctxMenu.session); }}>导出 HTML</div>
          <div className="ctx-sep" />
          <div className="ctx-item" onClick={() => { closeMenu(); onCopyId(ctxMenu.session); }}>复制 Session ID</div>
          <div className="ctx-item" onClick={() => { closeMenu(); onOpenDir(ctxMenu.session); }}>打开所在目录</div>
          <div className="ctx-sep" />
          <div className="ctx-item ctx-danger" onClick={() => { closeMenu(); onDelete(ctxMenu.session); }}>删除</div>
        </div>,
        document.body
      )}
    </>
  );
};
