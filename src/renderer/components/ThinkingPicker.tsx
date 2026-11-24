import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../store';
import { rpc } from '../rpc-client';
import { hasRuntimeThinking, planThinkingRepair, repairModelThinking } from '../utils/model-thinking';
import type { ModelInfo, ThinkingLevel } from '../../shared/rpc-types';

const LEVELS: { value: ThinkingLevel; label: string; desc: string }[] = [
  { value: 'off', label: '关闭', desc: '不思考' },
  { value: 'minimal', label: '极简', desc: '仅在必要时思考' },
  { value: 'low', label: '低', desc: '轻度思考' },
  { value: 'medium', label: '中', desc: '平衡' },
  { value: 'high', label: '高', desc: '深入思考' },
  { value: 'xhigh', label: '极高', desc: '非常深入' },
  { value: 'max', label: '最大', desc: '最大思考深度' },
];

export const ThinkingPicker: React.FC = () => {
  const level = useApp((s) => s.thinkingLevel);
  const model = useApp((s) => s.model);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  /** omp 侧不认识该模型的思考能力时，向上游确认它到底支不支持（打开菜单时现拉） */
  const [probe, setProbe] = useState<{ supported: boolean; efforts?: ThinkingLevel[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // omp 认不认这个模型的思考能力（`Mu()` 空 → set_thinking_level 一律被 clamp 回 off）
  const runtimeOk = hasRuntimeThinking(model);

  // 只有「omp 不支持」时才需要问上游，避免每次打开菜单都发 HTTP
  useEffect(() => {
    if (!open || runtimeOk || !model) return;
    let cancelled = false;
    setBusy(true);
    setProbe(null);
    void window.omp
      .fetchProviderModels(model.provider)
      .then((list) => {
        if (cancelled) return;
        const meta = (list as ModelInfo[]).find((m) => m.id === model.id);
        setProbe({
          supported: meta?.upstreamReasoning === true,
          efforts: meta?.upstreamEfforts,
        });
      })
      .catch(() => {
        if (!cancelled) setProbe({ supported: false });
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, runtimeOk, model?.provider, model?.id]);

  // 模型对象还没拿到（切会话瞬间 / get_state 未返回）：整个隐藏，避免闪出"思考"占位按钮。
  if (!model) return null;
  const supported = model.thinking?.efforts;
  // omp 侧不支持思考时，除「关闭」外的档位一律不可选 —— 选也只会被 clamp 回 off（历史误导点）
  const isSupported = (v: ThinkingLevel) =>
    v === 'off' || (runtimeOk && (!supported || supported.includes(v)));

  const pick = (l: ThinkingLevel) => {
    if (!isSupported(l)) return;
    setOpen(false);
    const sp = useApp.getState().currentSessionPath;
    if (!sp) return;
    // 会话可能只是浏览（未拉起进程）：先按需拉起再设置
    void useApp.getState().ensureOnline(sp).then((ok) => {
      if (!ok) return;
      void rpc.setThinkingLevel(sp, l).catch((e) => {
        useApp.getState().pushToast(`切换思考等级失败：${e instanceof Error ? e.message : String(e)}`, 'error');
      });
    });
  };

  const cycle = () => {
    const sp = useApp.getState().currentSessionPath;
    if (!sp) return;
    void useApp.getState().ensureOnline(sp).then((ok) => {
      if (!ok) return;
      void rpc.cycleThinkingLevel(sp).catch((e) => {
        useApp.getState().pushToast(`循环切换思考等级失败：${e instanceof Error ? e.message : String(e)}`, 'error');
      });
    });
  };

  /**
   * 一键修复：写 models.yml + 重启进程。
   * @param forceEfforts 上游沉默但用户确信支持思考时，手动指定档位强制开启
   */
  const repair = (forceEfforts?: ThinkingLevel[]) => {
    if (!model || busy) return;
    setBusy(true);
    void repairModelThinking(model.provider, model.id, forceEfforts ? { forceEfforts } : undefined)
      .then(({ efforts, written, reloaded }) => {
        const levels = efforts.join(' / ');
        const tail = reloaded ? '，进程已重载——重新选一次档位即可' : '；当前会话无法自动重载，切换会话或重启应用后生效';
        useApp.getState().pushToast(
          written
            ? `已为 ${model.id} 写入思考档位 ${levels}${tail}`
            : `配置早已就绪（档位 ${levels}），已重启进程让它生效${tail}`,
          reloaded ? 'success' : 'warn',
        );
        setOpen(false);
      })
      .catch((e) => {
        useApp.getState().pushToast(`修复思考能力失败：${e instanceof Error ? e.message : String(e)}`, 'error');
      })
      .finally(() => setBusy(false));
  };

  const current = LEVELS.find((l) => l.value === level);
  const repairable = !runtimeOk && probe?.supported === true;
  const repairPlan = planThinkingRepair(
    probe ? { upstreamReasoning: probe.supported, upstreamEfforts: probe.efforts } : null,
  );

  return (
    <div className="thinking-picker" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)} title="思考等级（Ctrl+T 循环切换）">
        {current?.label ?? level ?? '中'} ▾
      </button>
      {open && (
        <div className="thinking-menu">
          {LEVELS.map((l) => {
            const ok = isSupported(l.value);
            return (
              <div
                key={l.value}
                className={`thinking-item ${level === l.value ? 'current' : ''} ${ok ? '' : 'disabled'}`}
                onClick={() => pick(l.value)}
                title={
                  ok
                    ? l.desc
                    : runtimeOk
                      ? `当前模型不支持（仅支持：${(supported ?? []).join(' / ')}）`
                      : 'omp 未把该模型标记为支持思考（models.yml 缺 reasoning/thinking）'
                }
                style={ok ? undefined : { opacity: 0.35, cursor: 'not-allowed' }}
              >
                <span>{l.label}</span>
                <span className="thinking-desc">{ok ? l.desc : '不支持'}</span>
                {level === l.value && <span>✓</span>}
              </div>
            );
          })}
          {runtimeOk ? (
            <div className="thinking-menu-hint" onClick={cycle}>
              Ctrl+T 循环切换
            </div>
          ) : probe === null ? (
            <div className="thinking-menu-hint thinking-repair disabled">正在检测上游的能力声明…</div>
          ) : repairable ? (
            <div
              className="thinking-menu-hint thinking-repair"
              onClick={busy ? undefined : () => repair()}
              title="把上游声明的思考能力写进 models.yml 并重启 omp；若配置已就绪则只重启进程让它生效"
            >
              {busy ? '正在检测/修复…' : `修复思考能力（写入 ${(repairPlan?.efforts ?? []).join(' / ')}）`}
            </div>
          ) : (
            // 上游 /v1/models 没声明思考，但你知道模型能思考 → 手动指定档位强制开启
            <div
              className="thinking-menu-hint thinking-repair"
              onClick={busy ? undefined : () => repair(['low', 'high'])}
              title="上游没有声明 reasoning 能力；点击按 低 / 高 两档强制写入 models.yml（若该模型确实支持思考）"
            >
              {busy ? '正在检测/修复…' : '强制开启思考（低 / 高）'}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
