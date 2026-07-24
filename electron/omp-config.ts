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
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument, Document, YAMLMap } from 'yaml';
import type { OmpModelsConfig, OmpProviderConfig } from '../src/shared/ipc-channels';

/** omp agent 配置目录（与 omp getAgentDir() 一致：$OMP_HOME/agent 或 ~/.omp/agent） */
export function getAgentDir(): string {
  const base = process.env.OMP_HOME && process.env.OMP_HOME.trim()
    ? process.env.OMP_HOME
    : path.join(os.homedir(), '.omp');
  return path.join(base, 'agent');
}

/** 解析 models.yml 实际路径：models.yml 优先，回退 models.yaml；都不存在则返回 models.yml（新建目标） */
function resolveModelsFile(): string {
  const dir = getAgentDir();
  const yml = path.join(dir, 'models.yml');
  const yaml = path.join(dir, 'models.yaml');
  try {
    if (fs.existsSync(yml)) return yml;
    if (fs.existsSync(yaml)) return yaml;
  } catch {
    /* fallthrough */
  }
  return yml;
}

/** 读 models.yml → 纯 JS 对象（文件不存在/解析失败返回空配置，不抛错） */
export function readModelsConfig(): OmpModelsConfig {
  const file = resolveModelsFile();
  try {
    if (!fs.existsSync(file)) return { providers: {} };
    const raw = fs.readFileSync(file, 'utf8');
    const doc = parseDocument(raw);
    if (doc.errors.length > 0) {
      // 配置文件损坏时不要静默吞掉——抛给调用方提示用户，避免后续写入覆盖坏文件
      throw new Error(`models.yml 解析失败: ${doc.errors[0].message}`);
    }
    const obj = (doc.toJS() ?? {}) as OmpModelsConfig;
    if (!obj.providers || typeof obj.providers !== 'object') obj.providers = {};
    return obj;
  } catch (e) {
    if (e instanceof Error && e.message.includes('解析失败')) throw e;
    return { providers: {} };
  }
}

/** 加载 YAML Document（保注释）；文件不存在时给空文档 */
function loadDoc(file: string): Document {
  try {
    if (fs.existsSync(file)) {
      const doc = parseDocument(fs.readFileSync(file, 'utf8'));
      if (doc.errors.length > 0) {
        throw new Error(`models.yml 已存在但解析失败（${doc.errors[0].message}），为避免破坏原文件已中止写入，请手工修复后重试`);
      }
      return doc;
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('中止写入')) throw e;
  }
  return new Document({});
}

function writeDoc(file: string, doc: Document): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, doc.toString(), 'utf8');
}

/** 新增/覆盖一个自定义 provider（只动 providers.<id> 子树，其余内容原样保留） */
export function writeProvider(id: string, cfg: OmpProviderConfig): void {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`provider id 不合法（只允许字母/数字/-/_）: ${id}`);
  }
  const file = resolveModelsFile();
  const doc = loadDoc(file);
  // 清理 undefined 字段，避免 YAML 里出现 "key: null"
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v !== undefined && v !== null && v !== '') clean[k] = v;
  }
  if (!(doc.contents instanceof YAMLMap) && doc.contents != null) {
    throw new Error('models.yml 顶层不是 map，为避免破坏原文件已中止写入');
  }
  doc.setIn(['providers', id], doc.createNode(clean));
  writeDoc(file, doc);
}

/** 删除一个自定义 provider */
export function deleteProvider(id: string): void {
  const file = resolveModelsFile();
  if (!fs.existsSync(file)) return;
  const doc = loadDoc(file);
  doc.deleteIn(['providers', id]);
  writeDoc(file, doc);
}
