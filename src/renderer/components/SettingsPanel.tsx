/**
 * SettingsPanel — 配置页主框架（全屏 overlay：左侧导航 + 右侧内容区）。
 * 入口：TitleBar 的 Window 菜单 →「设置」。Esc / 遮罩点击 / ✕ 关闭。
 */

import React, { useEffect, useState } from 'react';
import { useApp } from '../store';
import { SettingsModelConfig } from './SettingsModelConfig';
import { SettingsHooks } from './SettingsHooks';
import type { AppearanceConfig } from '../../shared/ipc-channels';
import { builtinThemes } from '../themes';
import { Icon, type IconName } from './Icon';

const TABS: Array<{ key: 'system' | 'agent' | 'model'; icon: IconName; label: string }> = [
  { key: 'system', icon: 'cog', label: '系统配置' },
  { key: 'agent', icon: 'robot', label: '智能体设置' },
  { key: 'model', icon: 'pkg', label: '模型配置' },
];

const FONT_PRESETS: Array<{ label: string; value: string }> = [
  { label: '系统默认', value: '' },
  { label: '无衬线 Sans', value: "'Inter', -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { label: '等宽 Mono', value: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace" },
  { label: '衬线 Serif', value: "Georgia, 'Times New Roman', 'Songti SC', serif" },
  { label: '微软雅黑', value: "'Microsoft YaHei', 'PingFang SC', sans-serif" },
];

const MODE_OPTIONS: Array<{ value: 'system' | 'light' | 'dark'; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
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
          <span className="settings-header-title">设置</span>
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
                <span className="settings-nav-icon">
                  <Icon name={t.icon} size={18} strokeWidth={1.8} />
                </span>
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          <div className="settings-content">
            {tab === 'system' && <SystemConfigTab />}
            {tab === 'agent' && <SettingsHooks />}
            {tab === 'model' && <SettingsModelConfig />}
          </div>
        </div>
      </div>
    </div>
  );
};

/** 系统配置：系统提示词 + 输入行为（默认：引导）+ 系统风格（外观） */
const SystemConfigTab: React.FC = () => {
  const systemPrompt = useApp((s) => s.systemPrompt);
  const appearance = useApp((s) => s.appearance);
  const inputBehavior = useApp((s) => s.inputBehavior ?? 'guide');

  const [promptDraft, setPromptDraft] = useState(systemPrompt ?? '');
  // appearance 用本地草稿，避免每次拖动滑块都触发 persist（失焦/松手时提交）
  const [theme, setTheme] = useState(appearance?.theme ?? '');
  const [mode, setMode] = useState<AppearanceConfig['mode']>(appearance?.mode ?? 'system');
  const [fontFamily, setFontFamily] = useState(appearance?.fontFamily ?? '');
  const [fontSize, setFontSize] = useState(appearance?.fontSize ?? 14);
  const [bgEnabled, setBgEnabled] = useState(Boolean(appearance?.bgColor));
  const [bgColor, setBgColor] = useState(appearance?.bgColor ?? '#0d1117');
  const [accentEnabled, setAccentEnabled] = useState(Boolean(appearance?.accentColor));
  const [accentColor, setAccentColor] = useState(appearance?.accentColor ?? '#0a84ff');

  // 外部（如恢复默认）同步时刷新本地草稿
  useEffect(() => { setPromptDraft(systemPrompt ?? ''); }, [systemPrompt]);
  useEffect(() => {
    setTheme(appearance?.theme ?? '');
    setMode(appearance?.mode ?? 'system');
    setFontFamily(appearance?.fontFamily ?? '');
    setFontSize(appearance?.fontSize ?? 14);
    setBgEnabled(Boolean(appearance?.bgColor));
    setBgColor(appearance?.bgColor ?? '#0d1117');
    setAccentEnabled(Boolean(appearance?.accentColor));
    setAccentColor(appearance?.accentColor ?? '#0a84ff');
  }, [appearance]);

  // 从 store get() 读最新值作为 base，避免闭包捕获到过时的本地草稿 state
  const commit = (patch: Partial<AppearanceConfig>) => {
    const prev = useApp.getState().appearance;
    const next: AppearanceConfig = {
      theme: prev?.theme ?? (theme || undefined),
      mode: prev?.mode ?? mode,
      fontFamily: prev?.fontFamily ?? (fontFamily || undefined),
      fontSize: prev?.fontSize ?? (fontSize > 0 ? fontSize : undefined),
      bgColor: prev?.bgColor ?? (bgEnabled ? bgColor : undefined),
      accentColor: prev?.accentColor ?? (accentEnabled ? accentColor : undefined),
      ...patch,
    };
    useApp.getState().setAppearance(next);
  };

  const resetAppearance = () => {
    setTheme(''); setMode('system'); setFontFamily(''); setFontSize(14);
    setBgEnabled(false); setBgColor('#0d1117');
    setAccentEnabled(false); setAccentColor('#0a84ff');
    useApp.getState().setAppearance({});
  };

  return (
    <div className="settings-scroll">
      {/* ===== 系统提示词 ===== */}
      <section className="settings-section">
        <h3 className="settings-section-title">系统提示词</h3>
        <p className="settings-section-desc">
          每次<strong>新建会话</strong>时，这段内容会通过 omp 的 <code>--append-system-prompt</code> 自动注入到新会话中（追加在 omp 默认提示词之后）。续接/恢复的历史会话不会重复注入。
        </p>
        <textarea
          className="settings-textarea"
          placeholder="例如：你是一个严谨的中文助手，回答尽量简洁，代码注释用中文。"
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)}
          onBlur={() => useApp.getState().setSystemPrompt(promptDraft)}
          rows={6}
        />
        <div className="settings-row-end">
          <span className="settings-hint">{promptDraft.trim() ? `${promptDraft.trim().length} 字` : '未设置'}</span>
          {systemPrompt !== promptDraft && (
            <button className="settings-btn" onClick={() => useApp.getState().setSystemPrompt(promptDraft)}>
              保存提示词
            </button>
          )}
        </div>
      </section>

      {/* ===== 输入行为：Enter 默认行为（引导 / 排队） ===== */}
      <section className="settings-section">
        <h3 className="settings-section-title">输入行为</h3>
        <p className="settings-section-desc">
          控制输入框 <kbd>Enter</kbd> 默认行为；<kbd>Shift</kbd>+<kbd>Enter</kbd> 自动取反。
        </p>
        <div className="settings-toggle-row" role="tablist" aria-label="输入行为">
          <button
            role="tab"
            aria-selected={inputBehavior === 'queue'}
            className={`settings-toggle-btn ${inputBehavior === 'queue' ? 'active' : ''}`}
            onClick={() => useApp.getState().setInputBehavior('queue')}
            title="等当前 agent turn 跑完再处理（不打断当前 tool/t）"
          >
            排队
          </button>
          <button
            role="tab"
            aria-selected={inputBehavior === 'guide'}
            className={`settings-toggle-btn ${inputBehavior === 'guide' ? 'active' : ''}`}
            onClick={() => useApp.getState().setInputBehavior('guide')}
            title="mid-run 引导：当前 tool 完成后立即按新方向继续（omp 跳过剩余 tool 队列）"
          >
            引导
          </button>
        </div>
        <p className="settings-hint" style={{ marginTop: 10 }}>
          {inputBehavior === 'guide'
            ? '当前：Enter 引导（mid-run）。omp 在当前 tool 完成后立即按新方向继续，跳过剩余 tool 队列。'
            : '当前：Enter 排队。把消息追加到当前会话末尾，等当前 agent turn 跑完再处理，不打断当前 tool/t。'}
        </p>
      </section>

      {/* ===== 系统风格 ===== */}
      <section className="settings-section">
        <h3 className="settings-section-title">系统风格</h3>
        <p className="settings-section-desc">选择主题风格与配色模式，调整字体、字号、背景色与强调色。修改即时生效，并自动保存。</p>

        {/* 主题风格 */}
        <div className="settings-field">
          <label className="settings-field-label">主题风格</label>
          <div className="theme-grid">
            <button
              className={`theme-card ${theme === '' ? 'active' : ''}`}
              onClick={() => { setTheme(''); commit({ theme: undefined }); }}
            >
              <span className="theme-card-icon">
                <span className="theme-card-icon-lines">
                  <i />
                  <i />
                  <i />
                </span>
                <i className="theme-card-icon-bar" style={{ background: 'hsl(211 100% 50%)' }} />
              </span>
              <span className="theme-card-info">
                <span className="theme-card-name">默认</span>
                <span className="theme-card-desc">Apple 蓝，简洁明快</span>
              </span>
            </button>
            {builtinThemes.map((t) => (
              <button
                key={t.id}
                className={`theme-card ${theme === t.id ? 'active' : ''}`}
                onClick={() => { setTheme(t.id); commit({ theme: t.id }); }}
              >
                <span className="theme-card-icon">
                  <span className="theme-card-icon-lines">
                    <i />
                    <i />
                    <i />
                  </span>
                  <i className="theme-card-icon-bar" style={{ background: `hsl(${t.light.accent.brand})` }} />
                </span>
                <span className="theme-card-info">
                  <span className="theme-card-name">{t.name}</span>
                  <span className="theme-card-desc">{t.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* 配色模式 */}
        <div className="settings-field">
          <label className="settings-field-label">配色模式</label>
          <div className="segmented">
            {MODE_OPTIONS.map((o) => (
              <button
                key={o.value}
                className={`segmented-item ${mode === o.value ? 'active' : ''}`}
                onClick={() => { setMode(o.value); commit({ mode: o.value }); }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* 字体 */}
        <div className="settings-field">
          <label className="settings-field-label">主字体</label>
          <select
            className="settings-select"
            value={fontFamily}
            onChange={(e) => { setFontFamily(e.target.value); commit({ fontFamily: e.target.value || undefined }); }}
          >
            {FONT_PRESETS.map((f) => (
              <option key={f.label} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>

        {/* 字号 */}
        <div className="settings-field">
          <label className="settings-field-label">字号</label>
          <div className="settings-slider-row">
            <input
              type="range"
              min={12}
              max={20}
              step={1}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              onMouseUp={() => commit({ fontSize: fontSize > 0 ? fontSize : undefined })}
              onTouchEnd={() => commit({ fontSize: fontSize > 0 ? fontSize : undefined })}
            />
            <span className="settings-slider-value">{fontSize}px</span>
          </div>
        </div>

        {/* 背景色 */}
        <div className="settings-field">
          <label className="settings-field-label">背景颜色</label>
          <div className="settings-color-row">
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={bgEnabled}
                onChange={(e) => { setBgEnabled(e.target.checked); commit({ bgColor: e.target.checked ? bgColor : undefined }); }}
              />
              <span>自定义背景色</span>
            </label>
            <input
              type="color"
              className="settings-color"
              value={bgColor}
              disabled={!bgEnabled}
              onChange={(e) => { setBgColor(e.target.value); commit({ bgColor: e.target.value }); }}
            />
          </div>
        </div>

        {/* 强调色 */}
        <div className="settings-field">
          <label className="settings-field-label">强调色</label>
          <div className="settings-color-row">
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={accentEnabled}
                onChange={(e) => { setAccentEnabled(e.target.checked); commit({ accentColor: e.target.checked ? accentColor : undefined }); }}
              />
              <span>自定义强调色</span>
            </label>
            <input
              type="color"
              className="settings-color"
              value={accentColor}
              disabled={!accentEnabled}
              onChange={(e) => { setAccentColor(e.target.value); commit({ accentColor: e.target.value }); }}
            />
          </div>
        </div>

        <div className="settings-row-end">
          <button className="settings-btn ghost" onClick={resetAppearance}>恢复默认外观</button>
        </div>
      </section>
    </div>
  );
};
