import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { modelKey } from '../utils/path-key';
import { modelDisplayNames } from '../utils/model-display';
import { fetchAvailableModels } from '../utils/available-models';
import { rpc } from '../rpc-client';
import type { ModelInfo } from '../../shared/rpc-types';

/**
 * ModelRestoreModal — 历史会话原模型不可恢复时的替代模型选择弹窗（omp 18.6.3+）。
 *
 * 背景：omp 18.6.3 起，`--resume`/`--continue` 在 rpc-ui 模式下若会话保存的模型已下线、
 * 被移除（如 19.1.0 移除 google-gemini-cli）或 provider 不可用，进程会直接以
 * `Could not restore model <provider/id>` 非 0 退出，不再静默回退默认模型。
 *
 * 本弹窗让用户手动选择一个替代模型，然后以 `--model <provider/id>` 重新 acquire 该会话。
 */
export const ModelRestoreModal: React.FC<{
  onRestored: (sessionPath: string) => void;
}> = ({ onRestored }) => {
  const prompt = useApp((s) => s.modelRestorePrompt);
  const enabledModels = useApp((s) => s.enabledModels);
  const lastModel = useApp((s) => s.lastModel);

  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!prompt) return;
    let cancelled = false;
    setLoading(true);
    // 优先借用任一在线会话实时拉取，否则走 cacheOnly（内存缓存 + 落盘缓存 + models.yml）
    const st = useApp.getState();
    const onlineEntry = Object.entries(st.procStateMap).find(
      ([sp, ps]) => sp !== prompt.sessionPath && ps.status === 'online',
    );
    const sp = onlineEntry?.[0] ?? '';
    void fetchAvailableModels(sp, { cacheOnly: !onlineEntry })
      .then((res) => {
        if (!cancelled) setAvailableModels(res.models);
      })
      .catch(() => {
        if (!cancelled) setAvailableModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prompt]);

  const candidates = useMemo(() => {
    const enabledSet = enabledModels && enabledModels.length > 0 ? new Set(enabledModels) : null;
    const base = !showAll && enabledSet
      ? availableModels.filter((m) => enabledSet.has(modelKey(m)))
      : availableModels;
    const list = base.length > 0 ? base : availableModels;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter((m) => `${m.provider}/${m.id} ${m.name ?? ''}`.toLowerCase().includes(q))
      : list;
    // 把上次使用的兜底模型置顶，便于一键确认
    if (!lastModel) return filtered;
    const lastKey = modelKey(lastModel);
    return [...filtered].sort((a, b) => {
      const aHit = modelKey(a) === lastKey ? 0 : 1;
      const bHit = modelKey(b) === lastKey ? 0 : 1;
      return aHit - bHit;
    });
  }, [availableModels, enabledModels, lastModel, query, showAll]);

  const displayNames = useMemo(() => modelDisplayNames(candidates), [candidates]);

  if (!prompt) return null;

  const close = () => {
    if (busy) return;
    setErr(null);
    setQuery('');
    useApp.getState().setModelRestorePrompt(null);
  };

  const pickModel = async (m: ModelInfo) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const selector = `${m.provider}/${m.id}`;
    try {
      await rpc.acquire(prompt.sessionPath, prompt.cwd, prompt.approvalMode, {
        model: selector,
        restore: prompt.restore,
      });
      const st = useApp.getState();
      st.setLastModelForSession(prompt.sessionPath, { provider: m.provider, id: m.id, name: m.name });
      st.setModelRestorePrompt(null);
      st.pushToast(`已使用替代模型 ${m.name ?? m.id} 恢复会话`, 'info');
      setQuery('');
      onRestored(prompt.sessionPath);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hasWhitelist = Boolean(enabledModels && enabledModels.length > 0);

  return (
    <div className="modal-overlay" onMouseDown={close}>
      <div
        className="modal modal-wide"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) close();
        }}
      >
        <div className="modal-title">原会话模型不可用，请选择替代模型</div>
        <div className="modal-message">
          该历史会话保存的模型 <code>{prompt.missingModel}</code> 当前无法恢复（可能已下线、被移除或凭证失效）。
          请选择一个可用模型继续恢复此会话：
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <input
            type="text"
            placeholder="搜索 provider 或模型名…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            disabled={busy}
            style={{ flex: 1 }}
          />
          {hasWhitelist && (
            <label style={{ fontSize: 12, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                disabled={busy}
              />
              显示全部
            </label>
          )}
        </div>

        {err && (
          <div className="modal-message" style={{ color: 'var(--accent-danger, #e5484d)', marginBottom: 8 }}>
            恢复失败：{err}
          </div>
        )}

        <div className="model-restore-list">
          {loading && candidates.length === 0 ? (
            <div className="modal-detail-empty">正在加载可用模型列表…</div>
          ) : candidates.length === 0 ? (
            <div className="modal-detail-empty">
              未找到匹配模型。请先在「设置 → 模型配置」中配置可用提供商，或勾选「显示全部」。
            </div>
          ) : (
            candidates.slice(0, 120).map((m) => {
              const k = modelKey(m);
              const isLast = lastModel ? modelKey(lastModel) === k : false;
              const label = displayNames.get(k) ?? m.name ?? m.id;
              return (
                <button
                  key={k}
                  type="button"
                  className={`model-restore-item${isLast ? ' recommended' : ''}`}
                  disabled={busy}
                  onClick={() => void pickModel(m)}
                >
                  <span className="model-restore-name">
                    {label}
                    {isLast && <span className="model-restore-badge">默认</span>}
                  </span>
                  <span className="model-restore-meta">
                    {m.provider} · {m.id}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={close} disabled={busy}>取消</button>
        </div>
      </div>
    </div>
  );
};
