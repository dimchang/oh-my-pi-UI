import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../store';
import { rpc } from '../rpc-client';
import type { ThinkingLevel } from '../../shared/rpc-types';

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

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // 当前模型实际支持的 thinking 档位（实测 model.thinking.efforts）。
  // 无此信息时不过滤（显示全部），有则只显示支持的，避免切到不支持档位被 clamp。
  const supported = model?.thinking?.efforts;
  const isSupported = (v: ThinkingLevel) => !supported || supported.includes(v);

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

  const current = LEVELS.find((l) => l.value === level);

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
                title={ok ? l.desc : `当前模型不支持（仅支持：${(supported ?? []).join(' / ')}）`}
                style={ok ? undefined : { opacity: 0.35, cursor: 'not-allowed' }}
              >
                <span>{l.label}</span>
                <span className="thinking-desc">{ok ? l.desc : '不支持'}</span>
                {level === l.value && <span>✓</span>}
              </div>
            );
          })}
          <div className="thinking-menu-hint" onClick={cycle}>
            Ctrl+T 循环切换
          </div>
        </div>
      )}
    </div>
  );
};
