/**
 * omp 进程崩溃中断的判据（2026-11-14，session 01a1d892 事故）。
 *
 * 事故形态：omp 18.3.2 在 `eval`/`browser.open()` 里 Bun tab worker 抛未捕获
 * `TypeError: No default value` → omp 写 `session_exit{reason:unhandled_rejection,kind:fatal}`
 * 后进程退出。UI 自动 `-r` resume 后，omp 补一条
 * `stopReason:'aborted'` + `errorMessage:'Previous OMP process exited before completing the turn.'`
 * 的 assistant 终止帧，turn 就此结束、**不会自动继续**。
 *
 * 这里只做纯判据，不碰 store / DOM，便于单测覆盖：
 *  - 用户主动 abort 也是 stopReason='aborted'，必须靠 errorMessage 区分，不能误报；
 *  - 很久以前崩过、之后用户已重发并正常跑完的会话不能再报警；
 *  - 因此只检查「最后一条 user 消息之后」的尾部。
 */

/** 崩溃中断标记（store 里按 sessionPath 存，运行时态，不持久化） */
export interface CrashInterruptInfo {
  /** 首次标记时间（ms epoch），用于同一次崩溃的事件去重 */
  at: number;
  /** 判据来源：进程退出 / omp 落盘的 session_exit 帧 / resume 补写的 aborted 终止帧 */
  source: 'exit' | 'session_exit' | 'aborted';
  /** 被中断那一轮的用户文本（「重发上一条」用） */
  lastUserText?: string;
  /** 退出码 / omp 记录的 reason，展示在红色提醒里 */
  detail?: string;
}

export const CRASH_INTERRUPT_TOAST = '⚠️ 上一轮因 omp 进程崩溃中断，不会自动继续，请重新发送';
export const CRASH_RECOVER_TOAST = 'omp 进程已重新连接，但被中断的那一轮不会自动继续，请重新发送';

/** omp resume 时补写的终止帧里的固定文案（实测 18.3.2 jsonl 尾部）。 */
const ABORTED_BY_CRASH = /previous omp process exited/i;

/** 单帧判据：stopReason=aborted 且 errorMessage 说明是上一进程退出 —— 用户主动 abort 不匹配。 */
export function isCrashAbortedMessage(m: { stopReason?: string; errorMessage?: string }): boolean {
  return m.stopReason === 'aborted' && ABORTED_BY_CRASH.test(m.errorMessage ?? '');
}

/** 单帧判据：omp 落盘的 `customType:'session_exit'` 且是致命退出。 */
export function isCrashSessionExit(m: { customType?: string; details?: unknown }): boolean {
  if (m.customType !== 'session_exit') return false;
  const d = m.details as { reason?: string; kind?: string } | null | undefined;
  if (!d) return false;
  return d.kind === 'fatal' || /unhandled_rejection|uncaught_exception/i.test(d.reason ?? '');
}

interface DetectMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
  customType?: string;
  details?: unknown;
}

export interface DetectedCrash {
  source: 'session_exit' | 'aborted';
  lastUserText?: string;
  detail?: string;
}

function textOf(m: { content?: Array<{ type?: string; text?: string }> }): string {
  return (m.content ?? [])
    .filter((b) => b.type === 'text' || typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim();
}

function reasonOf(details: unknown): string | undefined {
  const d = details as { reason?: string; kind?: string } | null | undefined;
  if (!d) return undefined;
  return [d.reason, d.kind].filter(Boolean).join(' / ') || undefined;
}

/**
 * 从会话历史（readSessionMessages 的返回）判断「当前是否停在一次崩溃中断上」。
 * 只看最后一条 user 消息之后的尾部：其后若已有正常完成的 assistant 回复 → 说明已续上，返回 null。
 */
export function detectCrashInterrupt(msgs: readonly DetectMessage[]): DetectedCrash | null {
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return null; // 没有用户消息，谈不上「重发上一条」

  const lastUserMsg = msgs[lastUserIdx];
  const lastUserText = (lastUserMsg ? textOf(lastUserMsg) : '') || undefined;
  let found: DetectedCrash | null = null;
  for (let i = lastUserIdx + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    // 崩溃之后又跑完了一轮 → 用户已处理过，不再提醒
    if (m.role === 'assistant' && m.stopReason === 'stop' && textOf(m)) return null;
    if (isCrashAbortedMessage(m)) {
      // resume 补写的终止帧最权威，覆盖先前的 session_exit 判据
      found = { source: 'aborted', lastUserText, detail: m.errorMessage };
    } else if (!found && isCrashSessionExit(m)) {
      found = { source: 'session_exit', lastUserText, detail: reasonOf(m.details) };
    }
  }
  return found;
}

/** 从渲染层 per-session 消息缓冲里取最后一条用户消息文本（重发按钮兜底）。 */
export function lastUserTextFromChat(
  chat: readonly { role: string; parts?: Array<{ kind: string; text?: string }> }[],
): string {
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (!m || m.role !== 'user') continue;
    return (m.parts ?? [])
      .filter((p) => p.kind === 'text')
      .map((p) => p.text ?? '')
      .join('\n')
      .trim();
  }
  return '';
}
