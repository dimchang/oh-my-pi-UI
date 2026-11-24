import { describe, it, expect } from 'vitest';
import {
  detectCrashInterrupt,
  isCrashAbortedMessage,
  isCrashSessionExit,
  lastUserTextFromChat,
} from './crash-interrupt';

type M = Parameters<typeof detectCrashInterrupt>[0][number];

const user = (text: string): M => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string, stopReason = 'stop'): M => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason,
});
const abortedByCrash: M = {
  role: 'assistant',
  content: [],
  stopReason: 'aborted',
  errorMessage: 'Previous OMP process exited before completing the turn.',
};
const sessionExit: M = {
  role: 'custom',
  content: [],
  customType: 'session_exit',
  details: { reason: 'unhandled_rejection', kind: 'fatal', pendingToolCalls: [{ toolName: 'eval' }] },
};

describe('isCrashAbortedMessage', () => {
  it('只认「上一进程退出」导致的 aborted', () => {
    expect(isCrashAbortedMessage(abortedByCrash)).toBe(true);
    expect(isCrashAbortedMessage({ stopReason: 'aborted', errorMessage: 'Aborted by user' })).toBe(false);
    expect(isCrashAbortedMessage({ stopReason: 'aborted' })).toBe(false);
    expect(isCrashAbortedMessage({ stopReason: 'stop', errorMessage: 'Previous OMP process exited' })).toBe(false);
  });
});

describe('isCrashSessionExit', () => {
  it('只认致命退出', () => {
    expect(isCrashSessionExit(sessionExit)).toBe(true);
    expect(isCrashSessionExit({ customType: 'session_exit', details: { reason: 'manual' } })).toBe(false);
    expect(isCrashSessionExit({ customType: 'tool_execution_start', details: { kind: 'fatal' } })).toBe(false);
  });
});

describe('detectCrashInterrupt', () => {
  it('真实事故形态：session_exit + resume 补写的 aborted 终止帧 → 命中且带上一条用户文本', () => {
    const r = detectCrashInterrupt([
      user('V2 工程线淘宝网多少钱一根？'),
      assistant('浏览器工具能用。我开真实 Chromium 渲染…', 'toolUse'),
      sessionExit,
      abortedByCrash,
    ]);
    expect(r).toEqual({
      source: 'aborted',
      lastUserText: 'V2 工程线淘宝网多少钱一根？',
      detail: 'Previous OMP process exited before completing the turn.',
    });
  });

  it('只有 session_exit 落盘帧也能命中', () => {
    expect(detectCrashInterrupt([user('继续'), sessionExit])?.source).toBe('session_exit');
  });

  it('用户主动点停止（aborted 但 errorMessage 不匹配）不误报', () => {
    expect(detectCrashInterrupt([user('hi'), { ...abortedByCrash, errorMessage: undefined }])).toBeNull();
  });

  it('崩溃之后用户已重发并正常跑完 → 不再提醒', () => {
    expect(detectCrashInterrupt([
      user('第一次'),
      sessionExit,
      abortedByCrash,
      user('重发一次'),
      assistant('正常回答', 'stop'),
    ])).toBeNull();
  });

  it('没有用户消息 / 空历史 / 正常会话都不提醒', () => {
    expect(detectCrashInterrupt([sessionExit, abortedByCrash])).toBeNull();
    expect(detectCrashInterrupt([])).toBeNull();
    expect(detectCrashInterrupt([user('正常问题'), assistant('正常回答')])).toBeNull();
  });

  it('非致命 session_exit（用户主动退出）不算崩溃', () => {
    expect(detectCrashInterrupt([
      user('hi'),
      { ...sessionExit, details: { reason: 'manual' } },
    ])).toBeNull();
  });
});

describe('lastUserTextFromChat', () => {
  it('取最后一条 user 的 text parts，忽略 tool/assistant', () => {
    expect(lastUserTextFromChat([
      { role: 'user', parts: [{ kind: 'text', text: '旧问题' }] },
      { role: 'assistant', parts: [{ kind: 'text', text: '回答' }] },
      { role: 'user', parts: [{ kind: 'text', text: '新问题' }, { kind: 'tool', text: 'tool' }] },
    ])).toBe('新问题');
  });

  it('没有用户消息时返回空串', () => {
    expect(lastUserTextFromChat([{ role: 'assistant', parts: [{ kind: 'text', text: '回答' }] }])).toBe('');
  });
});
