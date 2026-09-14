import type { ChatMessage, MessagePart, TextPart } from '../store';

/**
 * 回合视图（turn view）—— 用户视角的「一问一答」聚合与内容切分。
 *
 * 背景（2026-09-13 实测本项目会话 JSONL）：omp 一次 agent run 会产出**多条** assistant 消息，
 * 每次模型响应独立成一条 —— 「思考 + 工具调用」若干条 + 最后一条「纯文本最终回答」。
 * 单条会话可含 480+ 条 assistant 消息（如 483 条），若逐条渲染就会出现用户抱怨的
 * 「每次思考过程一行」。故渲染以**回合**为单位：
 *
 *   [用户消息] → [一行折叠的思考过程（全部 thinking / 工具卡 / 过程说明）] → [详细的最终回复]
 *
 * 本模块只做纯函数（不碰 React / DOM），便于用真实会话数据做单测。
 */

/** 一个回合 = 一条用户消息 + 其后连续的 assistant 消息。 */
export interface Turn {
  user?: ChatMessage;
  asst: ChatMessage[];
}

/** 按回合分组：assistant 消息并入「前面最近的回合」（即前一条用户消息所属回合）。
 *  窗口从回合中间起头（前面被裁掉）时会产生无 user 的孤立回合，此时单独渲染折叠块。 */
export function groupTurns(msgs: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of msgs) {
    if (m.role === 'assistant') {
      const last = turns[turns.length - 1];
      if (last) last.asst.push(m);
      else turns.push({ asst: [m] });
    } else {
      turns.push({ user: m, asst: [] });
    }
  }
  return turns;
}

/** 回合聚合统计（摘要行用）。
 *  注意 totalTokens 是**单次请求的上下文总量**（input + cacheRead + output），逐条累加会
 *  重复计数出天文数字（实测 483 条消息的回合累加得 23,391,974 —— 无意义）；
 *  只有 output / reasoningTokens 是各请求独立的生成量，才可跨请求求和。 */
export interface TurnStats {
  /** 回合内的模型响应数（= agent 步数）。omp 每次模型响应独立成一条 assistant 消息，
   *  故一"步"= 一次「思考 → 调工具」循环。摘要显示为「N 步」。 */
  steps: number;
  /** 回合内模型思考（reasoning）tokens 之和 */
  thinkingTokens: number;
  /** 回合内模型生成（输出）tokens 之和 */
  outputTokens: number;
  /** 回合内模型请求耗时之和（ms），不含工具执行时间 */
  durationMs: number;
}

export function computeTurnStats(msgs: ChatMessage[]): TurnStats {
  let thinkingTokens = 0;
  let outputTokens = 0;
  let durationMs = 0;
  for (const m of msgs) {
    thinkingTokens += m.usage?.reasoningTokens ?? 0;
    outputTokens += m.usage?.outputTokens ?? 0;
    durationMs += m.usage?.duration ?? 0;
  }
  return { steps: msgs.length, thinkingTokens, outputTokens, durationMs };
}

/** 把 parts 切成「折叠块」与「最终回答」两部分。
 *
 *  - 折叠块：全部 thinking、全部工具卡、以及**过程说明**（narration —— 与工具调用同处一条消息的文本）。
 *  - 最终回答：来自「不含工具调用」的纯文本消息的文本块。
 *
 *  兜底（重要）：若回合已结束（streaming=false）却没有任何可见回答 —— 模型最后一条是
 *  「过程说明 + 工具调用」后被打断（用户插话 / 停止 / 报错）—— 则把最后一条含文本消息的文本
 *  提升为可见回答，避免整个回合只剩一条折叠条、正文一个字看不到（2026-09-13 用户截图反馈）。
 *  流式期间不做提升，否则中途的过程说明会被当成最终回答一直挂在正文里。 */
export function splitTurnParts(
  msgs: ChatMessage[],
  streaming: boolean,
): { folded: MessagePart[]; reply: TextPart[] } {
  const all = msgs.flatMap((m) => m.parts);
  const visible = new Set<MessagePart>();
  for (const p of all) {
    if (p.kind === 'text' && !p.narration) visible.add(p);
  }
  if (visible.size === 0 && !streaming) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const texts = msgs[i]!.parts.filter(
        (p): p is TextPart => p.kind === 'text' && p.text.trim() !== '',
      );
      if (texts.length === 0) continue;
      for (const t of texts) visible.add(t);
      break;
    }
  }
  const folded: MessagePart[] = [];
  const reply: TextPart[] = [];
  for (const p of all) {
    if (p.kind === 'text' && visible.has(p)) reply.push(p);
    else folded.push(p);
  }
  return { folded, reply };
}

/** tokens 紧凑格式：<1k 原样，<10k 一位小数 k，<1M 整数 k，≥1M 两位小数 M。 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

/** 摘要行文案：`思考过程 · 39 步 · 思考 3.4k tokens · 生成 1.2k tokens · 45.3s`
 *  各项缺省则省略（如非推理模型无 thinkingTokens）。 */
export function formatTurnSummary(s: TurnStats): string {
  const out = [`思考过程 · ${s.steps} 步`];
  if (s.thinkingTokens > 0) out.push(`思考 ${formatTokens(s.thinkingTokens)} tokens`);
  if (s.outputTokens > 0) out.push(`生成 ${formatTokens(s.outputTokens)} tokens`);
  if (s.durationMs > 0) out.push(`${(s.durationMs / 1000).toFixed(1)}s`);
  return out.join(' · ');
}
