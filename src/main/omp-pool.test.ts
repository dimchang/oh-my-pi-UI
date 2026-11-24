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
    /** 每个实例的构造 opts（resumeSession 等），供断言 spawn 参数 */
    static optsLog: Array<Record<string, unknown>> = [];
    /** false 时 start() 不自动 ready（模拟 omp 启动慢 / 卡在 ready 之前） */
    static autoReady = true;
    events: {
      onReady(): void;
      onExit(code: number | null): void;
      onFrame(frame: unknown): void;
      onStderr(line: string): void;
    };
    constructor(opts: Record<string, unknown>, events: MockOmpProcess['events']) {
      MockOmpProcess.optsLog.push(opts);
      this.events = events;
      MockOmpProcess.instances.push(this);
    }
    start = vi.fn(async () => { if (MockOmpProcess.autoReady) this.events.onReady(); });
    write = vi.fn();
    kill = vi.fn();
  }
  return { OmpProcess: MockOmpProcess };
});

import { OmpProcessPool } from '../../electron/omp-pool';
import type { OmpFrame } from '../shared/rpc-types';

function makePool(maxPool = 5) {
  const seen: Array<{ sessionPath: string; kind: string; code?: number | null; line?: string }> = [];
  const pool = new OmpProcessPool('C:/fake/omp.exe', {
    onFrame: (sessionPath, _frame) => seen.push({ sessionPath, kind: 'frame' }),
    onReady: (sessionPath) => seen.push({ sessionPath, kind: 'ready' }),
    onExit: (sessionPath, code) => seen.push({ sessionPath, kind: 'exit', code }),
    onStderr: (sessionPath, line) => seen.push({ sessionPath, kind: 'stderr', line }),
    onLog: () => undefined,
    onReplaced: (sessionPath) => seen.push({ sessionPath, kind: 'replaced' }),
  }, maxPool);
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

describe('OmpProcessPool temp 会话防分裂（2026-09-14 bet_zp 事故回归）', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-pool-split-'));
  const tempKey = '__new_split-test';
  const realFile = path.join(cwd, 'fake-real.jsonl');

  it('temp 进程被杀后 acquire(tempKey) 用记忆的 sessionFile -r 续接，不全新 spawn', async () => {
    const { pool } = makePool();
    await pool.acquireNew(tempKey, cwd, 'write');
    pool.evict(tempKey); // 模拟权限切换旧实现 release / 池淘汰杀进程
    // 注入记忆（模拟 ready 后 get_state.sessionFile 已返回）
    pool['tempSessionFiles'].set(tempKey, realFile);
    await pool.acquire(tempKey, cwd, 'write');
    // 第二个 OmpProcess 构造必须带 resumeSession=realFile（-r 续接，而非全新会话）
    const { OmpProcess } = await import('../../electron/omp-process');
    const optsLog = (OmpProcess as unknown as { optsLog: Array<{ resumeSession?: string }> }).optsLog;
    const second = optsLog[optsLog.length - 1];
    expect(second?.resumeSession).toBe(realFile);
    expect(pool.has(tempKey)).toBe(true);
    pool.killAll();
  });

  it('无记忆的 tempKey acquire 仍全新 spawn（用户从未发消息的正常路径）', async () => {
    const { pool } = makePool();
    await pool.acquireNew('__new_fresh-1', cwd, 'write');
    const { OmpProcess } = await import('../../electron/omp-process');
    const optsLog = (OmpProcess as unknown as { optsLog: Array<{ resumeSession?: string }> }).optsLog;
    expect(optsLog[optsLog.length - 1]?.resumeSession).toBeUndefined();
    pool.killAll();
  });

  it('消息桥 tempKey（__wecom_）同样记忆 sessionFile：首轮结束前进程死掉，重拉带 -r 续接不分裂', async () => {
    const { pool } = makePool();
    const key = '__wecom_split-test';
    const e = await pool.acquireNew(key, cwd, 'write');
    const proc = e.proc as unknown as {
      write: { mock: { calls: Array<[{ type: string; id: string }]> } };
      events: { onFrame(f: unknown): void };
    };
    const getState = proc.write.mock.calls.map((c) => c[0]).find((c) => c.type === 'get_state');
    expect(getState).toBeDefined();
    proc.events.onFrame({ type: 'response', id: getState!.id, command: 'get_state', success: true, data: { sessionFile: realFile } });
    await Promise.resolve();
    pool.evict(key);
    await pool.acquire(key, cwd, 'write');
    const { OmpProcess } = await import('../../electron/omp-process');
    const optsLog = (OmpProcess as unknown as { optsLog: Array<{ resumeSession?: string }> }).optsLog;
    expect(optsLog[optsLog.length - 1]?.resumeSession).toBe(realFile);
    pool.killAll();
  });
});

type MockProc = {
  events: { onReady(): void; onExit(c: number | null): void; onStderr(l: string): void };
  kill: ReturnType<typeof vi.fn>;
};
async function mockProcClass(): Promise<{ instances: MockProc[]; autoReady: boolean }> {
  const { OmpProcess } = await import('../../electron/omp-process');
  return OmpProcess as unknown as { instances: MockProc[]; autoReady: boolean };
}
/** 让出事件循环直到条件成立（用 setImmediate，不受 fake setTimeout 影响；等异步 stat 完成） */
async function until(cond: () => boolean, max = 5000): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) await new Promise((r) => setImmediate(r));
}

describe('OmpProcessPool spawn / 退出生命周期', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-pool-life-'));

  it('spawn 中被 evict：spawn Promise 立即 reject，且不再拉起池外孤儿进程', async () => {
    const { pool } = makePool();
    const Mock = await mockProcClass();
    const before = Mock.instances.length;
    const key = '__new_evict-during-spawn';
    const p = pool.acquireNew(key, cwd, 'write');
    pool.evict(key); // 此时仍在异步 stat，proc 尚未创建
    await expect(p).rejects.toThrow(/evicted/);
    await new Promise((r) => setTimeout(r, 200)); // 等原 spawn 流程的异步 stat 跑完
    expect(Mock.instances.length).toBe(before);
    expect(pool.has(key)).toBe(false);
    pool.killAll();
  });

  it('未 ready 时被 evict 再 acquire 同 key：立即新拉起，旧 spawn 的 30s 超时也不得淘汰新 entry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const Mock = await mockProcClass();
    try {
      const { pool } = makePool();
      const key = path.join(cwd, 'timeout-race.jsonl');
      const before = Mock.instances.length;
      Mock.autoReady = false;
      const p1 = pool.acquire(key, cwd, 'write');
      p1.catch(() => undefined);
      await until(() => Mock.instances.length > before); // 进程已创建、未 ready
      const oldProc = Mock.instances[Mock.instances.length - 1]!;
      pool.evict(key);
      expect(oldProc.kill).toHaveBeenCalled();
      Mock.autoReady = true;
      // 旧 spawn Promise 必须立即结束，否则 acquire 去重会把同 key 的新请求挂在它上面
      await expect(p1).rejects.toThrow(/evicted/);
      const e2 = await pool.acquire(key, cwd, 'write');
      expect(e2.proc).not.toBe(oldProc);
      vi.advanceTimersByTime(31_000); // 旧 spawn 的超时到点
      expect(pool.get(key)).toBe(e2);
      pool.killAll();
    } finally {
      Mock.autoReady = true;
      vi.useRealTimers();
    }
  });

  it('进程退出整体释放 pin：同 key 重拉的新进程不会被永久视为 pinned', async () => {
    const { pool } = makePool(1);
    const key = path.join(cwd, 'pinned.jsonl');
    const e1 = await pool.acquire(key, cwd, 'write');
    pool.pin(key, 'req-1');
    pool.pin(key, 'req-2'); // 两个未应答的确认弹窗
    (e1.proc as unknown as MockProc).events.onExit(1); // 进程崩溃
    pool.unpin(key, 'req-1');
    await pool.acquire(key, cwd, 'write'); // 自愈重拉
    // 池满（max=1）：新会话应能 LRU 淘汰 key，而不是报"所有会话都在等待用户确认"
    await expect(pool.acquire(path.join(cwd, 'other.jsonl'), cwd, 'write')).resolves.toBeDefined();
    expect(pool.has(key)).toBe(false);
    pool.killAll();
  });

  it('pin 按请求 id 释放：重复/未知 id 的 unpin 不会释放其他未应答请求', async () => {
    const { pool } = makePool(1);
    const key = path.join(cwd, 'pin-ids.jsonl');
    await pool.acquire(key, cwd, 'write');
    pool.pin(key, 'a');
    pool.pin(key, 'b');
    pool.unpin(key, 'a');
    pool.unpin(key, 'a'); // 重复应答
    pool.unpin(key, 'zzz'); // 未知 id
    await expect(pool.acquire(path.join(cwd, 'other2.jsonl'), cwd, 'write')).rejects.toThrow(/进程池已满/);
    pool.unpin(key, 'b'); // 最后一个请求被 cancel 撤销
    await expect(pool.acquire(path.join(cwd, 'other2.jsonl'), cwd, 'write')).resolves.toBeDefined();
    expect(pool.has(key)).toBe(false);
    pool.killAll();
  });

  it('renameKey 目标 key 已有进程：旧进程被回收（不成为池外孤儿），其迟到的退出也不影响迁移后的 entry', async () => {
    const { pool, seen } = makePool();
    const realPath = path.join(cwd, 'clash.jsonl');
    const dup = await pool.acquire(realPath, cwd, 'write');
    const temp = await pool.acquireNew('__new_clash', cwd, 'write');
    pool.renameKey('__new_clash', realPath);
    expect((dup.proc as unknown as MockProc).kill).toHaveBeenCalled();
    expect(pool.get(realPath)).toBe(temp);
    // 消息桥需据此收尾挂在被回收进程上的回合
    expect(seen.filter((s) => s.kind === 'replaced')).toEqual([{ sessionPath: realPath, kind: 'replaced' }]);
    seen.length = 0;
    (dup.proc as unknown as MockProc).events.onExit(0);
    expect(pool.get(realPath)).toBe(temp);
    expect(seen).toEqual([]);
    pool.killAll();
  });
});
