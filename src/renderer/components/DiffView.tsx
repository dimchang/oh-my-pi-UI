import React from 'react';

/**
 * DiffView — unified diff 渲染，增删行着色。
 * extractDiff：从 tool_execution_end.result 里尽力找 diff 文本（字段名实测为准，做多种兼容）。
 */

export function extractDiff(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === 'string') {
    return looksLikeDiff(result) ? result : null;
  }
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    for (const key of ['diff', 'patch', 'unified_diff', 'unifiedDiff', 'edits', 'changes']) {
      const v = r[key];
      if (typeof v === 'string' && looksLikeDiff(v)) return v;
    }
    // 有的结果包一层 result/output
    for (const key of ['result', 'output', 'data']) {
      const nested = extractDiff(r[key]);
      if (nested) return nested;
    }
  }
  return null;
}

function looksLikeDiff(s: string): boolean {
  return /^--- |^\+\+\+ |^@@ |^[-+]\s/m.test(s) || s.includes('@@ -');
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
