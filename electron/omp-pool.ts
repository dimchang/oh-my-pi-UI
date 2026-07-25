/**
 * omp-pool.ts — 多 omp 进程池（每会话一进程，上限 5，懒加载 + LRU 淘汰）。
 *
 * 目标：切换会话不中断之前的会话。每个活跃会话绑定独立 omp 进程，
 * 该进程的 current session 就是这个会话。切会话 = 切显示指针 + 切"跟哪个进程说话"，
 * 不切任何进程的 current，因此旧会话不会被丢弃。
 *
 * 帧 routing：每个进程的帧带 __sessionPath 标记推给 renderer，
 * renderer 按该字段路由到对应会话缓冲（不再靠 ompCurrentPath 猜）。
 */

import { OmpProcess } from './omp-process';
import { FrameRouter } from '../src/main/frame-router';
import type { OmpFrame, RpcCommand, RpcResponse } from '../src/shared/rpc-types';
import type { ApprovalMode } from '../src/shared/ipc-channels';
import * as path from 'path';
import * as fs from 'fs';

export interface PoolEntry {
  sessionPath: string;
  cwd: string;
  approvalMode: ApprovalMode;
  proc: OmpProcess;
  router: FrameRouter;
  lastActiveAt: number;
  status: 'spawning' | 'online' | 'evicted';
}

export interface PoolEvents {
  onFrame(sessionPath: string, frame: OmpFrame): void;
  onReady(sessionPath: string): void;
  onExit(sessionPath: string, code: number | null): void;
  onStderr(sessionPath: string, line: string): void;
  onLog(line: string): void;
}

const DEFAULT_MAX_POOL = 5;
const SPAWN_TIMEOUT_MS = 30_000;

export class OmpProcessPool {
  private entries = new Map<string, PoolEntry>();
  /** 同一 sessionPath 正在 spawn 时复用同一个 Promise，避免重复拉起。 */
  private spawning = new Map<string, Promise<PoolEntry>>();
  /** 有未应答 UI 请求（工具确认 / 选择 / 输入弹窗等）的会话 → refcount。
   *  LRU 淘汰时跳过 pinned 会话，避免杀掉"正在等用户确认"的进程
   *  （那种进程不输出帧，lastActiveAt 很旧，会被误判为最闲而被淘汰）。 */
  private pinned = new Map<string, number>();

  /** 标记某会话有未应答 UI 请求（防止被 LRU 淘汰）。可重复调用（refcount）。 */
  pin(sessionPath: string): void {
    this.pinned.set(sessionPath, (this.pinned.get(sessionPath) ?? 0) + 1);
  }
  /** 解除一个 UI 请求的 pin（应答后调用）。refcount 归零才真正释放。 */
  unpin(sessionPath: string): void {
    const n = (this.pinned.get(sessionPath) ?? 0) - 1;
    if (n <= 0) this.pinned.delete(sessionPath);
    else this.pinned.set(sessionPath, n);
  }

  constructor(
    private ompPath: string,
    private events: PoolEvents,
    private maxPool = DEFAULT_MAX_POOL,
  ) {}

  /** 池里是否已有该会话的 online 进程。 */
  has(sessionPath: string): boolean {
    const e = this.entries.get(sessionPath);
    return !!e && e.status === 'online';
  }

  /** 取已在线的 entry（不拉起）。 */
  get(sessionPath: string): PoolEntry | undefined {
    const e = this.entries.get(sessionPath);
    return e && e.status === 'online' ? e : undefined;
  }

  /** 所有 online 会话 path。 */
  onlinePaths(): string[] {
    const out: string[] = [];
    for (const e of this.entries.values()) if (e.status === 'online') out.push(e.sessionPath);
    return out;
  }

  /** 当前 online 进程数（不含 spawning/evicted）。 */
  onlineCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.status === 'online') n++;
    return n;
  }

  /** 获取（或懒拉起）某会话的进程。带 -c 续接该会话历史。
   *  - 已 online → 直接返回（更新 lastActiveAt）。
   *  - 池满 → 先 LRU 淘汰最久未活跃的 idle 进程。
   *  - spawn 带 -c：resume 该 sessionPath 的历史（用户切回旧会话续接）。 */
  async acquire(sessionPath: string, cwd: string, approvalMode: ApprovalMode = 'write', hooks?: string[]): Promise<PoolEntry> {
    const existing = this.entries.get(sessionPath);
    if (existing && existing.status === 'online') {
      existing.lastActiveAt = Date.now();
      return existing;
    }
    const pending = this.spawning.get(sessionPath);
    if (pending) return pending;
    if (this.onlineCount() >= this.maxPool) this.evictLRU();
    // 历史会话（磁盘文件存在）→ -r resume 指定文件；
    // 否则（tempKey 或文件不存在，如新建会话）→ 全新 spawn（不带 -r/-c）
    const resumePath = sessionPath && fs.existsSync(sessionPath) ? sessionPath : undefined;
    const p = this.spawnEntry(sessionPath, cwd, approvalMode, /*continueSession*/ false, resumePath, undefined, hooks);
    this.spawning.set(sessionPath, p);
    try {
      return await p;
    } finally {
      this.spawning.delete(sessionPath);
    }
  }

  /** 新建会话：spawn 不带 -c（开新 .jsonl），ready 后由调用方 listSessions
   *  解析真实 path 再 renameKey(tempKey, realPath)。tempKey 用临时占位。
   *  systemPrompt 非空时通过 --append-system-prompt 注入到该新会话。
   *  hooks 非空时逐个通过 --hook=<path> 注入（全局钩子）。 */
  async acquireNew(tempKey: string, cwd: string, approvalMode: ApprovalMode = 'write', systemPrompt?: string, hooks?: string[]): Promise<PoolEntry> {
    const pending = this.spawning.get(tempKey);
    if (pending) return pending;
    if (this.onlineCount() >= this.maxPool) this.evictLRU();
    const p = this.spawnEntry(tempKey, cwd, approvalMode, /*continueSession*/ false, undefined, systemPrompt, hooks);
    this.spawning.set(tempKey, p);
    try {
      return await p;
    } finally {
      this.spawning.delete(tempKey);
    }
  }

  /** 新进程 ready 后，把临时 key 换成真实 sessionPath（listSessions 解析出的）。 */
  renameKey(oldKey: string, newKey: string): PoolEntry | undefined {
    if (oldKey === newKey) return this.entries.get(oldKey);
    const e = this.entries.get(oldKey);
    if (!e) return undefined;
    this.entries.delete(oldKey);
    e.sessionPath = newKey;
    this.entries.set(newKey, e);
    // 迁移 pin 引用：未应答 UI 请求（工具确认弹窗等）必须随会话一起转移，
    // 否则新 key 不再被 pinned，会在用户犹豫期间被 LRU 误杀 → "omp process not online"。
    const pc = this.pinned.get(oldKey);
    if (pc !== undefined) {
      this.pinned.delete(oldKey);
      this.pinned.set(newKey, pc);
    }
    return e;
  }

  /** 往某会话的进程发命令并等响应。 */
  async send<T = unknown>(sessionPath: string, cmd: RpcCommand): Promise<RpcResponse<T>> {
    const entry = this.get(sessionPath);
    if (!entry) throw new Error(`omp process not online for session: ${sessionPath}`);
    entry.lastActiveAt = Date.now();
    return entry.router.send<T>(cmd);
  }

  /** 直接写命令到某会话进程 stdin（不等响应，用于 extension_ui_response）。 */
  write(sessionPath: string, cmd: RpcCommand): void {
    const entry = this.get(sessionPath);
    if (!entry) throw new Error(`omp process not online for session: ${sessionPath}`);
    entry.proc.write(cmd);
  }

  /** 主动淘汰某会话的进程（用户关闭会话 / 切权限模式重起时用）。 */
  evict(sessionPath: string): void {
    const e = this.entries.get(sessionPath);
    if (!e) return;
    this.pinned.delete(sessionPath); // 释放可能的 pin（被显式 evict 的会话不再受保护）
    e.status = 'evicted';
    e.router.rejectAll('evicted by pool');
    try { e.proc.kill(); } catch { /* noop */ }
    this.entries.delete(sessionPath);
  }

  /** LRU 淘汰：找 lastActiveAt 最小的 online 进程杀掉。不淘汰 spawning 状态的，
   *  也不淘汰有未应答 UI 请求（pinned）的会话——那种会话正等用户确认，杀掉会让弹窗失效。 */
  private evictLRU(): void {
    let victim: PoolEntry | undefined;
    for (const e of this.entries.values()) {
      if (e.status !== 'online') continue;
      if (this.pinned.has(e.sessionPath)) continue; // 有未应答 UI 请求 → 禁止淘汰
      if (!victim || e.lastActiveAt < victim.lastActiveAt) victim = e;
    }
    if (victim) {
      this.events.onLog(`[pool] LRU evict ${victim.sessionPath}`);
      this.evict(victim.sessionPath);
    }
  }

  /** 杀掉所有进程（app 退出时用，同步等死透）。 */
  killAll(): void {
    for (const e of this.entries.values()) {
      e.status = 'evicted';
      e.router.rejectAll('app quitting');
      try { e.proc.kill(true); } catch { /* noop */ }
    }
    this.entries.clear();
    this.spawning.clear();
  }

  private spawnEntry(
    sessionPath: string,
    cwd: string,
    approvalMode: ApprovalMode,
    continueSession: boolean,
    resumeSession?: string,
    systemPrompt?: string,
    hooks?: string[],
  ): Promise<PoolEntry> {
    return new Promise<PoolEntry>((resolve, reject) => {
      if (!fs.existsSync(cwd)) {
        reject(new Error(`工作目录不存在: ${cwd}`));
        return;
      }
      const normalizedCwd = path.normalize(cwd);
      // 用 ctx 包装让 proc 回调能引用尚未声明的 entry/router（闭包运行时解析）
      const ctx: { entry?: PoolEntry; router?: FrameRouter } = {};
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.evict(sessionPath);
          reject(new Error(`omp spawn timeout (${SPAWN_TIMEOUT_MS}ms) for ${sessionPath}`));
        }
      }, SPAWN_TIMEOUT_MS);
      const proc = new OmpProcess(
        { ompPath: this.ompPath, cwd: normalizedCwd, approvalMode, continueSession, resumeSession, systemPrompt, hooks },
        {
          onReady: () => {
            if (ctx.entry) ctx.entry.status = 'online';
            if (ctx.entry) ctx.entry.lastActiveAt = Date.now();
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              if (ctx.entry) resolve(ctx.entry);
              else reject(new Error('entry missing on ready'));
            }
            this.events.onReady(sessionPath);
          },
          onFrame: (frame) => ctx.router?.dispatch(frame),
          onExit: (code) => {
            if (ctx.entry) ctx.entry.status = 'evicted';
            ctx.router?.rejectAll(`omp exited (code=${code})`);
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(new Error(`omp exited before ready (code=${code}) for ${sessionPath}`));
            }
            this.events.onExit(sessionPath, code);
          },
          onStderr: (line) => this.events.onStderr(sessionPath, line),
        },
      );
      const router = new FrameRouter({
        write: (cmd) => proc.write(cmd),
        pushEvent: (frame) => this.events.onFrame(sessionPath, frame),
        onLog: (line) => this.events.onLog(line),
      });
      ctx.router = router;
      const entry: PoolEntry = {
        sessionPath,
        cwd: normalizedCwd,
        approvalMode,
        proc,
        router,
        lastActiveAt: Date.now(),
        status: 'spawning',
      };
      ctx.entry = entry;
      this.entries.set(sessionPath, entry);
      try {
        proc.start();
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.entries.delete(sessionPath);
          reject(e as Error);
        }
      }
    });
  }
}
