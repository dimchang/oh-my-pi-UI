import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { rpc } from '../rpc-client';
import { modelKey } from '../utils/path-key';
import { fetchAvailableModels } from '../utils/available-models';
import type { ModelInfo } from '../../shared/rpc-types';

/** get_available_models 的客户端超时（ms）。FrameRouter 默认 5 分钟对 UI 下拉太长。 */
const MODELS_FETCH_TIMEOUT_MS = 10_000;

export const ModelPicker: React.FC = () => {
  const model = useApp((s) => s.model);
  const ready = useApp((s) => s.ready);
  const enabledModels = useApp((s) => s.enabledModels);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  /** 回退提示：get_available_models 因 omp 目录过大失败，已用缓存/本地配置回退 */
  const [fallback, setFallback] = useState<{ reason?: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // 组件卸载后置 true，避免 fetchModels 的延迟回调在卸载后 setState（issue 13）
  // 注意：React 18 StrictMode 开发模式会 mount→cleanup→remount，必须在 effect body 里重置为 false
  const cancelledRef = useRef(false);
  useEffect(() => { cancelledRef.current = false; return () => { cancelledRef.current = true; }; }, []);

  const fetchModels = React.useCallback((showLoading = false, cacheOnly = false) => {
    const sp = useApp.getState().currentSessionPath;
    if (!sp) {
      if (showLoading) setFetchError(true);
      return;
    }
    if (showLoading) setLoading(true);
    setFetchError(false);
    setFallback(null);

    const timer = setTimeout(() => {
      if (cancelledRef.current) return;
      setLoading(false);
      setFetchError(true);
    }, MODELS_FETCH_TIMEOUT_MS);

    // 会话可能只是浏览（未拉起进程）：先按需拉起再拉模型列表
    void useApp.getState().ensureOnline(sp).then((ok) => {
      if (!ok) {
        clearTimeout(timer);
        if (cancelledRef.current) return;
        setLoading(false);
        setFetchError(true);
        return;
      }
      void fetchAvailableModels(sp, { cacheOnly }).then((res) => {
        clearTimeout(timer);
        if (cancelledRef.current) return;
        setLoading(false);
        setModels(res.models);
        setFallback(res.fallback ? { reason: res.reason } : null);
        // 回退且没有任何模型可得时才算真正失败（避免整片空白）
        setFetchError(res.fallback && res.models.length === 0);
      }).catch(() => {
        clearTimeout(timer);
        if (cancelledRef.current) return;
        setLoading(false);
        setFetchError(true);
      });
    });
  }, []);

  // 首次 ready 预热一次（让首次打开下拉不白屏）。
  // 只走本地缓存 + models.yml（cacheOnly），不打 get_available_models RPC——
  // omp 目录过大时该调用必超 transport limit，启动时纯属浪费（还会触发主进程回退链）。
  // 实时列表在用户点开下拉时再刷新。
  useEffect(() => {
    if (ready) fetchModels(false, true);
  }, [ready, fetchModels]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // 打开时自动 focus 搜索框 + 重新拉取模型列表
  // （omp 端或 GUI 内新增模型后无需重启即可看到）
  useEffect(() => {
    if (open) {
      setQuery('');
      fetchModels(true);
      // 等下一帧再 focus，input 已经被挂载
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, fetchModels]);

  // 白名单转 Set，避免 includes O(n)（enabledModels 可能很长）
  const enabledSet = useMemo(() => new Set(enabledModels ?? []), [enabledModels]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const whitelistActive = enabledModels !== undefined;
    const acc: Record<string, ModelInfo[]> = {};
    for (const m of models) {
      // 白名单过滤：未勾选的模型不在切换列表里显示
      // （但当前正在使用的模型始终可见，避免"选中的被藏、切不回来"）
      if (whitelistActive) {
        const key = modelKey(m);
        const isCurrent = model?.provider === m.provider && model?.id === m.id;
        if (!enabledSet.has(key) && !isCurrent) continue;
      }
      if (q) {
        const hay = `${m.name ?? m.id} ${m.id} ${m.provider}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      (acc[m.provider] ??= []).push(m);
    }
    return acc;
  }, [models, query, enabledModels, enabledSet, model]);

  const pick = (m: ModelInfo) => {
    setOpen(false);
    const sp = useApp.getState().currentSessionPath;
    if (!sp) return;
    void rpc.setModel(sp, m.provider, m.id).then((r) => {
      if (r.success && r.data) {
        useApp.getState().setState({ model: r.data as ModelInfo });
        // 记录到 lastModel 并持久化，重启 UI 后能自动恢复
        const mm = r.data as ModelInfo;
        useApp.getState().setLastModel({ provider: mm.provider, id: mm.id, name: mm.name });
      }
    }).catch(() => undefined);
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (query) {
        e.stopPropagation();
        setQuery('');
      } else {
        setOpen(false);
      }
    } else if (e.key === 'Enter') {
      // 选中第一项可见模型
      const first = Object.values(groups).flat()[0];
      if (first) pick(first);
    }
  };

  const totalMatched = Object.values(groups).reduce((n, list) => n + list.length, 0);

  return (
    <div className="model-picker" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)}>
        {model?.name ?? model?.id ?? '选择模型'} ▾
      </button>
      {open && (
        <div className="model-menu">
          <div className="model-search">
            <input
              ref={searchRef}
              className="model-search-input"
              type="text"
              placeholder="搜索模型"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            />
          </div>
          <div className="model-list">
            {fallback && models.length > 0 && (
              <div className="model-fallback-note" title={fallback.reason}>
                模型列表为本地缓存/配置回退（omp 目录过大），可能不全
              </div>
            )}
            {loading ? (
              <div className="model-empty">加载模型列表中…</div>
            ) : fetchError ? (
              <div className="model-empty">
                模型加载失败
                <button
                  className="btn"
                  style={{ marginLeft: 8, fontSize: '0.85em' }}
                  onClick={() => fetchModels(true)}
                >
                  重试
                </button>
              </div>
            ) : totalMatched === 0 ? (
              <div className="model-empty">没有匹配的模型</div>
            ) : (
              Object.entries(groups).map(([provider, list]) => (
                <div key={provider}>
                  <div className="model-group">{provider}</div>
                  {list.map((m) => (
                    <div
                      key={`${m.provider}/${m.id}`}
                      className={`model-item ${model?.id === m.id && model?.provider === m.provider ? 'current' : ''}`}
                      onClick={() => pick(m)}
                      title={m.contextWindow ? `上下文 ${m.contextWindow} tokens` : ''}
                    >
                      <span>{m.name ?? m.id}</span>
                      {model?.id === m.id && model?.provider === m.provider && <span>✓</span>}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
