/**
 * AutomationPanel — 定时任务面板（主工作区视图，mainView === 'automation'）。
 *
 * 两个标签页：
 *  - 定时任务：按「当前（启用）/ 已暂停」分组展示，行尾显示下次执行倒计时；
 *    支持搜索、立即执行、编辑、删除、批量启停/删除。
 *  - 运行记录：每次执行的 running/success/error 记录（主进程 automations.json 落盘）。
 *
 * 执行模型：主进程 ticker 只负责「何时触发」（发 AutomationTrigger 事件），
 * 实际执行在渲染层（App.runAutomationTask：新建会话 + prompt，复用会话创建全链路）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { Icon } from './Icon';
import type { AutomationRun, AutomationTask, AutomationsFile, ApprovalMode } from '../../shared/ipc-channels';
import { describeSchedule, describeNextRun } from '../../shared/automation-schedule';
import { fetchAvailableModels } from '../utils/available-models';
import type { ModelInfo } from '../../shared/rpc-types';

/** OMP-UI 权限选项（与工作空间 approvalMode 同一语义，spawn 时生效）。 */
const APPROVAL_OPTIONS: Array<{ value: ApprovalMode; label: string }> = [
  { value: 'write', label: 'Write · 默认' },
  { value: 'yolo', label: 'YOLO · 全自动' },
  { value: 'always-ask', label: 'Always Ask · 每次询问' },
];

const approvalLabel = (m: ApprovalMode): string =>
  APPROVAL_OPTIONS.find((o) => o.value === m)?.label ?? m;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** datetime-local / date 输入的本地时间格式化。 */
function fmtLocal(ts: number, withTime: boolean): string {
  const d = new Date(ts);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return withTime ? `${date}T${pad2(d.getHours())}:${pad2(d.getMinutes())}` : date;
}

/** 表单草稿（HTML input 友好的扁平结构）。 */
interface TaskDraft {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  approvalMode: ApprovalMode;
  modelKey: string; // '' = 默认模型
  kind: 'once' | 'daily' | 'weekly' | 'monthly';
  at: string; // datetime-local
  time: string; // HH:MM
  weekday: number;
  day: number;
  validUntilEnabled: boolean;
  validUntil: string; // YYYY-MM-DD
  enabled: boolean;
}

function draftFromTask(t: AutomationTask | null, defaultCwd: string): TaskDraft {
  if (!t) {
    // 单次默认 = 5 分钟后（直接配过期时间没意义，还容易一保存就触发）
    const d = new Date(Date.now() + 5 * 60_000);
    d.setSeconds(0, 0);
    return {
      id: '', name: '', prompt: '', cwd: defaultCwd, approvalMode: 'write', modelKey: '',
      kind: 'once', at: fmtLocal(d.getTime(), true), time: '09:00', weekday: 1, day: 1,
      validUntilEnabled: false, validUntil: fmtLocal(Date.now(), false), enabled: true,
    };
  }
  const s = t.schedule;
  return {
    id: t.id, name: t.name, prompt: t.prompt, cwd: t.cwd, approvalMode: t.approvalMode ?? 'write',
    modelKey: t.model ? `${t.model.provider}/${t.model.id}` : '',
    kind: s.kind ?? 'once',
    at: s.at ?? fmtLocal(Date.now(), true),
    time: s.time ?? '09:00',
    weekday: s.weekday ?? 1,
    day: s.day ?? 1,
    validUntilEnabled: !!t.validUntil,
    validUntil: t.validUntil ?? fmtLocal(Date.now(), false),
    enabled: t.enabled !== false,
  };
}

function draftToTask(d: TaskDraft, prev: AutomationTask | null): AutomationTask {
  const modelSel = d.modelKey ? d.modelKey.split('/') : null;
  const task: AutomationTask = {
    id: d.id || `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: d.name.trim() || '未命名任务',
    prompt: d.prompt,
    cwd: d.cwd,
    approvalMode: d.approvalMode,
    model: modelSel && modelSel.length >= 2
      ? { provider: modelSel[0]!, id: modelSel.slice(1).join('/'), name: undefined }
      : undefined,
    schedule:
      d.kind === 'once'
        ? { kind: 'once', at: d.at }
        : d.kind === 'daily'
          ? { kind: 'daily', time: d.time }
          : d.kind === 'weekly'
            ? { kind: 'weekly', weekday: d.weekday, time: d.time }
            : { kind: 'monthly', day: d.day, time: d.time },
    validUntil: d.validUntilEnabled && d.validUntil ? d.validUntil : undefined,
    enabled: d.enabled,
    createdAt: prev?.createdAt ?? Date.now(),
    lastRunAt: prev?.lastRunAt,
  };
  return task;
}

// ---------------------------------------------------------------------------
// 添加/编辑弹窗
// ---------------------------------------------------------------------------

const TaskModal: React.FC<{
  draft: TaskDraft;
  onClose: () => void;
  onSubmit: (t: AutomationTask) => void;
}> = ({ draft: initial, onClose, onSubmit }) => {
  const [draft, setDraft] = useState<TaskDraft>(initial);
  const workspaces = useApp((s) => s.workspaces);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const set = <K extends keyof TaskDraft>(k: K, v: TaskDraft[K]) =>
    setDraft((p) => ({ ...p, [k]: v }));

  // 模型列表：落盘缓存 + 本地 models.yml（不打 omp RPC，不阻塞弹窗）
  useEffect(() => {
    const sp = useApp.getState().currentSessionPath ?? '';
    void fetchAvailableModels(sp, { cacheOnly: true })
      .then((r) => setModels(r.models))
      .catch(() => undefined);
  }, []);

  const canSubmit = draft.prompt.trim().length > 0 && !!draft.cwd;
  const submit = () => {
    if (!canSubmit) return;
    const prev = useApp.getState().automations.find((t) => t.id === draft.id) ?? null;
    onSubmit(draftToTask(draft, prev));
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="automation-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="automation-modal-head">
          <span>{draft.id ? '编辑定时任务' : '添加定时任务'}</span>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="automation-modal-body">
          <label className="automation-field-label">名称</label>
          <input
            className="automation-input"
            type="text"
            placeholder="输入任务名称"
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
          />

          <label className="automation-field-label">提示词</label>
          <div className="automation-prompt-card">
            <textarea
              className="automation-textarea"
              placeholder="添加提示词"
              value={draft.prompt}
              onChange={(e) => set('prompt', e.target.value)}
            />
            <div className="automation-prompt-foot">
              <span className="automation-prompt-ico" title="目标工作空间（任务在该目录下新建会话执行）">
                <Icon name="folder" size={13} />
                <select
                  value={draft.cwd}
                  onChange={(e) => set('cwd', e.target.value)}
                >
                  {workspaces.length === 0 && <option value="">（无工作空间）</option>}
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.cwd}>{w.displayName}</option>
                  ))}
                </select>
              </span>
              <span className="automation-prompt-ico" title="权限模式（OMP-UI 权限选项）">
                <Icon name="shield" size={13} />
                <select
                  value={draft.approvalMode}
                  onChange={(e) => set('approvalMode', e.target.value as ApprovalMode)}
                >
                  {APPROVAL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </span>
              <span className="automation-prompt-ico automation-model-sel" title="执行时使用的模型">
                <Icon name="model" size={13} />
                <select value={draft.modelKey} onChange={(e) => set('modelKey', e.target.value)}>
                  <option value="">默认模型</option>
                  {models.map((m) => (
                    <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                      {m.name && m.name !== m.id ? `${m.name} (${m.provider}/${m.id})` : `${m.provider}/${m.id}`}
                    </option>
                  ))}
                </select>
              </span>
            </div>
          </div>

          <div className="automation-schedule-row">
            <span className="automation-field-label inline">执行频率：</span>
            <select
              value={draft.kind}
              onChange={(e) => set('kind', e.target.value as TaskDraft['kind'])}
            >
              <option value="once">单次</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
            {draft.kind === 'once' && (
              <input
                type="datetime-local"
                value={draft.at}
                onChange={(e) => set('at', e.target.value)}
              />
            )}
            {draft.kind !== 'once' && (
              <input
                type="time"
                value={draft.time}
                onChange={(e) => set('time', e.target.value)}
              />
            )}
            {draft.kind === 'weekly' && (
              <select value={draft.weekday} onChange={(e) => set('weekday', Number(e.target.value))}>
                <option value={0}>周日</option>
                <option value={1}>周一</option>
                <option value={2}>周二</option>
                <option value={3}>周三</option>
                <option value={4}>周四</option>
                <option value={5}>周五</option>
                <option value={6}>周六</option>
              </select>
            )}
            {draft.kind === 'monthly' && (
              <select value={draft.day} onChange={(e) => set('day', Number(e.target.value))}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{`${d} 日`}</option>
                ))}
              </select>
            )}
            <span className="automation-field-label inline">有效期：</span>
            <select
              value={draft.validUntilEnabled ? 'until' : 'forever'}
              onChange={(e) => set('validUntilEnabled', e.target.value === 'until')}
            >
              <option value="forever">长期有效</option>
              <option value="until">截止日期</option>
            </select>
            {draft.validUntilEnabled && (
              <input
                type="date"
                value={draft.validUntil}
                onChange={(e) => set('validUntil', e.target.value)}
              />
            )}
          </div>
        </div>

        <div className="automation-modal-actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button className={`btn btn-primary ${canSubmit ? '' : 'disabled'}`} onClick={submit} disabled={!canSubmit}>
            确定
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 运行记录标签页
// ---------------------------------------------------------------------------

const RunRow: React.FC<{ run: AutomationRun }> = ({ run }) => {
  const d = new Date(run.startedAt);
  const time = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const statusLabel = run.status === 'running' ? '进行中' : run.status === 'success' ? '成功' : '失败';
  return (
    <div className="automation-row" title={run.error ?? undefined}>
      <div className="automation-row-main">
        <span className="automation-row-name">{run.taskName}</span>
        <span className="automation-row-desc">· {time}</span>
        {run.error && <span className="automation-row-desc automation-err">· {run.error}</span>}
      </div>
      <span className={`automation-run-status ${run.status}`}>{statusLabel}</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 主面板
// ---------------------------------------------------------------------------

export const AutomationPanel: React.FC<{
  onRunTask: (task: AutomationTask) => void;
}> = ({ onRunTask }) => {
  const tasks = useApp((s) => s.automations);
  const [tab, setTab] = useState<'tasks' | 'runs'>('tasks');
  const [search, setSearch] = useState('');
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modalDraft, setModalDraft] = useState<TaskDraft | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [, forceTick] = useState(0);

  // 倒计时文案每 30s 刷新一次
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const reload = useCallback(async (): Promise<AutomationsFile> => {
    const file = await window.omp.getAutomations();
    useApp.getState().setAutomations(file.tasks);
    setRuns(file.runs);
    return file;
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const persist = useCallback(async (tasks: AutomationTask[]) => {
    // 整文件保存：先取当前文件保留 runs，绝不能传空数组把运行记录抹掉
    const cur = await window.omp.getAutomations();
    const file = await window.omp.saveAutomations({ version: 1, tasks, runs: cur.runs });
    useApp.getState().setAutomations(file.tasks);
    setRuns(file.runs);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) => t.name.toLowerCase().includes(q));
  }, [tasks, search]);
  const enabled = useMemo(() => filtered.filter((t) => t.enabled !== false), [filtered]);
  const paused = useMemo(() => filtered.filter((t) => t.enabled === false), [filtered]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const batchSetEnabled = async (v: boolean) => {
    await persist(tasks.map((t) => (selected.has(t.id) ? { ...t, enabled: v } : t)));
    setSelected(new Set());
  };
  const batchDelete = async () => {
    await persist(tasks.filter((t) => !selected.has(t.id)));
    setSelected(new Set());
  };
  const deleteOne = async (t: AutomationTask) => {
    await persist(tasks.filter((x) => x.id !== t.id));
  };
  const toggleOne = async (t: AutomationTask) => {
    await persist(tasks.map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x)));
  };
  const clearRuns = async () => {
    const file = await window.omp.getAutomations();
    await window.omp.saveAutomations({ version: 1, tasks: file.tasks, runs: [] });
    setRuns([]);
  };

  const submitModal = async (t: AutomationTask) => {
    const exists = tasks.some((x) => x.id === t.id);
    await persist(exists ? tasks.map((x) => (x.id === t.id ? t : x)) : [...tasks, t]);
    setModalDraft(null);
  };

  const Row: React.FC<{ t: AutomationTask }> = ({ t }) => (
    <div className="automation-row">
      {batchMode && (
        <input
          type="checkbox"
          className="automation-check"
          checked={selected.has(t.id)}
          onChange={() => toggleSelect(t.id)}
        />
      )}
      <div className="automation-row-main" onDoubleClick={() => setModalDraft(draftFromTask(t, t.cwd))}>
        <span className="automation-row-name">{t.name}</span>
        <span className="automation-row-tag">定时任务</span>
        <span className="automation-row-desc">{describeSchedule(t.schedule)}</span>
        <span className="automation-row-desc">· {approvalLabel(t.approvalMode ?? 'write')}</span>
        {t.model && <span className="automation-row-desc">· {t.model.name ?? `${t.model.provider}/${t.model.id}`}</span>}
      </div>
      <div className="automation-row-actions">
        <button className="btn btn-sm" title="立即执行" onClick={() => onRunTask(t)}>执行</button>
        <button className="btn btn-sm" title={t.enabled === false ? '启用' : '暂停'} onClick={() => toggleOne(t)}>
          {t.enabled === false ? '启用' : '暂停'}
        </button>
        <button className="btn btn-sm" title="编辑" onClick={() => setModalDraft(draftFromTask(t, t.cwd))}>编辑</button>
        <button className="btn btn-sm danger" title="删除" onClick={() => deleteOne(t)}>删除</button>
      </div>
      <span className={`automation-row-status ${t.enabled === false ? 'paused' : ''}`}>
        {describeNextRun(t, Date.now())}
      </span>
    </div>
  );

  return (
    <div className="automation-panel">
      <div className="automation-toolbar">
        <div className="automation-tabs">
          <button className={`automation-tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>
            <Icon name="clock" size={14} /> 定时任务
          </button>
          <button className={`automation-tab ${tab === 'runs' ? 'active' : ''}`} onClick={() => setTab('runs')}>
            <Icon name="todo" size={14} /> 运行记录
          </button>
        </div>
        <div className="automation-toolbar-right">
          <div className="automation-search">
            <input
              type="text"
              placeholder="搜索定时任务/记录"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            className="icon-btn"
            title="刷新"
            onClick={() => void reload()}
          >
            <Icon name="cog" size={15} />
          </button>
          {tab === 'tasks' && (
            <>
              <button
                className={`btn btn-sm ${batchMode ? 'btn-primary' : ''}`}
                onClick={() => { setBatchMode((v) => !v); setSelected(new Set()); }}
              >
                {batchMode ? '退出批量' : '批量管理'}
              </button>
              <button
                className="btn btn-sm btn-primary dark"
                onClick={() => setModalDraft(draftFromTask(null, useApp.getState().currentWorkspace()?.cwd ?? ''))}
              >
                添加定时任务
              </button>
            </>
          )}
          {tab === 'runs' && (
            <button className="btn btn-sm" onClick={() => void clearRuns()}>清空记录</button>
          )}
        </div>
      </div>

      {batchMode && tab === 'tasks' && (
        <div className="automation-batchbar">
          <span>已选 {selected.size} 项</span>
          <button className="btn btn-sm" disabled={selected.size === 0} onClick={() => void batchSetEnabled(true)}>启用</button>
          <button className="btn btn-sm" disabled={selected.size === 0} onClick={() => void batchSetEnabled(false)}>暂停</button>
          <button className="btn btn-sm danger" disabled={selected.size === 0} onClick={() => void batchDelete()}>删除</button>
        </div>
      )}

      <div className="automation-list">
        {tab === 'tasks' ? (
          <>
            {enabled.length > 0 && (
              <>
                <div className="automation-group">当前</div>
                {enabled.map((t) => <Row key={t.id} t={t} />)}
              </>
            )}
            {paused.length > 0 && (
              <>
                <div className="automation-group">已暂停</div>
                {paused.map((t) => <Row key={t.id} t={t} />)}
              </>
            )}
            {enabled.length === 0 && paused.length === 0 && (
              <div className="automation-empty">
                还没有定时任务。点击右上角「添加定时任务」，让 MyPi 每天自动干活。
              </div>
            )}
          </>
        ) : (
          <>
            {runs.length === 0 ? (
              <div className="automation-empty">暂无运行记录</div>
            ) : (
              runs.map((r) => <RunRow key={r.id} run={r} />)
            )}
          </>
        )}
      </div>

      {modalDraft && (
        <TaskModal
          draft={modalDraft}
          onClose={() => setModalDraft(null)}
          onSubmit={(t) => void submitModal(t)}
        />
      )}
    </div>
  );
};
