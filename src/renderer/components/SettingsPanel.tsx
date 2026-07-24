/**
 * SettingsPanel — 配置页主框架（全屏 overlay：左侧导航 + 右侧内容区）。
 * 入口：TitleBar 的 Window 菜单 →「配置」。Esc / 遮罩点击 / ✕ 关闭。
 */

import React, { useEffect } from 'react';
import { useApp } from '../store';
import { SettingsModelConfig } from './SettingsModelConfig';

const TABS: Array<{ key: 'system' | 'agent' | 'model'; icon: string; label: string }> = [
  { key: 'system', icon: '⚙️', label: '系统设置' },
  { key: 'agent', icon: '🤖', label: '智能体设置' },
  { key: 'model', icon: '📦', label: '模型配置' },
];

export const SettingsPanel: React.FC = () => {
  const open = useApp((s) => s.settingsOpen);
  const tab = useApp((s) => s.settingsTab);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useApp.getState().setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-overlay settings-overlay" onMouseDown={(e) => {
      if (e.target === e.currentTarget) useApp.getState().setSettingsOpen(false);
    }}>
      <div className="settings-panel">
        <div className="settings-header">
          <span className="settings-header-title">配置</span>
          <button
            className="settings-close"
            title="关闭"
            onClick={() => useApp.getState().setSettingsOpen(false)}
          >
            ✕
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-nav">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`settings-nav-item ${tab === t.key ? 'active' : ''}`}
                onClick={() => useApp.getState().setSettingsTab(t.key)}
              >
                <span className="settings-nav-icon">{t.icon}</span>
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          <div className="settings-content">
            {tab === 'system' && (
              <div className="settings-placeholder">系统设置 · 暂无配置项</div>
            )}
            {tab === 'agent' && (
              <div className="settings-placeholder">智能体设置 · 暂无配置项</div>
            )}
            {tab === 'model' && <SettingsModelConfig />}
          </div>
        </div>
      </div>
    </div>
  );
};
