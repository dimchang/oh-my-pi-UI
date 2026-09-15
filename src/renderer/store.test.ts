import { describe, it, expect, beforeEach } from 'vitest';
import { useApp, connTone, connDetail } from './store';
import type { ToolPart } from './store';

const SP = 'D:/proj';
const ev = (frame: Record<string, unknown>): void =>
  useApp.getState().applyAgentEvent({ __sessionPath: SP, ...frame } as Record<string, unknown>);

const tools = (): ToolPart[] =>
  useApp.getState().messages.flatMap((m) => m.parts.filter((p): p is ToolPart => p.kind === 'tool'));

beforeEach(() => {
  useApp.setState({ currentSessionPath: SP, messages: [], sessionsMap: {}, subagents: [], subagentsAt: 0 });
});

// 帧形状均取自 .temp/frames-task.jsonl / frames-bgdone.jsonl 实测
describe('subagents', () => {
  it('task start 用 args.tasks 预建条目并带上 intent', () => {
    ev({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'task',
      intent: 'Probing two sonic agents',
      args: {
        context: 'Probe test',
        tasks: [
          { agent: 'sonic', name: 'ProbeOne', task: 'Reply with exactly: ALPHA' },
          { agent: 'sonic', name: 'ProbeTwo', task: 'Reply with exactly: BETA' },
        ],
      },
    });
    const jobs = useApp.getState().subagents;
    expect(jobs.map((j) => j.id)).toEqual(['ProbeOne', 'ProbeTwo']);
    expect(jobs[0]).toMatchObject({
      status: 'pending',
      agent: 'sonic',
      intent: 'Probing two sonic agents',
      assignment: 'Reply with exactly: ALPHA',
    });
  });

  it('progress 推进状态，终态数据落地', () => {
    ev({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'task', args: { tasks: [{ name: 'P1' }] } });
    ev({
      type: 'tool_execution_update',
      toolCallId: 'c',
      toolName: 'task',
      partialResult: {
        content: [{ type: 'text', text: 'Running background task P1...' }],
        details: { progress: [{ id: 'P1', status: 'running', tokens: 0, durationMs: 0 }] },
      },
    });
    expect(useApp.getState().subagents[0]?.status).toBe('running');

    ev({
      type: 'tool_execution_update',
      toolCallId: 'c',
      toolName: 'task',
      partialResult: {
        content: [{ type: 'text', text: 'Background task P1 complete.' }],
        details: {
          progress: [{ id: 'P1', status: 'completed', durationMs: 3613, tokens: 1623, toolCount: 1, resolvedModel: 'LocalWBAPI/glm-5.3' }],
        },
      },
    });
    expect(useApp.getState().subagents[0]).toMatchObject({
      status: 'completed',
      durationMs: 3613,
      tokens: 1623,
      resolvedModel: 'LocalWBAPI/glm-5.3',
    });
  });

  it('task 的 end 帧（派发瞬间的 pending 快照）不回退状态', () => {
    ev({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'task', args: { tasks: [{ name: 'P1' }] } });
    ev({
      type: 'tool_execution_update',
      toolCallId: 'c',
      toolName: 'task',
      partialResult: { content: [], details: { progress: [{ id: 'P1', status: 'completed', durationMs: 100 }] } },
    });
    ev({
      type: 'tool_execution_end',
      toolCallId: 'c',
      toolName: 'task',
      result: { details: { async: { jobId: 'P1' }, progress: [{ id: 'P1', status: 'pending' }], results: [] } },
    });
    expect(useApp.getState().subagents[0]).toMatchObject({ status: 'completed', durationMs: 100 });
  });

  it('hub 的 jobs 只收 task 型，并读结构化 status', () => {
    ev({
      type: 'tool_execution_update',
      toolCallId: 'h',
      toolName: 'hub',
      partialResult: {
        content: [{ type: 'text', text: 'Waiting...' }],
        details: {
          op: 'wait',
          jobs: [
            { id: 'bg_1', type: 'bash', status: 'completed', label: 'sleep 25' },
            { id: 'ProbeTwo', type: 'task', status: 'running', label: 'ProbeTwo', resolvedModel: 'LocalWBAPI/glm-5.3' },
          ],
        },
      },
    });
    const jobs = useApp.getState().subagents;
    expect(jobs.map((j) => j.id)).toEqual(['ProbeTwo']);
    expect(jobs[0]).toMatchObject({ status: 'running', resolvedModel: 'LocalWBAPI/glm-5.3' });
  });

  it('async-result：jobId 归一化 + <task-result status> 判失败', () => {
    const content = '<system-notice>\n<task-result id="CloudReviewFix" agent="task" status="failed (exit 1)">\n</system-notice>';
    ev({
      type: 'message_start',
      message: {
        role: 'custom',
        customType: 'async-result',
        display: true,
        content,
        details: { jobs: [{ jobId: 'CloudReviewFix', type: 'task', label: 'CloudReviewFix', durationMs: 996402 }] },
      },
    });
    const job = useApp.getState().subagents[0];
    expect(job).toMatchObject({ id: 'CloudReviewFix', status: 'failed', durationMs: 996402 });
    expect(job?.errorText).toContain('failed (exit 1)');
    // custom 消息不进气泡
    expect(useApp.getState().messages).toEqual([]);
  });

  // omp 源码 `#X` 的 status 只取 completed / `failed (exit N)` / cancelled / merge failed
  it('async-result：cancelled / merge failed 判为非完成，不会被当成完成', () => {
    for (const [raw, want] of [['cancelled', 'cancelled'], ['merge failed', 'failed']] as const) {
      useApp.setState({ subagents: [], subagentsAt: 0 });
      ev({
        type: 'message_start',
        message: {
          role: 'custom',
          customType: 'async-result',
          display: true,
          content: `<task-result id="EscJob" agent="task" status="${raw}">`,
          details: { jobs: [{ jobId: 'EscJob', type: 'task', label: 'EscJob' }] },
        },
      });
      const job = useApp.getState().subagents[0];
      expect(job?.status).toBe(want);
      expect(job?.errorText).toBe(raw);
    }
  });

  it('progress 的 aborted 也归入取消，而非排队中', () => {
    ev({
      type: 'tool_execution_update',
      toolCallId: 'c',
      toolName: 'task',
      partialResult: { content: [], details: { progress: [{ id: 'A1', status: 'aborted' }] } },
    });
    expect(useApp.getState().subagents[0]?.status).toBe('cancelled');
  });

  it('同名 task 重派不碰既有条目（omp 会给新 job 改名，prime 的名字必然不准）', () => {
    ev({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'task', intent: '第一批', args: { tasks: [{ name: 'Same', agent: 'scout' }] } });
    ev({
      type: 'tool_execution_update',
      toolCallId: 'c1',
      toolName: 'task',
      partialResult: { content: [], details: { progress: [{ id: 'Same', status: 'running' }] } },
    });
    const before = useApp.getState().subagents[0];
    expect(before).toMatchObject({ id: 'Same', status: 'running', intent: '第一批' });

    ev({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'task', intent: '第二批', args: { tasks: [{ name: 'Same', agent: 'scout' }] } });
    expect(useApp.getState().subagents).toHaveLength(1);
    const after = useApp.getState().subagents[0];
    expect(after).toMatchObject({ id: 'Same', status: 'running', intent: '第一批' });
    expect(after?.startedAt).toBe(before?.startedAt);
  });

  // omp 把撞名 job 改名为 X-2，此时 args 里的 name 是过期猜测 -> 占位条目必须让位
  it('被改名的占位条目在真 id 到达时淘汰', () => {
    ev({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'task', intent: '跑', args: { tasks: [{ name: 'Dup', agent: 'scout' }] } });
    expect(useApp.getState().subagents.map((j) => j.id)).toEqual(['Dup']);
    ev({
      type: 'tool_execution_update',
      toolCallId: 'c1',
      toolName: 'task',
      partialResult: { content: [], details: { progress: [{ id: 'Dup-2', status: 'running' }] } },
    });
    const jobs = useApp.getState().subagents;
    expect(jobs.map((j) => j.id)).toEqual(['Dup-2']);
    expect(jobs[0]?.intent).toBeUndefined(); // 帧里没有 intent，不该被凭空造出
  });

  it('新名字仍在首个 progress 帧前预建条目', () => {
    ev({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'task', intent: '跑两个', args: { tasks: [{ name: 'N1', agent: 'scout' }, { name: 'N2', agent: 'task' }] } });
    expect(useApp.getState().subagents.map((j) => [j.id, j.status, j.intent])).toEqual([
      ['N1', 'pending', '跑两个'],
      ['N2', 'pending', '跑两个'],
    ]);
  });

  it('未知 id 的 job 不建条目，空只读不写', () => {
    ev({ type: 'tool_execution_update', toolCallId: 'c', toolName: 'task', partialResult: { content: [], details: { progress: [{ status: 'running' }] } } });
    expect(useApp.getState().subagents).toEqual([]);
    expect(useApp.getState().subagentsAt).toBe(0);
  });
});

describe('tool partial 文本', () => {
  it('从 partialResult.content[] 抽文本（旧实现按 string 拼接 → 恒空）', () => {
    ev({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', intent: 'Running background sleep job' });
    ev({ type: 'tool_execution_update', toolCallId: 'b', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'tick1\n' }], details: {} } });
    expect(tools()[0]?.partial).toBe('tick1\n');
    expect(tools()[0]?.intent).toBe('Running background sleep job');
    // content 是累积语义 → 直接替换而非拼接
    ev({ type: 'tool_execution_update', toolCallId: 'b', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'tick1\ntick2\n' }], details: {} } });
    expect(tools()[0]?.partial).toBe('tick1\ntick2\n');
  });
});

// 默认折叠的判据：含 toolCall 的 assistant 消息里，文本块全是"过程说明"；
// 无 toolCall 的纯文本消息 = 最终回答，不折叠。实测 1554 条消息：371 / 19 / 0（文本在 toolCall 后）。
describe('过程说明判定', () => {
  const lastParts = () => useApp.getState().messages.at(-1)?.parts ?? [];

  it('文本 + toolCall → 文本标记 narration', () => {
    ev({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '我先看一下文件' }] } });
    ev({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先看一下文件' },
          { type: 'toolCall', id: 'tc1', name: 'read' },
          { type: 'thinking', thinking: '想一下' },
        ],
      },
    });
    const text = lastParts().filter((p) => p.kind === 'text');
    expect(text).toHaveLength(1);
    expect(text[0]?.narration).toBe(true);
  });

  it('纯文本（无 toolCall）→ 最终回答，不标记', () => {
    ev({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '结论如下' }] } });
    ev({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '结论如下' }] },
    });
    const text = lastParts().filter((p) => p.kind === 'text');
    expect(text).toHaveLength(1);
    expect(text[0]?.narration).toBeUndefined();
  });
});

// 输入框状态胶囊 / 状态栏共用的三色判定（conn-pill: 红=未连接、绿=就绪、黄=运行中）。
// 该判定必须在两处完全一致，故此处锁定整张真值表；纯函数，无需真起 omp 进程。
describe('连接状态三色', () => {
  const snap = (o: Record<string, unknown>) => ({
    ready: true,
    ompExited: false,
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    currentSessionPath: SP,
    procStateMap: { [SP]: { status: 'online', isStreaming: false, isAborting: false } },
    ...o,
  }) as Parameters<typeof connTone>[0];

  it('未选会话 / 进程未拉起 / 已退出 → 红', () => {
    expect(connTone(snap({ currentSessionPath: undefined }))).toBe('red');
    expect(connTone(snap({ procStateMap: { [SP]: { status: 'offline', isStreaming: false, isAborting: false } } }))).toBe('red');
    // exit code 0 也算退出，不能用 truthy 判断
    expect(connTone(snap({ ompExited: 0 }))).toBe('red');
  });

  it('在线且空闲 → 绿', () => {
    expect(connTone(snap({}))).toBe('green');
  });

  it('连接中 / 生成中 / 压缩中 / 重试中 / 疑似卡死 → 黄', () => {
    expect(connTone(snap({ procStateMap: { [SP]: { status: 'spawning', isStreaming: false, isAborting: false } } }))).toBe('yellow');
    expect(connTone(snap({ isStreaming: true }))).toBe('yellow');
    expect(connTone(snap({ isCompacting: true }))).toBe('yellow');
    expect(connTone(snap({ isRetrying: true }))).toBe('yellow');
    // lastFrameAt 早就超阈值 + 仍在 streaming = 卡死
    expect(connTone(snap({
      procStateMap: { [SP]: { status: 'online', isStreaming: true, isAborting: false, stuckSince: Date.now() - 5 * 60_000 } },
    }))).toBe('yellow');
    expect(connDetail(snap({ isStreaming: true }))).toBe('运行中（生成中）');
  });
});

// 2026-09-13「agent 已回复但 UI 不显示」排查配套（v0.4.44）：
// 三道防线 —— message_end 兜底不丢回复、agent_end 自愈同步显示数组、帧诊断日志存在。
describe('回复不显示三道防线', () => {
  it('防线1：message_start 丢失时 message_end 兜底追加最终回答（不再静默丢弃）', () => {
    // 模拟异常流：没有 message_start / message_update，直接收到 finalized assistant 消息
    ev({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'thinking', thinking: 'THINK' }, { type: 'text', text: '已提交。工作区干净' }],
      },
    });
    const msgs = useApp.getState().messages;
    expect(msgs).toHaveLength(1);
    const m0 = msgs[0]!;
    expect(m0.role).toBe('assistant');
    expect(m0.streaming).toBe(false);
    const text = m0.parts.find((p) => p.kind === 'text');
    expect(text && 'text' in text && text.text).toBe('已提交。工作区干净');
  });

  it('防线1负例：user 消息不兜底（本地已建，omp 回显再追加会重复）', () => {
    ev({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
    expect(useApp.getState().messages).toHaveLength(0);
  });

  it('防线2：agent_end 时 messages 落后于 sessionsMap → 强制同步（自愈）', () => {
    // 正常建一条 assistant 消息进 buffer
    ev({ type: 'message_start', message: { role: 'assistant', content: [] } });
    ev({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'reply' }] } });
    expect(useApp.getState().messages).toHaveLength(1);
    // 模拟失步：显示数组被某处回滚为空，sessionsMap 仍是完整 buffer
    useApp.setState({ messages: [] });
    expect(useApp.getState().messages).toHaveLength(0);
    // 回合结束 → 自愈把 messages 对齐回 buffer
    ev({ type: 'agent_end' });
    expect(useApp.getState().messages).toHaveLength(1);
    expect(useApp.getState().messages[0]?.parts.some((p) => p.kind === 'text')).toBe(true);
  });

  it('诊断日志：帧处理写入 window.__ompDiag 环形缓冲', async () => {
    ev({ type: 'agent_start' });
    const diag = (globalThis as { __ompDiag?: Array<{ type: string; display: boolean }> }).__ompDiag;
    expect(diag).toBeDefined();
    expect(diag!.some((d) => d.type === 'agent_start' && d.display)).toBe(true);
  });
});

// 2026-09-16 串模型事故修复：模型选择按 sessionPath 隔离（lastModelMap），
// B 会话切模型不得影响 A 会话（原全局单值 lastModel + refreshState 自动恢复导致串模型）。
describe('lastModelMap（会话间模型隔离）', () => {
  const A = 'D:/proj/a/session-01.jsonl';
  const B = 'D:/proj/a/session-02.jsonl';
  const glm = { provider: 'z-ai', id: 'glm-5.3-flash', name: 'GLM' };
  const hy3 = { provider: 'moonshot', id: 'kimi-hy3', name: 'HY3' };

  beforeEach(() => {
    useApp.setState({ lastModel: undefined, lastModelMap: {} });
  });

  it('setLastModelForSession 按 sessionPath 各自记录，互不覆盖', () => {
    const st = useApp.getState();
    st.setLastModelForSession(A, glm);
    st.setLastModelForSession(B, hy3);
    const s = useApp.getState();
    expect(s.lastModelMap[A]).toEqual(glm);
    expect(s.lastModelMap[B]).toEqual(hy3);
    // 全局 lastModel 仍记录最近一次选择（新会话兜底用）
    expect(s.lastModel).toEqual(hy3);
  });

  it('migrateLastModelKey：tempKey → realPath 迁移，目标已有记录时不覆盖', () => {
    const st = useApp.getState();
    st.setLastModelForSession('__new_temp1', glm);
    st.migrateLastModelKey('__new_temp1', B);
    expect(useApp.getState().lastModelMap[B]).toEqual(glm);
    expect(useApp.getState().lastModelMap['__new_temp1']).toBeUndefined();

    // 目标已有自己的记录 → 保留目标记录
    useApp.getState().setLastModelForSession(A, hy3);
    useApp.getState().setLastModelForSession('__new_temp2', glm);
    useApp.getState().migrateLastModelKey('__new_temp2', A);
    expect(useApp.getState().lastModelMap[A]).toEqual(hy3);
  });

  it('removeLastModelKey：删除会话时清理记录，无记录时为无害 no-op', () => {
    const st = useApp.getState();
    st.setLastModelForSession(A, glm);
    st.removeLastModelKey(A);
    expect(useApp.getState().lastModelMap[A]).toBeUndefined();
    // no-op 不抛错
    expect(() => useApp.getState().removeLastModelKey(A)).not.toThrow();
  });

  it('恢复优先级：lastModelMap[sp] 优先于全局 lastModel（restoreSessionModel 的取值语义）', () => {
    const st = useApp.getState();
    st.setLastModelForSession(B, hy3);
    // A 无 per-session 记录 → 回退全局 lastModel（B 的选择同时写入了全局）
    const sp = A;
    expect(useApp.getState().lastModelMap[sp]).toBeUndefined();
    expect(useApp.getState().lastModelMap[sp] ?? useApp.getState().lastModel).toEqual(hy3);
    // A 设了自己的记录后 → per-session 记录优先，不再吃全局兜底
    useApp.getState().setLastModelForSession(sp, glm);
    expect(useApp.getState().lastModelMap[sp] ?? useApp.getState().lastModel).toEqual(glm);
  });
});
