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
  /** 兜底强杀计时器（kill 时安排，1500ms 后 SIGKILL）。存引用以便复用时清理；
   *  关键：只针对当时被 kill 的那个 child 实例，且它仍未退出才强杀，避免误杀 PID 被复用后的新进程。 */
  private pendingKillTimer: NodeJS.Timeout | null = null;
  /** restart() 进行中时保存其 reject，供 handleExit 检测新 omp 在 ready 前就死了的情况，
   *  立即拒绝 restart Promise（不等 timeout），并阻止 exit 冒泡到上层（避免双重 spawn）。 */
  private restartReject: ((err: Error) => void) | null = null;

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
    return new Promise<void>((resolve, reject) => {
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
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.restartReject = null;
        clearTimeout(timeout);
        fn();
      };
      // 防御：若新 omp 始终不 ready（慢 / 卡死），30s 后 reject。
      const timeout = setTimeout(() => done(() => reject(new Error('omp restart timeout'))), 30000);
      // 新 omp 在 ready 前死了 → handleExit 用此回调立即拒绝
      this.restartReject = (err) => done(() => reject(err));

      this.opts.cwd = newCwd;
      const prevOnReady = this.events.onReady;
      // 用一次性包装 onReady：拿到 ready 后恢复原 handler 并 resolve
      this.events.onReady = () => {
        this.events.onReady = prevOnReady;
        prevOnReady();
        this.events.onRestarted?.();
        done(resolve);
      };
      try {
        this.kill();
      } catch (e) {
        this.events.onReady = prevOnReady;
        done(() => reject(e));
        return;
      }
      try {
        this.start();
      } catch (e) {
        this.events.onReady = prevOnReady;
        done(() => reject(e));
      }
    });
  }

  start(): void {
    if (this.child) return;

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

    // 日志
    try {
      const dir = this.opts.logDir ?? path.join(process.cwd(), '.temp');
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      this.logStream = fs.createWriteStream(path.join(dir, `omp-stderr-${day}.log`), { flags: 'a' });
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

    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.logStream?.write(`[${new Date().toISOString()}] ${text}`);
      text.split(/\r?\n/).forEach((ln) => ln && this.events.onStderr(ln));
    });

    this.child.on('error', (err) => {
      this.events.onStderr(`[spawn-error] ${err.message}`);
    });

    this.child.on('exit', this.handleExit);
  }

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
    this.events.onExit(code);
    this.cleanup();
  };

  /** 写一帧命令到 stdin（自动补换行）。不暴露 end()。 */
  write(cmd: RpcCommand): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('omp process not running');
    }
    this.child.stdin.write(JSON.stringify(cmd) + '\n');
  }

  kill(sync = false): void {
    const victim = this.child;
    // 清理上一次可能残留的强杀计时器
    if (this.pendingKillTimer) {
      clearTimeout(this.pendingKillTimer);
      this.pendingKillTimer = null;
    }
    if (victim && victim.pid) {
      // 换掉旧进程的 exit handler：旧进程退出是预期内的，仅 clean，不触发 onExit。
      // 用 handler 替换而非共享标记，避免「旧进程退出标记被新进程误读」的竞态。
      victim.removeListener('exit', this.handleExit);
      // 旧进程退出：kill() 已 cleanup()；此后新进程可能已 start()，
      // 这里不能调 cleanup()（否则会 null 掉新进程的 child/rl）。
      victim.on('exit', () => { /* 旧进程：所有资源已在 kill().cleanup() 释放 */ });
      // 树杀整棵进程（Windows 下 omp.exe 是 bun shim，真 agent 是子进程 bun.exe）。
      // sync=true 用于 app 退出路径（需同步等进程真死透，异步计时器等不到）。
      killProcessTree(victim.pid, sync);
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.rl?.close();
    this.rl = null;
    this.child = null;
    this.logStream?.end();
    this.logStream = null;
  }
}
