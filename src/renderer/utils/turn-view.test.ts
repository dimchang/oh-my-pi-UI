import { describe, it, expect } from 'vitest';
import type { ChatMessage, MessagePart } from '../store';
import {
  groupTurns,
  splitTurnParts,
  computeTurnStats,
  formatTurnSummary,
  formatTokens,
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

describe('formatTokens', () => {
  it('紧凑格式', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(577)).toBe('577');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(621_765)).toBe('622k');
    expect(formatTokens(1_500_000)).toBe('1.50M');
  });
});
