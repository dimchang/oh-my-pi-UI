import React from 'react';
import { useApp, connTone, connDetail, connStuckMinutes } from '../store';
import { Icon } from './Icon';

export const StatusBar: React.FC = () => {
  const usage = useApp((s) => s.contextUsage);
  const stats = useApp((s) => s.sessionStats);
  // 当前会话的模型 / 思考档位（refreshState 已填充，这里仅展示）
  const model = useApp((s) => s.model);
  const thinking = useApp((s) => s.thinkingLevel);
  // 直接从 selector 参数 s 中 find，避免在 selector 内调用 get() 破坏响应式订阅
  const currentWorkspace = useApp((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId) ?? null);
  // 连接三色与文案统一由 store 派生（与输入框旁的 conn-pill 同源，避免判定漂移）
  const tone = useApp(connTone);
  const statusText = useApp(connDetail);
  const stuckMinutes = useApp(connStuckMinutes);

  // sessionStats 不再在这里一次性拉取：改由 App.refreshState 统一驱动
  // （onReady / agent_end / 切会话时都会刷新），本组件纯展示。

  const dot = tone === 'red' ? 'off' : tone === 'green' ? 'on' : 'busy';

  return (
    <div className="statusbar">
      <span className="status-item" style={stuckMinutes > 0 ? { color: 'var(--yellow)' } : undefined}>
        <span className={`status-dot ${dot}`} />
        {statusText}
      </span>
      {currentWorkspace && (
        <span className="status-item status-workspace" title={currentWorkspace.cwd}>
          <Icon name="folder" size={14} />
          {currentWorkspace.displayName}
        </span>
      )}
      {model && (
        <span className="status-item" title={model.id}>
          {model.name ?? model.id} · {model.provider}
        </span>
      )}
      {thinking && <span className="status-item">思考: {thinking}</span>}
      <span className="status-spacer" />
      {stats?.totalTokens !== undefined && Number.isFinite(stats.totalTokens) && (
        <span className="status-item" title={`${stats.messageCount ?? 0} 条消息`}>
          会话: {(stats.totalTokens / 1000).toFixed(1)}k tokens
          {stats.totalCost !== undefined && Number.isFinite(stats.totalCost) && ` · ¥${stats.totalCost.toFixed(4)}`}
        </span>
      )}
      {usage && (
        <span className="status-item" style={{ color: usage.percent > 80 ? 'var(--yellow)' : undefined }}>
          窗口: {usage.tokens.toLocaleString()} / {(usage.contextWindow / 1000).toFixed(0)}k ({usage.percent.toFixed(1)}%)
        </span>
      )}
    </div>
  );
};
