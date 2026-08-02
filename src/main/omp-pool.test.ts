/**
 * omp-pool.test.ts — 回归测试：tempKey→realPath 迁移后，帧/事件的 sessionPath 标记
 * 必须跟随 entry 的当前 key（issue: 新建会话首轮正常、次轮 UI 无回应的根因）。
 *
 * 背景（实证 session 019fc35d）：新建会话用 __new_* tempKey spawn，首轮 agent_end 后
 * migrateTempSession 把池 entry renameKey 成真实 .jsonl 路径。旧代码的 pushEvent/
 * onReady/onExit/onStderr 闭包捕获的是 spawn 时传入的初始 sessionPath（tempKey），
 * renameKey 只更新 entry.sessionPath，闭包不跟随 → 次轮所有帧仍带 __sessionPath=tempKey，
 * 渲染层按 realPath 找缓冲（appendUserMessage 用的 currentSessionPath），isDisplay=false，
 * assistant 消息只写进孤儿缓冲、不更新 messages → 界面停在用户提问、无任何回复。
 */
import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

vi.mock('../../electron/omp-process', () => {
  class MockOmpProcess {
    static instances: MockOmpProcess[] = [];
    events: {
      onReady(): void;
      onExit(code: number | null): void;
      onFrame(frame: unknown): void;
      onStderr(line: string): void;
    };
    constructor(_opts: unknown, events: MockOmpProcess['events']) {
      this.events = events;
      MockOmpProcess.instances.push(this);
    }
    start = vi.fn(async () => { this.events.onReady(); });
    write = vi.fn();
    kill = vi.fn();
  }
  return { OmpProcess: MockOmpProcess };
});

import { OmpProcessPool } from '../../electron/omp-pool';
import type { OmpFrame } from '../shared/rpc-types';

function makePool() {
  const seen: Array<{ sessionPath: string; kind: string; code?: number | null; line?: string }> = [];
  const pool = new OmpProcessPool('C:/fake/omp.exe', {
    onFrame: (sessionPath, _frame) => seen.push({ sessionPath, kind: 'frame' }),
    onReady: (sessionPath) => seen.push({ sessionPath, kind: 'ready' }),
    onExit: (sessionPath, code) => seen.push({ sessionPath, kind: 'exit', code }),
    onStderr: (sessionPath, line) => seen.push({ sessionPath, kind: 'stderr', line }),
    onLog: () => undefined,
  }, 5);
  return { pool, seen };
}

describe('OmpProcessPool tempKey→realPath frame routing', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-pool-test-'));
  const tempKey = '__new_test-uuid';
  const realPath = path.join(cwd, '2026-08-02T00-00-00-000Z_019fc35d-59a3-7000-a5d3-477c71f2996b.jsonl');

  it('renameKey 后 pushEvent 用当前 key 标记帧（次轮消息才能显示）', async () => {
    const { pool, seen } = makePool();
    const entry = await pool.acquireNew(tempKey, cwd, 'write');
    expect(pool.has(tempKey)).toBe(true);
    // rename temp→real
    const renamed = pool.renameKey(tempKey, realPath);
    expect(renamed).toBe(entry);
    expect(pool.has(realPath)).toBe(true);
    // 模拟 omp 推送一条次轮 assistant 帧
    entry.router.dispatch({ type: 'message_end', message: { role: 'assistant' } } as unknown as OmpFrame);
    expect(seen.filter((s) => s.kind === 'frame').map((s) => s.sessionPath)).toEqual([realPath]);
    pool.killAll();
  });

  it('evict（LRU/主动淘汰）后推送 onExit，渲染层才能同步 offline（LRU 淘汰后 rpc:send 报 not online 的根因）', async () => {
    const { pool, seen } = makePool();
    await pool.acquireNew(tempKey, cwd, 'write');
    seen.length = 0; // 清掉 spawn/ready 阶段事件，只断言 evict 的行为
    pool.evict(tempKey);
    expect(seen).toEqual([{ sessionPath: tempKey, kind: 'exit', code: null }]);
    expect(pool.has(tempKey)).toBe(false);
  });

  it('renameKey 后 onReady/onExit/onStderr 也用当前 key', async () => {
    const { pool, seen } = makePool();
    const entry = await pool.acquireNew(tempKey, cwd, 'write');
    pool.renameKey(tempKey, realPath);
    seen.length = 0; // 清掉 spawn/ready 阶段（rename 前）的事件，只断言 rename 后的标记
    // 通过 mock proc 的事件回调触发（entry.proc 是 MockOmpProcess）
    const proc = entry.proc as unknown as {
      events: { onReady(): void; onExit(c: number | null): void; onStderr(l: string): void };
    };
    proc.events.onReady();
    proc.events.onExit(0);
    proc.events.onStderr('hello');
    expect(seen).toEqual([
      { sessionPath: realPath, kind: 'ready' },
      { sessionPath: realPath, kind: 'exit', code: 0 },
      { sessionPath: realPath, kind: 'stderr', line: 'hello' },
    ]);
    pool.killAll();
  });
});
