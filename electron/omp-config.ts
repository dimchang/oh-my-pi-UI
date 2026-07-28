/**
 * omp-config.ts — 读写 omp 原生配置文件 ~/.omp/agent/models.yml。
 *
 * 事实依据（omp 17.0.7 源码实证，见 .workbuddy/memory/2026-07-23.md「调研」节）：
 * - 自定义 provider 的唯一官方存储 = models.yml 的 providers.<id>（RPC 无 add_provider 命令）。
 * - ConfigFile 查找顺序：models.yml → models.yaml（GUI 同样兼容）。
 * - apiKey 明文写在 providers.<id>.apiKey，omp 启动时读入内存。
 * - 写完必须重启 omp 进程才生效（ModelRegistry 只在构造时加载）。
 *
 * 写入策略：用 yaml 的 Document API 只改 providers.<id> 子树，
 * 尽量保留用户手写的其它内容（其余 provider、注释、顶层字段）。
 *
 * I/O 策略（issue 28）：全部使用 fs.promises 异步 API，避免在主进程
 * IPC handler 热路径中做同步 I/O 阻塞事件循环。
 * 原子写（issue 31）：先写临时文件再 rename，进程崩溃不会留下截断的 YAML。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { parseDocument, Document, YAMLMap } from 'yaml';
import type { OmpModelsConfig, OmpProviderConfig } from '../src/shared/ipc-channels';

/** omp agent 配置目录（与 omp getAgentDir() 一致：$OMP_HOME/agent 或 ~/.omp/agent） */
export function getAgentDir(): string {
  const base = process.env.OMP_HOME && process.env.OMP_HOME.trim()
    ? process.env.OMP_HOME
    : path.join(os.homedir(), '.omp');
  return path.join(base, 'agent');
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

/** 解析 models.yml 实际路径：models.yml 优先，回退 models.yaml；都不存在则返回 models.yml（新建目标） */
async function resolveModelsFile(): Promise<string> {
  const dir = getAgentDir();
  const yml = path.join(dir, 'models.yml');
  const yaml = path.join(dir, 'models.yaml');
  if (await fileExists(yml)) return yml;
  if (await fileExists(yaml)) return yaml;
  return yml;
}

/** 读 models.yml → 纯 JS 对象（文件不存在/解析失败返回空配置，不抛错） */
export async function readModelsConfig(): Promise<OmpModelsConfig> {
  const file = await resolveModelsFile();
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    return { providers: {} };
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    // 配置文件损坏时不要静默吞掉——抛给调用方提示用户，避免后续写入覆盖坏文件
    throw new ModelsConfigError('parse-error', `models.yml 解析失败: ${doc.errors[0]?.message ?? '未知错误'}`);
  }
  const obj = (doc.toJS() ?? {}) as OmpModelsConfig;
  if (!obj.providers || typeof obj.providers !== 'object') obj.providers = {};
  return obj;
}

/** 自定义错误类（issue 83）：用 code 区分错误类型，不再依赖消息子串匹配。 */
export class ModelsConfigError extends Error {
  constructor(public code: 'parse-error' | 'abort-write', message: string) {
    super(message);
    this.name = 'ModelsConfigError';
  }
}

/** 加载 YAML Document（保注释）；文件不存在时给空文档 */
async function loadDoc(file: string): Promise<Document> {
  let raw: string | null = null;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    raw = null; // 文件不存在 → 空文档
  }
  if (raw !== null) {
    const doc = parseDocument(raw);
    if (doc.errors.length > 0) {
      throw new ModelsConfigError('abort-write', `models.yml 已存在但解析失败（${doc.errors[0]?.message ?? '未知错误'}），为避免破坏原文件已中止写入，请手工修复后重试`);
    }
    return doc;
  }
  return new Document({});
}

/** 原子写（issue 31）：先写同目录临时文件再 rename，避免进程崩溃留下截断的 YAML。 */
async function writeDoc(file: string, doc: Document): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  await fs.promises.writeFile(tmp, doc.toString(), 'utf8');
  await fs.promises.rename(tmp, file);
}

/** 新增/覆盖一个自定义 provider（只动 providers.<id> 子树，其余内容原样保留） */
export async function writeProvider(id: string, cfg: OmpProviderConfig): Promise<void> {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`provider id 不合法（只允许字母/数字/-/_）: ${id}`);
  }
  const file = await resolveModelsFile();
  const doc = await loadDoc(file);
  // 清理 undefined 字段，避免 YAML 里出现 "key: null"
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'extra') continue; // issue 90: extra 单独展开，不作为字面字段写入
    if (v !== undefined && v !== null && v !== '') clean[k] = v;
  }
  // issue 90: 把 extra 里的未知字段展开回顶层，保持对未知配置的透传语义
  if (cfg.extra) {
    for (const [k, v] of Object.entries(cfg.extra)) {
      if (v !== undefined && v !== null && v !== '') clean[k] = v;
    }
  }
  if (!(doc.contents instanceof YAMLMap) && doc.contents != null) {
    throw new ModelsConfigError('abort-write', 'models.yml 顶层不是 map，为避免破坏原文件已中止写入');
  }
  doc.setIn(['providers', id], doc.createNode(clean));
  await writeDoc(file, doc);
}

/** 删除一个自定义 provider（issue 86：不做 existsSync 预检，loadDoc 内 catch ENOENT） */
export async function deleteProvider(id: string): Promise<void> {
  const file = await resolveModelsFile();
  const doc = await loadDoc(file);
  if (doc.contents == null) return; // 文件不存在/为空，无需删除
  doc.deleteIn(['providers', id]);
  await writeDoc(file, doc);
}
