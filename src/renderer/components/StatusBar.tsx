import React, { useEffect } from 'react';
import { useApp } from '../store';
import { rpc } from '../rpc-client';

export const StatusBar: React.FC = () => {
  const ready = useApp((s) => s.ready);
  const exited = useApp((s) => s.ompExited);
  const isStreaming = useApp((s) => s.isStreaming);
  const model = useApp((s) => s.model);
  const thinking = useApp((s) => s.thinkingLevel);
  const usage = useApp((s) => s.contextUsage);
  const stats = useApp((s) => s.sessionStats);
  const isCompacting = useApp((s) => s.isCompacting);
  const isRetrying = useApp((s) => s.isRetrying);
  const currentWorkspace = useApp((s) => s.currentWorkspace());

  useEffect(() => {
    if (!ready) return;
    const sp = useApp.getState().currentSessionPath;
    if (!sp) return;
    void rpc.getSessionStats(sp).then((r) => {
      if (r.success && r.data) {
        useApp.getState().setState({ sessionStats: r.data as Record<string, unknown> });
      }
    }).catch(() => undefined);
  }, [ready]);

  const dot = exited !== false && exited !== null ? 'off' : isStreaming ? 'busy' : ready ? 'on' : 'busy';
  const statusText =
    exited !== false && exited !== null ? `omp 已退出 (${exited})`
      : isCompacting ? '压缩中'
      : isRetrying ? '重试中'
      : isStreaming ? '生成中'
      : ready ? '就绪'
      : '连接中';

  return (
    <div className="statusbar">
      <span className="status-item">
        <span className={`status-dot ${dot}`} />
        {statusText}
      </span>
      {currentWorkspace && (
        <span className="status-item status-workspace" title={currentWorkspace.cwd}>
          📂 {currentWorkspace.displayName}
        </span>
      )}
      {model && (
        <span className="status-item" title={model.id}>
          {model.name ?? model.id} · {model.provider}
        </span>
      )}
      {thinking && <span className="status-item">思考: {thinking}</span>}
      <span className="status-spacer" />
      {stats?.totalTokens !== undefined && (
        <span className="status-item" title={`${stats.messageCount ?? 0} 条消息`}>
          会话: {(stats.totalTokens / 1000).toFixed(1)}k tokens
          {stats.totalCost !== undefined && ` · ¥${stats.totalCost.toFixed(4)}`}
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
