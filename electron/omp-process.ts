/**
 * omp-process.ts — spawn omp.exe 子进程，逐行读 stdout，写 stdin。
 *
 * 不变式（kimi_plan §0.1-1 / §2.1）：stdin 生命周期 = 子进程生命周期。
 * 本类不对外暴露 stdin.end()，仅 kill() 时随进程释放。
 */

import { spawn, spawnSync, execSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import type { OmpFrame, RpcCommand } from '../src/shared/rpc-types';
import type { ApprovalMode } from '../src/shared/ipc-channels';

export interface OmpProcessOptions {
  ompPath: string;
  cwd: string;
  approvalMode?: ApprovalMode;
  /** true 时加 --no-session（内存会话不写盘，用于调试握手） */
  noSession?: boolean;
  /** 系统提示词：新建会话时通过 --append-system-prompt 注入（仅新建会话，不用于续接/恢复）。 */
  systemPrompt?: string;
  logDir?: string;
  /** 重启时带 -c 继续上一个会话（用于同 cwd 切权限模式，保留会话上下文） */
  continueSession?: boolean;
  /** resume 指定 path 的历史会话（-r <path>）。多进程池 acquire 历史会话时用。
   *  与 continueSession 互斥：resumeSession 优先。 */
  resumeSession?: string;
  /** 钩子文件绝对路径列表，逐个通过 --hook=<path> 注入 omp（全局钩子，每个进程都加载）。 */
  hooks?: string[];
}

export interface OmpProcessEvents {
  onReady(): void;
  onFrame(frame: OmpFrame): void;
  onExit(code: number | null): void;
  onStderr(line: string): void;
  /** 重启完成后触发（用于在 main.ts 重新通知 renderer） */
  onRestarted?(): void;
}

/** Windows 下给子进程注入 UTF-8 环境，治理中文乱码（kimi_plan §7）
 *
 * 乱码根因：omp 内部 spawn bash/powershell 执行命令时，Windows 控制台默认
 * codepage 为 CP936（GBK），而 LANG=C.UTF-8 让 shell 期望 UTF-8 输出，
 * 两边编码不一致 → 中文文件名/输出变成 ◆◆◆◆ mojibake。
 *
 * 策略：尽可能把所有涉及 I/O 编码的运行时环境变量都切到 UTF-8。
 * 注意：这只能"建议"子进程使用 UTF-8，最终效果取决于 omp 内部如何
 * spawn 子 shell 以及如何解码其 stdout。彻底修复需上游 omp 配合。
 *
 * omp 18.2.1+：上游已修复"shell/PTY 输出从 UTF-8 回退到系统 ANSI 码页"问题
 * （中文区域回退 GBK）。本注入与之可能交互：待实测 §5.2 三条命令后决定去留；
 * 实测无冲突前保留注入（17.x 乱码治理成果，勿轻易回退）。
 */
function utf8Env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // --- POSIX shell (Git Bash / MSYS2 / WSL) ---
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    // --- Python ---
    PYTHONIOENCODING: 'utf-8:replace',   // stdin/stdout/stderr 强制 UTF-8，非法字节用 U+FFFD 替代
    PYTHONUTF8: '1',                       // Python 3.7+ 全局 UTF-8 模式（含文件系统、subprocess 等）
    PYTHONLEGACYWINDOWSSTDIO: 'utf-8',     // Windows 上 Python 控制台 UTF-8 兜底
    // --- Node.js / Bun ---
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --no-deprecation`.trim(),
    // --- General ---
    NO_COLOR: '1',
  };
}

/**
 * 跨平台树杀：杀死 pid 及其全部子孙进程。
 *
 * 关键根因（2026-07-24）：`omp.exe` 只是 bun shim 壳（~4MB），真正的 agent 是它
 * 的子进程 `bun.exe`（~370MB，下面还有两级孙进程）。只 kill shim 的 PID 杀不死 bun，
 * 导致"点停止不停""关 UI 后 omp 仍后台输出""重启/自愈后双进程写同一会话"等一串 bug。
 * 必须整棵树杀。
 *  - Windows：`taskkill /PID <pid> /T /F`（/T=含子树，/F=强制）。
 *  - 其它：递归枚举子进程后 SIGKILL。
 * `sync=true` 时用 spawnSync（app 退出路径需要同步等进程真的死透）。
 */
export function killProcessTree(pid: number, sync = false): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T', '/F'];
    try {
      if (sync) spawnSync('taskkill', args, { windowsHide: true });
      else spawn('taskkill', args, { windowsHide: true });
    } catch {
      /* noop */
    }
    return;
  }
  // posix：递归杀子进程，再杀自身
  try {
    for (const child of childPids(pid)) killProcessTree(child, sync);
    process.kill(pid, 'SIGKILL');
  } catch {
    /* noop */
  }
}

/** posix 下枚举某 pid 的直接子进程 */
function childPids(pid: number): number[] {
  const pids: number[] = [];
  try {
    if (process.platform === 'linux') {
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
          const m = stat.match(/^(\d+) \(.*\) \w+ (\d+)/);
          if (m && Number(m[2]) === pid) pids.push(Number(m[1]));
        } catch { /* noop */ }
      }
    } else {
      const out = execSync(`pgrep -P ${pid}`, { encoding: 'utf8' });
      for (const l of out.trim().split(/\r?\n/)) {
        const n = Number(l.trim());
        if (n) pids.push(n);
      }
    }
  } catch {
    /* noop */
  }
  return pids;
}

export class OmpProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private readyFired = false;
  private logStream: fs.WriteStream | null = null;
  /** stderr 跨 chunk 解码器：避免多字节 UTF-8 字符被 chunk 边界截断导致乱码（issue 27）。 */
  private stderrDecoder: StringDecoder | null = null;
  /** 兜底强杀计时器（kill 时安排，1500ms 后 SIGKILL）。存引用以便复用时清理；
   *  关键：只针对当时被 kill 的那个 child 实例，且它仍未退出才强杀，避免误杀 PID 被复用后的新进程。 */
  private pendingKillTimer: NodeJS.Timeout | null = null;
  /** restart() 进行中时保存其 reject，供 handleExit 检测新 omp 在 ready 前就死了的情况，
   *  立即拒绝 restart Promise（不等 timeout），并阻止 exit 冒泡到上层（避免双重 spawn）。 */
  private restartReject: ((err: Error) => void) | null = null;
  /** restart() 进行中时保存其 resolve：新进程 ready 后一次性兑现，不修改共享的 events.onReady（issue 26）。 */
  private restartResolve: (() => void) | null = null;
  /** 自然退出时在 'exit' 记录的退出码，'close'（stdio 全关）后再交给 handleExit（§2.2 排空）。 */
  private exitCode: number | null = null;
  /** exit→close 的有界兜底计时器（孙进程继承 stdio 时 close 可能被无限拖延，P3-A）。 */
  private closeFallbackTimer: NodeJS.Timeout | null = null;
  /** stdin 高水位沿触发标记：进入记一次，drain 后重置（P2-D 防逐帧刷屏）。 */
  private stdinBackpressure = false;

  constructor(
    private opts: OmpProcessOptions,
    private events: OmpProcessEvents,
  ) {}

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  /** 当前实际子进程 PID（omp.exe shim）。供主进程记住并树杀整棵进程树。 */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** omp 子进程**实际**工作目录。spawn 时设的 cwd，跟 store 里的 currentWorkspace 没关系。
   *  渲染进程要用这个值做"是否需要 restart"的判断，不能用 store 推断（启动时序错位）。 */
  get cwd(): string {
    return this.opts.cwd;
  }

  /** 运行时更新权限模式（下次 start/restart 生效）。 */
  setApprovalMode(mode: ApprovalMode): void {
    this.opts.approvalMode = mode;
  }

  /** 切换工作目录并重启 omp 子进程。返回 Promise，在新 omp 的 onReady 后 resolve。
   *  不变式：stdin 生命周期 = 子进程生命周期，kill 旧进程后再 spawn 新进程。
   *  若新 omp 在 ready 之前意外退出，立刻 reject（不等 30s timeout）。
   *  - newApprovalMode：若与当前不同，则即使 cwd 相同也重启（用于同工作空间切权限）。
   *  - continueSession：true 时给新进程加 -c，继续上一个会话（切权限时保留上下文）。 */
  restart(newCwd: string, newApprovalMode?: ApprovalMode, continueSession?: boolean): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      const prevMode = this.opts.approvalMode;
      if (newApprovalMode) this.opts.approvalMode = newApprovalMode;
      if (continueSession !== undefined) this.opts.continueSession = continueSession;
      // 用「改之前的旧值」判断模式是否变化，避免外部提前 setApprovalMode 导致误判无变化。
      const modeChanged = newApprovalMode !== undefined && newApprovalMode !== prevMode;
      if (path.normalize(newCwd) === path.normalize(this.opts.cwd) && this.isRunning && !modeChanged) {
        // 同 cwd、同权限模式、且已在跑，无需重启
        resolve();
        return;
      }
      let settled = false;
      // 防御：若新 omp 始终不 ready（慢 / 卡死），30s 后 reject。
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.restartResolve = null;
        this.restartReject = null;
        reject(new Error('omp restart timeout'));
      }, 30000);
      // 用一次性 Promise 兑现（不修改共享的 this.events.onReady，避免竞态，issue 26）：
      //   - 新进程 ready → handleReady 内检测到 restartResolve 则兑现；
      //   - 新进程在 ready 前死 → handleExit 内 restartReject 立即拒绝。
      this.restartResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.restartReject = null;
        this.events.onRestarted?.();
        resolve();
      };
      this.restartReject = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.restartResolve = null;
        reject(err);
      };

      this.opts.cwd = newCwd;
      try {
        this.kill();
      } catch (e) {
        this.restartResolve = null;
        this.restartReject = null;
        return reject(e);
      }
      try {
        await this.start();
      } catch (e) {
        this.restartResolve = null;
        this.restartReject = null;
        return reject(e);
      }
    });
  }

  async start(): Promise<void> {
    if (this.child) return;

    // omp 18.2.1+：--resume/--continue 与 --no-session 组合会直接报错
    // （"--resume requires session persistence"），不再静默降级。启动前显式失败，
    // 避免表现为"进程秒退"的黑盒（§4.1）。
    if (this.opts.noSession && (this.opts.resumeSession || this.opts.continueSession)) {
      throw new Error('--no-session 不能与 -r/-c 组合（omp 18.2.1+ 直接报错）');
    }

    const args = ['--mode', 'rpc-ui', '--approval-mode', this.opts.approvalMode ?? 'write'];
    if (this.opts.noSession) args.push('--no-session');
    if (this.opts.resumeSession) args.push('-r', this.opts.resumeSession);
    else if (this.opts.continueSession) args.push('-c');
    // 系统提示词：仅新建会话（acquireNew，不带 -r/-c）时注入。续接/恢复的历史会话不重复注入。
    if (this.opts.systemPrompt && this.opts.systemPrompt.trim()) {
      args.push('--append-system-prompt', this.opts.systemPrompt.trim());
    }
    // 钩子：全局加载，每个 omp 进程都注入（--hook 可重复多次）
    if (this.opts.hooks && this.opts.hooks.length) {
      for (const h of this.opts.hooks) args.push('--hook', h);
    }

    // 日志（按日轮转 + 旧文件清理，issue 82）
    try {
      const dir = this.opts.logDir ?? path.join(process.cwd(), '.temp');
      // issue 7：mkdir 改用异步，避免热路径 IPC 调用中同步阻塞主进程事件循环。
      await fs.promises.mkdir(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      this.logStream = fs.createWriteStream(path.join(dir, `omp-stderr-${day}.log`), { flags: 'a' });
      // issue #2: WriteStream 未挂 error 监听，磁盘满/权限不足/路径无效时会抛 'error' 事件，
      // 未处理即以 uncaughtException 崩溃主进程。挂上监听，best-effort 记录并置空，
      // 使后续 this.logStream?.write 变为 no-op，不影响 omp 进程运行。
      this.logStream.on('error', (err) => {
        this.events.onStderr(`[log-stream-error] ${err.message}`);
        this.logStream = null;
      });
      // 删除超过保留期的旧 stderr 日志，避免无限增长（best-effort，异步不阻塞 spawn）。
      void OmpProcess.pruneOldStderrLogs(dir);
    } catch {
      this.logStream = null;
    }

    this.readyFired = false;
    this.child = spawn(this.opts.ompPath, args, {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: utf8Env(),
      windowsVerbatimArguments: false,
    });

    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let frame: OmpFrame;
      try {
        frame = JSON.parse(trimmed) as OmpFrame;
      } catch (err) {
        this.events.onStderr(`[parse-error] ${trimmed.slice(0, 200)} :: ${String(err)}`);
        return;
      }
      if (!this.readyFired && (frame as { type?: string }).type === 'ready') {
        this.readyFired = true;
        this.events.onReady();
      }
      this.events.onFrame(frame);
    });

    // 用 StringDecoder 增量解码：多字节 UTF-8 字符跨 chunk 边界时不会产生乱码（issue 27）
    this.stderrDecoder = new StringDecoder('utf8');
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = this.stderrDecoder!.write(chunk);
      if (!text) return;
      this.logStream?.write(`[${new Date().toISOString()}] ${text}`);
      text.split(/\r?\n/).forEach((ln) => ln && this.events.onStderr(ln));
    });

    this.child.on('error', (err) => {
      this.events.onStderr(`[spawn-error] ${err.message}`);
    });

    // stdin 管道断裂（EPIPE 等）时若无 error 监听会以 unhandled 'error' 事件 crash 主进程（issue 25）
    this.child.stdin.on('error', (err) => {
      this.events.onStderr(`[stdin-error] ${err.message}`);
    });

    // stdin 排空恢复 → 重置高水位沿触发标记（P2-D）
    this.child.stdin.on('drain', () => {
      this.stdinBackpressure = false;
    });

    // omp 18.2.1+：RPC 输出对慢消费者溢出到临时磁盘，并在**退出前排空最终响应**。
    // 'exit' 只代表进程终止，stdio 管道里可能还有最后一帧（写盘失败的终态 notice、
    // prompt_result 等）；收尾统一延迟到 'close'（stdio 全部关闭、readline 读完），
    // 保证最后一帧不丢（§2.2）。kill() 路径仍立即回收（排空无意义），见 kill()。
    // 防御：重置上一进程可能残留的退出码，避免误报。
    this.exitCode = null;
    this.child.on('exit', this.handleProcessExit);
    this.child.on('close', this.handleProcessClose);
  }

  /** 'exit' 仅记录退出码；真正收尾等 'close'（§2.2 排空）。类属性以便 kill() 按引用摘除。
   *  兜底（审查 P3-A）：Node 保证 close 在 exit 后到达，但若孙进程继承了 stdio 管道，
   *  close 理论上可能被无限拖延 → onExit/cleanup 永不执行。1s 内 close 未到则强制收尾
   *  （探针实测 0ms，此为防御性的有界兜底）。 */
  private handleProcessExit = (code: number | null): void => {
    this.exitCode = code;
    if (this.closeFallbackTimer) clearTimeout(this.closeFallbackTimer);
    this.closeFallbackTimer = setTimeout(() => {
      this.closeFallbackTimer = null;
      this.handleExit(this.exitCode ?? code);
    }, 1000);
  };

  private handleProcessClose = (code: number | null): void => {
    if (this.closeFallbackTimer) { clearTimeout(this.closeFallbackTimer); this.closeFallbackTimer = null; }
    this.handleExit(this.exitCode ?? code);
  };

  private handleExit = (code: number | null): void => {
    // restart() 进行中，新 omp 在 ready 之前就死了 → 立即拒绝 restart Promise
    // （不冒泡到 events.onExit，避免主进程当做"意外退出"再 spawn 一个）。
    if (this.restartReject) {
      const rj = this.restartReject;
      this.restartReject = null;
      this.cleanup();
      rj(new Error(`omp exited during restart (code=${code})`));
      return;
    }
    // §5.1：非 0 退出且 omp 18.2.1 前的机器常见"找不到 bash.exe 秒退"。给一条
    // 可操作提示，避免渲染层陷入自愈循环却无从排查。
    // 包 try/catch（审查 P1）：提示绝不阻断后面的 onExit/cleanup——那两句若不执行，
    // 会话不会被标记离线、自愈不启动、child/readline/日志流全泄漏。
    if (code !== 0 && code !== null) {
      try {
        this.events.onStderr(`[omp-exit] 退出码 ${code}：若秒退请检查 omp 环境（如 \`omp --version\` 是否可用、Git/ bash 是否安装）`);
      } catch { /* stderr 出口异常不阻断收尾 */ }
    }
    this.events.onExit(code);
    this.cleanup();
  };

  /** 写一帧命令到 stdin（自动补换行）。不暴露 end()。
   *  §2.2：与 omp 18.2.1 的"慢读者溢出磁盘"互补，这里治理"写得快"——
   *  stdin 高水位时记录（沿触发：进入记一次、drain 恢复后重置），避免逐帧刷屏。 */
  write(cmd: RpcCommand): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('omp process not running');
    }
    // 带错误回调：写入失败（管道断裂）时记入 stderr 日志而非抛出 unhandled 'error'（issue 25）
    const ok = this.child.stdin.write(JSON.stringify(cmd) + '\n', (err) => {
      if (err) this.events.onStderr(`[stdin-write-error] ${err.message}`);
    });
    if (!ok && !this.stdinBackpressure) {
      this.stdinBackpressure = true;
      this.events.onStderr('[stdin-backpressure] stdin 进入高水位，帧已入内部缓冲排队（恢复时不再逐条提示）');
    }
  }

  kill(sync = false): void {
    const victim = this.child;
    // 清理上一次可能残留的强杀计时器
    if (this.pendingKillTimer) {
      clearTimeout(this.pendingKillTimer);
      this.pendingKillTimer = null;
    }
    if (victim && victim.pid) {
      // 换掉旧进程的 exit/close handler：旧进程退出是预期内的，仅 clean，不触发 onExit。
      // 用 handler 替换而非共享标记，避免「旧进程退出标记被新进程误读」的竞态。
      victim.removeListener('exit', this.handleProcessExit);
      victim.removeListener('close', this.handleProcessClose);
      // 旧进程退出：kill() 已 cleanup()；此后新进程可能已 start()，
      // 这里不能调 cleanup()（否则会 null 掉新进程的 child/rl）。
      victim.on('exit', () => { /* 旧进程：所有资源已在 kill().cleanup() 释放 */ });
      victim.on('close', () => { /* 旧进程：同上 */ });
      // 树杀整棵进程（Windows 下 omp.exe 是 bun shim，真 agent 是子进程 bun.exe）。
      // sync=true 用于 app 退出路径（需同步等进程真死透，异步计时器等不到）。
      killProcessTree(victim.pid, sync);
    }
    this.cleanup();
  }

  private cleanup(): void {
    // 兜底计时器随收尾一并清理（kill 路径尤其重要：旧进程的定时器不能触发到新进程上）
    if (this.closeFallbackTimer) {
      clearTimeout(this.closeFallbackTimer);
      this.closeFallbackTimer = null;
    }
    this.stdinBackpressure = false;
    // issue 9：先 flush stderrDecoder，把增量解码器里残留的未完整多字节序列吐出，
    // 避免进程被杀时丢失最后几字节解码输出。
    if (this.stderrDecoder) {
      const tail = this.stderrDecoder.write(Buffer.alloc(0));
      if (tail) {
        this.logStream?.write(`[${new Date().toISOString()}] ${tail}`);
        this.events.onStderr(tail);
      }
    }
    this.rl?.close();
    this.rl = null;
    // issue 9：显式销毁 stdout/stderr 流，释放文件描述符，避免依赖 GC 回收（不可靠）。
    try { this.child?.stdout?.destroy(); } catch { /* noop */ }
    try { this.child?.stderr?.destroy(); } catch { /* noop */ }
    this.child = null;
    this.logStream?.end();
    this.logStream = null;
  }

  /** stderr 日志保留天数（issue 82）：按日轮转文件名 omp-stderr-YYYY-MM-DD.log，
   *  超过此天数的旧文件在下次 spawn 时删除，防止 .temp 无限增长。 */
  private static readonly LOG_RETENTION_DAYS = 7;

  /** 删除超过保留期的 omp-stderr-YYYY-MM-DD.log 旧日志（issue 82）。
   *  用文件名里的日期判断年龄（不依赖 mtime，重命名/复制也稳）；best-effort：
   *  任何 I/O 失败都吞掉，绝不影响进程启动。 */
  private static async pruneOldStderrLogs(dir: string): Promise<void> {
    try {
      const cutoff = Date.now() - OmpProcess.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const files = await fs.promises.readdir(dir);
      for (const name of files) {
        const m = /^omp-stderr-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
        if (!m) continue;
        const t = Date.parse(`${m[1]}T00:00:00Z`);
        if (Number.isNaN(t) || t >= cutoff) continue;
        try {
          await fs.promises.unlink(path.join(dir, name));
        } catch {
          /* 单个文件删除失败（占用/权限）忽略，不影响其它文件与启动 */
        }
      }
    } catch {
      /* 目录不存在/读取失败等，忽略 */
    }
  }
}
