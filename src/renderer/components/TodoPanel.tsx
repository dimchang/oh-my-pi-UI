import React from 'react';
import { useApp } from '../store';
import type { TodoPhase, TodoItem } from '../../shared/rpc-types';

const StatusIcon: React.FC<{ status?: string }> = ({ status }) => {
  if (status === 'completed' || status === 'done') return <span className="todo-done">✓</span>;
  if (status === 'in_progress' || status === 'active') return <span className="todo-active">◎</span>;
  if (status === 'blocked' || status === 'failed') return <span className="todo-blocked">✗</span>;
  return <span className="todo-pending">○</span>;
};

export const TodoPanel: React.FC = () => {
  const phases = useApp((s) => s.todoPhases);

  if (!phases || phases.length === 0) {
    return (
      <div className="todo-panel">
        <div className="panel-header">
          <span>Todo</span>
        </div>
        <div className="panel-empty">暂无待办</div>
      </div>
    );
  }

  return (
    <div className="todo-panel">
      <div className="panel-header">
        <span>Todo</span>
        <span className="todo-count">
          {phases.reduce((sum, p) => sum + (p.items?.length ?? 0), 0)} 项
        </span>
      </div>
      <div className="todo-list">
        {phases.map((phase: TodoPhase, pi: number) => (
          <div key={phase.phase ?? pi} className="todo-phase">
            <div className="todo-phase-title">{phase.phase}</div>
            {phase.items?.map((item: TodoItem, ii: number) => (
              <div key={ii} className="todo-item">
                <StatusIcon status={item.status} />
                <span className="todo-text">{item.content}</span>
              </div>
            )) ?? (
              <div className="todo-item todo-empty-phase">(空)</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
