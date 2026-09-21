/**
 * automations.ts — 定时任务：主进程持久化 + 调度 ticker。
 *
 * 职责边界（与渲染层的分工）：
 *  - 主进程：automations.json 读写（userData）、到期判定、发出 AutomationTrigger 事件。
 *    用主进程 setInterval 是因为渲染层窗口最小化/被遮挡时定时器会被 Chromium 节流，
 *    定时任务不能依赖渲染层时钟。
 *  - 渲染层：收到 trigger 后走「新建会话 + prompt」全链路执行（复用 tempKey 迁移等
 *    已验证机制），并把执行记录通过 automation:record-run 交回主进程落盘。
 *
 * 扣账语义：发出 trigger 前先写 lastRunAt=now 并立即落盘——同一时刻绝不触发两次，
 * 崩溃重启也只可能「补跑最近一次错过的」（≤24h 内），更早的错过直接跳过不补发。
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { IPC, type AutomationsFile, type AutomationTask, type AutomationRun } from '../src/shared/ipc-channels';
import { computeNextRunAt } from '../src/shared/automation-schedule';

export function automationsFile(): string {
  return path.join(app.getPath('userData'), 'automations.json');
}

export function emptyAutomationsFile(): AutomationsFile {
  return { version: 1, tasks: [], runs: [] };
}

const MAX_RUNS = 200;
/** 错过超过 24h 的计划时刻不再补跑（单次任务则直接停用）。 */
const CATCH_UP_MAX_MS = 24 * 60 * 60 * 1000;

/** 结构校验（白名单式）：脏数据回退默认，避免污染调度。 */
export function parseAutomationsFile(raw: string): AutomationsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyAutomationsFile();
  }
  const p = parsed as Partial<AutomationsFile> | null;
  if (!p || typeof p !== 'object' || !Array.isArray(p.tasks)) return emptyAutomationsFile();
  const tasks: AutomationTask[] = [];
  for (const t of p.tasks) {
    if (!t || typeof t !== 'object') continue;
    const x = t as Partial<AutomationTask>;
    if (typeof x.id !== 'string' || typeof x.name !== 'string' || typeof x.prompt !== 'string') continue;
    if (typeof x.cwd !== 'string' || !x.cwd) continue;
    if (!x.schedule || typeof x.schedule !== 'object') continue;
    tasks.push({
      id: x.id,
      name: x.name,
      prompt: x.prompt,
      cwd: x.cwd,
      approvalMode: x.approvalMode === 'yolo' || x.approvalMode === 'always-ask' ? x.approvalMode : 'write',
      model: x.model && typeof x.model.provider === 'string' && typeof x.model.id === 'string'
        ? { provider: x.model.provider, id: x.model.id, name: typeof x.model.name === 'string' ? x.model.name : undefined }
        : undefined,
      schedule: x.schedule as AutomationTask['schedule'],
      validUntil: typeof x.validUntil === 'string' ? x.validUntil : undefined,
      enabled: x.enabled !== false,
      createdAt: typeof x.createdAt === 'number' ? x.createdAt : 0,
      lastRunAt: typeof x.lastRunAt === 'number' ? x.lastRunAt : undefined,
    });
  }
  const runs: AutomationRun[] = Array.isArray(p.runs)
    ? (p.runs as AutomationRun[]).filter((r) => r && typeof r === 'object' && typeof r.id === 'string').slice(0, MAX_RUNS)
    : [];
  return { version: 1, tasks, runs };
}

let cache: AutomationsFile | null = null;

export async function loadAutomations(): Promise<AutomationsFile> {
  if (cache) return cache;
  try {
    const raw = await fs.promises.readFile(automationsFile(), 'utf8');
    cache = parseAutomationsFile(raw);
  } catch {
    cache = emptyAutomationsFile();
  }
  return cache;
}

export async function saveAutomations(file: AutomationsFile): Promise<void> {
  const next: AutomationsFile = {
    version: 1,
    tasks: Array.isArray(file.tasks) ? file.tasks : [],
    runs: (Array.isArray(file.runs) ? file.runs : []).slice(0, MAX_RUNS),
  };
  cache = next;
  await fs.promises.mkdir(path.dirname(automationsFile()), { recursive: true });
  await fs.promises.writeFile(automationsFile(), JSON.stringify(next, null, 2), 'utf8');
}

/** 按 run.id upsert 一条执行记录（渲染层先报 running、后补 success/error）。 */
export async function recordAutomationRun(run: AutomationRun): Promise<AutomationsFile> {
  const file = await loadAutomations();
  const idx = file.runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) file.runs[idx] = run;
  else file.runs.unshift(run);
  file.runs.sort((a, b) => b.startedAt - a.startedAt);
  const trimmed: AutomationsFile = { ...file, runs: file.runs.slice(0, MAX_RUNS) };
  await saveAutomations(trimmed);
  return trimmed;
}

export interface AutomationTickerDeps {
  /** 触发回调（通常 = mainWindow.webContents.send(IPC.AutomationTrigger, task)） */
  fire(task: AutomationTask): void;
  /** 文件被主进程改动（扣账/停用）后的通知，渲染层据此刷新列表 */
  onChanged(file: AutomationsFile): void;
  log(line: string): void;
}

/**
 * 调度 ticker：每 15s 扫一遍到期任务。返回停止函数。
 * 扣账在发出事件**之前**持久化，避免触发过程中崩溃导致重复执行。
 */
export function startAutomationTicker(deps: AutomationTickerDeps): () => void {
  const TICK_MS = 15_000;
  const tick = async (): Promise<void> => {
    const file = await loadAutomations();
    const now = Date.now();
    let dirty = false;
    for (const task of file.tasks) {
      if (!task.enabled) continue;
      const base = task.lastRunAt ?? 0;
      let next = computeNextRunAt(task.schedule, base, task.validUntil);
      if (next === null) continue;
      if (next > now) continue; // 未到期
      // 错过太久：循环跳过中间的周期（单次任务直接停用）
      while (next !== null && now - next > CATCH_UP_MAX_MS) {
        if (task.schedule.kind === 'once') {
          task.enabled = false;
          deps.log(`[automation] expire once task ${task.name} (${task.id})`);
          dirty = true;
          next = null;
          break;
        }
        task.lastRunAt = next; // 消费掉这个过期时刻，不补发
        dirty = true;
        next = computeNextRunAt(task.schedule, task.lastRunAt, task.validUntil);
      }
      if (next === null || next > now) continue;
      // 到期：先扣账再触发
      task.lastRunAt = now;
      dirty = true;
      deps.log(`[automation] fire task ${task.name} (${task.id})`);
      try {
        deps.fire(task);
      } catch (e) {
        deps.log(`[automation] fire failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (dirty) {
      await saveAutomations(file).catch(() => undefined);
      deps.onChanged(file);
    }
  };
  const timer = setInterval(() => {
    void tick().catch((e) => deps.log(`[automation] tick error: ${e instanceof Error ? e.message : String(e)}`));
  }, TICK_MS);
  return () => clearInterval(timer);
}
