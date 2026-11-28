import { describe, expect, it } from 'vitest';
import { isToolMountNotice } from './notice-filter';

describe('isToolMountNotice', () => {
  it('匹配旧版 xd:// 挂载通知', () => {
    expect(isToolMountNotice('xd://: mounted mcp__node_repl_js, mcp__fs')).toBe(true);
    expect(isToolMountNotice('XD://: unmounted mcp__foo')).toBe(true);
  });

  it('匹配 OMP 19.1.0+ tools.commands / commandNotices 挂载通知', () => {
    expect(isToolMountNotice('commands: mounted mcp__github_search, mcp__git')).toBe(true);
    expect(isToolMountNotice('tools.commands: unmounted mcp__old')).toBe(true);
    expect(isToolMountNotice('mounted command mcp__postgres')).toBe(true);
    expect(isToolMountNotice('mounted mcp__fetch')).toBe(true);
  });

  it('不误伤真正的错误或业务通知', () => {
    expect(isToolMountNotice('Session store stopped accepting writes: disk full')).toBe(false);
    expect(isToolMountNotice('Rate limit exceeded, retrying...')).toBe(false);
    expect(isToolMountNotice('')).toBe(false);
    expect(isToolMountNotice(undefined)).toBe(false);
  });
});
