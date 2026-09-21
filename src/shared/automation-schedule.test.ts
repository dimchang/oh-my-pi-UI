import { describe, it, expect } from 'vitest';
import { computeNextRunAt, describeSchedule, describeNextRun, endOfDay } from './automation-schedule';
import type { AutomationSchedule } from './ipc-channels';

/** 本地时区便捷构造：2026-09-21 10:00:00.000 之类。 */
const L = (y: number, m1: number, d: number, h = 0, mi = 0, s = 0): number =>
  new Date(y, m1 - 1, d, h, mi, s, 0).getTime();

describe('computeNextRunAt / once', () => {
  it('未来时刻原样返回；已过期（base 之后没有）返回 null', () => {
    const s: AutomationSchedule = { kind: 'once', at: '2026-09-21T20:23' };
    expect(computeNextRunAt(s, L(2026, 9, 21, 10))).toBe(L(2026, 9, 21, 20, 23));
    expect(computeNextRunAt(s, L(2026, 9, 21, 21))).toBeNull();
    // 执行过（lastRunAt ≥ at）不再触发
    expect(computeNextRunAt(s, 0, undefined)).toBe(L(2026, 9, 21, 20, 23));
    expect(computeNextRunAt(s, L(2026, 9, 21, 20, 23))).toBeNull();
  });
});

describe('computeNextRunAt / daily', () => {
  const s: AutomationSchedule = { kind: 'daily', time: '15:40' };
  it('今天的时刻未过 → 今天；已过 → 明天', () => {
    expect(computeNextRunAt(s, L(2026, 9, 21, 10))).toBe(L(2026, 9, 21, 15, 40));
    expect(computeNextRunAt(s, L(2026, 9, 21, 16))).toBe(L(2026, 9, 22, 15, 40));
  });
  it('以 lastRunAt 为 base 扣账：刚执行过 → 明天同一时刻，绝不重复', () => {
    const fired = L(2026, 9, 21, 15, 40, 5); // 20:23:05 触发
    expect(computeNextRunAt(s, fired)).toBe(L(2026, 9, 22, 15, 40));
  });
});

describe('computeNextRunAt / weekly', () => {
  // 2026-09-21 是周一
  const s: AutomationSchedule = { kind: 'weekly', weekday: 5, time: '09:00' };
  it('本周五未过 → 本周五；已过 → 下周五', () => {
    expect(computeNextRunAt(s, L(2026, 9, 21, 8))).toBe(L(2026, 9, 25, 9));
    expect(computeNextRunAt(s, L(2026, 9, 25, 10))).toBe(L(2026, 10, 2, 9));
  });
  it('当天即是目标日：时刻未过 → 今天；时刻已过 → 下周', () => {
    expect(computeNextRunAt(s, L(2026, 9, 25, 8))).toBe(L(2026, 9, 25, 9));
    expect(computeNextRunAt(s, L(2026, 9, 25, 9))).toBe(L(2026, 10, 2, 9));
  });
});

describe('computeNextRunAt / monthly', () => {
  const s: AutomationSchedule = { kind: 'monthly', day: 1, time: '06:00' };
  it('本月 1 日未过 → 本月；已过 → 下月 1 日', () => {
    expect(computeNextRunAt(s, L(2026, 9, 1, 5))).toBe(L(2026, 9, 1, 6));
    expect(computeNextRunAt(s, L(2026, 9, 15))).toBe(L(2026, 10, 1, 6));
  });
  it('31 日配置在 9 月 → 取 9 月 30 日（月末截断）', () => {
    const s31: AutomationSchedule = { kind: 'monthly', day: 31, time: '08:00' };
    expect(computeNextRunAt(s31, L(2026, 9, 1))).toBe(L(2026, 9, 30, 8));
    // 9 月 30 日已过 → 10 月 31 日
    expect(computeNextRunAt(s31, L(2026, 9, 30, 9))).toBe(L(2026, 10, 31, 8));
  });
});

describe('computeNextRunAt / 有效期', () => {
  it('候选时刻晚于 validUntil 当天末尾 → null', () => {
    const s: AutomationSchedule = { kind: 'daily', time: '15:40' };
    expect(computeNextRunAt(s, L(2026, 9, 21, 10), '2026-09-20')).toBeNull();
    expect(computeNextRunAt(s, L(2026, 9, 21, 10), '2026-09-21')).toBe(L(2026, 9, 21, 15, 40));
    expect(computeNextRunAt(s, L(2026, 9, 21, 16), '2026-09-21')).toBeNull();
  });
  it('endOfDay 边界：validUntil 当天 23:59:59.999 仍有效', () => {
    expect(endOfDay('2026-09-21')).toBe(L(2026, 9, 21, 23, 59, 59) + 999);
  });
});

describe('describeSchedule / describeNextRun', () => {
  it('各频率文案', () => {
    expect(describeSchedule({ kind: 'once', at: '2026-09-21T20:23' })).toBe('单次 2026-09-21 20:23');
    expect(describeSchedule({ kind: 'daily', time: '15:40' })).toBe('每天 15:40');
    expect(describeSchedule({ kind: 'weekly', weekday: 5, time: '06:00' })).toBe('每周五 06:00');
    expect(describeSchedule({ kind: 'monthly', day: 1, time: '08:00' })).toBe('每月 1 日 08:00');
    expect(describeSchedule(undefined)).toBe('未设置频率');
  });
  it('状态文案：已暂停 / 已过期 / 即将 / 分钟 / 小时 / 天', () => {
    const now = L(2026, 9, 21, 20, 0);
    expect(describeNextRun({ enabled: false, schedule: { kind: 'daily', time: '06:00' } }, now)).toBe('已暂停');
    expect(describeNextRun({ enabled: true, schedule: { kind: 'once', at: '2026-09-20T06:00' } }, now)).toBe('已过期');
    expect(describeNextRun({ enabled: true, schedule: { kind: 'daily', time: '20:23' } }, now)).toBe('23 分钟后执行');
    expect(describeNextRun({ enabled: true, schedule: { kind: 'daily', time: '20:20' } }, now)).toBe('20 分钟后执行');
    // 30 秒后执行 → 即将执行
    expect(describeNextRun({ enabled: true, schedule: { kind: 'once', at: '2026-09-21T20:59:45' } }, L(2026, 9, 21, 20, 59, 30))).toBe('即将执行');
    expect(describeNextRun({ enabled: true, schedule: { kind: 'daily', time: '06:30' } }, now)).toBe('10 小时 30 分后执行');
    expect(describeNextRun({ enabled: true, schedule: { kind: 'monthly', day: 1, time: '06:00' } }, now)).toBe('9 天后执行');
  });
});
