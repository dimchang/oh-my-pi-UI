import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../store';
import type { ApprovalMode } from '../../shared/ipc-channels';

/** 权限模式选项（对应 omp `--approval-mode` 三档）。
 *  - yolo：全自动，不弹窗（信任任务时用）。
 *  - write：默认，读/写自动，仅执行类（bash/浏览器/ssh/task）弹窗。
 *  - always-ask：每次工具调用都弹窗确认。 */
const MODES: { value: ApprovalMode; label: string; desc: string }[] = [
  { value: 'yolo', label: 'YOLO · 全自动', desc: '自动批准所有工具调用，不弹窗（仅信任的任务使用）' },
  { value: 'write', label: 'Write · 默认', desc: '读/写自动执行，仅执行类（bash/浏览器/ssh 等）弹窗' },
  { value: 'always-ask', label: 'Always Ask · 每次询问', desc: '每次工具调用都弹窗确认' },
];

export const PermissionPicker: React.FC<{ onChange: (mode: ApprovalMode) => void }> = ({ onChange }) => {
  const mode = useApp((s) => s.currentWorkspace()?.approvalMode ?? 'write');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const current = MODES.find((m) => m.value === mode) ?? MODES[1] ?? MODES[0]!;

  const pick = (m: ApprovalMode) => {
    setOpen(false);
    if (m === mode) return;
    onChange(m);
  };

  return (
    <div className="model-picker" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)} title="权限模式（按工作空间生效）">
        权限: {current.label.split(' · ')[0] ?? current.label} ▾
      </button>
      {open && (
        <div className="model-menu">
          {MODES.map((m) => (
            <div
              key={m.value}
              className={`model-item ${mode === m.value ? 'current' : ''}`}
              onClick={() => pick(m.value)}
              title={m.desc}
            >
              <div className="model-item-body">
                <span className="model-item-label">{m.label}</span>
                <span className="model-item-desc">{m.desc}</span>
              </div>
              {mode === m.value && <span>✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
