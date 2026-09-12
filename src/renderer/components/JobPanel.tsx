import React, { useEffect, useState } from 'react';
import { useApp } from '../store';
import type { SubagentJob } from '../store';

/** 耗时：终态用 omp 给的 durationMs，运行中用本地 startedAt 计时
 *  （omp 的 progress.durationMs 在运行期恒为 0，实测）。 */
function durationOf(job: SubagentJob, nowMs: number): string {
  const ms = job.status === 'pending' || job.status === 'running' ? nowMs - job.startedAt : job.durationMs;
  if (ms === undefined || ms <= 0) return job.status === 'pending' ? '排队中' : '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

const STATUS_TEXT: Record<SubagentJob['status'], string> = {
  pending: '排队中',
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
};

const StatusIcon: React.FC<{ status: SubagentJob['status'] }> = ({ status }) => {
  if (status === 'completed') return <span className="job-done">✓</span>;
  if (status === 'running') return <span className="job-active">◎</span>;
  if (status === 'failed') return <span className="job-failed">✗</span>;
  if (status === 'cancelled') return <span className="job-cancelled">⊘</span>;
  return <span className="job-pending">○</span>;
};

/** 主 agent 空闲时 omp 不再推子智能体进度（实测：agent_end 后的 25s 窗口内零帧），
 *  所以面板自己每秒重渲染一次，把"运行中"的耗时和滞后提示刷新出来。 */
function useNow(active: boolean): number {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Date.now();
}

export const JobPanel: React.FC = () => {
  const jobs = useApp((s) => s.subagents);
  const updatedAt = useApp((s) => s.subagentsAt);
  const active = jobs.some((j) => j.status === 'pending' || j.status === 'running');
  const now = useNow(jobs.length > 0);

  if (jobs.length === 0) {
    return (
      <div className="job-panel">
        <div className="panel-header">
          <span>子智能体</span>
        </div>
        <div className="panel-empty">暂无子智能体</div>
      </div>
    );
  }

  const done = jobs.filter((j) => j.status === 'completed').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;
  const cancelled = jobs.filter((j) => j.status === 'cancelled').length;

  return (
    <div className="job-panel">
      <div className="panel-header">
        <span>子智能体</span>
        <span className="job-count">
          {done}/{jobs.length} 完成{failed > 0 ? ` · ${failed} 失败` : ''}
          {cancelled > 0 ? ` · ${cancelled} 取消` : ''}
        </span>
      </div>
      <div className="job-list">
        {jobs.map((job) => {
          const dur = durationOf(job, now);
          return (
            <div key={job.id} className={`job-item ${job.status}`}>
              <div className="job-head">
                <StatusIcon status={job.status} />
                <span className="job-id" title={job.assignment}>{job.id}</span>
                <span className="job-status">{STATUS_TEXT[job.status]}</span>
              </div>
              {/* "在等什么"：优先一句意图，退回任务原文 */}
              {(job.intent ?? job.assignment) && (
                <div className="job-why" title={job.assignment ?? job.intent}>
                  {job.intent ?? job.assignment}
                </div>
              )}
              <div className="job-meta">
                {job.agent && <span>{job.agent}</span>}
                {job.resolvedModel && <span title={job.resolvedModel}>{job.resolvedModel.split('/').pop()}</span>}
                {dur && <span>{dur}</span>}
                {job.toolCount !== undefined && job.toolCount > 0 && <span>{job.toolCount} 工具</span>}
                {job.tokens !== undefined && job.tokens > 0 && <span>{job.tokens} tok</span>}
              </div>
              {job.errorText && <div className="job-error">{job.errorText}</div>}
            </div>
          );
        })}
      </div>
      {updatedAt > 0 && (
        <div className="job-footer">
          最后更新于 {Math.max(0, Math.round((now - updatedAt) / 1000))} 秒前
          {active && now - updatedAt > 5000 ? '（主 agent 空闲时进度可能滞后）' : ''}
        </div>
      )}
    </div>
  );
};
