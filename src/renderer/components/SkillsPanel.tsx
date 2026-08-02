import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp } from '../store';
import { Icon } from './Icon';
import { rpc } from '../rpc-client';
import { cwdKey } from '../utils/path-key';
import type { SkillDetail, SkillInfo } from '../../shared/ipc-channels';
import type { SlashCommand } from '../../shared/rpc-types';

/** 头像字母（技能名首字母） */
function avatarLetter(name: string): string {
  const s = name.trim();
  return s ? s.charAt(0).toUpperCase() : '?';
}

const AVATAR_COLORS = ['#4f8ef7', '#5cbf8a', '#e8a13a', '#b57df0', '#e76f9e', '#3ab8c9', '#8f9cff', '#6ecb63', '#f07f4f', '#d0578f'];
/** 由技能名生成稳定的头像底色 */
function colorOf(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? '#4f8ef7';
}

/** 开关控件（iOS 风格） */
function Toggle({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }): React.ReactElement {
  return (
    <button
      type="button"
      className={`skill-toggle ${on ? 'on' : 'off'}`}
      aria-pressed={on}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}
    >
      <span className="skill-toggle-knob" />
    </button>
  );
}

/** 从 React 子树提取纯文本（代码块复制用） */
function textFromChildren(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromChildren).join('');
  if (React.isValidElement(node)) return textFromChildren((node.props as { children?: React.ReactNode }).children);
  return '';
}

/** Markdown 代码块：带复制按钮 */
function PreBlock(props: React.HTMLAttributes<HTMLPreElement>): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await window.omp.copyText(textFromChildren(props.children));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
  };
  return (
    <div className="code-block">
      <button type="button" className="code-copy" onClick={copy}>{copied ? '✓ 已复制' : '复制'}</button>
      <pre {...props} />
    </div>
  );
}

/** 详情页（图2 风格）：标题 + 描述 + 元信息 + Markdown 正文 + 去试试/开关/卸载 */
function SkillDetailView({
  detail,
  busy,
  onBack,
  onToggle,
  onTry,
  onUninstall,
}: {
  detail: SkillDetail;
  busy: boolean;
  onBack: () => void;
  onToggle: (v: boolean) => void;
  onTry: () => void;
  onUninstall: () => void;
}): React.ReactElement {
  const metaRows: Array<[string, string]> = [];
  if (detail.path) metaRows.push(['path', detail.path]);
  if (detail.metadata) {
    for (const [k, v] of Object.entries(detail.metadata)) {
      if (k === 'name' || k === 'description') continue;
      metaRows.push([k, typeof v === 'string' ? v : JSON.stringify(v)]);
    }
  }
  return (
    <div className="skill-detail">
      <div className="skill-detail-top">
        <button className="btn btn-ghost" onClick={onBack} disabled={busy}>← 返回</button>
        <button className="btn btn-danger" onClick={onUninstall} disabled={busy}>卸载</button>
      </div>
      <div className="skill-detail-head">
        <div className="skill-detail-avatar" style={{ background: colorOf(detail.name) }}>{avatarLetter(detail.name)}</div>
        <div className="skill-detail-title-wrap">
          <h2 className="skill-detail-name">{detail.name}</h2>
          {detail.description && <p className="skill-detail-desc">{detail.description}</p>}
        </div>
        <div className="skill-detail-actions">
          <button className="btn" onClick={onTry} disabled={busy}>去试试</button>
          <div className="skill-detail-toggle">
            <span>{detail.enabled ? '已启用' : '已停用'}</span>
            <Toggle on={detail.enabled} disabled={busy} onChange={(v) => onToggle(v)} />
          </div>
        </div>
      </div>
      {metaRows.length > 0 && (
        <div className="skill-detail-meta">
          {metaRows.map(([k, v]) => (
            <div key={k} className="skill-detail-meta-row">
              <span className="skill-detail-meta-key">{k}</span>
              <code className="skill-detail-meta-val">{v}</code>
            </div>
          ))}
        </div>
      )}
      <div className="skill-detail-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: PreBlock }}>
          {detail.body ?? ''}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/**
 * SkillsPanel — 技能页（图1 风格）：网格小卡片 + 开关；点卡片进详情（图2：说明 + 卸载）。
 * 数据来自主进程 skillsList()（磁盘扫描 + config.yml skills.ignoredSkills），
 * 比 slashCommands 更完整（含已停用技能），解决"没有完全显示所有项"的问题。
 */
export const SkillsPanel: React.FC = () => {
  const installed = useApp((s) => s.skills);
  const cmds = useApp((s) => s.slashCommands);
  const [q, setQ] = useState('');
  const [detailName, setDetailName] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const list = await window.omp.skillsList();
      useApp.getState().setSkills(list);
    } catch {
      // 主进程不可用等静默
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** 当前会话进程在线且空闲时重启它，让 omp 真正加载/卸载该技能（ignoredSkills 新进程生效） */
  const maybeRespawnCurrentSession = useCallback(async () => {
    const st = useApp.getState();
    const sp = st.currentSessionPath;
    if (!sp) return;
    const ps = st.procStateMap[sp];
    if (!ps || ps.status !== 'online') return;
    if (ps.isStreaming || ps.isAborting) {
      useApp.getState().pushToast('当前会话正在生成，技能变更将在会话进程下次重启后生效', 'info');
      return;
    }
    const session = st.sessions.find((x) => x.path === sp);
    const ws = session && st.workspaces.find((w) => cwdKey(w.cwd) === cwdKey(session.cwd));
    const cwd = ws?.cwd ?? session?.cwd;
    if (!cwd) return;
    const mode = ws?.approvalMode ?? 'write';
    await rpc.release(sp).catch(() => undefined);
    await rpc.acquire(sp, cwd, mode).catch((e) =>
      useApp.getState().pushToast(`重启会话进程失败：${e instanceof Error ? e.message : String(e)}`, 'error'),
    );
  }, []);

  const toggleSkill = useCallback(async (name: string, enabled: boolean) => {
    setBusy(name);
    try {
      const list = await window.omp.skillsSetEnabled(name, enabled);
      useApp.getState().setSkills(list);
      if (detailName === name && detail) {
        setDetail({ ...detail, enabled });
      }
      useApp.getState().pushToast(enabled ? `已启用技能「${name}」` : `已停用技能「${name}」`, 'info');
      await maybeRespawnCurrentSession();
    } catch (e) {
      useApp.getState().pushToast(`切换技能状态失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [detailName, detail, maybeRespawnCurrentSession]);

  const openDetail = useCallback(async (name: string) => {
    setDetailName(name);
    setDetail(null);
    try {
      const d = await window.omp.skillsDetail(name);
      setDetail(d);
    } catch (e) {
      useApp.getState().pushToast(`读取技能详情失败：${e instanceof Error ? e.message : String(e)}`, 'error');
      setDetailName(null);
    }
  }, []);

  const uninstall = useCallback(async (name: string) => {
    const ok = window.confirm(`确定要卸载技能「${name}」吗？\n技能目录将被移到 ~/.omp/agent/skills-trash（可手动恢复）。`);
    if (!ok) return;
    setBusy(name);
    try {
      const res = await window.omp.skillsUninstall(name);
      if (res.ok) {
        useApp.getState().pushToast(`已卸载技能「${name}」`, 'info');
        await refresh();
        await maybeRespawnCurrentSession();
        setDetailName(null);
        setDetail(null);
      } else {
        useApp.getState().pushToast(`卸载失败：${res.error ?? '未知错误'}`, 'error');
      }
    } catch (e) {
      useApp.getState().pushToast(`卸载失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [refresh, maybeRespawnCurrentSession]);

  const back = () => useApp.getState().setMainView('chat');
  const tryIt = useCallback((name: string) => {
    useApp.getState().setMainView('chat');
    useApp.getState().setDraftInput(`/skill:${name} `);
  }, []);

  const query = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query) return installed;
    return installed.filter((s) =>
      s.name.toLowerCase().includes(query) || (s.description ?? '').toLowerCase().includes(query),
    );
  }, [installed, query]);

  const plugins = useMemo(() => {
    return cmds.filter((c: SlashCommand) => !!c.source && c.source !== 'builtin' && c.source !== 'skill');
  }, [cmds]);

  if (detailName) {
    return (
      <div className="skills-view">
        {detail ? (
          <SkillDetailView
            detail={detail}
            busy={busy === detailName}
            onBack={() => { setDetailName(null); setDetail(null); }}
            onToggle={(v) => void toggleSkill(detailName, v)}
            onTry={() => tryIt(detailName)}
            onUninstall={() => void uninstall(detailName)}
          />
        ) : (
          <div className="skills-empty">加载中…</div>
        )}
      </div>
    );
  }

  return (
    <div className="skills-view">
      <div className="skills-topbar">
        <div className="skills-title">
          <span className="skills-title-main">我安装的技能</span>
          <span className="skills-count">{installed.length}</span>
        </div>
        <div className="skills-actions">
          <button className="btn btn-ghost" onClick={() => void refresh()} disabled={busy !== null}>刷新</button>
          <button className="btn" onClick={back}>← 返回对话</button>
        </div>
      </div>

      <div className="skills-body">
        <input
          type="text"
          className="skill-filter"
          placeholder="搜索技能…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        {loading ? (
          <div className="skills-empty">正在读取已安装技能…</div>
        ) : filtered.length === 0 ? (
          <div className="skills-empty">
            {installed.length === 0 ? '未发现已安装的技能（检查 ~/.agents/skills、~/.claude/skills 等目录）' : '没有匹配的技能。'}
          </div>
        ) : (
          <div className="skill-grid">
            {filtered.map((s: SkillInfo) => (
              <div
                key={s.name}
                className={`skill-card ${s.enabled ? '' : 'off'}`}
                onClick={() => void openDetail(s.name)}
              >
                <div className="skill-card-avatar" style={{ background: colorOf(s.name) }}>{avatarLetter(s.name)}</div>
                <div className="skill-card-name">{s.name}</div>
                <div className="skill-card-desc">{s.description || '（无描述）'}</div>
                <div className="skill-card-toggle">
                  <Toggle on={s.enabled} disabled={busy === s.name} onChange={(v) => void toggleSkill(s.name, v)} />
                </div>
              </div>
            ))}
          </div>
        )}

        {plugins.length > 0 && (
          <section className="skills-plugins">
            <div className="skills-section-title">
              <Icon name="plug" size={14} /> 插件 / 扩展 <span className="skills-section-count">{plugins.length}</span>
            </div>
            <div className="plugin-list">
              {plugins.map((c: SlashCommand) => (
                <div key={c.name} className="plugin-item">
                  <span className="plugin-name">/{c.name}</span>
                  {c.description && <span className="plugin-desc">{c.description}</span>}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
