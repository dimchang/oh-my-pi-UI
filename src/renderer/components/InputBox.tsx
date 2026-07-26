import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';

export const InputBox: React.FC<{ onSend: (text: string) => void; onAbort: () => void }> = ({
  onSend,
  onAbort,
}) => {
  const [draft, setDraft] = useState('');
  const [selIdx, setSelIdx] = useState(0);
  const isStreaming = useApp((s) => s.isStreaming);
  const isAborting = useApp((s) => s.isAborting);
  const ready = useApp((s) => s.ready);
  const slashCommands = useApp((s) => s.slashCommands);
  const draftInput = useApp((s) => s.draftInput);
  const setDraftInput = useApp((s) => s.setDraftInput);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 提交防重复：onSend 把状态切到 streaming 有一帧延迟，期间按两次 Enter 会重复发送
  const submittingRef = useRef(false);

  // 一次性输入回填（分叉等场景）：draftInput 非空时填入 textarea 并立即消费
  useEffect(() => {
    if (draftInput !== undefined && draftInput !== '') {
      setDraft(draftInput);
      setDraftInput(''); // consume — 置空避免重复填入
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.style.height = 'auto';
          ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
          ta.focus();
        }
      });
    }
  }, [draftInput, setDraftInput]);

  const slashMatch = useMemo(() => {
    if (!draft.startsWith('/')) return null;
    const q = (draft.slice(1).split(/\s/)[0] ?? '').toLowerCase();
    const list = slashCommands.filter(
      (c) => c.name.toLowerCase().startsWith(q) || c.aliases?.some((a) => a.toLowerCase().startsWith(q)),
    );
    return { q, list: list.slice(0, 12) };
  }, [draft, slashCommands]);

  const autoGrow = () => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    }
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || !ready || isStreaming || isAborting || submittingRef.current) return;
    submittingRef.current = true;
    setDraft('');
    requestAnimationFrame(autoGrow);
    onSend(text);
    // 释放：等状态切到 streaming 或超时后允许再次发送（避免异常时永久锁死）
    setTimeout(() => { submittingRef.current = false; }, 500);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatch && slashMatch.list.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelIdx((i) => (i + 1) % slashMatch.list.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelIdx((i) => (i - 1 + slashMatch.list.length) % slashMatch.list.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const c = slashMatch.list[selIdx];
        if (c) setDraft('/' + c.name + ' ');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && isStreaming) {
      onAbort();
    }
  };

  return (
    <div className="input-area">
      <div className="input-inner">
        {slashMatch && slashMatch.list.length > 0 && (
          <div className="slash-popup">
            {slashMatch.list.map((c, i) => (
              <div
                key={c.name}
                className={`slash-item ${i === selIdx ? 'sel' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); setDraft('/' + c.name + ' '); taRef.current?.focus(); }}
              >
                <span className="slash-name">/{c.name}</span>
                <span className="slash-desc">{c.description ?? ''}</span>
              </div>
            ))}
          </div>
        )}
        <div className="input-box">
          <textarea
            ref={taRef}
            rows={1}
            value={draft}
            placeholder={ready ? '给 Codex 派个任务…（/ 打开命令，Esc 中止）' : '正在连接 omp…'}
            onChange={(e) => { setDraft(e.target.value); setSelIdx(0); autoGrow(); }}
            onKeyDown={onKeyDown}
          />
          {isStreaming ? (
            <button className="btn" onClick={onAbort} disabled={isAborting}>
              {isAborting ? '停止中…' : '停止'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={submit} disabled={!ready || !draft.trim()}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
