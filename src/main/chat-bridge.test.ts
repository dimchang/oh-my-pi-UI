/**
 * chat-bridge.test.ts — 消息桥（企微/飞书）核心逻辑回归测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';

vi.mock('electron', () => ({
  app: { getPath: () => path.join(__dirname, '__chat_bridge_test_no_such_dir__') },
}));

import { ChatBridgeCore, type BridgeIncomingMessage, type ChatTransport } from '../../electron/chat-bridge-core';
import { tailUtf8Bytes } from '../../electron/wecom-client';
import { stripLeadingMention } from '../../electron/wecom-bridge';
import type { OmpProcessPool } from '../../electron/omp-pool';

function makePool() {
  return {
    send: vi.fn(async () => ({ success: true, data: {} })),
    acquireNew: vi.fn(async () => undefined),
    acquire: vi.fn(async () => undefined),
    renameKey: vi.fn(),
  };
}

function makeTransport() {
  return {
    connected: true,
    respondText: vi.fn(async () => undefined),
    respondStream: vi.fn(async () => undefined),
    pushText: vi.fn(async () => undefined),
  } satisfies ChatTransport;
}

function msg(id: string, text: string, supportsStream = false): BridgeIncomingMessage {
  return { reqId: id, msgid: id, chatKey: 'c1', chatType: 'single', text, supportsStream };
}

async function setup(opts: { streamWindowMs?: number; supportsStream?: boolean; bound?: boolean } = {}) {
  const pool = makePool();
  const transport = makeTransport();
  const core = new ChatBridgeCore('test', '__test_', opts.streamWindowMs ?? 0);
  await core.init(
    {
      pool: pool as unknown as OmpProcessPool,
      resolveHooks: async () => [],
      defaultCwd: 'C:\\work',
      onStatusChange: () => undefined,
      log: () => undefined,
      channelLabel: 'test',
    },
    transport,
    opts.supportsStream ?? false,
  );
  if (opts.bound) {
    await core.saveConfig({
      ...core.config,
      bindings: [{ chatKey: 'c1', sessionPath: 'S', chatType: 'single', title: '', createdAt: 0 }],
    });
  }
  return { pool, transport, core };
}

const delta = (text: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });

describe('chat bridge', () => {
  beforeEach(() => {
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tailUtf8Bytes 按字节截尾且不切开代理对', () => {
    const s = '中'.repeat(10_000) + '😀end';
    const out = tailUtf8Bytes(s, 20_480);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(20_480);
    expect(s.endsWith(out)).toBe(true);
    // 预算恰好卡在 emoji 中间时整颗丢弃，而不是留下孤立低代理
    expect(tailUtf8Bytes('a😀bc', 5)).toBe('bc');
  });

  it('企微群聊剥离命令前的 @ 显示名，正文里的路径不受影响', () => {
    expect(stripLeadingMention('@机器人 /bind 1')).toBe('/bind 1');
    expect(stripLeadingMention('@张三 @Claude Code /status')).toBe('/status');
    expect(stripLeadingMention('@机器人 看下 /etc/hosts')).toBe('@机器人 看下 /etc/hosts');
  });

  it('同一聊天首条消息建会话期间到达的第二条不会重复建会话', async () => {
    const { pool, core } = await setup();
    let release!: () => void;
    pool.acquireNew.mockImplementation(() => new Promise<undefined>((r) => { release = () => r(undefined); }));
    const p1 = core.handleMessage(msg('m1', 'hi'));
    const p2 = core.handleMessage(msg('m2', 'second'));
    await vi.waitFor(() => expect(pool.acquireNew).toHaveBeenCalled());
    release();
    await Promise.all([p1, p2]);
    expect(pool.acquireNew).toHaveBeenCalledTimes(1);
    const cmds = pool.send.mock.calls.map((c) => (c as unknown[])[1] as { type: string; message: string });
    expect(cmds).toEqual([{ type: 'prompt', message: 'hi' }, { type: 'steer', message: 'second' }]);
  });

  it('info 级 notice（如 xd:// 挂载通知）不提前结束回合', async () => {
    const { transport, core } = await setup({ bound: true });
    await core.handleMessage(msg('m1', 'go'));
    core.handleFrame('S', delta('A'));
    core.handleFrame('S', { type: 'notice', message: 'xd://: mounted mcp__x', level: 'info' });
    core.handleFrame('S', delta('B'));
    expect(core.status().activeChats).toEqual(['c1']);
    core.handleFrame('S', { type: 'agent_end' });
    expect(transport.respondText).toHaveBeenCalledTimes(1);
    expect(transport.respondText).toHaveBeenCalledWith('m1', 'AB');
  });

  it('流式窗口过期后继续累积，终稿通过 pushText 主动推送', async () => {
    const { transport, core } = await setup({ bound: true, supportsStream: true, streamWindowMs: 1 });
    await core.handleMessage(msg('m1', 'go', true));
    await new Promise((r) => setTimeout(r, 5));
    core.handleFrame('S', delta('part1 '));
    core.handleFrame('S', delta('final answer'));
    core.handleFrame('S', { type: 'agent_end' });
    expect(transport.pushText).toHaveBeenCalledWith('c1', 'single', 'part1 final answer');
    const finishes = transport.respondStream.mock.calls.filter((c) => (c as unknown[])[3] === true);
    expect(finishes).toHaveLength(1);
  });

  it('保存配置时 secret 留空沿用已存凭证', async () => {
    const { core } = await setup();
    await core.saveConfig({ ...core.config, botId: 'bot', secret: 's3cret' });
    await core.saveConfig({ ...core.config, botId: 'bot', secret: '', injectMode: 'followUp' });
    expect(core.config.secret).toBe('s3cret');
    expect(core.config.injectMode).toBe('followUp');
  });
});
