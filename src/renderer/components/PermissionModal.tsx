import React, { useEffect, useMemo, useState } from 'react';
import type { UiRequest } from '../store';
import { useApp, toolNameOf } from '../store';
import { pathsEqual } from '../utils/path-key';
import { rpc } from '../rpc-client';
import {
  parseHtmlForm,
  serializeFormData,
  type FormDataRecord,
  type FormNode,
} from '../../shared/html-form-parser';

/**
 * PermissionModal — 按 extension_ui_request.method 渲染 confirm/select/input/editor/form。
 * 单队列顺序展示（store.uiQueue[0]），cancel 帧由 App 负责关对应 modal。
 *
 * 信息架构（2026-09-22 / omp 19.1.1 适配）：
 *  - 顶部「任务 · xxx」：显示触发请求的会话名（sessionNames 覆盖名 → 侧栏标题兜底）；
 *  - 标题 = omp title 首行（omp 把工具名/命令等详情用 \n 塞在 title 后续行）；
 *  - 「详细 ▾」折叠区：title 剩余行（命令等）+ prompt + meta（工具/类型/会话/请求 ID）；
 *    对于 method === 'input'（如 omp 18.22.2 高风险 OAuth 登录要求输入 "yes"），自动展示 title 剩余行避免用户漏看警告；
 *  - method === 'form'（omp 19.1.0+ ask 工具整页 HTML 表单）：安全纯解析后用原生 React 控件渲染，绝不执行脚本。
 *
 * "始终允许"链路：confirm 勾选后，应答成功即把 工具名 写入 per-session 缓存（store.permAllow）；
 * 下次同一会话同一工具的 confirm 在 handleUiRequest 里命中缓存、自动放行、不弹窗。
 * 失败时不丢队列（保持弹窗），改为内联错误 + "重试/关闭"，避免单模态死锁卡住后续 UI 请求。
 */
export const PermissionModal: React.FC<{ req: UiRequest }> = ({ req }) => {
  /** 把 omp 的 option 统一规整成 {value, label, description} 形态
   *  （omp 实际发的是 string[]，但 type schema 早期写成对象数组，兼容两种） */
  const normOptions = useMemo(
    () =>
      (req.options ?? []).map((o) => {
        if (typeof o === 'string') {
          return { value: o, label: o, description: undefined };
        }
        return { value: o.value, label: o.label ?? o.value, description: o.description };
      }),
    [req.options],
  );

  // omp 18.20.0+：select 携带 initialIndex，优先按其初始化选中项
  const initialSelected = useMemo(() => {
    const idx = req.initialIndex;
    if (typeof idx === 'number' && idx >= 0 && idx < normOptions.length) {
      return normOptions[idx]!.value;
    }
    return normOptions[0]?.value ?? '';
  }, [normOptions, req.initialIndex]);

  // omp 19.1.0+：method === 'form' 的安全 HTML 解析
  const parsedForm = useMemo(
    () => (req.method === 'form' ? parseHtmlForm(req.html ?? '') : null),
    [req.method, req.html],
  );

  const [inputVal, setInputVal] = useState(req.defaultValue ?? '');
  const [showSecret, setShowSecret] = useState(false);
  const [selected, setSelected] = useState<string>(initialSelected);
  const [formValues, setFormValues] = useState<FormDataRecord>(() => parsedForm?.initialValues ?? {});
  const [always, setAlways] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [remainingSec, setRemainingSec] = useState<number | null>(() =>
    typeof req.timeout === 'number' && req.timeout > 0 ? Math.ceil(req.timeout / 1000) : null,
  );
  const busyRef = React.useRef(false);
  const lastPayload = React.useRef<{ value?: string; confirmed?: boolean; cancelled?: boolean; data?: FormDataRecord }>({});

  useEffect(() => {
    if (remainingSec === null) return;
    if (remainingSec <= 0) return;
    const t = window.setInterval(() => {
      setRemainingSec((s) => (s !== null && s > 0 ? s - 1 : s));
    }, 1000);
    return () => window.clearInterval(t);
  }, [remainingSec !== null]);

  // 任务名称：让用户知道是哪个会话/任务触发了本次权限请求。
  // 优先用户自定义覆盖名（sessionNames），兜底侧栏会话标题；都拿不到则不显示该行。
  const sessionNames = useApp((s) => s.sessionNames);
  const sessions = useApp((s) => s.sessions);
  const taskName = useMemo(() => {
    const sp = req.sessionPath;
    if (!sp) return null;
    const override = sessionNames[sp];
    if (override) return override;
    const hit = sessions.find((x) => pathsEqual(x.path, sp));
    return hit?.title ?? null;
  }, [req.sessionPath, sessionNames, sessions]);

  // omp 把工具名 + 命令等详情塞在 title 里（\n 分隔）：首行做标题，剩余行收进「详细」折叠区。
  const rawTitle = req.title ?? titleOf(req.method);
  const nlIdx = rawTitle.indexOf('\n');
  const titleHead = nlIdx >= 0 ? rawTitle.slice(0, nlIdx) : rawTitle;
  const titleRest = nlIdx >= 0 ? rawTitle.slice(nlIdx + 1).trim() : '';
  // 详细区的 meta 行：工具名 / 请求类型 / 来源会话 / 请求 ID
  const detailTool = toolNameOf(req);
  const sessionBasename = req.sessionPath ? (req.sessionPath.split(/[\\/]/).pop() ?? req.sessionPath) : null;
  const checkedSet = useMemo(() => new Set(req.checkedIndices ?? []), [req.checkedIndices]);

  // open_url 请求：批准后才真正打开链接（issue #5）。req.raw.method 在 App 中保留为 'open_url'。
  const openUrl = (req.raw as unknown as { __openUrl?: string; method?: string } | undefined)?.['__openUrl']
    ?? ((req.raw as unknown as { __openUrl?: string; method?: string } | undefined)?.method === 'open_url'
      ? (req.launchUrl ?? req.url)
      : undefined);

  const respond = async (payload: { value?: string; confirmed?: boolean; cancelled?: boolean; data?: FormDataRecord }) => {
    // 防重复点击：RPC 进行中直接丢弃后续调用
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    lastPayload.current = payload;
    setErr(null);
    try {
      await rpc.respondUIAndDequeue(req.sessionPath ?? '', { id: req.id, ...payload });
      // 成功：respondUIAndDequeue 已自动 dequeue。若勾选"始终允许"则写入缓存。
      if (payload.confirmed && always) {
        const tool = toolNameOf(req);
        if (tool) useApp.getState().setPermAllow(req.sessionPath ?? '', tool);
      }
      // open_url：用户批准后才打开外部链接（scheme 由主进程 OpenExternal 再次校验为 http/https）。
      if (payload.confirmed && openUrl) {
        void window.omp.openExternal(openUrl).catch(() => undefined);
      }
    } catch (e) {
      // 进程已离线（被 LRU 淘汰 / 崩溃 / temp→real 迁移没跟上）：保持弹窗，给重试/关闭。
      setErr(
        `操作未送达：${e instanceof Error ? e.message : String(e)}。可点"重试"再试，或点"关闭"关闭此弹窗（关闭后需重新进入该会话才能再次操作）。`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const onClose = () => useApp.getState().dequeueUi(req.id);
  const onRetry = () => void respond(lastPayload.current);

  const renderFormNode = (node: FormNode, key: string): React.ReactNode => {
    switch (node.kind) {
      case 'heading': {
        const cls = `ask-form-h ask-form-h${Math.min(Math.max(node.level, 1), 6)}`;
        return <div key={key} className={cls}>{node.text}</div>;
      }
      case 'paragraph':
        return <p key={key} className="ask-form-p">{node.text}</p>;
      case 'list':
        return node.ordered ? (
          <ol key={key} className="ask-form-list">
            {node.items.map((it, i) => <li key={i}>{it}</li>)}
          </ol>
        ) : (
          <ul key={key} className="ask-form-list">
            {node.items.map((it, i) => <li key={i}>{it}</li>)}
          </ul>
        );
      case 'pre':
        return <pre key={key} className="ask-form-pre">{node.text}</pre>;
      case 'table':
        return (
          <div key={key} className="ask-form-table-wrap">
            <table className="ask-form-table">
              {node.headers.length > 0 && (
                <thead>
                  <tr>{node.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
                </thead>
              )}
              <tbody>
                {node.rows.map((r, ri) => (
                  <tr key={ri}>{r.map((c, ci) => <td key={ci}>{c}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'image':
        return <img key={key} className="ask-form-img" src={node.src} alt={node.alt} />;
      case 'hr':
        return <hr key={key} className="ask-form-hr" />;
      case 'fieldset':
        return (
          <fieldset key={key} className="ask-form-fieldset">
            {node.legend && <legend className="ask-form-legend">{node.legend}</legend>}
            {node.children.map((ch, i) => renderFormNode(ch, `${key}-${i}`))}
          </fieldset>
        );
      case 'radio': {
        const cur = formValues[node.name];
        return (
          <label key={key} className="modal-radio">
            <input
              type="radio"
              name={`form-${req.id}-${node.name}`}
              value={node.value}
              checked={cur === node.value}
              disabled={node.disabled || busy}
              onChange={() => setFormValues((prev) => ({ ...prev, [node.name]: node.value }))}
            />
            <span>{node.label}</span>
          </label>
        );
      }
      case 'checkbox': {
        const curArr = Array.isArray(formValues[node.name]) ? (formValues[node.name] as string[]) : [];
        const isChecked = curArr.includes(node.value);
        return (
          <label key={key} className="modal-check">
            <input
              type="checkbox"
              checked={isChecked}
              disabled={node.disabled || busy}
              onChange={(e) => {
                const nextChecked = e.target.checked;
                setFormValues((prev) => {
                  const arr = Array.isArray(prev[node.name]) ? [...(prev[node.name] as string[])] : [];
                  if (nextChecked && !arr.includes(node.value)) arr.push(node.value);
                  else if (!nextChecked) {
                    const idx = arr.indexOf(node.value);
                    if (idx >= 0) arr.splice(idx, 1);
                  }
                  return { ...prev, [node.name]: arr };
                });
              }}
            />
            <span>{node.label}</span>
          </label>
        );
      }
      case 'select': {
        const val = formValues[node.name];
        return (
          <div key={key} className="ask-form-field">
            {node.label && <label className="ask-form-label">{node.label}</label>}
            <select
              multiple={node.multiple}
              disabled={node.disabled || busy}
              value={node.multiple ? (Array.isArray(val) ? val : []) : String(val ?? '')}
              onChange={(e) => {
                if (node.multiple) {
                  const picked = Array.from(e.target.selectedOptions).map((o) => o.value);
                  setFormValues((prev) => ({ ...prev, [node.name]: picked }));
                } else {
                  setFormValues((prev) => ({ ...prev, [node.name]: e.target.value }));
                }
              }}
            >
              {node.options.map((opt, idx) => (
                <option key={`${opt.value}-${idx}`} value={opt.value} disabled={opt.disabled}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        );
      }
      case 'input': {
        if (node.inputType === 'hidden') return null;
        const val = formValues[node.name];
        return (
          <div key={key} className="ask-form-field">
            {node.label && <label className="ask-form-label">{node.label}</label>}
            <input
              type={node.inputType}
              value={val === undefined ? '' : String(val)}
              placeholder={node.placeholder}
              required={node.required}
              disabled={node.disabled || busy}
              onChange={(e) => setFormValues((prev) => ({ ...prev, [node.name]: e.target.value }))}
            />
          </div>
        );
      }
      case 'textarea': {
        const val = formValues[node.name];
        return (
          <div key={key} className="ask-form-field">
            {node.label && <label className="ask-form-label">{node.label}</label>}
            <textarea
              rows={node.rows ?? 4}
              value={val === undefined ? '' : String(val)}
              placeholder={node.placeholder}
              required={node.required}
              disabled={node.disabled || busy}
              onChange={(e) => setFormValues((prev) => ({ ...prev, [node.name]: e.target.value }))}
            />
          </div>
        );
      }
    }
  };

  const renderBody = () => {
    switch (req.method) {
      case 'confirm':
        return (
          <>
            <div className="modal-message">{req.message ?? req.prompt ?? '确认执行此操作？'}</div>
            {!openUrl && (
              <label className="modal-check">
                <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
                始终允许此工具（本会话）
              </label>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => respond({ confirmed: false })} disabled={busy}>拒绝</button>
              <button className="btn btn-primary" onClick={() => respond({ confirmed: true })} disabled={busy}>
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
                {normOptions.map((opt, idx) => (
                  <label key={`${opt.value}-${idx}`} className="modal-radio">
                    <input
                      type="radio"
                      name={`sel-${req.id}`}
                      checked={selected === opt.value}
                      onChange={() => setSelected(opt.value)}
                    />
                    <span>
                      {checkedSet.has(idx) ? `${req.selectionMarker ?? '✓'} ` : ''}
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{opt.description}</span>
                    )}
                  </label>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => respond({ cancelled: true })} disabled={busy}>取消</button>
              <button className="btn btn-primary" onClick={() => respond({ value: selected })} disabled={busy}>确定</button>
            </div>
          </>
        );
      case 'input':
      case 'editor':
        return (
          <>
            {/* omp 18.22.2+：高风险登录等 input 请求会把警告与 "输入 yes" 提示放在 title 后续行，直接展开展示 */}
            {req.method === 'input' && titleRest && (
              <div className="modal-message" style={{ whiteSpace: 'pre-wrap' }}>{titleRest}</div>
            )}
            {(req.message ?? req.prompt) && (
              <div className="modal-message">{req.message ?? req.prompt}</div>
            )}
            {req.method === 'editor' ? (
              <textarea
                rows={8}
                value={inputVal}
                placeholder={req.placeholder}
                onChange={(e) => setInputVal(e.target.value)}
              />
            ) : (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type={req.secret && !showSecret ? 'password' : 'text'}
                  value={inputVal}
                  placeholder={req.placeholder}
                  onChange={(e) => setInputVal(e.target.value)}
                  autoFocus
                  style={{ flex: 1 }}
                  onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && !busy && respond({ value: inputVal })}
                />
                {req.secret && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setShowSecret((v) => !v)}
                    title={showSecret ? '隐藏输入' : '显示输入'}
                  >
                    {showSecret ? '隐藏' : '显示'}
                  </button>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => respond({ cancelled: true })} disabled={busy}>取消</button>
              <button className="btn btn-primary" onClick={() => respond({ value: inputVal })} disabled={busy}>确定</button>
            </div>
          </>
        );
      case 'form': {
        const nodes = parsedForm?.nodes ?? [];
        const onSubmitForm = (e: React.FormEvent) => {
          e.preventDefault();
          if (!parsedForm) return;
          const data = serializeFormData(formValues, parsedForm.fieldMeta);
          void respond({ data });
        };
        return (
          <form onSubmit={onSubmitForm} className="ask-form">
            {remainingSec !== null && (
              <div className="ask-form-timeout">
                超时倒计时：{remainingSec}s（超时后 omp 将自动提交当前默认值）
              </div>
            )}
            <div className="ask-form-body">
              {nodes.length > 0 ? (
                nodes.map((node, i) => renderFormNode(node, `n-${i}`))
              ) : (
                <div className="modal-message">{req.message ?? '（空表单）'}</div>
              )}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => respond({ cancelled: true })} disabled={busy}>取消</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>提交</button>
            </div>
          </form>
        );
      }
      default:
        return (
          <>
            <div className="modal-message">{req.message ?? `未处理的请求类型：${req.method}`}</div>
            <div className="modal-actions">
              <button className="btn" onClick={() => respond({ cancelled: true })} disabled={busy}>取消</button>
              <button className="btn btn-primary" onClick={() => respond({ confirmed: true })} disabled={busy}>知道了</button>
            </div>
          </>
        );
    }
  };

  return (
    <div className="modal-overlay">
      <div className={`modal${req.method === 'form' ? ' modal-wide' : ''}`}>
        {taskName && (
          <div className="modal-task-line">
            任务 · <span className="modal-task-name">{taskName}</span>
          </div>
        )}
        <div className="modal-title-row">
          <div className="modal-title">{titleHead}</div>
          <button
            type="button"
            className="modal-detail-toggle"
            onClick={() => setDetailOpen((o) => !o)}
          >
            {detailOpen ? '收起 ▴' : '详细 ▾'}
          </button>
        </div>
        {detailOpen && (
          <div className="modal-detail">
            {titleRest && <pre>{titleRest}</pre>}
            {req.prompt && req.prompt !== req.message && <pre>{req.prompt}</pre>}
            {!titleRest && !req.prompt && <div className="modal-detail-empty">（omp 未随请求附带更多操作细节）</div>}
            <div className="modal-detail-meta">
              {detailTool && detailTool !== titleHead && (
                <>
                  <span>工具</span>
                  <span>{detailTool}</span>
                </>
              )}
              <span>类型</span>
              <span>{req.method}</span>
              {sessionBasename && (
                <>
                  <span>会话</span>
                  <span title={req.sessionPath}>{sessionBasename}</span>
                </>
              )}
              <span>请求</span>
              <span>{req.id}</span>
            </div>
          </div>
        )}
        {err ? (
          <div className="modal-message" style={{ color: 'var(--accent-danger, #e5484d)' }}>{err}</div>
        ) : (
          renderBody()
        )}
        {err && (
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>关闭</button>
            <button className="btn btn-primary" onClick={onRetry}>重试</button>
          </div>
        )}
      </div>
    </div>
  );
};

function titleOf(method: string): string {
  switch (method) {
    case 'confirm': return '需要批准';
    case 'select': return '请选择';
    case 'input': return '需要输入';
    case 'editor': return '编辑';
    case 'form': return '请填写表单';
    default: return '请求';
  }
}
