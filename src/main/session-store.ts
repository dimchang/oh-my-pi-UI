/**
 * session-store.ts — 扫描 ~/.omp/agent/sessions 列会话。
 *
 * 稳态方案（kimi_plan §2.6）：遍历所有子目录，只读每个 .jsonl 首行 SessionHeader
 * 取 title/cwd/id，按 cwd 过滤、mtime 倒序。不自己实现目录编码规则，不解析完整 JSONL。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type { SessionSummary } from '../shared/ipc-channels';
import type { SessionHeader, AgentMessage, ReplayMessage } from '../shared/rpc-types';

function sessionsRoot(): string {
  return path.join(os.homedir(), '.omp', 'agent', 'sessions');
}

/** 读文件前 64KB，返回其中的 SessionHeader（type:"session" 的那一行）。
 *  实测：JSONL 首行可能是 {"type":"title"}，{"type":"session"} 在第二行及以后。
 *  所以不能只看首行，要扫前几行找 type:"session"。 */
async function readSessionHeader(filePath: string): Promise<SessionHeader | null> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return null;
    // issue 34: 64KB 边界可能截断 UTF-8 多字节字符，用 TextDecoder 处理尾部不完整序列
    const text = new TextDecoder('utf8').decode(buf.subarray(0, bytesRead));
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
  } catch (err) {
    // issue 87: 不再静默吞没，便于排查扫盘失败
    console.warn(`[session-store] readSessionHeader failed: ${filePath}`, err);
    return null;
  } finally {
    if (fd !== null) {
      try { await fd.close(); } catch { /* noop */ }
    }
  }
}

/** 只读文件头部最多 maxBytes（默认 256KB），不把整个会话文件读进内存。
 *  用于 titleFallback 兜底——只需要前几条消息就能拿到标题，无需全量加载数十 MB 文件。 */
async function readHead(filePath: string, maxBytes = 256 * 1024): Promise<string> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    // issue 34: 避免尾部多字节字符被截断
    return new TextDecoder('utf8').decode(buf.subarray(0, bytesRead));
  } catch (err) {
    // issue 87: 不再静默吞没
    console.warn(`[session-store] readHead failed: ${filePath}`, err);
    return '';
  } finally {
    if (fd !== null) {
      try { await fd.close(); } catch { /* noop */ }
    }
  }
}

async function titleFallback(header: SessionHeader, filePath: string): Promise<string> {
  if (header.title && header.title.trim()) return header.title.trim();
  // 读首条 user 消息前 40 字兜底：只扫文件头部（最多 256KB），不读全文件
  try {
    const head = await readHead(filePath);
    const lines = head.split('\n').slice(0, 50);
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

/** 并发控制器：限制同时进行的异步任务数，避免数百个 session 文件同时打开耗尽 fd。 */
async function parallelLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

export async function listSessions(cwdFilter?: string): Promise<SessionSummary[]> {
  const root = sessionsRoot();
  try {
    await fs.promises.access(root);
  } catch {
    return [];
  }

  // 收集所有待扫描的 .jsonl 文件路径
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const allFiles: string[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(root, d.name);
    let files: string[];
    try {
      files = (await fs.promises.readdir(sub)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) allFiles.push(path.join(sub, f));
  }

  // 并发扫描（限制 16 并发，避免 fd 耗尽，同时比纯顺序快 10x+）
  const summaries = await parallelLimit(
    allFiles.map((fp) => async (): Promise<SessionSummary | null> => {
      const header = await readSessionHeader(fp);
      if (!header || typeof header.cwd !== 'string') return null;
      if (cwdFilter && normalizePath(header.cwd) !== normalizePath(cwdFilter)) return null;
      let mtime = 0;
      try { mtime = (await fs.promises.stat(fp)).mtimeMs; } catch { /* noop */ }
      return {
        path: fp,
        id: header.id ?? path.basename(fp, '.jsonl'),
        cwd: header.cwd,
        title: await titleFallback(header, fp),
        mtime,
      };
    }),
    16,
  );

  const out = summaries.filter((x): x is SessionSummary => x !== null);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** issue 36: Windows 路径比较大小写不敏感，统一 normalize 后小写归一。 */
function normalizePath(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** issue #3: 读取前校验 filePath 是否真的落在 sessions 根目录内（跟随 symlink 后比较），
 *  防止渲染进程传入任意路径读取磁盘上其它文件。越界直接抛错。 */
async function assertWithinSessionsRoot(filePath: string): Promise<void> {
  const root = sessionsRoot();
  const rootReal = await fs.promises.realpath(root).catch(() => path.resolve(root));
  const normRoot = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal;
  const targetReal = await fs.promises.realpath(filePath).catch(() => path.resolve(filePath));
  const normTarget = process.platform === 'win32' ? targetReal.toLowerCase() : targetReal;
  const inside = normTarget === normRoot || normTarget.startsWith(normRoot + path.sep);
  if (!inside) throw new Error('refuse to read outside sessions root');
}

export async function deleteSession(filePath: string): Promise<void> {
  const root = sessionsRoot();
  // issue 134-138: 解析真实路径（跟随 symlink/junction）后再比较边界，Windows 小写归一化，
  // 防止恶意符号链接绕过 path.normalize 的检查删任意文件。
  const rootReal = await fs.promises.realpath(root).catch(() => path.resolve(root));
  const absTarget = path.resolve(filePath);
  const targetReal = await fs.promises.realpath(absTarget).catch(() => absTarget);

  const normRoot = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal;
  const normTarget = process.platform === 'win32' ? targetReal.toLowerCase() : targetReal;
  // issue 17: 显式拒绝 path 等于 sessions 根目录本身（即使经 ../ 绕回根也拦截），
  // 避免 unlink 根目录（或未来路径语义变化）误删整个 sessions 目录。
  const isRoot = normTarget === normRoot;
  if (isRoot) {
    throw new Error('refuse to delete sessions root');
  }
  const insideRoot = normTarget.startsWith(normRoot + path.sep);
  if (!insideRoot) {
    throw new Error('refuse to delete outside sessions root');
  }
  // issue 35: 去掉 existsSync 预检，直接 unlink 并吞掉 ENOENT，避免检查与删除之间的 TOCTOU 窗口
  await fs.promises.unlink(absTarget).catch((err) => {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  });
}

/** 读取 session JSONL 中的完整消息历史（type:"message" 行的 .message 字段）。
 *  用于「切换会话看历史时不中断正在生成的会话」——此时 omp current 仍是旧会话，
 *  get_messages 拿不到目标会话，只能从磁盘还原。返回 AgentMessage[]，renderer 侧
 *  用 contentToParts 转成 ChatMessage。 */
export async function readSessionMessages(filePath: string): Promise<ReplayMessage[]> {
  // issue #3: 读取前校验路径确实落在 sessions 根目录内，杜绝渲染进程传入任意路径读取任意文件。
  try {
    await assertWithinSessionsRoot(filePath);
  } catch (err) {
    console.warn(`[session-store] readSessionMessages refused (outside sessions root): ${filePath}`, err);
    return [];
  }
  // 基于 readline 流逐行解析：内存只保留单行 + 增量 toolMeta/out，且解析过程让出事件循环，
  // 避免 readFileSync 把数十 MB 文件一次性读进内存并阻塞主进程事件循环（导致 UI 冻结）。
  // 单遍前向扫描：tool_execution_start 总是先于对应 toolResult 出现，边扫边建 toolMeta。
  const toolMeta = new Map<string, { toolName?: string; args?: unknown }>();
  const out: ReplayMessage[] = [];
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    for await (const ln of rl) {
      if (!ln.trim()) continue;
      try {
        const entry = JSON.parse(ln) as {
          type?: string;
          customType?: string;
          data?: { toolCallId?: string; toolName?: string; args?: unknown };
          message?: AgentMessage & { toolCallId?: string; toolName?: string };
        };
        if (entry.type === 'custom' && entry.customType === 'tool_execution_start' && entry.data?.toolCallId) {
          toolMeta.set(entry.data.toolCallId, { toolName: entry.data.toolName, args: entry.data.args });
          continue;
        }
        if (entry && entry.type === 'message' && entry.message) {
          const m = entry.message;
          if (m.role === 'toolResult' && m.toolCallId) {
            const meta = toolMeta.get(m.toolCallId);
            // issue 88: 匹配到 toolResult 后立即清理对应 toolMeta，避免 map 无限增长
            toolMeta.delete(m.toolCallId);
            out.push({ ...m, toolName: meta?.toolName ?? m.toolName, replayArgs: meta?.args });
          } else {
            out.push(m);
          }
        }
      } catch { /* 跳过损坏行 */ }
    }
    rl.close();
  } catch {
    return [];
  }
  return out;
}

/** 读 session JSONL，返回所有 user 消息的 entry id + 文本（按出现顺序）。
 *  供分叉（branch）功能使用：branch 需要 user message 的 entryId 作为分叉点。
 *  同样改为 readline 流式解析，避免大文件全量读入阻塞主进程。 */
export async function readUserEntries(filePath: string): Promise<{ id: string; text: string }[]> {
  // issue #3: 同上，读取前校验路径边界，防止越权读任意文件。
  try {
    await assertWithinSessionsRoot(filePath);
  } catch (err) {
    console.warn(`[session-store] readUserEntries refused (outside sessions root): ${filePath}`, err);
    return [];
  }
  const out: { id: string; text: string }[] = [];
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    for await (const ln of rl) {
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
    rl.close();
  } catch {
    return [];
  }
  return out;
}
