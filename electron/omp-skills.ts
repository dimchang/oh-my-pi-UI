/**
 * omp-skills.ts — 技能（Skills）管理：扫描安装目录 + 读写 ~/.omp/agent/config.yml 的 skills.* 配置。
 *
 * 事实依据（官网文档 + 本机实测 2026-08-03）：
 * - config.yml 的 skills.ignoredSkills 按技能名过滤（glob），**新进程启动时生效**（实测：运行中进程
 *   不动态重读，开关后需重启会话进程才真正禁用 /skill:<name>）。
 * - 技能目录含 SKILL.md（front-matter 有 name/description/...），发现根包括：
 *   ~/.agents/skills、~/.claude/skills、~/.codex/skills（顶层目录）+ skills.customDirectories。
 * - 卸载 = 把技能目录移到 ~/.omp/agent/skills-trash/<name>-<时间戳>（可恢复），并加入 ignoredSkills
 *   防止其它目录里的同名副本被重新发现。
 *
 * 写入策略与 omp-config.ts 一致：yaml Document API 只改 skills.* 子树，保留用户其它内容与注释；
 * 原子写（tmp + rename，issue 31）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { parseDocument, Document, parse, YAMLMap } from 'yaml';
import { getAgentDir } from './omp-config';
import type { SkillInfo, SkillDetail } from '../src/shared/ipc-channels';

/** 用户主目录：OMP_HOME 显式设置时以它为准（与 getAgentDir 一致，测试也可用它隔离） */
function userHome(): string {
  const h = process.env.OMP_HOME && process.env.OMP_HOME.trim();
  return h ? h : os.homedir();
}

/** 技能发现根目录（对应 omp 的 agents/claude/codex 三个 user provider；custom 目录单独合并） */
function baseSkillRoots(): string[] {
  const home = userHome();
  return [
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.codex', 'skills'),
  ];
}

const ESCAPE_RE = new RegExp("[.*+?^${}()|[\\]\\\\]", "g");
function escapeRegExp(s: string): string {
  return s.replace(ESCAPE_RE, "\\$&");
}

/** 简单 glob 匹配（仅支持 *，按技能名匹配；与 omp ignoredSkills/includeSkills 语义一致） */
function globMatch(pattern: string, name: string): boolean {
  if (!pattern) return false;
  const re = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
  return re.test(name);
}

function isIgnored(patterns: string[], name: string): boolean {
  return patterns.some((p) => globMatch(p, name));
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

/** config.yml 路径（与 omp-config.ts 的 getAgentDir 一致） */
async function resolveConfigFile(): Promise<string> {
  return path.join(getAgentDir(), 'config.yml');
}

/** 读 config.yml 的 skills.* 状态（文件缺失/解析失败返回空，不抛错） */
export interface SkillConfigState {
  ignoredSkills: string[];
  customDirectories: string[];
}
export async function readSkillConfig(): Promise<SkillConfigState> {
  const file = await resolveConfigFile();
  let obj: Record<string, unknown> = {};
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const doc = parseDocument(raw);
    if (doc.errors.length === 0) obj = (doc.toJS() ?? {}) as Record<string, unknown>;
  } catch {
    // 文件不存在 → 空配置
  }
  const skills = (obj.skills ?? {}) as { ignoredSkills?: unknown; customDirectories?: unknown };
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    ignoredSkills: asStrings(skills.ignoredSkills),
    customDirectories: asStrings(skills.customDirectories),
  };
}

/** 加载 config.yml 为 YAML Document（保留注释）；文件不存在给空文档；解析失败抛错避免覆盖坏文件 */
async function loadConfigDoc(file: string): Promise<Document> {
  let raw: string | null = null;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    raw = null;
  }
  if (raw !== null) {
    const doc = parseDocument(raw);
    if (doc.errors.length > 0) {
      throw new Error('config.yml 已存在但解析失败，为避免破坏原文件已中止写入，请手工修复后重试');
    }
    return doc;
  }
  return new Document({});
}

/** 原子写（tmp + rename） */
async function writeConfigDoc(file: string, doc: Document): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  await fs.promises.writeFile(tmp, doc.toString(), 'utf8');
  await fs.promises.rename(tmp, file);
}

/** 解析 SKILL.md：front-matter（--- 块）与正文分离 */
function parseSkillMd(raw: string): { metadata: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { metadata: {}, body: raw };
  let metadata: Record<string, unknown> = {};
  try {
    const fm = m[1];
    if (fm !== undefined) metadata = (parse(fm) ?? {}) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return { metadata, body: raw.slice(m[0].length) };
}

/** 扫描所有技能根，返回 name → { dir, source }（同名取第一个找到的） */
async function scanSkillDirs(customDirs: string[]): Promise<Map<string, { dir: string; source: string }>> {
  const roots = [...baseSkillRoots(), ...customDirs];
  const out = new Map<string, { dir: string; source: string }>();
  for (const root of roots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      continue; // 根不存在 → 跳过
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      if (!(await fileExists(path.join(dir, 'SKILL.md')))) continue;
      if (!out.has(e.name)) out.set(e.name, { dir, source: path.basename(root) });
    }
  }
  return out;
}

/** 技能名对应的所有 SKILL.md 目录（卸载用：同名可能存在于多个根） */
async function findAllSkillDirs(name: string, customDirs: string[]): Promise<string[]> {
  const roots = [...baseSkillRoots(), ...customDirs];
  const out: string[] = [];
  for (const root of roots) {
    const dir = path.join(root, name);
    if (await fileExists(path.join(dir, 'SKILL.md'))) out.push(dir);
  }
  return out;
}

function validateSkillName(name: string): void {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || /\s/.test(name)) {
    throw new Error('技能名不合法');
  }
}

/** 列出已安装技能（含已停用）：目录扫描 + config 启停状态 */
export async function listSkills(): Promise<SkillInfo[]> {
  const cfg = await readSkillConfig();
  const dirs = await scanSkillDirs(cfg.customDirectories);
  const out: SkillInfo[] = [];
  for (const [name, info] of dirs) {
    let description: string | undefined;
    try {
      const raw = await fs.promises.readFile(path.join(info.dir, 'SKILL.md'), 'utf8');
      const { metadata } = parseSkillMd(raw);
      if (typeof metadata.description === 'string') description = metadata.description;
    } catch {
      // 读不到描述不阻塞
    }
    out.push({ name, description, enabled: !isIgnored(cfg.ignoredSkills, name), path: info.dir, source: info.source });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 技能详情：SKILL.md front-matter + 正文（点卡片后展示） */
export async function readSkillDetail(name: string): Promise<SkillDetail> {
  validateSkillName(name);
  const cfg = await readSkillConfig();
  const dirs = await scanSkillDirs(cfg.customDirectories);
  const info = dirs.get(name);
  const detail: SkillDetail = { name, enabled: !isIgnored(cfg.ignoredSkills, name) };
  if (!info) return detail;
  detail.path = info.dir;
  try {
    const raw = await fs.promises.readFile(path.join(info.dir, 'SKILL.md'), 'utf8');
    const { metadata, body } = parseSkillMd(raw);
    detail.metadata = metadata;
    if (typeof metadata.description === 'string') detail.description = metadata.description;
    detail.body = body;
  } catch {
    // 读不到正文也不阻塞
  }
  return detail;
}

/** 启停技能：改 config.yml skills.ignoredSkills（加/删精确技能名）。新进程启动时生效。 */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  validateSkillName(name);
  const file = await resolveConfigFile();
  const doc = await loadConfigDoc(file);
  if (doc.contents != null && !(doc.contents instanceof YAMLMap)) {
    throw new Error('config.yml 顶层不是 map，为避免破坏原文件已中止写入');
  }
  const cfg = await readSkillConfig();
  let next: string[];
  if (enabled) {
    next = cfg.ignoredSkills.filter((x) => x !== name);
  } else {
    next = cfg.ignoredSkills.includes(name) ? cfg.ignoredSkills : [...cfg.ignoredSkills, name];
  }
  if (next.length === 0) {
    doc.deleteIn(['skills', 'ignoredSkills']);
  } else {
    doc.setIn(['skills', 'ignoredSkills'], doc.createNode(next));
  }
  await writeConfigDoc(file, doc);
}

/** 卸载技能：把 SKILL.md 目录移到 skills-trash（可恢复），并加入 ignoredSkills 防止重新发现。
 *  只允许移动白名单根目录下的技能目录。 */
export async function uninstallSkill(name: string): Promise<{ ok: boolean; moved: string[]; error?: string }> {
  try {
    validateSkillName(name);
    const cfg = await readSkillConfig();
    const dirs = await findAllSkillDirs(name, cfg.customDirectories);
    if (dirs.length === 0) {
      return { ok: false, moved: [], error: "未找到该技能的目录" };
    }
    const roots = [...baseSkillRoots(), ...cfg.customDirectories].map((r) => path.resolve(r));
    const trashRoot = path.join(getAgentDir(), 'skills-trash');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashDir = path.join(trashRoot, `${name}-${stamp}`);
    await fs.promises.mkdir(trashDir, { recursive: true });
    const moved: string[] = [];
    for (const dir of dirs) {
      const target = path.resolve(dir);
      const underRoot = roots.some((r) => target === r || target.startsWith(r + path.sep));
      if (!underRoot) {
        return { ok: false, moved: [], error: `拒绝卸载非技能目录: ${dir}` };
      }
      const dest = path.join(trashDir, path.basename(target));
      await fs.promises.rename(target, dest);
      moved.push(dest);
    }
    // 防止其它目录里的同名副本被重新发现
    await setSkillEnabled(name, false);
    return { ok: true, moved };
  } catch (e) {
    return { ok: false, moved: [], error: e instanceof Error ? e.message : String(e) };
  }
}
