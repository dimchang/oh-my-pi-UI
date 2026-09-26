/**
 * diagnostics.ts — 渲染进程自证埋点（白屏/卡死取证）。
 *
 * 背景（2026-09-15 白屏事故）：现场 renderer 持续 111% 单核、6.6GB 常驻、28.7k 句柄、
 * 进入后不自愈；而同实例主进程与两个 omp 进程全 0% CPU —— 没有任何外部输入却持续输出。
 * 更麻烦的是**当时没有任何日志**（主进程未监听 renderer 崩溃/无响应，渲染侧也没有
 * ErrorBoundary / window.onerror），白屏完全静默，事后只能靠猜。本模块专门用来把现场
 * 快照落盘，并把三种形态区分开：
 *   ① renders/sec 数百、frames/sec 也在动 → 重渲染循环（React 侧状态抖动）
 *   ② renders/sec 为 0 但心跳还在 → 主线程被非 React 的忙循环/GC 占死
 *   ③ 心跳 gap 突然拉长或直接断档 → 主线程被长任务或 GC 阻塞，**断档时刻即白屏起点**
 *
 * 落盘策略：心跳只进内存环形缓冲；只有出现"可疑信号"才把缓冲回放写文件并转入持续记录，
 * 平时不产出任何日志（避免正常使用把磁盘写满）。渲染进程无 fs 权限，统一经
 * IPC.DiagLog 交主进程 append 到 userData/logs/ui-YYYY-MM-DD.log。
 *
 * 用 OMP_UI_DIAG=0 可关闭（通过 URL query 或 localStorage 均可，见 isDisabled）。
 */

/** 心跳周期（ms）。卡死时 setInterval 会被推迟，gap 字段就是"被推迟了多少"。 */
const TICK_MS = 1000;
/** 内存环形缓冲条数（300 条 ≈ 最近 5 分钟）。 */
const RING_SIZE = 300;
/** 触发落盘的阈值。任一命中即转入"持续记录"模式。 */
const LIMIT = {
  /** 单次 tick 实际间隔超过这个值 = 主线程刚才被卡住 */
  gapMs: 3000,
  /** 每秒 React 渲染次数 */
  rendersPerSec: 60,
  /** JS 堆（MB） */
  heapMB: 800,
  /** 单个长任务（ms） */
  longTaskMs: 2000,
};

interface RenderStats {
  renders: number;
  totalActualMs: number;
  maxActualMs: number;
}

const renderStats: RenderStats = { renders: 0, totalActualMs: 0, maxActualMs: 0 };

/** omp 帧处理计数（store 侧每帧自增，见 store.ts 的 pushFrameDiag）。
 *  与 renders 对照即可判断"是帧太多"还是"render 自己空转"。 */
interface OmpStat {
  frames: number;
}
export const ompStat: OmpStat = { frames: 0 };
(globalThis as { __ompStat?: OmpStat }).__ompStat = ompStat;

/** React.Profiler 的 onRender 回调：累计渲染次数与实际耗时。 */
export function reportRender(actualDuration: number): void {
  renderStats.renders++;
  renderStats.totalActualMs += actualDuration;
  if (actualDuration > renderStats.maxActualMs) renderStats.maxActualMs = actualDuration;
}

function send(lines: string[]): void {
  try {
    const api = (globalThis as { omp?: { diagLog?: (l: string[]) => void } }).omp;
    api?.diagLog?.(lines);
  } catch {
    /* 诊断自身绝不能抛：它存在的意义就是把现场留下来，不能反过来把 UI 弄崩 */
  }
}

/** 把诊断行**直接落盘**（绕过环形缓冲与"可疑信号"触发条件）。
 *  0.5.21：供 store 帧处理 catch 使用——帧抛错时立即可见化，不等别的异常触发回放
 *  （01a0cc6c 教训：applyAgentEvent 抛错会静默吞掉 agent_end 的状态复位，而内存环形
 *  缓冲在 25h 后早已滚动丢失，事后无法区分「帧未送达」与「送达但处理抛错」）。 */
export function exportDiagLines(lines: string[]): void {
  send(lines);
}

function isDisabled(): boolean {
  try {
    if (new URLSearchParams(location.search).get('diag') === '0') return true;
    return localStorage.getItem('omp.diag') === '0';
  } catch {
    return false;
  }
}

let installed = false;

/** 安装诊断埋点。幂等：重复调用只生效一次。 */
export function installDiagnostics(): void {
  if (installed) return;
  installed = true;
  // 单测/SSR 等无 window 环境直接跳过（本模块只在渲染进程有意义）
  if (typeof window === 'undefined' || typeof performance === 'undefined') return;
  if (isDisabled()) return;

  const ring: string[] = [];
  let streaming = false;
  let lastTickAt = 0;
  let lastRenders = 0;
  let lastFrames = 0;
  let seq = 0;
  let ltCount = 0;
  let ltTotalMs = 0;
  let ltMaxMs = 0;

  // ---- 长任务观测（>50ms 的任务；>LIMIT.longTaskMs 触发落盘）----
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        ltCount++;
        ltTotalMs += entry.duration;
        if (entry.duration > ltMaxMs) ltMaxMs = entry.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* 环境不支持 longtask 时静默降级 */
  }

  // ---- 未捕获错误：渲染期抛错会让 React 卸载整棵树（= 白屏），必须留痕 ----
  window.addEventListener('error', (e) => {
    const err = (e as ErrorEvent).error as Error | undefined;
    send([
      `!! window.onerror ${e.message || String(err?.message ?? '')} @${e.filename ?? ''}:${e.lineno ?? 0}:${e.colno ?? 0}`,
      ...(err?.stack ? [`   ${String(err.stack).slice(0, 3000)}`] : []),
    ]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason as { message?: string; stack?: string } | undefined;
    send([
      `!! unhandledrejection ${String(r?.message ?? (e as PromiseRejectionEvent).reason)}`,
      ...(r?.stack ? [`   ${String(r.stack).slice(0, 3000)}`] : []),
    ]);
  });

  // ---- 心跳 ----
  const tick = (): void => {
    const now = performance.now();
    const gap = lastTickAt === 0 ? 0 : now - lastTickAt;
    lastTickAt = now;
    seq++;

    const renders = renderStats.renders - lastRenders;
    lastRenders = renderStats.renders;
    const frames = ompStat.frames - lastFrames;
    lastFrames = ompStat.frames;

    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const heapMB = mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1;

    let dom = -1;
    try {
      dom = document.querySelectorAll('*').length;
    } catch {
      /* 拿不到就留 -1，不影响其它字段 */
    }

    const ltWindowCount = ltCount;
    const ltWindowTotal = Math.round(ltTotalMs);
    const ltWindowMax = Math.round(ltMaxMs);
    ltCount = 0;
    ltTotalMs = 0;
    ltMaxMs = 0;

    const line =
      `hb t=${seq} gap=${Math.round(gap)}ms renders=${renders} frames=${frames}` +
      ` renderMax=${Math.round(renderStats.maxActualMs)}ms renderAvg=${(renderStats.totalActualMs / Math.max(1, renderStats.renders)).toFixed(1)}ms` +
      ` lt=${ltWindowCount}/${ltWindowTotal}ms(ltMax=${ltWindowMax}ms) heap=${heapMB}MB dom=${dom}`;

    ring.push(line);
    if (ring.length > RING_SIZE) ring.shift();

    const hit: string[] = [];
    if (gap > LIMIT.gapMs) hit.push(`gap=${Math.round(gap)}ms>${LIMIT.gapMs}`);
    if (renders > LIMIT.rendersPerSec) hit.push(`renders=${renders}>${LIMIT.rendersPerSec}`);
    if (ltWindowMax > LIMIT.longTaskMs) hit.push(`ltMax=${ltWindowMax}ms>${LIMIT.longTaskMs}`);
    if (heapMB > LIMIT.heapMB) hit.push(`heap=${heapMB}MB>${LIMIT.heapMB}`);

    if (hit.length > 0 && !streaming) {
      // 首次命中：把之前几分钟的心跳一并回放，卡死起点才不至于被截断
      streaming = true;
      send([
        `!! 诊断触发（${hit.join(' ')}）—— 回放最近 ${ring.length} 条心跳，之后持续记录`,
        ...ring,
      ]);
    } else if (streaming) {
      send([line]);
    }
  };

  window.setInterval(tick, TICK_MS);
  send([`diag installed ua=${navigator.userAgent.slice(0, 120)}`]);
}
