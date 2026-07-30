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
    // 一级：标准 diff 字段
    for (const key of ['diff', 'patch', 'unified_diff', 'unifiedDiff', 'edits', 'changes']) {
      const v = r[key];
      if (typeof v === 'string' && looksLikeDiff(v)) return v;
    }
    // 二级：Write 工具可能返回 content/text/file 等字段（整文件内容或确认消息）
    for (const key of ['content', 'text', 'file', 'after', 'before']) {
      const v = r[key];
      if (typeof v === 'string' && looksLikeDiff(v)) return v;
      // OpenAI 格式：content 可能是 [{ type: "text", text: "..." }]
      if (Array.isArray(v) && v.length > 0) {
        const first = v[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) {
          const inner = (first as Record<string, unknown>).text ?? (first as Record<string, unknown>).content;
          if (typeof inner === 'string' && looksLikeDiff(inner)) return inner;
        }
      }
    }
    // 三级：嵌套 result/output/data
    for (const key of ['result', 'output', 'data']) {
      const nested = extractDiff(r[key], depth + 1, visited);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * 从 Write/Edit 工具的 result + args 中提取变更摘要。
 * 当 extractDiff 无法找到 unified diff 时作为兜底，
 * 至少让用户看到"哪个文件被改了"以及结果摘要。
 */
export function extractChangeSummary(
  result: unknown,
  toolName: string,
  args: unknown,
): string | null {
  if (!result) return null;

  // 尝试从各种 result 形态中提取文本摘要
  let summaryText: string | null = null;

  if (typeof result === 'string') {
    summaryText = result.trim();
  } else if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;
    // 直接文本字段
    for (const key of ['text', 'content', 'output', 'message', 'detail']) {
      const v = r[key];
      if (typeof v === 'string' && v.trim()) { summaryText = v.trim(); break; }
    }
    // OpenAI 数组格式: content: [{ type: "text", text: "..." }]
    if (!summaryText && Array.isArray(r.content)) {
      for (const item of r.content) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const t = (item as Record<string, unknown>).text;
          if (typeof t === 'string' && t.trim()) { summaryText = t.trim(); break; }
        }
      }
    }
  }

  if (!summaryText) return null;

  // 从 args 中提取文件路径
  let filePath = '';
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const a = args as Record<string, unknown>;
    // Write 工具用 file_path / path / filepath；Edit 用 file_path
    for (const key of ['file_path', 'filePath', 'path', 'filepath', 'file']) {
      const v = a[key];
      if (typeof v === 'string') { filePath = v; break; }
    }
  }

  // 生成类 diff 摘要：文件头 + 结果文本
  const fileName = filePath ? filePath.replace(/.*[\\/]/, '') : '';
  const header = filePath
    ? `--- /dev/null\n+++ ${filePath}\n`
    : `--- \n+++ ${toolName}\n`;

  // 把摘要文本包装成纯新增 diff 行（每行前加 +）
  const body = summaryText
    .split('\n')
    .map((l) => `+${l}`)
    .join('\n');

  return `${header}${body}`;
}

function looksLikeDiff(s: string): boolean {
  if (!s) return false;
  const lines = s.split('\n');
  // 标准 hunk 头
  const hasHunk = lines.some((l) => /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(l));
  // 文件头（--- / +++）
  const hasHeader = lines.some((l) => /^--- /.test(l)) && lines.some((l) => /^\+\+\+ /.test(l));
  const hasAdd = lines.some((l) => /^\+(?!\+\+)/.test(l));
  const hasDel = lines.some((l) => /^-(?!--)/.test(l));
  // 放宽：有标准 hunk 或文件头的纯新增也视为合法 diff（覆盖 Write 新建文件场景）
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
