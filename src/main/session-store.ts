/**
 * session-store.ts — 扫描 ~/.omp/agent/sessions 列会话。
 *
 * 稳态方案（kimi_plan §2.6）：遍历所有子目录，只读每个 .jsonl 首行 SessionHeader
 * 取 title/cwd/id，按 cwd 过滤、mtime 倒序。不自己实现目录编码规则，不解析完整 JSONL。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionSummary } from '../shared/ipc-channels';
import type { SessionHeader, AgentMessage, ReplayMessage } from '../shared/rpc-types';

function sessionsRoot(): string {
  return path.join(os.homedir(), '.omp', 'agent', 'sessions');
}

/** 读文件前 64KB，返回其中的 SessionHeader（type:"session" 的那一行）。
 *  实测：JSONL 首行可能是 {"type":"title"}，{"type":"session"} 在第二行及以后。
 *  所以不能只看首行，要扫前几行找 type:"session"。 */
function readSessionHeader(filePath: string): SessionHeader | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n === 0) return null;
    const text = buf.toString('utf8', 0, n);
    const lines = text.split('\n').slice(0, 20); // 只扫前 20 行足够
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const entry = JSON.parse(ln) as SessionHeader & { type?: string };
        if (entry && entry.type === 'session' && typeof entry.cwd === 'string') {
          return entry as SessionHeader;
        }
      } catch { /* skip */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }
}

function titleFallback(header: SessionHeader, filePath: string): string {
  if (header.title && header.title.trim()) return header.title.trim();
  // 读首条 user 消息前 40 字兜底：扫前若干行找 message/user
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').slice(0, 50);
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const entry = JSON.parse(ln) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
        if (entry.message?.role === 'user') {
          const textPart = entry.message.content?.find((c) => c.type === 'text');
          if (textPart?.text) return textPart.text.slice(0, 40);
        }
      } catch { /* skip */ }
    }
  } catch { /* noop */ }
  return '(untitled)';
}

export function listSessions(cwdFilter?: string): SessionSummary[] {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return [];

  const out: SessionSummary[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(root, d.name);
    let files: string[];
    try {
      files = fs.readdirSync(sub).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = path.join(sub, f);
      const header = readSessionHeader(fp);
      if (!header || typeof header.cwd !== 'string') continue;
      if (cwdFilter && path.normalize(header.cwd) !== path.normalize(cwdFilter)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(fp).mtimeMs;
      } catch { /* noop */ }
      out.push({
        path: fp,
        id: header.id ?? path.basename(f, '.jsonl'),
        cwd: header.cwd,
        title: titleFallback(header, fp),
        mtime,
      });
    }
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function deleteSession(filePath: string): void {
  const root = sessionsRoot();
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(path.normalize(root))) {
    throw new Error('refuse to delete outside sessions root');
  }
  if (fs.existsSync(normalized)) fs.unlinkSync(normalized);
}

/** 读取 session JSONL 中的完整消息历史（type:"message" 行的 .message 字段）。
 *  用于「切换会话看历史时不中断正在生成的会话」——此时 omp current 仍是旧会话，
 *  get_messages 拿不到目标会话，只能从磁盘还原。返回 AgentMessage[]，renderer 侧
 *  用 contentToParts 转成 ChatMessage。 */
export function readSessionMessages(filePath: string): ReplayMessage[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // 第一遍：收集 tool_execution_start 的参数（如 read 的 path），按 toolCallId 索引。
    // 这些 custom 帧之前被整体丢弃，导致历史回放里 toolResult 拿不到 args、也无法重建 ToolCard。
    const toolMeta = new Map<string, { toolName?: string; args?: unknown }>();
    const lines = content.split('\n');
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const entry = JSON.parse(ln) as {
          type?: string;
          customType?: string;
          data?: { toolCallId?: string; toolName?: string; args?: unknown };
        };
        if (entry.type === 'custom' && entry.customType === 'tool_execution_start' && entry.data?.toolCallId) {
          toolMeta.set(entry.data.toolCallId, { toolName: entry.data.toolName, args: entry.data.args });
        }
      } catch { /* ignore */ }
    }
    // 第二遍：把所有 message 帧转为 ReplayMessage，给 toolResult 补上匹配的 args。
    const out: ReplayMessage[] = [];
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const entry = JSON.parse(ln) as { type?: string; message?: AgentMessage & { toolCallId?: string } };
        if (entry && entry.type === 'message' && entry.message) {
          const m = entry.message;
          if (m.role === 'toolResult' && m.toolCallId) {
            const meta = toolMeta.get(m.toolCallId);
            out.push({ ...m, toolName: meta?.toolName ?? m.toolName, replayArgs: meta?.args });
          } else {
            out.push(m);
          }
        }
      } catch { /* 跳过损坏行 */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** 读 session JSONL，返回所有 user 消息的 entry id + 文本（按出现顺序）。
 *  供分叉（branch）功能使用：branch 需要 user message 的 entryId 作为分叉点。 */
export function readUserEntries(filePath: string): { id: string; text: string }[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const out: { id: string; text: string }[] = [];
    for (const ln of content.split('\n')) {
      if (!ln.trim()) continue;
      try {
        const entry = JSON.parse(ln) as {
          type?: string;
          id?: string;
          message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
        };
        if (entry.type === 'message' && entry.id && entry.message?.role === 'user') {
          const text = entry.message.content
            ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text)
            .join('') ?? '';
          out.push({ id: entry.id, text });
        }
      } catch { /* 跳过损坏行 */ }
    }
    return out;
  } catch {
    return [];
  }
}
