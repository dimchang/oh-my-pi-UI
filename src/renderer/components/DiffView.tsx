import React from 'react';

/**
 * DiffView — unified diff 渲染，增删行着色。
 * extractDiff：从 tool_execution_end.result 里尽力找 diff 文本（字段名实测为准，做多种兼容）。
 */

const MAX_DIFF_DEPTH = 6;

export function extractDiff(
  result: unknown,
  depth = 0,
  visited: WeakSet<object> = new WeakSet(),
): string | null {
  if (!result) return null;
  if (depth > MAX_DIFF_DEPTH) return null;
  if (typeof result === 'string') {
    return looksLikeDiff(result) ? result : null;
  }
  if (typeof result === 'object') {
    if (visited.has(result as object)) return null; // 循环引用保护
    visited.add(result as object);
    const r = result as Record<string, unknown>;
    for (const key of ['diff', 'patch', 'unified_diff', 'unifiedDiff', 'edits', 'changes']) {
      const v = r[key];
      if (typeof v === 'string' && looksLikeDiff(v)) return v;
    }
    // 有的结果包一层 result/output
    for (const key of ['result', 'output', 'data']) {
      const nested = extractDiff(r[key], depth + 1, visited);
      if (nested) return nested;
    }
  }
  return null;
}

function looksLikeDiff(s: string): boolean {
  if (!s) return false;
  const lines = s.split('\n');
  // 更严格：要求标准 hunk 头 / 文件头，或同时出现 +/- 修改行（排除纯 markdown 列表的单项 +/-）
  const hasHunk = lines.some((l) => /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(l));
  const hasHeader = lines.some((l) => /^--- /.test(l)) && lines.some((l) => /^\+\+\+ /.test(l));
  const hasAdd = lines.some((l) => /^\+(?!\+\+)/.test(l));
  const hasDel = lines.some((l) => /^-(?!--)/.test(l));
  return hasHunk || hasHeader || (hasAdd && hasDel);
}

export const DiffView: React.FC<{ diff: string }> = ({ diff }) => {
  const lines = diff.split('\n');
  return (
    <div className="diff">
      {lines.map((ln, i) => {
        let cls = 'diff-ctx';
        if (ln.startsWith('@@')) cls = 'diff-hunk';
        else if (ln.startsWith('+') && !ln.startsWith('+++')) cls = 'diff-add';
        else if (ln.startsWith('-') && !ln.startsWith('---')) cls = 'diff-del';
        else if (ln.startsWith('+++') || ln.startsWith('---')) cls = 'diff-hunk';
        return (
          <div key={i} className={`diff-line ${cls}`}>
            {ln || ' '}
          </div>
        );
      })}
    </div>
  );
};
