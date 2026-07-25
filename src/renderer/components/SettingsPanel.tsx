/**
 * SettingsPanel — 配置页主框架（全屏 overlay：左侧导航 + 右侧内容区）。
 * 入口：TitleBar 的 Window 菜单 →「设置」。Esc / 遮罩点击 / ✕ 关闭。
 */

import React, { useEffect, useState } from 'react';
import { useApp } from '../store';
import { SettingsModelConfig } from './SettingsModelConfig';
import { SettingsHooks } from './SettingsHooks';
import type { AppearanceConfig, CustomCssConfig } from '../../shared/ipc-channels';

const TABS: Array<{ key: 'system' | 'agent' | 'model'; icon: string; label: string }> = [
  { key: 'system', icon: '⚙️', label: '系统配置' },
  { key: 'agent', icon: '🤖', label: '智能体设置' },
  { key: 'model', icon: '📦', label: '模型配置' },
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
                <span className="settings-nav-icon">{t.icon}</span>
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

/** 系统配置：系统提示词 + 系统风格（外观） */
const SystemConfigTab: React.FC = () => {
  const systemPrompt = useApp((s) => s.systemPrompt);
  const appearance = useApp((s) => s.appearance);

  const [promptDraft, setPromptDraft] = useState(systemPrompt ?? '');
  // appearance 用本地草稿，避免每次拖动滑块都触发 persist（失焦/松手时提交）
  const [mode, setMode] = useState<AppearanceConfig['mode']>(appearance?.mode ?? 'system');
  const [fontFamily, setFontFamily] = useState(appearance?.fontFamily ?? '');
  const [fontSize, setFontSize] = useState(appearance?.fontSize ?? 14);
  const [bgEnabled, setBgEnabled] = useState(Boolean(appearance?.bgColor));
  const [bgColor, setBgColor] = useState(appearance?.bgColor ?? '#0d1117');
  const [accentEnabled, setAccentEnabled] = useState(Boolean(appearance?.accentColor));
  const [accentColor, setAccentColor] = useState(appearance?.accentColor ?? '#0a84ff');
  const [customCss, setCustomCss] = useState<CustomCssConfig[]>(appearance?.customCss ?? []);
  const [cssError, setCssError] = useState('');

  // 外部（如恢复默认）同步时刷新本地草稿
  useEffect(() => { setPromptDraft(systemPrompt ?? ''); }, [systemPrompt]);
  useEffect(() => {
    setMode(appearance?.mode ?? 'system');
    setFontFamily(appearance?.fontFamily ?? '');
    setFontSize(appearance?.fontSize ?? 14);
    setBgEnabled(Boolean(appearance?.bgColor));
    setBgColor(appearance?.bgColor ?? '#0d1117');
    setAccentEnabled(Boolean(appearance?.accentColor));
    setAccentColor(appearance?.accentColor ?? '#0a84ff');
    setCustomCss(appearance?.customCss ?? []);
  }, [appearance]);

  const commit = (patch: Partial<AppearanceConfig>) => {
    const next: AppearanceConfig = {
      mode,
      fontFamily: fontFamily || undefined,
      fontSize: fontSize > 0 ? fontSize : undefined,
      bgColor: bgEnabled ? bgColor : undefined,
      accentColor: accentEnabled ? accentColor : undefined,
      customCss: customCss.length ? customCss : undefined,
      ...patch,
    };
    useApp.getState().setAppearance(next);
  };

  const resetAppearance = () => {
    setMode('system'); setFontFamily(''); setFontSize(14);
    setBgEnabled(false); setBgColor('#0d1117');
    setAccentEnabled(false); setAccentColor('#0a84ff');
    // 恢复默认外观时保留已导入的自定义 CSS（它是独立于配色的资源）
    useApp.getState().setAppearance(customCss.length ? { customCss } : {});
  };

  // ---- 自定义 CSS 导入 ----
  const commitCss = (next: CustomCssConfig[]) => {
    setCustomCss(next);
    commit({ customCss: next.length ? next : undefined });
  };
  const basename = (p: string) => p.split(/[\\/]/).pop() || p;

  const importCss = async (importMode: 'embed' | 'link') => {
    setCssError('');
    const path = await window.omp.pickCssFile();
    if (!path) return;
    if (customCss.some((c) => c.path === path && c.mode === importMode)) {
      setCssError(`已导入过该文件（${importMode === 'embed' ? '嵌入' : '链接'}模式）：${basename(path)}`);
      return;
    }
    const id = `css-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next: CustomCssConfig[] = [...customCss, { id, path, mode: importMode, enabled: true, name: basename(path) }];
    commitCss(next);
  };

  const toggleCss = (idx: number) =>
    commitCss(customCss.map((c, i) => (i === idx ? { ...c, enabled: !c.enabled } : c)));
  const removeCss = (idx: number) => commitCss(customCss.filter((_, i) => i !== idx));
  const reloadCss = async (idx: number) => {
    setCssError('');
    const c = customCss[idx];
    if (c.mode === 'embed') {
      const r = await window.omp.readCssFile(c.path);
      if (r.error) { setCssError(`重新读取失败：${r.error}`); return; }
    }
    // 触发 syncCustomCss 重新写入 styles.css（embed 重新读源文件，link 重新生成 @import）
    commitCss(customCss);
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

      {/* ===== 系统风格 ===== */}
      <section className="settings-section">
        <h3 className="settings-section-title">系统风格</h3>
        <p className="settings-section-desc">调整配色模式、字体、字号、背景色与强调色。修改即时生效，并自动保存。</p>

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

        {/* 自定义 CSS 导入 */}
        <div className="settings-field">
          <label className="settings-field-label">自定义 CSS</label>
          <div className="css-import-header">
            <p className="settings-section-desc" style={{ margin: 0 }}>
              从 <code>.css</code> 文件导入样式。
              <strong>嵌入</strong>：内容写入 styles.css；
              <strong>链接</strong>：styles.css 顶部 <code>@import</code> 该文件。
            </p>
            <div className="css-import-actions">
              <button className="settings-btn ghost" onClick={() => void importCss('embed')}>嵌入导入…</button>
              <button className="settings-btn ghost" onClick={() => void importCss('link')}>链接导入…</button>
            </div>
          </div>
          {cssError && <div className="hook-error">{cssError}</div>}
          {customCss.length === 0 ? (
            <div className="css-empty">尚未导入 CSS 文件。</div>
          ) : (
            <div className="css-list">
              {customCss.map((c, idx) => (
                <div key={c.id ?? `${c.mode}:${c.path}`} className={`css-item ${c.enabled ? '' : 'disabled'}`}>
                  <label className="settings-checkbox css-item-toggle">
                    <input type="checkbox" checked={c.enabled} onChange={() => toggleCss(idx)} />
                  </label>
                  <div className="css-item-main">
                    <span className="css-item-name" title={c.name || basename(c.path)}>{c.name || basename(c.path)}</span>
                    <span className="css-item-path" title={c.path}>{c.path}</span>
                  </div>
                  <div className="css-item-badges">
                    <span className={`css-item-mode ${c.mode}`}>{c.mode === 'embed' ? '嵌入' : '链接'}</span>
                    <div className="css-item-actions">
                      <button title="重新读取并写入 styles.css" onClick={() => void reloadCss(idx)}>↻</button>
                      <button title="在文件管理器中定位" onClick={() => void window.omp.showItemInFolder(c.path)}>📂</button>
                      <button title="移除" onClick={() => removeCss(idx)}>✕</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="settings-row-end">
          <button className="settings-btn ghost" onClick={resetAppearance}>恢复默认外观</button>
        </div>
      </section>
    </div>
  );
};
