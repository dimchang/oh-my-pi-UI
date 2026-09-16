import { describe, it, expect } from 'vitest';
import { UNNAMED_SESSION, deriveSessionName } from './temp-session';

describe('deriveSessionName：会话自动命名判据', () => {
  it('取输入首行（跳过前导空行）并 trim', () => {
    expect(deriveSessionName('  修复登录超时  \n第二行说明')).toBe('修复登录超时');
    expect(deriveSessionName('\n\n  排查橙点常亮\n更多上下文')).toBe('排查橙点常亮');
  });

  it('单行输入直接用该行', () => {
    expect(deriveSessionName('重构会话列表')).toBe('重构会话列表');
  });

  it('过短或纯符号不配当标题 → 退回附件名', () => {
    expect(deriveSessionName('？', 'screenshot.png')).toBe('screenshot.png');
    expect(deriveSessionName('！！', 'a.png')).toBe('a.png');
    expect(deriveSessionName('。。')).toBe(UNNAMED_SESSION);
    expect(deriveSessionName('')).toBe(UNNAMED_SESSION);
  });

  it('没有附件名可退时用兜底值（与主进程 titleFallback 同值）', () => {
    expect(deriveSessionName(' ? ')).toBe(UNNAMED_SESSION);
    expect(deriveSessionName('')).toBe('（未命名会话）');
  });

  it('首行为空但有附件时用附件名', () => {
    expect(deriveSessionName('', 'report.pdf')).toBe('report.pdf');
  });

  it('首行不合格但附件名可用时，退回附件名', () => {
    expect(deriveSessionName('？', ' design-spec.md ')).toBe('design-spec.md');
  });

  it('统一截断 40 字符', () => {
    expect(deriveSessionName('一'.repeat(80))).toHaveLength(40);
    expect(deriveSessionName('?', 'x'.repeat(80))).toHaveLength(40);
  });
});
