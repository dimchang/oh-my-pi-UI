import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../store';

interface MenuItem {
  label?: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
}

interface MenuDef {
  label: string;
  items: MenuItem[];
}

// 模块级常量：不随每次 render 重建，避免菜单定义对象反复分配导致不必要的重渲染
const MENUS: MenuDef[] = [
  {
    label: 'Window',
    items: [
      { label: '切换开发者工具', action: () => window.omp.menuToggleDevTools() },
      { label: '设置', action: () => useApp.getState().setSettingsOpen(true) },
    ],
  },
  {
    label: 'Help',
    items: [
      { label: '关于 OMP UI', action: () => window.omp.menuShowAbout() },
      { separator: true },
      { label: 'Stats (会话统计)', action: () => window.omp.menuStats() },
    ],
  },
];

export function TitleBar(): React.ReactElement | null {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // 监听最大化状态变化
  useEffect(() => {
    let mounted = true;
    window.omp.isWindowMaximized().then((v) => {
      if (mounted) setIsMaximized(v);
    }).catch(() => undefined);
    const off = window.omp.onWindowMaximizedChange((v) => setIsMaximized(v));
    return () => {
      mounted = false;
      off();
    };
  }, []);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!activeMenu) return;
    const onClick = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [activeMenu]);

  const exec = useCallback((item: MenuItem) => {
    if (item.disabled || item.separator || !item.action) return;
    item.action();
    setActiveMenu(null);
  }, []);

  const handleMenuEnter = useCallback((label: string) => {
    // 鼠标移到另一个菜单上时，若已有菜单打开则切换到悬停的菜单
    if (activeMenu) {
      setActiveMenu(label);
    }
  }, [activeMenu]);

  const handleMenuClick = useCallback((label: string) => {
    setActiveMenu((prev) => (prev === label ? null : label));
  }, []);

  return (
    <div ref={barRef} className="titlebar">
      <div className="titlebar-menus">
        <span className="titlebar-brand">OMP-UI</span>
        {MENUS.map((menu) => (
          <div
            key={menu.label}
            className={`titlebar-menu ${activeMenu === menu.label ? 'open' : ''}`}
            onMouseEnter={() => handleMenuEnter(menu.label)}
          >
            <button
              className="titlebar-menu-btn"
              onClick={() => handleMenuClick(menu.label)}
              onMouseDown={(e) => e.preventDefault()}
            >
              {menu.label}
            </button>
            {activeMenu === menu.label && (
              <div className="titlebar-dropdown">
              {menu.items.map((item, idx) =>
                item.separator ? (
                  <div key={`sep-${idx}`} className="titlebar-dropdown-separator" />
                ) : (
                  <button
                    key={item.label ?? idx}
                    className={`titlebar-dropdown-item ${item.disabled ? 'disabled' : ''}`}
                    onClick={() => exec(item)}
                    disabled={item.disabled}
                  >
                    {item.label}
                  </button>
                ),
              )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="titlebar-drag" aria-hidden="true" />
      <div className="titlebar-controls">
        <button
          className="titlebar-control minimize"
          title="最小化"
          onClick={() => window.omp.minimizeWindow()}
          aria-label="最小化"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="titlebar-control maximize"
          title={isMaximized ? '还原' : '最大化'}
          onClick={() => window.omp.maximizeWindow()}
          aria-label={isMaximized ? '还原' : '最大化'}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path
                d="M1 3.5v5h8v-5h-8zm1 1h6v3h-6v-3z"
                fill="currentColor"
              />
              <path
                d="M2 1.5h6v1h-6z"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect
                x="0.5"
                y="0.5"
                width="9"
                height="9"
                rx="0.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          )}
        </button>
        <button
          className="titlebar-control close"
          title="关闭"
          onClick={() => window.omp.closeWindow()}
          aria-label="关闭"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M1 1l8 8M9 1L1 9"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
