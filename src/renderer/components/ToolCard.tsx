import React, { useState } from 'react';
import type { ToolPart } from '../store';
import { DiffView, extractDiff } from './DiffView';

// 工具结果预览的最大字符数，超过则截断，避免超大结果（如整文件内容）撑爆 DOM 导致卡顿（issue 15）
const MAX_TOOL_PREVIEW = 20000;

function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') {
    if (v.length > MAX_TOOL_PREVIEW) {
      return v.slice(0, MAX_TOOL_PREVIEW) + `\n\n… (内容已截断，原始长度 ${v.length} 字符)`;
    }
    return v;
  }
  let s: string;
  try {
    s = JSON.stringify(v, null, 2);
  } catch {
    s = String(v);
  }
  if (s.length > MAX_TOOL_PREVIEW) {
    return s.slice(0, MAX_TOOL_PREVIEW) + `\n\n… (内容已截断，原始长度 ${s.length} 字符)`;
  }
  return s;
}

/** 中间截断：保留首尾各 keep 字符，避免长 URL 把工具名挤换行 */
function truncateMiddle(s: string, keep = 60): string {
  if (s.length <= keep * 2 + 3) return s;
  return s.slice(0, keep) + '…' + s.slice(-keep);
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

export const ToolCard = React.memo(function ToolCard({ tool }: { tool: ToolPart }) {
  // 默认折叠：工具输出/失败详情都收进卡片（标题显示状态 + 命令摘要），点击再展开。
  // 避免中间过程（如 gradle 构建日志）整段铺在主屏上。
  const [open, setOpen] = useState(false);
  const diff = extractDiff(tool.result);
  // 头部摘要做中间截断 + CSS 单行省略号兜底，防止长路径/URL 挤压工具名
  const summary = summaryOf(tool) ? truncateMiddle(summaryOf(tool)) : '';

  return (
    <div className="tool-card">
      <div className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{open ? '▼' : '▶'}</span>
        <span className="tool-name">{tool.toolName}</span>
        <span className={`tool-status ${tool.status}`}>
          {tool.status === 'running' ? '运行中' : tool.status === 'done' ? '完成' : '失败'}
        </span>
        {summary && <span className="tool-summary">{summary}</span>}
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
});
