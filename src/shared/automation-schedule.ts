/**
 * automation-schedule.ts — 定时任务的纯函数调度计算（主进程 ticker 与渲染层显示共用）。
 *
 * 时间语义（全部本地时区）：
 *  - computeNextRunAt(schedule, base, validUntil)：返回「严格晚于 base」的下一次计划时刻。
 *    主进程传 base = task.lastRunAt（从未执行传 0）→ 返回值 ≤ now 即「到期该触发」；
 *    渲染层传 base = Date.now() → 返回值必为未来时刻，用于「X小时后执行」显示。
 *  - 每次执行通过推进 lastRunAt「扣账」：同一时刻绝不触发两次（断电重启后也不会补发多天前的）。
 */

import type { AutomationSchedule } from './ipc-channels';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 解析 'HH:MM' → { h, m }；非法返回 null。 */
function parseHM(time: string | undefined): { h: number; m: number } | null {
  const mt = /^(\d{1,2}):(\d{2})$/.exec((time ?? '').trim());
  if (!mt) return null;
  const h = Number(mt[1]);
  const m = Number(mt[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return null;
  return { h, m };
}

/** 把 Date 调到当天 HH:MM。 */
function atTime(d: Date, h: number, m: number): void {
  d.setHours(h, m, 0, 0);
}

/** 当月最后一天（1-31）。 */
function lastDayOfMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/**
 * 计算严格晚于 base 的下一次计划时刻（ms）；null = 无（单次已执行 / 永不到达 / 已过期由调用方判）。
 * 迭代上限 400 次（约可跨 13 个月的月度任务），防御无效配置导致死循环。
 */
export function computeNextRunAt(
  schedule: AutomationSchedule | undefined,
  base: number,
  validUntil?: string,
): number | null {
  if (!schedule || !schedule.kind) return null;
  const validUntilEnd = validUntil ? endOfDay(validUntil) : null;
  const hm = parseHM(schedule.time);
  if (schedule.kind !== 'once' && !hm) return null;

  // 首个候选锚点：base 有效时以 base 为锚（扣账语义：严格晚于 base，跨天/补算都确定）；
  // base 过旧（从未执行传 0 / 系统时钟异常）时以当前时间为锚——与「不补发多天前的任务」一致，
  // 错过的周期直接跳到下一个未来时刻（否则 400 次迭代上限在远古锚点下永远追不上现在）。
  const BASE_FLOOR = new Date(2020, 0, 1).getTime();
  const cursor = base >= BASE_FLOOR ? new Date(base) : new Date();
  let advance: () => void;
  switch (schedule.kind) {
    case 'once': {
      if (!schedule.at) return null;
      const at = new Date(schedule.at).getTime();
      if (!Number.isFinite(at)) return null;
      return at > base ? at : null;
    }
    case 'daily': {
      atTime(cursor, hm!.h, hm!.m);
      advance = () => { cursor.setDate(cursor.getDate() + 1); atTime(cursor, hm!.h, hm!.m); };
      break;
    }
    case 'weekly': {
      if (!Number.isInteger(schedule.weekday) || (schedule.weekday as number) < 0 || (schedule.weekday as number) > 6) return null;
      const target = schedule.weekday as number;
      cursor.setDate(cursor.getDate() + ((target - cursor.getDay() + 7) % 7));
      atTime(cursor, hm!.h, hm!.m);
      advance = () => { cursor.setDate(cursor.getDate() + 7); atTime(cursor, hm!.h, hm!.m); };
      break;
    }
    case 'monthly': {
      if (!Number.isInteger(schedule.day) || (schedule.day as number) < 1 || (schedule.day as number) > 31) return null;
      const day = Math.min(schedule.day as number, lastDayOfMonth(cursor.getFullYear(), cursor.getMonth()));
      cursor.setDate(day);
      atTime(cursor, hm!.h, hm!.m);
      advance = () => {
        const y = cursor.getFullYear();
        const m0 = cursor.getMonth() + 1;
        cursor.setMonth(m0, Math.min(schedule.day as number, lastDayOfMonth(y, m0)));
        atTime(cursor, hm!.h, hm!.m);
      };
      break;
    }
    default:
      return null;
  }
  for (let i = 0; i < 400; i++) {
    const candidate = cursor.getTime();
    if (validUntilEnd !== null && candidate > validUntilEnd) return null;
    if (candidate > base) return candidate;
    advance();
  }
  return null;
}

/** 'YYYY-MM-DD' 当天 23:59:59.999 的 ms；非法返回 null。 */
export function endOfDay(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((dateStr ?? '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 补零。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 摘要行文案：`每天 15:40` / `每周五 06:00` / `每月 1 日 08:00` / `单次 2026-09-21 20:23`。 */
export function describeSchedule(schedule: AutomationSchedule | undefined): string {
  if (!schedule) return '未设置频率';
  const hm = parseHM(schedule.time);
  const timeStr = hm ? `${pad2(hm.h)}:${pad2(hm.m)}` : (schedule.time ?? '');
  switch (schedule.kind) {
    case 'once': {
      if (!schedule.at) return '单次（未设置时间）';
      const d = new Date(schedule.at);
      return Number.isFinite(d.getTime())
        ? `单次 ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
        : '单次（时间无效）';
    }
    case 'daily':
      return timeStr ? `每天 ${timeStr}` : '每天（时间无效）';
    case 'weekly':
      return hm && Number.isInteger(schedule.weekday)
        ? `每${WEEKDAY_NAMES[schedule.weekday as number] ?? '?'} ${timeStr}`
        : '每周（时间无效）';
    case 'monthly':
      return hm && Number.isInteger(schedule.day)
        ? `每月 ${schedule.day} 日 ${timeStr}`
        : '每月（时间无效）';
    default:
      return '未设置频率';
  }
}

/** 「X小时后执行 / 已暂停 / 已过期 / 即将执行」状态文案（列表行右侧用）。 */
export function describeNextRun(task: { enabled: boolean; schedule: AutomationSchedule; validUntil?: string; lastRunAt?: number }, now: number): string {
  if (!task.enabled) return '已暂停';
  const next = computeNextRunAt(task.schedule, now, task.validUntil);
  if (next === null) return '已过期';
  const diff = next - now;
  if (diff < 60_000) return '即将执行';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)} 分钟后执行`;
  if (diff < 24 * 60 * 60_000) {
    const h = Math.floor(diff / (60 * 60_000));
    const m = Math.round((diff % (60 * 60_000)) / 60_000);
    return m > 0 ? `${h} 小时 ${m} 分后执行` : `${h} 小时后执行`;
  }
  return `${Math.round(diff / DAY_MS)} 天后执行`;
}
