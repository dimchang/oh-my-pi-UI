import React, { useMemo, useState } from 'react';
import type { UiRequest } from '../store';
import { useApp } from '../store';
import { rpc } from '../rpc-client';

/**
 * PermissionModal — 按 extension_ui_request.method 渲染 confirm/select/input/editor。
 * 单队列顺序展示（store.uiQueue[0]），cancel 帧由 App 负责关对应 modal。
 */
export const PermissionModal: React.FC<{ req: UiRequest }> = ({ req }) => {
  /** 把 omp 的 option 统一规整成 {value, label, description} 形态
   *  （omp 实际发的是 string[]，但 type schema 早期写成对象数组，兼容两种） */
  const normOptions = useMemo(
    () =>
      (req.options ?? []).map((o, i) => {
        if (typeof o === 'string') {
          return { value: o, label: o, description: undefined };
        }
        return { value: o.value, label: o.label ?? o.value, description: o.description };
      }),
    [req.options],
  );

  const [inputVal, setInputVal] = useState(req.defaultValue ?? '');
  const [selected, setSelected] = useState<string>(normOptions[0]?.value ?? '');
  const [always, setAlways] = useState(false);

  const respond = async (payload: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    // 多进程：UI 请求带 sessionPath，应答路由回该会话的进程
    try {
      await rpc.respondUIAndDequeue(req.sessionPath ?? '', { id: req.id, ...payload });
    } catch (e) {
      // 进程已离线（被 LRU 淘汰 / 崩溃 / temp→real 迁移没跟上）：
      // 不要静默关弹窗，提示用户重新进入该会话后再试。
      useApp.getState().pushToast(
        `操作未送达：${e instanceof Error ? e.message : String(e)}。请重新进入该会话后重试。`,
        'error',
      );
    }
  };

  const renderBody = () => {
    switch (req.method) {
      case 'confirm':
        return (
          <>
            <div className="modal-message">{req.message ?? req.prompt ?? '确认执行此操作？'}</div>
            <label className="modal-check">
              <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
              始终允许此工具（本会话）
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={() => respond({ confirmed: false })}>拒绝</button>
              <button className="btn btn-primary" onClick={() => respond({ confirmed: true })}>
                批准
              </button>
            </div>
          </>
        );
      case 'select':
        return (
          <>
            <div className="modal-message">{req.message ?? req.prompt ?? ''}</div>
            {normOptions.length === 0 ? (
              <div className="modal-message">（无可选项）</div>
            ) : (
              <div>
                {normOptions.map((opt) => (
                  <label key={opt.value} className="modal-radio">
                    <input
                      type="radio"
                      name={`sel-${req.id}`}
                      checked={selected === opt.value}
                      onChange={() => setSelected(opt.value)}
                    />
                    <span>{opt.label}</span>
                    {opt.description && (
                      <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{opt.description}</span>
                    )}
                  </label>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => respond({ cancelled: true })}>取消</button>
              <button className="btn btn-primary" onClick={() => respond({ value: selected })}>确定</button>
            </div>
          </>
        );
      case 'input':
      case 'editor':
        return (
          <>
            <div className="modal-message">{req.message ?? req.prompt ?? ''}</div>
            {req.method === 'editor' ? (
              <textarea
                rows={8}
                value={inputVal}
                placeholder={req.placeholder}
                onChange={(e) => setInputVal(e.target.value)}
              />
            ) : (
              <input
                type="text"
                value={inputVal}
                placeholder={req.placeholder}
                onChange={(e) => setInputVal(e.target.value)}
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && respond({ value: inputVal })}
              />
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => respond({ cancelled: true })}>取消</button>
              <button className="btn btn-primary" onClick={() => respond({ value: inputVal })}>确定</button>
            </div>
          </>
        );
      default:
        return (
          <>
            <div className="modal-message">{req.message ?? `未处理的请求类型：${req.method}`}</div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => respond({ confirmed: true })}>知道了</button>
            </div>
          </>
        );
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <ModalTitle req={req} />
        {renderBody()}
      </div>
    </div>
  );
};

/** omp 工具权限弹窗把工具名 + 命令都塞在 title 里（用 \n 分隔），
 *  拆出来让命令单独成行用 monospace 字体显示，更清晰。 */
const ModalTitle: React.FC<{ req: UiRequest }> = ({ req }) => {
  const raw = req.title ?? titleOf(req.method);
  const idx = raw.indexOf('\n');
  if (idx < 0) return <div className="modal-title">{raw}</div>;
  const head = raw.slice(0, idx);
  const rest = raw.slice(idx + 1);
  return (
    <>
      <div className="modal-title">{head}</div>
      <div className="modal-subtitle">{rest}</div>
    </>
  );
};

function titleOf(method: string): string {
  switch (method) {
    case 'confirm': return '需要批准';
    case 'select': return '请选择';
    case 'input': return '需要输入';
    case 'editor': return '编辑';
    default: return '请求';
  }
}
