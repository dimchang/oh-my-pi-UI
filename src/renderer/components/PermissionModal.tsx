import React, { useMemo, useState } from 'react';
import type { UiRequest } from '../store';
import { useApp, toolNameOf } from '../store';
import { pathsEqual } from '../utils/path-key';
import { rpc } from '../rpc-client';

/**
 * PermissionModal — 按 extension_ui_request.method 渲染 confirm/select/input/editor。
 * 单队列顺序展示（store.uiQueue[0]），cancel 帧由 App 负责关对应 modal。
 *
 * 信息架构（2026-09-22）：
 *  - 顶部「任务 · xxx」：显示触发请求的会话名（sessionNames 覆盖名 → 侧栏标题兜底）；
 *  - 标题 = omp title 首行（omp 把工具名/命令等详情用 \n 塞在 title 后续行）；
 *  - 「详细 ▾」折叠区：title 剩余行（命令等）+ prompt + meta（工具/类型/会话/请求 ID）。
 *    select 类请求协议上没有 message 字段，详情只能并进 title 多行（配 OMP-HOOK project-guard）。
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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const busyRef = React.useRef(false);
  const lastPayload = React.useRef<{ value?: string; confirmed?: boolean; cancelled?: boolean }>({});

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

  // open_url 请求：批准后才真正打开链接（issue #5）。req.raw.method 在 App 中保留为 'open_url'。
  const openUrl = (req.raw as unknown as { __openUrl?: string; method?: string } | undefined)?.['__openUrl']
    ?? (req.raw as unknown as { __openUrl?: string; method?: string } | undefined)?.method === 'open_url'
      ? (req.launchUrl ?? req.url)
      : undefined;

  const respond = async (payload: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
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
              <button className="btn" onClick={() => respond({ cancelled: true })} disabled={busy}>取消</button>
              <button className="btn btn-primary" onClick={() => respond({ value: selected })} disabled={busy}>确定</button>
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
                onKeyDown={(e) => e.key === 'Enter' && !busy && respond({ value: inputVal })}
              />
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => respond({ cancelled: true })} disabled={busy}>取消</button>
              <button className="btn btn-primary" onClick={() => respond({ value: inputVal })} disabled={busy}>确定</button>
            </div>
          </>
        );
      default:
        return (
          <>
            <div className="modal-message">{req.message ?? `未处理的请求类型：${req.method}`}</div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => respond({ confirmed: true })} disabled={busy}>知道了</button>
            </div>
          </>
        );
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
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
    default: return '请求';
  }
}
