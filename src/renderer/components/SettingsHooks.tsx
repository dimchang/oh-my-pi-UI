/**
 * SettingsHooks — 智能体设置 · 钩子（Hooks）管理页。
 *
 * 从 .ts 文件导入 omp 钩子；一个文件可含多个钩子（具名导出），每个单元可独立启用/停用。
 * 启用集合在每次启动 omp 时通过 --hook=<path> 注入（主进程 resolveHookArgs 解析）。
 * 多单元文件会由主进程生成"只调用启用单元"的过滤包装文件再传给 --hook。
 */

import React, { useState } from 'react';
import { useApp } from '../store';
import { cwdKey } from '../utils/path-key';
import type { HookFileConfig, HookFileInfo, HookUnit } from '../../shared/ipc-channels';

function basename(p: string): string {
  const norm = p.replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1);
}

/** 把主进程解析结果转成 UI 单元列表。无默认导出且无具名导出 → 空数组（omp 无法加载，UI 提示）。 */
function buildUnits(info: HookFileInfo): HookUnit[] {
  if (info.hasDefault) {
    return [{ name: basename(info.path), fileLevel: true, events: info.events }];
  }
  if (info.namedHooks.length > 0) {
    return info.namedHooks.map((n) => ({ name: n, fileLevel: false }));
  }
  return [];
}

export const SettingsHooks: React.FC = () => {
  const hooks = useApp((s) => s.hooks) ?? [];
  const setHooks = useApp((s) => s.setHooks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onImport = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const paths = await window.omp.pickHookFiles();
      if (!paths || paths.length === 0) return;
      const infos = await window.omp.parseHookFiles(paths);
      // 路径去重前先归一化（小写 + 统一分隔符），避免 Windows 上 C:\a.ts / c:/a.ts / C:/a.ts 被当成不同文件
      const existing = new Set(hooks.map((h) => cwdKey(h.path)));
      const next: HookFileConfig[] = [...hooks];
      for (const info of infos) {
        if (info.error) {
          setError(`解析失败：${basename(info.path)} — ${info.error}`);
          continue;
        }
        if (existing.has(cwdKey(info.path))) continue; // 去重：已导入过（归一化比较）
        const units = buildUnits(info);
        next.push({
          path: info.path,
          enabled: true,
          units,
          enabledUnits: units.map((u) => u.name), // 默认全部启用
        });
      }
      setHooks(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleFile = (path: string, enabled: boolean): void => {
    setHooks(hooks.map((h) => (h.path === path ? { ...h, enabled } : h)));
  };

  const toggleUnit = (path: string, unitName: string, on: boolean): void => {
    setHooks(
      hooks.map((h) => {
        if (h.path !== path) return h;
        const cur = h.enabledUnits && h.enabledUnits.length ? h.enabledUnits : h.units.map((u) => u.name);
        const nextUnits = on ? [...new Set([...cur, unitName])] : cur.filter((n) => n !== unitName);
        return { ...h, enabledUnits: nextUnits };
      }),
    );
  };

  const removeFile = (path: string): void => {
    setHooks(hooks.filter((h) => h.path !== path));
  };

  const openFolder = (path: string): void => {
    void window.omp.showItemInFolder(path);
  };

  return (
    <div className="settings-scroll">
      <section className="settings-section">
        <h3 className="settings-section-title">钩子（Hooks）</h3>
        <p className="settings-section-desc">
          从 <code>.ts</code> 文件导入 omp 钩子。每个钩子文件是一个{' '}
          <code>export default function (pi: HookAPI)</code>，通过 <code>pi.on('event', ...)</code>{' '}
          订阅会话生命周期事件（如 <code>tool_call</code> / <code>tool_result</code>）。
          启用后会在每次启动 omp 时通过 <code>--hook</code> 注入。
          支持一个文件含多个钩子：勾选要启用的单元即可。
        </p>
        <div className="settings-row-end">
          <button className="settings-btn" onClick={() => void onImport()} disabled={busy}>
            {busy ? '解析中…' : '导入钩子文件'}
          </button>
          {hooks.length > 0 && <span className="settings-hint">{hooks.length} 个文件</span>}
        </div>
        {error && <div className="hook-error">⚠ {error}</div>}

        {hooks.length === 0 ? (
          <div className="hook-empty">
            还没有导入任何钩子文件。点击「导入钩子文件」选择 <code>.ts</code> 文件（可多选）。
            参考{' '}
            <a
              href="https://omp.sh/docs/hooks"
              onClick={(e) => {
                e.preventDefault();
                void window.omp.openExternal('https://omp.sh/docs/hooks');
              }}
            >
              omp 钩子文档
            </a>
            。
          </div>
        ) : (
          <div className="hook-list">
            {hooks.map((h) => {
              const multi = h.units.some((u) => !u.fileLevel);
              const enabledUnits =
                h.enabledUnits && h.enabledUnits.length ? h.enabledUnits : h.units.map((u) => u.name);
              const fileLevelUnit = h.units.find((u) => u.fileLevel);
              return (
                <div key={h.path} className={`hook-card ${h.enabled ? '' : 'disabled'}`}>
                  <div className="hook-card-head">
                    <label className="settings-checkbox hook-master">
                      <input
                        type="checkbox"
                        checked={h.enabled}
                        onChange={(e) => toggleFile(h.path, e.target.checked)}
                      />
                      <span className="hook-name">{basename(h.path)}</span>
                    </label>
                    <div className="hook-actions">
                      <button className="hook-link" title="在文件夹中显示" onClick={() => openFolder(h.path)}>
                        位置
                      </button>
                      <button className="hook-remove" title="移除" onClick={() => removeFile(h.path)}>
                        ✕
                      </button>
                    </div>
                  </div>
                  <div className="hook-path" title={h.path}>
                    {h.path}
                  </div>
                  {fileLevelUnit?.events && fileLevelUnit.events.length > 0 && (
                    <div className="hook-events">
                      {fileLevelUnit.events.map((ev) => (
                        <span key={ev} className="hook-event-chip">
                          {ev}
                        </span>
                      ))}
                    </div>
                  )}
                  {multi && h.enabled && (
                    <div className="hook-units">
                      {h.units.map((u) => (
                        <label key={u.name} className="settings-checkbox hook-unit">
                          <input
                            type="checkbox"
                            checked={enabledUnits.includes(u.name)}
                            onChange={(e) => toggleUnit(h.path, u.name, e.target.checked)}
                          />
                          <span>{u.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  {h.units.length === 0 && (
                    <div className="hook-warn">
                      ⚠ 该文件既无默认导出也无具名导出，omp 无法加载（请确认含 <code>export default</code> 或具名导出）。
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
