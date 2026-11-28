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
import type { ApprovalMode, AcquireOptions } from '../src/shared/ipc-channels';
import * as path from 'path';
import * as fs from 'fs';

export interface PoolEntry {
  sessionPath: string;
  cwd: string;
  approvalMode: ApprovalMode;
  /** 该进程启动时注入的 hook 路径列表（顺序无关）。用于配置变更后识别是否需要重起。 */
  hooks: string[];
  /** omp 19.0.0+：是否注入 PI_INTENT_TRACING=1 */
  intentTracing: boolean;
  proc: OmpProcess;
  router: FrameRouter;
  lastActiveAt: number;
  status: 'spawning' | 'online' | 'evicted';
}

export interface PoolAcquireOptions extends AcquireOptions {
  intentTracing?: boolean;
}

export interface PoolEvents {
  onFrame(sessionPath: string, frame: OmpFrame): void;
  onReady(sessionPath: string): void;
  onExit(sessionPath: string, code: number | null): void;
  onStderr(sessionPath: string, line: string): void;
  onLog(line: string): void;
  /** renameKey 时 newKey 下原有的另一个进程被回收（不推 onExit，渲染层已接管 newKey 的状态）。
   *  消息桥据此收尾挂在被回收进程上的回合，否则该回合会错收迁移过来的会话的输出。 */
  onReplaced?(sessionPath: string): void;
}

const DEFAULT_MAX_POOL = 5;
const SPAWN_TIMEOUT_MS = 30_000;

/** 尚未落盘的临时会话 key：渲染层新建（__new_）与企微/飞书桥自动建会话（__wecom_/__feishu_）。 */
function isTempKey(key: string): boolean {
  return /^__(new|wecom|feishu)_/.test(key);
}

/** 比较两组 hook 路径是否等价（忽略顺序与重复）。 */
function hooksEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

export class OmpProcessPool {
  private entries = new Map<string, PoolEntry>();
  /** 同一 sessionPath 正在 spawn 时复用同一个 Promise，避免重复拉起。 */
  private spawning = new Map<string, Promise<PoolEntry>>();
  /** 有未应答 UI 请求（工具确认 / 选择 / 输入弹窗等）的会话 → 未应答请求 id 集合。
   *  LRU 淘汰时跳过 pinned 会话，避免杀掉"正在等用户确认"的进程
   *  （那种进程不输出帧，lastActiveAt 很旧，会被误判为最闲而被淘汰）。
   *  按请求 id 记账而非 refcount：被 omp cancel 撤销的请求不会再有应答，必须能按 id 单独释放；
   *  重复/未知 id 的释放为 no-op，不会误减其他请求的 pin。 */
  private pinned = new Map<string, Set<string>>();
  /** tempKey → 该会话已落盘的真实 .jsonl 路径（omp get_state.sessionFile）。
   *  acquire(tempKey) 在进程死掉后重拉时用它带 -r 续接，杜绝对 tempKey 全新
  spawn 裂出第二个会话（2026-09-14 bet_zp 事故：进程被杀后 ensureOnline(tempKey)
  spawn 出 01a0a048，与 01a0a046 内容分裂）。renameKey 时同步清除。 */
  private tempSessionFiles = new Map<string, string>();
  /** spawning 中的 entry → 中止其 spawn Promise 的回调。evict/killAll 时立即 reject，
   *  否则等待方要挂到 30s 超时，且超时回调按 key 淘汰会误伤同 key 后来新建的 entry。 */
  private spawnAborts = new WeakMap<PoolEntry, (err: Error) => void>();

  /** 标记某会话有一个未应答 UI 请求（防止被 LRU 淘汰）。 */
  pin(sessionPath: string, requestId: string): void {
    let ids = this.pinned.get(sessionPath);
    if (!ids) {
      ids = new Set();
      this.pinned.set(sessionPath, ids);
    }
    ids.add(requestId);
  }
  /** 解除一个 UI 请求的 pin（应答或被 cancel 后调用）。该会话所有请求都释放才真正解除。
   *  幂等：未知 id / 已释放（如进程已退出）直接忽略（issue 23）。 */
  unpin(sessionPath: string, requestId: string): void {
    const ids = this.pinned.get(sessionPath);
    if (!ids || !ids.delete(requestId)) return;
    if (ids.size === 0) this.pinned.delete(sessionPath);
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

  /** 当前在途（spawning 或 online）进程数，用于容量判断（issue #1）。
   *  spawnEntry 会同步把新 entry 以 'spawning' 状态写入 this.entries，
   *  故并发 acquire 不同 sessionPath 时，先到者立即被计入，后到者能正确感知池已满，
   *  不会两个都越过 onlineCount() < maxPool 的检查而突破 maxPool 上限。 */
  inflightCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.status === 'spawning' || e.status === 'online') n++;
    return n;
  }

  /** 获取（或懒拉起）某会话的进程。带 -c 续接该会话历史。
   *  - 已 online → 直接返回（更新 lastActiveAt）。
   *  - 池满 → 先 LRU 淘汰最久未活跃的 idle 进程。
   *  - spawn 带 -c：resume 该 sessionPath 的历史（用户切回旧会话续接）。 */
  async acquire(
    sessionPath: string,
    cwd: string,
    approvalMode: ApprovalMode = 'yolo',
    hooks?: string[],
    opts?: PoolAcquireOptions,
  ): Promise<PoolEntry> {
    const wantIntent = Boolean(opts?.intentTracing);
    const existing = this.entries.get(sessionPath);
    if (existing && existing.status === 'online') {
      // hook 配置变更、显式 --restore / --model 重拉、或 intentTracing 开关变更时需重起进程。
      if (!hooksEqual(existing.hooks, hooks) || opts?.restore || opts?.model || existing.intentTracing !== wantIntent) {
        this.events.onLog(`[pool] respawn needed for ${sessionPath} (hooks/opts changed)`);
        this.evict(sessionPath);
      } else {
        existing.lastActiveAt = Date.now();
        return existing;
      }
    }
    const pending = this.spawning.get(sessionPath);
    if (pending) return pending;
    if (this.inflightCount() >= this.maxPool) {
      // 池已满：尝试 LRU 淘汰。若全部 online 进程都被 pin（等用户确认），
      // 无法安全淘汰——拒绝本次 acquire，保证池大小永不超过 maxPool（issue 24）。
      if (!this.evictLRU()) {
        throw new Error('进程池已满且所有会话都在等待用户确认，无法新建会话（请先关闭或回应某个会话）');
      }
    }
    // 历史会话（磁盘文件存在）→ -r / --restore resume 指定文件；
    // tempKey 防分裂兜底（2026-09-14 bet_zp 事故根因）：temp 会话曾落盘过
    // （tempSessionFiles 有记忆）→ 同样带 -r 续接，而不是全新 spawn 出第二个 .jsonl。
    // resume 判定已下移到 spawnEntry 内部用异步 stat 完成（issue 7），这里不再同步 existsSync，
    // 以保证容量检查 → spawning 注册之间不插入 await（维持 issue 1 的并发安全）。
    const knownFile = isTempKey(sessionPath) ? this.tempSessionFiles.get(sessionPath) : undefined;
    const p = this.spawnEntry(sessionPath, cwd, approvalMode, /*continueSession*/ false, knownFile, undefined, hooks, opts);
    this.spawning.set(sessionPath, p);
    try {
      return await p;
    } finally {
      if (this.spawning.get(sessionPath) === p) this.spawning.delete(sessionPath);
    }
  }

  /** 新建会话：spawn 不带 -c（开新 .jsonl），ready 后由调用方 listSessions
   *  解析真实 path 再 renameKey(tempKey, realPath)。tempKey 用临时占位。
   *  systemPrompt 非空时通过 --append-system-prompt 注入到该新会话。
   *  hooks 非空时逐个通过 --hook=<path> 注入（全局钩子）。 */
  async acquireNew(
    tempKey: string,
    cwd: string,
    approvalMode: ApprovalMode = 'yolo',
    systemPrompt?: string,
    hooks?: string[],
    opts?: PoolAcquireOptions,
  ): Promise<PoolEntry> {
    const pending = this.spawning.get(tempKey);
    if (pending) return pending;
    if (this.inflightCount() >= this.maxPool) {
      if (!this.evictLRU()) {
        throw new Error('进程池已满且所有会话都在等待用户确认，无法新建会话（请先关闭或回应某个会话）');
      }
    }
    const p = this.spawnEntry(tempKey, cwd, approvalMode, /*continueSession*/ false, undefined, systemPrompt, hooks, opts);
    this.spawning.set(tempKey, p);
    try {
      return await p;
    } finally {
      if (this.spawning.get(tempKey) === p) this.spawning.delete(tempKey);
    }
  }

  /** 新进程 ready 后，把临时 key 换成真实 sessionPath（listSessions 解析出的）。 */
  renameKey(oldKey: string, newKey: string): PoolEntry | undefined {
    if (oldKey === newKey) return this.entries.get(oldKey);
    const e = this.entries.get(oldKey);
    if (!e) return undefined;
    const clash = this.entries.get(newKey);
    if (clash && clash !== e) {
      // newKey 下已有另一个进程（如迁移前用户从侧栏又打开了同一真实会话）：直接覆盖会让它
      // 变成池外孤儿进程（killAll 杀不到、与迁移后的进程同写一个 .jsonl），先静默回收。
      // 不推 onExit：渲染层已把 newKey 的状态换成迁移过来的会话。
      this.events.onLog(`[pool] renameKey replaces existing entry for ${newKey}`);
      clash.status = 'evicted';
      this.spawnAborts.get(clash)?.(new Error(`omp spawn aborted (replaced by renameKey) for ${newKey}`));
      clash.router.rejectAll('replaced by renameKey');
      try { clash.proc.kill(); } catch { /* noop */ }
      this.pinned.delete(newKey);
      this.entries.delete(newKey);
      this.events.onReplaced?.(newKey);
    }
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
    // tempKey 落盘记忆同步迁移：renameKey 说明渲染层已确认 temp→real 映射，
    // 真实 path 本身就在磁盘上（spawnEntry 会 stat 到），tempKey 记忆已无用。
    this.tempSessionFiles.delete(oldKey);
    return e;
  }

  /** 往某会话的进程发命令并等响应。timeoutMs 可覆盖 FrameRouter 默认 5min 超时
   *  （0.5.21：看门狗对账传 3s——进程僵死时 5min pending 会随 30s 看门狗无限堆积）。 */
  async send<T = unknown>(sessionPath: string, cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse<T>> {
    const entry = this.get(sessionPath);
    if (!entry) throw new Error(`omp process not online for session: ${sessionPath}`);
    entry.lastActiveAt = Date.now();
    return entry.router.send<T>(cmd, timeoutMs);
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
    // 仍在 spawning（proc 可能尚未创建，kill 无效）：立即 reject 其 spawn Promise；
    // spawnEntry 的异步流程看到 status='evicted' 后不再拉起 / 会补杀进程。
    this.spawnAborts.get(e)?.(new Error(`omp spawn aborted (evicted) for ${sessionPath}`));
    e.router.rejectAll('evicted by pool');
    try { e.proc.kill(); } catch { /* noop */ }
    this.entries.delete(sessionPath);
    // 通知渲染层该会话已下线：proc.kill() 会摘掉子进程的 exit 监听（omp-process.ts），
    // 若不在 evict 里主动推 onExit，渲染层 procStateMap 会残留 online，之后对该会话的
    // 任意 rpc:send 都会抛 "omp process not online"（LRU 淘汰后点会话即复现）。
    // code=null：标记 offline、不弹"已退出"遮罩、也不触发自动恢复（被淘汰是预期行为）。
    this.events.onExit(sessionPath, null);
  }

  /** LRU 淘汰：找 lastActiveAt 最小的 online 进程杀掉。不淘汰 spawning 状态的，
   *  也不淘汰有未应答 UI 请求（pinned）的会话——那种会话正等用户确认，杀掉会让弹窗失效。
   *  @returns 是否成功淘汰了一个进程。若所有 online 进程都被 pin（等用户确认），返回 false。 */
  private evictLRU(): boolean {
    let victim: PoolEntry | undefined;
    for (const e of this.entries.values()) {
      if (e.status !== 'online') continue;
      if (this.pinned.has(e.sessionPath)) continue; // 有未应答 UI 请求 → 禁止淘汰
      if (!victim || e.lastActiveAt < victim.lastActiveAt) victim = e;
    }
    if (victim) {
      this.events.onLog(`[pool] LRU evict ${victim.sessionPath}`);
      this.evict(victim.sessionPath);
      return true;
    }
    return false;
  }

  /** 杀掉所有进程（app 退出时用，同步等死透）。 */
  killAll(): void {
    for (const e of this.entries.values()) {
      e.status = 'evicted';
      this.spawnAborts.get(e)?.(new Error('app quitting'));
      e.router.rejectAll('app quitting');
      try { e.proc.kill(true); } catch { /* noop */ }
    }
    this.entries.clear();
    this.spawning.clear();
    this.pinned.clear();
  }

  private spawnEntry(
    sessionPath: string,
    cwd: string,
    approvalMode: ApprovalMode,
    continueSession: boolean,
    resumeSession?: string,
    systemPrompt?: string,
    hooks?: string[],
    opts?: PoolAcquireOptions,
  ): Promise<PoolEntry> {
    return new Promise<PoolEntry>((resolve, reject) => {
      const normalizedCwd = path.normalize(cwd);
      // 用 ctx 包装让 proc 回调能引用尚未声明的 entry/router/proc（闭包运行时解析）
      const ctx: { entry?: PoolEntry; router?: FrameRouter; proc?: OmpProcess } = {};
      /** 启动期 stderr 缓冲（最多保留最近 20 行），用于检测 omp 18.6.3+ `Could not restore model <provider/id>` */
      const startupStderr: string[] = [];
      /** 当前池 key：renameKey 会更新 entry.sessionPath，而闭包不能引用 spawn 时捕获的
       *  初始 sessionPath（tempKey）——否则 rename 后帧/事件仍按旧 key 标记。 */
      const currentSessionKey = (): string => (ctx.entry ? ctx.entry.sessionPath : sessionPath);
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          // 只淘汰本次 spawn 自己的 entry：按初始 key 淘汰可能误伤同 key 后来新建的 entry。
          const own = ctx.entry;
          if (own && this.entries.get(own.sessionPath) === own) this.evict(own.sessionPath);
          reject(new Error(`omp spawn timeout (${SPAWN_TIMEOUT_MS}ms) for ${sessionPath}`));
        }
      }, SPAWN_TIMEOUT_MS);
      const router = new FrameRouter({
        // proc 在异步 I/O 之后才创建（issue 7），用 ctx.proc 间接引用。
        write: (cmd) => { if (ctx.proc) ctx.proc.write(cmd); },
        // 帧标记必须用 entry 当前的 sessionPath（renameKey temp→real 后仍指向新 key），
        // 否则渲染层把帧路由到已迁移走的旧 temp key 缓冲，消息不显示（issue: turn2 无回应）。
        pushEvent: (frame) => this.events.onFrame(currentSessionKey(), frame),
        onLog: (line) => this.events.onLog(line),
      });
      ctx.router = router;
      const entry: PoolEntry = {
        sessionPath,
        cwd: normalizedCwd,
        approvalMode,
        hooks: hooks ? [...hooks] : [],
        intentTracing: Boolean(opts?.intentTracing),
        // 占位，proc 创建后立即覆盖（entry 已同步注册，killAll 在 spawn 完成前不会用到它）。
        proc: undefined as unknown as OmpProcess,
        router,
        lastActiveAt: Date.now(),
        status: 'spawning',
      };
      ctx.entry = entry;
      /** 期间是否已被 evict/killAll（用函数读取，避免 TS 把 await 前的判断窄化延续到 await 之后）。 */
      const isEvicted = (): boolean => entry.status === 'evicted';
      this.spawnAborts.set(entry, (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
      // 同步注册 spawning entry（issue 1 并发安全：必须在任意 await 之前完成，
      // 保证并发 acquire 能通过 inflightCount 互相感知，不会同时越过容量上限）。
      this.entries.set(sessionPath, entry);
      void (async () => {
        try {
          // issue 7：cwd 校验由同步 existsSync 改为异步 stat + isDirectory。
          let st: fs.Stats;
          try {
            st = await fs.promises.stat(normalizedCwd);
          } catch {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              this.entries.delete(sessionPath);
              reject(new Error(`工作目录不存在: ${cwd}`));
            }
            return;
          }
          if (!st.isDirectory()) {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              this.entries.delete(sessionPath);
              reject(new Error(`工作目录不是目录: ${cwd}`));
            }
            return;
          }
          // issue 7：resume 判定由 acquire 里的同步 existsSync 改为此处异步 stat。
          let resolvedResume = resumeSession;
          if (!resolvedResume && sessionPath) {
            try {
              await fs.promises.stat(sessionPath);
              resolvedResume = sessionPath;
            } catch {
              resolvedResume = undefined;
            }
          }
          // 异步 stat 期间可能已被 evict/killAll：不再拉起进程，否则成为池外孤儿进程。
          if (isEvicted()) return;
          const proc = new OmpProcess(
            {
              ompPath: this.ompPath,
              cwd: normalizedCwd,
              approvalMode,
              continueSession,
              resumeSession: resolvedResume,
              restore: opts?.restore,
              model: opts?.model,
              intentTracing: opts?.intentTracing,
              systemPrompt,
              hooks,
            },
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
                this.events.onReady(currentSessionKey());
                // temp 会话：ready 后立即记下 omp 分配的真实落盘路径（spawn 时即已定，
                // 首条消息后开始流式写入）。之后进程若被杀/淘汰，acquire(tempKey)
                // 凭这条记忆带 -r 续接，不会全新 spawn 裂出第二个会话。
                if (isTempKey(sessionPath)) {
                  const key = sessionPath;
                  void ctx.router!.send({ type: 'get_state' }, 10_000).then((r) => {
                    const sf = (r.data as { sessionFile?: unknown } | undefined)?.sessionFile;
                    if (r.success && typeof sf === 'string' && sf && !isTempKey(sf)) {
                      // entry 可能已被 renameKey 迁走：只在仍是原 temp key 时记录
                      if (ctx.entry && ctx.entry.sessionPath === key) this.tempSessionFiles.set(key, sf);
                    }
                  }).catch(() => undefined);
                }
              },
              onFrame: (frame) => ctx.router?.dispatch(frame),
              onExit: (code) => {
                const key = currentSessionKey();
                // 只清理仍登记在池中的本 entry：同 key 下可能已是后来新建的 entry，不能误删 / 误报。
                const isCurrent = !!ctx.entry && this.entries.get(key) === ctx.entry;
                if (ctx.entry) ctx.entry.status = 'evicted';
                if (isCurrent) {
                  // 进程退出（无论就绪前还是之后）都必须从 entries 移除，否则会残留
                  // status='evicted' 的僵尸 entry（issue 77）。注意用 entry 当前的
                  // sessionPath（renameKey 后已更新），确保删对 key。
                  this.entries.delete(key);
                  // 进程已死，其未应答 UI 请求随之失效：整体释放 pin（与 evict 一致）。
                  // main.ts 的 unpin 只减 1，refcount>1 时会残留，同 key 重拉的新进程将永远被视为 pinned。
                  this.pinned.delete(key);
                }
                ctx.router?.rejectAll(`omp exited (code=${code})`);
                if (!settled) {
                  settled = true;
                  clearTimeout(timeout);
                  // omp 18.6.3+：历史会话保存的模型不可恢复时，-r/-c 在 rpc-ui 下直接报错退出
                  // （Could not restore model <provider/id>）。把该错误原文带回渲染层，便于弹窗选替代模型。
                  const stderrJoined = startupStderr.join('\n');
                  const restoreMatch = /Could not restore model\s+([^\s\r\n"'`]+)/i.exec(stderrJoined);
                  if (restoreMatch?.[1]) {
                    reject(new Error(`Could not restore model ${restoreMatch[1]} (code=${code})`));
                  } else {
                    reject(new Error(`omp exited before ready (code=${code}) for ${sessionPath}`));
                  }
                }
                if (isCurrent) this.events.onExit(key, code);
              },
              onStderr: (line) => {
                if (!settled) {
                  startupStderr.push(line);
                  if (startupStderr.length > 20) startupStderr.shift();
                }
                this.events.onStderr(currentSessionKey(), line);
              },
            },
          );
          ctx.proc = proc;
          entry.proc = proc;
          // issue 7：start() 已改为 async（内部 mkdir 异步），这里 await。
          await proc.start();
          // start() 内部 await 期间被 evict/killAll 时 proc.kill() 是 no-op（子进程尚未创建），这里补杀。
          if (isEvicted()) proc.kill();
        } catch (e) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.entries.delete(sessionPath);
            reject(e as Error);
          }
        }
      })();
    });
  }
}
