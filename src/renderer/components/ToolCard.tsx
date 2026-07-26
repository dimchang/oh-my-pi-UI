import React, { useState } from 'react';
import type { ToolPart } from '../store';
import { DiffView, extractDiff } from './DiffView';

function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 针对不同工具做友好摘要 */
function summaryOf(tool: ToolPart): string {
  const name = tool.toolName.toLowerCase();
  // args 可能非对象（如字符串/数字），强制断言会出错——先检查类型
  const args: Record<string, unknown> =
    typeof tool.args === 'object' && tool.args !== null ? (tool.args as Record<string, unknown>) : {};
  if (name === 'read' || name === 'write' || name === 'edit') {
    return String(args.path ?? args.file ?? '');
  }
  if (name === 'bash' || name === 'shell') {
    return String(args.command ?? args.cmd ?? '');
  }
  if (name === 'grep' || name === 'search' || name === 'glob') {
    return String(args.pattern ?? args.query ?? '');
  }
  return '';
}

export const ToolCard: React.FC<{ tool: ToolPart }> = ({ tool }) => {
  const [open, setOpen] = useState(tool.status === 'error');
  const diff = extractDiff(tool.result);
  const summary = summaryOf(tool);

  return (
    <div className="tool-card">
      <div className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{open ? '▼' : '▶'}</span>
        <span className="tool-name">{tool.toolName}</span>
        <span className={`tool-status ${tool.status}`}>
          {tool.status === 'running' ? '运行中' : tool.status === 'done' ? '完成' : '失败'}
        </span>
        {summary && (
          <span style={{ color: 'var(--text-faint)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {summary}
          </span>
        )}
      </div>
      {open && (
        <div className="tool-body">
          {tool.args !== undefined && (
            <div className="tool-section">
              <div className="tool-label">参数</div>
              <pre className="tool-pre">{stringify(tool.args)}</pre>
            </div>
          )}
          {tool.partial && (
            <div className="tool-section">
              <div className="tool-label">输出</div>
              <pre className="tool-pre">{tool.partial}</pre>
            </div>
          )}
          {diff ? (
            <div className="tool-section">
              <div className="tool-label">改动</div>
              <DiffView diff={diff} />
            </div>
          ) : (
            tool.result !== undefined && (
              <div className="tool-section">
                <div className="tool-label">结果</div>
                <pre className="tool-pre">{stringify(tool.result)}</pre>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
};
