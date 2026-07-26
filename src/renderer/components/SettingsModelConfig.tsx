/**
 * SettingsModelConfig — 配置页「模型配置」内容区。
 * - 展示 omp 当前所有可用模型（get_available_models 按 provider 分组）
 * - 每个模型 checkbox：勾选 = 进入 ModelPicker 白名单（enabledModels，存 workspaces.json）
 * - 自定义 provider（来自 ~/.omp/agent/models.yml）可删除；内置/OAuth provider 只读
 * - [+ 添加模型] 弹出 AddModelModal（写 models.yml + 重启 omp + 二步勾选模型）
 *
 * 白名单语义：
 *   enabledModels === undefined → 未配置白名单 → 显示全部模型
 *   enabledModels 为数组（含空数组 []）→ 白名单已激活 → 只显示数组内的模型
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { rpc } from '../rpc-client';
import { AddModelModal } from './AddModelModal';
import { modelKey } from '../utils/path-key';
import type { ModelInfo } from '../../shared/rpc-types';
import type { OmpModelsConfig } from '../../shared/ipc-channels';

export const SettingsModelConfig: React.FC = () => {
  const ready = useApp((s) => s.ready);
  const enabledModels = useApp((s) => s.enabledModels);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [ymlConfig, setYmlConfig] = useState<OmpModelsConfig>({ providers: {} });
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  // 递增请求序号：并发 refresh 时，只有最新一次请求能落下 loading=false / 数据，
  // 避免旧请求晚到时把新数据覆盖掉（并发 loading 错乱）。
  const refreshSeq = React.useRef(0);

  const refresh = useCallback(() => {
    const mySeq = ++refreshSeq.current;
    setLoading(true);
    setError('');
    const sp = useApp.getState().currentSessionPath ?? '';
    void Promise.allSettled([
      rpc.getAvailableModels(sp).then((r) => {
        if (r.success && r.data) return r.data.models ?? [];
        return [] as ModelInfo[];
      }),
      window.omp.readModelsConfig(),
    ]).then(([modelsRes, ymlRes]) => {
      // 不是最新请求：丢弃结果，避免覆盖新数据
      if (mySeq !== refreshSeq.current) return;
      const modelsList = modelsRes.status === 'fulfilled' ? (modelsRes.value as ModelInfo[]) : [];
      const yml = ymlRes.status === 'fulfilled' ? (ymlRes.value as OmpModelsConfig) : { providers: {} };
      setModels(modelsList);
      setYmlConfig(yml);
      setLoading(false);
    }).catch(() => {
      if (mySeq === refreshSeq.current) setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (ready) refresh();
  }, [ready, refresh]);

  // provider 分组；models.yml 里定义了但（还）没有模型的 provider 也要显示出来
  const groups = useMemo(() => {
    const acc: Record<string, ModelInfo[]> = {};
    for (const m of models) (acc[m.provider] ??= []).push(m);
    for (const pid of Object.keys(ymlConfig.providers ?? {})) {
      acc[pid] ??= [];
    }
    return acc;
  }, [models, ymlConfig]);

  const customProviders = useMemo(
    () => new Set(Object.keys(ymlConfig.providers ?? {})),
    [ymlConfig],
  );

  // 新语义：undefined = 未配置白名单（显示全部）；任何数组（含空数组 []）= 白名单已激活
  const whitelistActive = enabledModels !== undefined;
  const isEnabled = useCallback(
    (key: string) => !whitelistActive || (enabledModels?.includes(key) ?? false),
    [whitelistActive, enabledModels],
  );

  /** provider 级全选/全不选 */
  const toggleProvider = useCallback((_pid: string, list: ModelInfo[]) => {
    const keys = list.map(modelKey);
    const cur = useApp.getState().enabledModels;

    // 判断该 provider 下是否全部已勾选（undefined = 全部视为已勾选）
    const allOn = cur === undefined || keys.every((k) => cur.includes(k));

    let next: string[] | undefined;
    if (allOn) {
      // 全部已勾选 → 全不选
      if (cur === undefined) {
        // 首次操作：初始化为空数组（= 白名单激活但全部不选）
        next = [];
      } else {
        next = cur.filter((k) => !keys.includes(k));
      }
    } else {
      // 未全选 → 全选：合并入白名单
      next = Array.from(new Set([...cur, ...keys]));
    }

    useApp.getState().setEnabledModels(next);
  }, []);

  /** 删除自定义 provider：删 models.yml 条目 → 重启 omp → 刷新；白名单里该 provider 的 key 一并清理 */
  const doDeleteProvider = useCallback(async (pid: string) => {
    setConfirmDelete(null);
    setBusy(`正在删除 ${pid} 并重启 omp…`);
    setError('');
    try {
      await window.omp.deleteOmpProvider(pid);
      const st = useApp.getState();
      if (st.enabledModels?.some((k) => k.startsWith(`${pid}\u0000`))) {
        st.setEnabledModels(st.enabledModels.filter((k) => !k.startsWith(`${pid}\u0000`)));
      }
      // 多进程：models.yml 已保存，新 acquire 的进程会读新配置。
      // 已在线的进程不重读（omp 启动时读 models.yml）；如需立即生效切回该会话触发重新 acquire。
      refresh();
    } catch (e) {
      setError(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  }, [refresh]);

  return (
    <div className="model-config">
      <div className="model-config-head">
        <div>
          <div className="model-config-title">已配置的提供商与模型</div>
          <div className="model-config-hint">
            勾选的模型才会出现在工作窗口的模型切换列表中
            {!whitelistActive && '（当前未配置白名单，全部显示）'}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setAddOpen(true)}>+ 添加模型</button>
      </div>

      {error && <div className="model-config-error">{error}</div>}
      {busy && <div className="model-config-busy">{busy}</div>}
      {loading && <div className="settings-placeholder">加载中…</div>}

      {!loading && Object.keys(groups).length === 0 && (
        <div className="settings-placeholder">暂无可用模型（omp 未就绪或没有已配置的提供商）</div>
      )}

      <div className="provider-list">
        {Object.entries(groups).map(([pid, list]) => {
          const isCustom = customProviders.has(pid);
          const cfg = ymlConfig.providers?.[pid];
          const enabledCount = list.filter((m) => isEnabled(modelKey(m))).length;
          return (
            <div key={pid} className="provider-card">
              <div className="provider-card-head">
                <div className="provider-card-info">
                  <span className="provider-card-name">{cfg?.name ?? pid}</span>
                  {isCustom && <span className="provider-badge custom">自定义</span>}
                  {!isCustom && <span className="provider-badge">内置</span>}
                  <span className="provider-count">{enabledCount}/{list.length} 启用</span>
                </div>
                <div className="provider-card-actions">
                  {list.length > 0 && (
                    <button className="btn btn-sm" onClick={() => toggleProvider(pid, list)}>
                      {list.every((m) => isEnabled(modelKey(m))) ? '全不选' : '全选'}
                    </button>
                  )}
                  {isCustom && (
                    <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(pid)}>
                      删除
                    </button>
                  )}
                </div>
              </div>
              {cfg?.baseUrl && <div className="provider-card-url">{cfg.baseUrl}</div>}
              {list.length === 0 ? (
                <div className="provider-empty">
                  该提供商暂无已发现的模型（可能需要重启 omp 或检查 API Key / baseUrl）
                </div>
              ) : (
                <div className="provider-models">
                  {list.map((m) => {
                    const key = modelKey(m);
                    return (
                      <label key={key} className="provider-model-row" title={key}>
                        <input
                          type="checkbox"
                          checked={isEnabled(key)}
                          onChange={() => useApp.getState().toggleEnabledModel(key, [])}
                        />
                        <span className="provider-model-name">{m.name ?? m.id}</span>
                        {m.contextWindow ? (
                          <span className="provider-model-meta">{formatCtx(m.contextWindow)}</span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {confirmDelete && (
        <div className="modal-overlay inner">
          <div className="modal">
            <div className="modal-title">删除提供商「{confirmDelete}」？</div>
            <div className="modal-message">
              将从 ~/.omp/agent/models.yml 中移除该提供商（含其 API Key 配置），并重启 omp 生效。此操作不可恢复。
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="btn btn-danger" onClick={() => void doDeleteProvider(confirmDelete)}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {addOpen && (
        <AddModelModal
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
};

function formatCtx(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}K ctx`;
  return `${n} ctx`;
}
