/**
 * SettingsWecom — 智能体设置 · 消息桥（企微 + 飞书）配置页。
 *
 * 两个渠道共用同一套表单（BridgeChannelForm），只差凭证字段语义与说明文案：
 *  - 企微：管理后台 → 智能机器人 → API 模式（长连接）→ BotID + Secret；
 *  - 飞书：开放平台 → 自建应用 → 添加机器人能力 + 订阅 im.message.receive_v1
 *    + 选择「长连接」接收事件 + 发布版本 → App ID + App Secret。
 *
 * 工作空间下拉旁的「+ 新建」：调系统目录选择框，创建后直接选中（store.upsertWorkspace），
 * 解决「远程会话工作目录只能选已有空间」的限制。
 */

import React, { useEffect, useState } from 'react';
import { useApp } from '../store';
import { cwdKey, basename } from '../utils/path-key';
import type { WecomBridgeConfig, WecomBridgeStatus, Workspace } from '../../shared/ipc-channels';

interface ChannelApi {
  label: string;
  idLabel: string;
  secretLabel: string;
  help: React.ReactNode;
  getStatus(): Promise<WecomBridgeStatus>;
  saveConfig(cfg: WecomBridgeConfig): Promise<WecomBridgeStatus>;
  test(id: string, secret: string): Promise<{ ok: boolean; message: string }>;
  onChanged(cb: (s: WecomBridgeStatus) => void): () => void;
}

const WECOM_API: ChannelApi = {
  label: '企业微信桥',
  idLabel: 'BotID',
  secretLabel: 'Secret（长连接专用密钥）',
  help: (
    <>
      企业微信管理后台 → 安全与管理 → 智能机器人 → 开启「API 模式」并选择「长连接」，
      取得 <code>BotID</code> 与 <code>Secret</code>。长连接无需公网 IP、无需加解密。
    </>
  ),
  getStatus: () => window.omp.getWecomStatus(),
  saveConfig: (cfg) => window.omp.saveWecomConfig(cfg),
  test: (id, secret) => window.omp.testWecom(id, secret),
  onChanged: (cb) => window.omp.onWecomChanged(cb),
};

const FEISHU_API: ChannelApi = {
  label: '飞书桥',
  idLabel: 'App ID',
  secretLabel: 'App Secret',
  help: (
    <>
      飞书开放平台（open.feishu.cn）→ 创建「企业自建应用」→ 添加「机器人」能力 →
      「事件与回调」选「使用长连接接收事件」并订阅 <code>im.message.receive_v1</code> →
      开通 <code>im:message</code> 相关权限 → <b>发布应用版本</b> → 取得{' '}
      <code>App ID</code> 与 <code>App Secret</code>。
    </>
  ),
  getStatus: () => window.omp.getFeishuStatus(),
  saveConfig: (cfg) => window.omp.saveFeishuConfig(cfg),
  test: (id, secret) => window.omp.testFeishu(id, secret),
  onChanged: (cb) => window.omp.onFeishuChanged(cb),
};

/** BridgeChannelForm — 单渠道配置表单（企微/飞书共用） */
const BridgeChannelForm: React.FC<{ api: ChannelApi; initialId?: string }> = ({ api, initialId }) => {
  const workspaces = useApp((s) => s.workspaces) ?? [];
  const upsertWorkspace = useApp((s) => s.upsertWorkspace);
  const setCurrentWorkspaceId = useApp((s) => s.setCurrentWorkspaceId);
  const persistWorkspaces = useApp((s) => s.persistWorkspaces);
  const [status, setStatus] = useState<WecomBridgeStatus | null>(null);
  const [botId, setBotId] = useState('');
  const [secret, setSecret] = useState('');
  const [cwd, setCwd] = useState('');
  const [approvalMode, setApprovalMode] = useState<'write' | 'yolo' | 'always-ask'>('write');
  const [injectMode, setInjectMode] = useState<'steer' | 'followUp'>('steer');
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 表单是否已播种（避免主进程状态推送覆盖用户编辑） */
  const seededRef = React.useRef(false);

  useEffect(() => {
    const load = (s: WecomBridgeStatus | null) => {
      setStatus(s);
      if (!s) return;
      if (seededRef.current) return;
      seededRef.current = true;
      setBotId(s.botId);
      setInjectMode(s.injectMode);
      setApprovalMode(s.approvalMode);
      setCwd(s.cwd || workspaces[0]?.cwd || '');
    };
    void api.getStatus().then(load).catch(() => undefined);
    const off = api.onChanged((s) => setStatus(s));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onTest = async (): Promise<void> => {
    if (!botId.trim() || !secret.trim()) {
      setTestResult(`请先填写 ${api.idLabel} 与 Secret`);
      return;
    }
    setBusy(true);
    setTestResult(null);
    try {
      const r = await api.test(botId.trim(), secret.trim());
      setTestResult(r.ok ? `✅ ${r.message}` : `⚠ ${r.message}`);
    } catch (e) {
      setTestResult(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const buildConfig = (): WecomBridgeConfig => ({
    enabled: status?.enabled ?? false,
    botId: botId.trim(),
    secret: secret.trim(),
    cwd: cwd || workspaces[0]?.cwd || '',
    approvalMode,
    injectMode,
    bindings: status?.bindings ?? [],
  });

  const onSave = async (): Promise<void> => {
    setBusy(true);
    setSaveError(null);
    try {
      setStatus(await api.saveConfig(buildConfig()));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onToggle = async (): Promise<void> => {
    if (!status) return;
    if (!status.enabled && (!botId.trim() || !secret.trim())) {
      setSaveError(`启用前请先填写并保存 ${api.idLabel} 与 Secret`);
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      setStatus(await api.saveConfig({ ...buildConfig(), enabled: !status.enabled }));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 新建工作空间：系统目录选择框 → upsert + 选中 → 固化到本表单 cwd */
  const onAddWorkspace = async (): Promise<void> => {
    const dir = await window.omp.openDirDialog();
    if (!dir) return;
    const id = cwdKey(dir);
    if (!workspaces.some((w) => w.id === id)) {
      const ws: Workspace = {
        id,
        cwd: dir,
        displayName: basename(dir),
        collapsed: false,
        createdAt: Date.now(),
        approvalMode: 'write',
      };
      upsertWorkspace(ws);
      setCurrentWorkspaceId(id);
      persistWorkspaces();
    }
    setCwd(dir);
  };

  const connected = status?.connected ?? false;

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">{api.label}</h3>
      <p className="settings-section-desc">{api.help}</p>

      <div className="settings-row-end">
        <span className={`wecom-conn-dot ${connected ? 'on' : 'off'}`} />
        <span className="settings-hint">{connected ? '已连接' : '未连接'}</span>
        <button className="settings-btn" onClick={() => void onTest()} disabled={busy}>
          测试连接
        </button>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            onChange={() => void onToggle()}
            disabled={busy}
          />
          <span>启用桥</span>
        </label>
      </div>
      {testResult && <div className="hook-error">{testResult}</div>}
      {saveError && <div className="hook-error">⚠ {saveError}</div>}

      <div className="settings-field">
        <label className="settings-field-label">{api.idLabel}</label>
        <input
          className="settings-select"
          value={botId || initialId || ''}
          onChange={(e) => setBotId(e.target.value)}
          placeholder={api.idLabel}
          spellCheck={false}
        />
      </div>
      <div className="settings-field">
        <label className="settings-field-label">{api.secretLabel.split('（')[0]}</label>
        <input
          className="settings-select"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={api.secretLabel}
          spellCheck={false}
        />
      </div>

      <div className="settings-field">
        <label className="settings-field-label">工作目录</label>
        <select
          className="settings-select"
          value={cwd || workspaces[0]?.cwd || ''}
          onChange={(e) => setCwd(e.target.value)}
        >
          {workspaces.length === 0 && <option value="">（无工作空间）</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.cwd}>
              {w.displayName || w.cwd}
            </option>
          ))}
        </select>
        <button className="hook-link" onClick={() => void onAddWorkspace()} disabled={busy}>
          + 新建工作空间
        </button>
      </div>
      <p className="settings-hint">未绑定的聊天首条消息会在此目录新建 OMP 会话。</p>

      <div className="settings-field">
        <label className="settings-field-label">注入模式</label>
        <select
          className="settings-select"
          value={injectMode}
          onChange={(e) => setInjectMode(e.target.value as 'steer' | 'followUp')}
        >
          <option value="steer">steer — 新消息立即打断当前任务（远程纠偏）</option>
          <option value="followUp">followUp — 排队，当前任务跑完再处理</option>
        </select>
      </div>

      <div className="settings-field">
        <label className="settings-field-label">权限模式</label>
        <select
          className="settings-select"
          value={approvalMode}
          onChange={(e) => setApprovalMode(e.target.value as 'write' | 'yolo' | 'always-ask')}
        >
          <option value="write">write — 读写自动，执行类弹窗（推荐）</option>
          <option value="yolo">yolo — 全自动（无人值守时危险）</option>
          <option value="always-ask">always-ask — 每次都弹窗（远程无人应答会卡住）</option>
        </select>
      </div>

      <div className="settings-row-end">
        <button className="settings-btn" onClick={() => void onSave()} disabled={busy}>
          {busy ? '保存中…' : '保存配置'}
        </button>
      </div>

      <h4 className="settings-section-title" style={{ marginTop: 16 }}>绑定（{status?.bindings.length ?? 0}）</h4>
      {(status?.bindings.length ?? 0) === 0 ? (
        <div className="hook-empty">
          还没有绑定。在聊天里给机器人发消息即自动新建会话并绑定；
          或发 <code>/bind &lt;序号&gt;</code> 绑定已有会话（序号见 <code>/sessions</code>）。
          企微端命令：<code>/bind</code> <code>/unbind</code> <code>/new</code> <code>/sessions</code>{' '}
          <code>/reset</code> <code>/status</code>。
        </div>
      ) : (
        <div className="hook-list">
          {status?.bindings.map((b) => (
            <div key={b.chatKey} className="hook-card">
              <div className="hook-card-head">
                <span className="hook-name">
                  {b.chatType === 'group' ? '群聊' : '单聊'} · {b.title || b.chatKey}
                </span>
                <span className="settings-hint">
                  {status.activeChats.includes(b.chatKey) ? '● 生成中' : '空闲'}
                </span>
              </div>
              <div className="hook-path" title={b.sessionPath}>
                {b.sessionPath}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

export const SettingsWecom: React.FC = () => (
  <div className="settings-scroll">
    <BridgeChannelForm api={WECOM_API} />
  </div>
);

export const SettingsFeishu: React.FC = () => (
  <div className="settings-scroll">
    <BridgeChannelForm api={FEISHU_API} />
  </div>
);
