import { describe, it, expect } from 'vitest';
import type { ChatMessage, MessagePart } from '../store';
import {
  groupTurns,
  stabilizeTurns,
  splitTurnParts,
  computeTurnStats,
  formatTurnSummary,
  formatTokens,
  formatClock,
  formatElapsed,
} from './turn-view';

/** 便捷构造：assistant 消息，parts 由简写生成。't'=thinking, 'n'=narration 过程说明, 'x'=工具卡, 'r'=最终回答 */
function asst(parts: string, usage?: ChatMessage['usage']): ChatMessage {
  const built: MessagePart[] = parts.split('').map((c) => {
    if (c === 't') return { kind: 'thinking', text: 'think' };
    if (c === 'x') return { kind: 'tool', toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`, toolName: 'read', status: 'done' } as MessagePart;
    if (c === 'n') return { kind: 'text', text: 'narration', narration: true };
    return { kind: 'text', text: 'final answer' };
  });
  return { id: `a${Math.random().toString(36).slice(2, 9)}`, role: 'assistant', parts: built, usage };
}

function user(text = 'hi'): ChatMessage {
  return { id: `u${Math.random().toString(36).slice(2, 9)}`, role: 'user', parts: [{ kind: 'text', text }] };
}

describe('groupTurns', () => {
  it('回合 = 用户消息 + 其后连续 assistant 消息（真实会话里一次 run 会有成百条）', () => {
    const msgs = [user('问题A'), asst('tx'), asst('x'), asst('r'), user('问题B'), asst('tr')];
    const turns = groupTurns(msgs);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.user!.parts[0]).toMatchObject({ text: '问题A' });
    expect(turns[0]!.asst).toHaveLength(3);
    expect(turns[1]!.user!.parts[0]).toMatchObject({ text: '问题B' });
    expect(turns[1]!.asst).toHaveLength(1);
  });

  it('回归（2026-09-13「看不到回复」）：有用户的回合必须同时带 assistant 消息', () => {
    // 曾经渲染层写成 `t.user ? 只渲用户 : 只渲 assistant`，导致所有回复被吞掉。
    // 这里守护「分组结果」这一层契约：带了用户的回合，asst 不能是空的被丢弃状态。
    const msgs = [user('1'), asst('r'), user('2'), asst('tt'), asst('tx'), asst('r')];
    const turns = groupTurns(msgs);
    const withUser = turns.filter((t) => t.user);
    expect(withUser).toHaveLength(2);
    expect(withUser.map((t) => t.asst.length)).toEqual([1, 3]);
    // 渲染层两个分支都要产出：用户消息 + assistant 回合
    const rendered = turns.flatMap((t) => [
      ...(t.user ? ['user'] : []),
      ...(t.asst.length > 0 ? ['asst'] : []),
    ]);
    expect(rendered).toEqual(['user', 'asst', 'user', 'asst']);
  });

  it('窗口从回合中间起头（前面被裁掉）→ 无用户的孤立回合，不崩', () => {
    const turns = groupTurns([asst('tx'), asst('r')]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.user).toBeUndefined();
    expect(turns[0]!.asst).toHaveLength(2);
  });
});

describe('stabilizeTurns（2026-09-27 流式卡死修复）', () => {
  it('流式更新（仅流式回合内消息被替换）→ 未变化回合复用旧对象，流式回合换新', () => {
    const u1 = user('q1');
    const a1 = asst('r');
    const prev = stabilizeTurns([], groupTurns([u1, a1]));
    const u2 = user('q2');
    const a2 = asst('t');
    const mid = stabilizeTurns(prev, groupTurns([u1, a1, u2, a2]));
    expect(mid[0]).toBe(prev[0]); // 回合1 未变化 → 复用（memo 生效的前提是同一引用）
    // 模拟 message_update：只替换流式消息的引用（store 里 buf[i] = {...m, ...}）
    const a2b = { ...a2, parts: [...a2.parts] };
    const next = stabilizeTurns(mid, groupTurns([u1, a1, u2, a2b]));
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(mid[0]);     // 未变化回合复用
    expect(next[1]).not.toBe(mid[1]); // 流式回合换新身份
  });

  it('新回合追加（新用户消息）→ 旧回合引用保持，新回合是新对象', () => {
    const u1 = user('q1');
    const a1 = asst('r');
    const prev = stabilizeTurns([], groupTurns([u1, a1]));
    const u2 = user('q2');
    const next = stabilizeTurns(prev, groupTurns([u1, a1, u2]));
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).not.toBe(prev[0]);
    expect(next[1]!.user).toBe(u2);
  });

  it('会话整体切换（引用全变）→ 全部重建，不误复用', () => {
    const prev = stabilizeTurns([], groupTurns([user('a'), asst('r')]));
    const next = stabilizeTurns(prev, groupTurns([user('b'), asst('r')]));
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(prev[0]);
    expect(next[0]!.user!.id).not.toBe(prev[0]!.user!.id);
  });

  it('回合内新增 assistant 消息（agent 步进）→ 该回合换新，其余复用', () => {
    const u = user('q');
    const m1 = asst('t');
    const prev = stabilizeTurns([], groupTurns([u, m1]));
    const m2 = asst('x');
    const next = stabilizeTurns(prev, groupTurns([u, m1, m2]));
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(prev[0]);
    expect(next[0]!.asst).toHaveLength(2);
  });
});

describe('splitTurnParts', () => {
  it('全部中间过程（思考 / 工具卡 / 过程说明）进折叠块，最终回答留在折叠块外', () => {
    const msgs = [asst('tx'), asst('xx'), asst('ntx'), asst('r')];
    const { folded, reply } = splitTurnParts(msgs, false);
    expect(folded.map((p) => p.kind)).toEqual(['thinking', 'tool', 'tool', 'tool', 'text', 'thinking', 'tool']);
    // 折叠块里唯一的文本是 narration（过程说明）
    expect(folded.filter((p) => p.kind === 'text')).toHaveLength(1);
    expect(reply.map((p) => p.text)).toEqual(['final answer']);
    // 折叠块 + 最终回答 = 全部 parts（不丢不重）
    expect(folded.length + reply.length).toBe(msgs.flatMap((m) => m.parts).length);
  });

  it('一个 483 条消息的真实形状回合 → 只有一个折叠块，且最终回复可见', () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 480; i++) msgs.push(asst(i % 3 === 0 ? 'tx' : 'xx'));
    msgs.push(asst('t'));
    msgs.push(asst('r')); // 最终回答
    const { folded, reply } = splitTurnParts(msgs, false);
    expect(reply).toHaveLength(1);
    expect(reply[0]).toMatchObject({ text: 'final answer' });
    // 全部中间过程收进**同一条**折叠块（961 个条目：480×2 + 1），正文外只留最终回答
    expect(folded.length).toBe(961);
    expect(computeTurnStats(msgs).steps).toBe(482); // 回合步数 = 模型响应数
  });

  it('回合结束但模型最后一条是「叙述 + 工具调用」（被打断）→ 提升最后一条文本为可见回复', () => {
    const msgs = [asst('tx'), asst('xx'), asst('nx')]; // 没有纯文本回答
    const { reply } = splitTurnParts(msgs, false);
    expect(reply.map((p) => p.text)).toEqual(['narration']);
  });

  it('流式期间不做提升（避免把中途过程说明当成最终回答挂在正文里）', () => {
    const msgs = [asst('tx'), { ...asst('nx'), streaming: true }];
    const { reply } = splitTurnParts(msgs, true);
    expect(reply).toHaveLength(0);
  });

  it('无中间过程（简单问答）→ 折叠块为空，不渲染折叠条', () => {
    const { folded, reply } = splitTurnParts([asst('r')], false);
    expect(folded).toHaveLength(0);
    expect(reply).toHaveLength(1);
  });
});

describe('computeTurnStats / formatTurnSummary', () => {
  // 真实会话实测（483 条消息的回合）：逐条累加 totalTokens 得 23,391,974（上下文重复计数，无意义）；
  // output=731,059 / reasoning=621,765 才是可累加的生成量。
  const msgs = [
    asst('tx', { totalTokens: 21_391, outputTokens: 155, reasoningTokens: 37, duration: 1800 }),
    asst('xx', { totalTokens: 22_935, outputTokens: 151, reasoningTokens: 10, duration: 1959 }),
    asst('r', { totalTokens: 26_266, outputTokens: 271, reasoningTokens: 98, duration: 2108 }),
  ];

  it('tokens 用可累加的生成量，绝不累加 totalTokens（上下文量）', () => {
    const s = computeTurnStats(msgs);
    expect(s.outputTokens).toBe(577);
    expect(s.thinkingTokens).toBe(145);
    expect(s.durationMs).toBe(5867);
    expect(s.steps).toBe(3);
    // 累加 totalTokens 会得到 70,592 —— 必须不出现在任何统计里
    expect(Object.values(s)).not.toContain(70_592);
  });

  it('摘要一行：步数 · 思考 tokens · 生成 tokens · 耗时', () => {
    expect(formatTurnSummary(computeTurnStats(msgs))).toBe(
      '思考过程 · 3 步 · 思考 145 tokens · 生成 577 tokens · 5.9s',
    );
  });

  it('非推理模型（无 thinkingTokens）省略该段', () => {
    const s = computeTurnStats([asst('r', { totalTokens: 100, outputTokens: 12, duration: 900 })]);
    expect(formatTurnSummary(s)).toBe('思考过程 · 1 步 · 生成 12 tokens · 0.9s');
  });
});

describe('回合时间线（开始 → 结束 · 总用时）', () => {
  // omp JSONL 实测（2026-09-21 probe）：assistant 消息带 timestamp（epoch ms，请求开始）
  // 与 duration（ms）→ 结束 = timestamp + duration。相邻请求的 timestamp 紧跟上一条结束。
  const t0 = new Date(2026, 8, 21, 19, 30, 12).getTime();
  const msgs = [
    asst('tx', { outputTokens: 155, reasoningTokens: 37, duration: 1800 }),
    asst('xx', { outputTokens: 151, reasoningTokens: 10, duration: 1959 }),
    asst('r', { outputTokens: 271, reasoningTokens: 98, duration: 2108 }),
  ];
  msgs[0]!.timestamp = t0;
  msgs[1]!.timestamp = t0 + 1900; // 中间含工具执行间隔
  msgs[2]!.timestamp = t0 + 4000;

  it('startAt = 最早的 assistant timestamp；endAt = 最晚的 timestamp + duration（含工具执行墙钟时间）', () => {
    const s = computeTurnStats(msgs);
    expect(s.startAt).toBe(t0);
    expect(s.endAt).toBe(t0 + 4000 + 2108);
    // durationMs 仍是不含工具时间的模型请求耗时之和（既有契约不回退）
    expect(s.durationMs).toBe(5867);
  });

  it('摘要行追加「开始 → 结束 · 总用时」段', () => {
    const text = formatTurnSummary(computeTurnStats(msgs));
    expect(text).toBe(
      `思考过程 · 3 步 · 思考 145 tokens · 生成 577 tokens · 5.9s · ${formatClock(t0)} → ${formatClock(t0 + 6108)} · 总用时 6.1s`,
    );
  });

  it('消息无 timestamp（旧会话/未知来源）→ 时间线段整体省略，不崩', () => {
    const text = formatTurnSummary(computeTurnStats([asst('r', { duration: 900 })]));
    expect(text).toBe('思考过程 · 1 步 · 0.9s');
  });

  it('流式中最后一条消息无 duration → endAt 退化为该消息开始时刻，不产生负值段', () => {
    const streaming = [...msgs];
    const last = { ...asst('r', { duration: 0 }), timestamp: t0 + 60_000, streaming: true };
    streaming[2] = last;
    const s = computeTurnStats(streaming);
    expect(s.endAt).toBe(t0 + 60_000);
    expect(s.endAt! >= s.startAt!).toBe(true);
  });

  it('formatClock / formatElapsed 边界', () => {
    expect(formatClock(new Date(2026, 8, 21, 9, 5, 3).getTime())).toBe('09:05:03');
    expect(formatElapsed(45_300)).toBe('45.3s');
    expect(formatElapsed(59_900)).toBe('59.9s');
    expect(formatElapsed(60_000)).toBe('1m00s');
    expect(formatElapsed(513_000)).toBe('8m33s');
  });
});

describe('formatTokens', () => {
  it('紧凑格式', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(577)).toBe('577');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(621_765)).toBe('622k');
    expect(formatTokens(1_500_000)).toBe('1.50M');
  });
});
