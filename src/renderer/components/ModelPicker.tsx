import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { rpc } from '../rpc-client';
import { modelKey } from '../utils/path-key';
import type { ModelInfo } from '../../shared/rpc-types';

export const ModelPicker: React.FC = () => {
  const model = useApp((s) => s.model);
  const ready = useApp((s) => s.ready);
  const enabledModels = useApp((s) => s.enabledModels);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // 组件卸载后置 true，避免 fetchModels 的延迟回调在卸载后 setState（issue 13）
  const cancelledRef = useRef(false);
  useEffect(() => () => { cancelledRef.current = true; }, []);

  const fetchModels = React.useCallback(() => {
    const sp = useApp.getState().currentSessionPath;
    if (!sp) return;
    void rpc.getAvailableModels(sp).then((r) => {
      if (cancelledRef.current) return;
      if (r.success && r.data) setModels(r.data.models ?? []);
    }).catch(() => undefined);
  }, []);

  // 首次 ready 预热一次（让首次打开下拉不白屏）
  useEffect(() => {
    if (ready) fetchModels();
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
      fetchModels();
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
            {totalMatched === 0 ? (
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
