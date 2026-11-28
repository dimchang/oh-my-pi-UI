import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useApp, connTone, connDetail, sessionDotStatus, shouldHealStuckStreaming, shouldHealFromDisk, shouldClearStaleRetry, resolveDesiredSessionModel, RETRY_WORK_FRAME_TYPES, RETRY_STALE_MS, hexToHslTriplet } from './store';
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

  it('同批派发的同前缀兄弟（Review 与 Review-UI）不会被当成改名占位淘汰', () => {
    ev({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'task', intent: '审查', args: { tasks: [{ name: 'Review' }, { name: 'Review-UI' }] } });
    ev({
      type: 'tool_execution_update',
      toolCallId: 'c1',
      toolName: 'task',
      partialResult: { content: [], details: { progress: [{ id: 'Review', status: 'running' }, { id: 'Review-UI', status: 'running' }] } },
    });
    const jobs = useApp.getState().subagents;
    expect(jobs.map((j) => j.id)).toEqual(['Review', 'Review-UI']);
    expect(jobs[0]).toMatchObject({ status: 'running', intent: '审查' });
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

  it('工具帧只替换含该工具卡的消息，其余消息保持原引用（回合 memo 依赖引用稳定）', () => {
    ev({ type: 'message_start', message: { role: 'assistant', content: [] } });
    ev({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '上一回合' }] } });
    useApp.getState().appendUserMessage('下一问', undefined, SP);
    ev({ type: 'message_start', message: { role: 'assistant', content: [] } });
    ev({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash' });
    for (const frame of [
      { type: 'tool_execution_update', toolCallId: 'b', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'x' }] } },
      { type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash', result: 'ok' },
    ]) {
      const before = useApp.getState().messages;
      ev(frame);
      const after = useApp.getState().messages;
      expect(after[0]).toBe(before[0]);
      expect(after[1]).toBe(before[1]);
      expect(after[2]).not.toBe(before[2]);
    }
    expect(tools()[0]).toMatchObject({ status: 'done', partial: 'x', result: 'ok' });
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

  it('user 回显只认对应的本地气泡：消息桥投的 prompt / steer 越过排队消息时不改写别的气泡', () => {
    const userTexts = () => useApp.getState().messages
      .filter((m) => m.role === 'user')
      .map((m) => m.parts.map((p) => ('text' in p ? p.text : '')).join(''));
    useApp.getState().appendUserMessage('问题一', undefined, SP);
    ev({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '问题一\n\nAttached files (absolute paths, read them as needed):\n- D:/a.txt' }] } });
    expect(userTexts()).toEqual(['问题一\n\nAttached files (absolute paths, read them as needed):\n- D:/a.txt']);
    // 消息桥（企业微信/飞书）直接投给进程的 prompt：本地无气泡，不得改写「问题一」
    ev({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '来自企业微信的问题' }] } });
    expect(userTexts()[0]).toContain('问题一');
    // 先排队 B、再引导 C：omp 先送达 C、后送达 B，各自只更新自己的气泡
    useApp.getState().appendUserMessage('B', { queued: true }, SP);
    useApp.getState().appendUserMessage('C', { steered: true }, SP);
    ev({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'C' }] } });
    ev({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'B' }] } });
    expect(userTexts().slice(1)).toEqual(['B', 'C']);
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

// 侧栏会话状态点（2026-09-16）：橙=运行中、绿=有结果未查看、红=出错或待确认。
describe('侧栏会话状态点', () => {
  const BG = 'D:/proj/bg-session.jsonl'; // 后台会话（非当前显示）
  const evBg = (frame: Record<string, unknown>): void =>
    useApp.getState().applyAgentEvent({ __sessionPath: BG, ...frame } as Record<string, unknown>);

  beforeEach(() => {
    useApp.setState({
      currentSessionPath: SP,
      messages: [],
      sessionsMap: {},
      procStateMap: {},
      unreadSessions: {},
      sessionErrors: {},
      uiQueue: [],
    });
  });

  const dot = (sp: string) =>
    sessionDotStatus(sp, {
      procStateMap: useApp.getState().procStateMap,
      unreadSessions: useApp.getState().unreadSessions,
      sessionErrors: useApp.getState().sessionErrors,
      uiQueue: useApp.getState().uiQueue,
    });

  it('后台会话 agent_end → 绿点；当前显示会话不打标', () => {
    evBg({ type: 'agent_end' });
    expect(useApp.getState().unreadSessions[BG]).toBe(true);
    expect(dot(BG)).toBe('green');
    // 当前正在显示的会话（SP）回合结束 → 用户正在看，不打标
    ev({ type: 'agent_end' });
    expect(useApp.getState().unreadSessions[SP]).toBeUndefined();
  });

  it('后台会话 message_end stopReason=error → 红点（错误文本入 sessionErrors）', () => {
    evBg({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '404 model not found', content: [] } });
    expect(useApp.getState().sessionErrors[BG]).toBe('404 model not found');
    expect(dot(BG)).toBe('red');
  });

  it('uiQueue 有该会话的待应答请求 → 红点', () => {
    useApp.setState({
      uiQueue: [{ id: 'r1', method: 'confirm', title: '允许执行 bash?', sessionPath: BG, raw: {} }],
    });
    expect(dot(BG)).toBe('red');
  });

  it('isStreaming → 橙点', () => {
    useApp.setState({
      procStateMap: { [BG]: { status: 'online', isStreaming: true, isAborting: false } },
    });
    expect(dot(BG)).toBe('orange');
  });

  it('优先级：红 > 橙 > 绿', () => {
    useApp.setState({
      procStateMap: { [BG]: { status: 'online', isStreaming: true, isAborting: false } },
      unreadSessions: { [BG]: true },
      sessionErrors: { [BG]: 'boom' },
    });
    expect(dot(BG)).toBe('red');
    useApp.setState({ sessionErrors: {} });
    expect(dot(BG)).toBe('orange');
    useApp.setState({ procStateMap: { [BG]: { status: 'online', isStreaming: false, isAborting: false } } });
    expect(dot(BG)).toBe('green');
  });

  it('无任何标记 → null（不显示点）', () => {
    expect(dot(BG)).toBeNull();
  });

  it('setCurrentSessionPath：选中即视为已查看，清掉未读与错误标记', () => {
    evBg({ type: 'agent_end' });
    evBg({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'x', content: [] } });
    expect(dot(BG)).toBe('red');
    useApp.getState().setCurrentSessionPath(BG);
    expect(useApp.getState().currentSessionPath).toBe(BG);
    expect(useApp.getState().unreadSessions[BG]).toBeUndefined();
    expect(useApp.getState().sessionErrors[BG]).toBeUndefined();
    expect(dot(BG)).toBeNull();
  });

  it('migrateSessionStatus / clearSessionStatus：tempKey 迁移与删除清理', () => {
    useApp.setState({ unreadSessions: { __new_t1: true }, sessionErrors: { __new_t1: 'err' } });
    useApp.getState().migrateSessionStatus('__new_t1', BG);
    expect(useApp.getState().unreadSessions[BG]).toBe(true);
    expect(useApp.getState().sessionErrors[BG]).toBe('err');
    expect(useApp.getState().unreadSessions['__new_t1']).toBeUndefined();
    useApp.getState().clearSessionStatus(BG);
    expect(dot(BG)).toBeNull();
    // 无记录时 no-op 不抛错
    expect(() => useApp.getState().clearSessionStatus(BG)).not.toThrow();
  });
});

// 流式状态对账判定（2026-09-16 橙点常亮修复）：omp 的 abort/异常路径不补发 agent_end，
// 帧流断掉后本侧 isStreaming 卡 true。以 omp get_state 为权威真值对账，带新鲜度守卫。
describe('shouldHealStuckStreaming（agent_end 丢失自愈判定）', () => {
  const ps = (o: Record<string, unknown>) =>
    ({ status: 'online', isStreaming: true, isAborting: false, ...o }) as Parameters<typeof shouldHealStuckStreaming>[0];

  it('本侧 streaming + omp 报已结束 + 往返期间无新帧 → 需要自愈', () => {
    const sentAt = 1000;
    expect(shouldHealStuckStreaming(ps({ lastFrameAt: 900 }), false, sentAt)).toBe(true);
    // lastFrameAt 缺失视为很旧 → 需要自愈
    expect(shouldHealStuckStreaming(ps({}), false, sentAt)).toBe(true);
  });

  it('往返期间有新帧 → 帧流是权威，不覆写（可能已 agent_end 或新回合已 agent_start）', () => {
    const sentAt = 1000;
    expect(shouldHealStuckStreaming(ps({ lastFrameAt: 1001 }), false, sentAt)).toBe(false);
  });

  it('omp 仍报 streaming（含 undefined 未知）→ 不自愈（真挂死走 stuck 提示分支）', () => {
    const sentAt = 1000;
    expect(shouldHealStuckStreaming(ps({ lastFrameAt: 900 }), true, sentAt)).toBe(false);
    expect(shouldHealStuckStreaming(ps({ lastFrameAt: 900 }), undefined, sentAt)).toBe(false);
  });

  it('本侧已不 streaming（agent_end 已正常处理）→ 无需对账', () => {
    const sentAt = 1000;
    expect(shouldHealStuckStreaming(ps({ isStreaming: false, lastFrameAt: 900 }), false, sentAt)).toBe(false);
    expect(shouldHealStuckStreaming(undefined, false, sentAt)).toBe(false);
  });
});

// P1 磁盘对账判定（0.5.21，01a0cc6c 事故）：exit 丢失 + RPC 失败时，用 jsonl 尾部
// （最后一条 assistant stopReason==='stop' + mtime 停滞）判定 turn 已完结。
describe('shouldHealFromDisk（磁盘对账自愈判定）', () => {
  const MIN = 60 * 1000;
  const now = 100 * MIN;
  const ps = (o: Record<string, unknown>) =>
    ({ status: 'online', isStreaming: true, isAborting: false, lastFrameAt: now - 20 * MIN, ...o }) as Parameters<typeof shouldHealFromDisk>[0];
  const tail = (o: { mtimeMs: number; lastStopReason?: string }) => o;

  it('全部满足：streaming + stop 收尾 + 渲染层静默 + mtime 停滞 → 自愈', () => {
    expect(shouldHealFromDisk(ps({}), tail({ mtimeMs: now - 20 * MIN, lastStopReason: 'stop' }), now)).toBe(true);
  });

  it('尾部非 stop（error/aborted/无收尾）→ 不自愈（真挂死或异常回合，交给 P0 失败计数）', () => {
    const t = (r: string | undefined) => tail({ mtimeMs: now - 20 * MIN, lastStopReason: r });
    expect(shouldHealFromDisk(ps({}), t('error'), now)).toBe(false);
    expect(shouldHealFromDisk(ps({}), t('aborted'), now)).toBe(false);
    expect(shouldHealFromDisk(ps({}), t(undefined), now)).toBe(false);
    expect(shouldHealFromDisk(ps({}), undefined, now)).toBe(false);
  });

  it('渲染层静默不足（最后帧距今 < 10min）→ 不自愈', () => {
    expect(
      shouldHealFromDisk(ps({ lastFrameAt: now - 5 * MIN }), tail({ mtimeMs: now - 20 * MIN, lastStopReason: 'stop' }), now),
    ).toBe(false);
  });

  it('mtime 仍在推进（omp 可能还在 flush）→ 不自愈', () => {
    expect(
      shouldHealFromDisk(ps({}), tail({ mtimeMs: now - 2 * MIN, lastStopReason: 'stop' }), now),
    ).toBe(false);
  });

  it('本侧已不 streaming → 无需自愈', () => {
    expect(
      shouldHealFromDisk(ps({ isStreaming: false }), tail({ mtimeMs: now - 20 * MIN, lastStopReason: 'stop' }), now),
    ).toBe(false);
  });
});

// P2 灰橙点（0.5.21）：运行中但静默超阈值 → stalled（判据 lastFrameAt，非 stuckSince——
// stuckSince 只在对账成功路径写入，进程失联时永远写不进去，判据会自依赖失效）。
describe('sessionDotStatus stalled（运行中但静默）', () => {
  const snap = (o: Record<string, unknown>) => ({
    procStateMap: { [SP]: { status: 'online', isStreaming: true, isAborting: false, ...o } } as never,
    unreadSessions: {},
    sessionErrors: {},
    uiQueue: [],
  });
  const now = 100 * 60 * 1000;

  it('streaming + 静默 >= 10min → stalled', () => {
    expect(sessionDotStatus(SP, snap({ lastFrameAt: now - 11 * 60 * 1000 }), now)).toBe('stalled');
    // 恰好在阈值上
    expect(sessionDotStatus(SP, snap({ lastFrameAt: now - 10 * 60 * 1000 }), now)).toBe('stalled');
  });

  it('streaming + 静默未超阈值 → orange（正常运行中）', () => {
    expect(sessionDotStatus(SP, snap({ lastFrameAt: now - 5 * 60 * 1000 }), now)).toBe('orange');
  });

  it('lastFrameAt 未知 → 保守显示 orange（不误报 stalled）', () => {
    expect(sessionDotStatus(SP, snap({}), now)).toBe('orange');
  });

  it('红点优先级高于 stalled（等确认 > 静默）', () => {
    const s = {
      ...snap({ lastFrameAt: now - 11 * 60 * 1000 }),
      uiQueue: [{ sessionPath: SP, method: 'confirm', raw: {} }] as never,
    };
    expect(sessionDotStatus(SP, s, now)).toBe('red');
  });
});

// 0.5.40：omp 进程崩溃中断 → 侧栏红点（用户要求从「运行中」橙点改为红点）。
// crashInterrupted 是 crash-interrupt.ts 的运行时标记，用户重发/发新消息后由 store 清除。
describe('sessionDotStatus crashInterrupted（进程崩溃中断 → 红点）', () => {
  const now = 100 * 60 * 1000;
  const crashed = { [SP]: { at: now, source: 'exit' as const } };
  const snap = (o: Record<string, unknown> = {}, withCrash = true) => ({
    procStateMap: { [SP]: { status: 'online', isStreaming: true, isAborting: false, lastFrameAt: now, ...o } } as never,
    unreadSessions: { [SP]: true },
    sessionErrors: {},
    uiQueue: [],
    ...(withCrash ? { crashInterrupted: crashed } : {}),
  });

  it('崩溃中断覆盖 streaming 橙点', () => {
    expect(sessionDotStatus(SP, snap(), now)).toBe('red');
  });

  it('崩溃中断覆盖 stalled 灰橙点与未读绿点', () => {
    expect(sessionDotStatus(SP, snap({ lastFrameAt: now - 11 * 60 * 1000 }), now)).toBe('red');
    expect(sessionDotStatus(SP, { ...snap({ isStreaming: false }), procStateMap: {} }, now)).toBe('red');
  });

  it('未标记崩溃时维持原逻辑（不误报红点）', () => {
    expect(sessionDotStatus(SP, snap({}, false), now)).toBe('orange');
    expect(sessionDotStatus(SP, { ...snap({}, false), procStateMap: {} }, now)).toBe('green');
  });
});

// 2026-09-17「重试中 (1/10)… 常亮」修复：omp 的 auto_retry_end 不保证送达
// （成功路径被 IX(e)/#s>0 两道门挡住就直接 return；失败路径多处只在 #s>1 时补发）。
// 复现：session 01a0ab4b-66c0-750d-b8e0-0e3a01775714 断网触发重试，网络恢复后同一回合
// 正常续跑、后续多轮对话全部 stopReason=stop，但结束帧始终没到 → 气泡永久常亮。
describe('重试气泡终结（auto_retry_end 丢失兜底）', () => {
  const BG = 'D:/proj-bg';
  const reset = (): void =>
    useApp.setState({
      currentSessionPath: SP,
      isRetrying: false,
      retryInfo: '',
      retrySessionPath: null,
      retryStartedAt: 0,
    });
  /** 制造一次进行中的重试气泡（模拟 auto_retry_start，与实测帧一致） */
  const startRetry = (): void =>
    ev({ type: 'auto_retry_start', attempt: 1, maxAttempts: 10, delayMs: 5000, errorMessage: 'socket closed' });

  beforeEach(reset);

  it('auto_retry_start → 气泡出现并记录归属', () => {
    startRetry();
    const s = useApp.getState();
    expect(s.isRetrying).toBe(true);
    expect(s.retryInfo).toBe('重试中 (1/10)…');
    expect(s.retrySessionPath).toBe(SP);
  });

  it('auto_retry_end（正常路径）→ 气泡清除', () => {
    startRetry();
    ev({ type: 'auto_retry_end', success: true, attempt: 1 });
    expect(useApp.getState().isRetrying).toBe(false);
    expect(useApp.getState().retrySessionPath).toBeNull();
  });

  it('关键回归：结束帧丢失时，回合内出现「干活」帧即终结气泡', () => {
    // 断网那次的失败回合：message_end(error) + agent_end 不得清掉气泡（否则退避期间气泡会闪没）
    startRetry();
    ev({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'socket closed', content: [{ type: 'thinking', thinking: 'x' }] },
    });
    expect(useApp.getState().isRetrying).toBe(true);
    ev({ type: 'agent_end' });
    expect(useApp.getState().isRetrying).toBe(true);
    // 网络恢复：重试续跑开始产出（agent_start / message_update / 工具执行任一命中即可）
    ev({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '继续' }] } });
    expect(useApp.getState().isRetrying).toBe(false);
    expect(useApp.getState().retryInfo).toBe('');
    expect(useApp.getState().retrySessionPath).toBeNull();
  });

  it('agent_start / tool_execution_* 同样是终结信号', () => {
    for (const frame of [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: 'ok' },
    ]) {
      reset();
      startRetry();
      ev(frame);
      expect(useApp.getState().isRetrying, JSON.stringify(frame)).toBe(false);
    }
  });

  it('归属隔离：别的会话的帧不会清掉本会话气泡，切会话则清', () => {
    startRetry();
    // 后台会话的干活帧 → 不影响本会话气泡
    useApp.getState().applyAgentEvent({ __sessionPath: BG, type: 'agent_start' } as Record<string, unknown>);
    expect(useApp.getState().isRetrying).toBe(true);
    // 切到别的会话 → 气泡不跟着串台
    useApp.getState().setCurrentSessionPath(BG);
    expect(useApp.getState().isRetrying).toBe(false);
    expect(useApp.getState().retrySessionPath).toBeNull();
  });

  it('shouldClearStaleRetry：超阈值才算过期，新一轮 auto_retry_start 会刷新计时', () => {
    expect(shouldClearStaleRetry(false, 1000, 1000 + RETRY_STALE_MS)).toBe(false);
    expect(shouldClearStaleRetry(true, 1000, 1000 + RETRY_STALE_MS - 1)).toBe(false);
    expect(shouldClearStaleRetry(true, 1000, 1000 + RETRY_STALE_MS)).toBe(true);
    // lastStartAt 缺失（0）视为未知，不误清
    expect(shouldClearStaleRetry(true, 0, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('RETRY_WORK_FRAME_TYPES 不含收尾类帧（避免退避期间误清）', () => {
    expect(RETRY_WORK_FRAME_TYPES.has('message_end')).toBe(false);
    expect(RETRY_WORK_FRAME_TYPES.has('agent_end')).toBe(false);
    expect(RETRY_WORK_FRAME_TYPES.has('auto_retry_start')).toBe(false);
  });
});

// 每会话草稿（2026-10-25）：输入框文字/附件按 sessionPath 隔离，切会话不串。
describe('每会话草稿', () => {
  const A = 'D:/proj/sess-a.jsonl';
  const B = 'D:/proj/sess-b.jsonl';

  beforeEach(() => {
    useApp.setState({ composerDrafts: {}, currentSessionPath: A });
  });

  it('两个会话的草稿互不影响', () => {
    const st = useApp.getState();
    st.setComposerText(A, '给 A 的任务');
    st.setComposerText(B, '给 B 的任务');
    expect(useApp.getState().composerDrafts[A]!.text).toBe('给 A 的任务');
    expect(useApp.getState().composerDrafts[B]!.text).toBe('给 B 的任务');
    // 清空 A 不影响 B
    useApp.getState().clearComposerDraft(A);
    expect(useApp.getState().composerDrafts[A]).toBeUndefined();
    expect(useApp.getState().composerDrafts[B]!.text).toBe('给 B 的任务');
  });

  it('写文本不清掉该会话已选附件，反之亦然', () => {
    const st = useApp.getState();
    st.setComposerAttachments(A, [{ path: 'D:/proj/a.png', name: 'a.png', kind: 'image' }]);
    useApp.getState().setComposerText(A, '带图的任务');
    expect(useApp.getState().composerDrafts[A]!.attachments).toHaveLength(1);
    expect(useApp.getState().composerDrafts[A]!.text).toBe('带图的任务');
  });

  it('migrateComposerDraft：tempKey → realPath 草稿跟随；目标已有草稿时以目标为准', () => {
    const st = useApp.getState();
    st.setComposerText('__new_t1', 'temp 草稿');
    useApp.getState().migrateComposerDraft('__new_t1', A);
    expect(useApp.getState().composerDrafts['__new_t1']).toBeUndefined();
    expect(useApp.getState().composerDrafts[A]!.text).toBe('temp 草稿');

    st.setComposerText('__new_t2', '旧');
    useApp.getState().setComposerText(A, '新');
    useApp.getState().migrateComposerDraft('__new_t2', A);
    expect(useApp.getState().composerDrafts[A]!.text).toBe('新');
  });
});

// 进程重起后的模型恢复取值（2026-10-25「会话1模型被改成别的会话刚选的模型」修复）。
describe('resolveDesiredSessionModel', () => {
  const glm = { provider: 'openrouter', id: 'z-ai/glm-5.3-flash' };
  const deepseek = { provider: 'deepseek', id: 'deepseek-chat' };
  const real = 'D:/proj/sess-a.jsonl';

  it('有 per-session 记录 → 用记录，即便全局 lastModel 是别的', () => {
    expect(resolveDesiredSessionModel(real, { [real]: deepseek }, glm)).toEqual(deepseek);
  });

  it('无记录的老会话 → undefined（绝不回退全局，避免覆盖 omp 从会话文件恢复的模型）', () => {
    expect(resolveDesiredSessionModel(real, {}, glm)).toBeUndefined();
  });

  it('无记录的新会话（tempKey）→ 回退全局 lastModel（新开会话跟最后一次模型走）', () => {
    expect(resolveDesiredSessionModel('__new_abc', {}, glm)).toEqual(glm);
  });

  it('新会话也没有全局记录时 → undefined（omp 用 config 默认模型）', () => {
    expect(resolveDesiredSessionModel('__new_abc', {}, undefined)).toBeUndefined();
  });
});

// sessionModels 展示层快照：切会话时按会话回显，避免显示上一个会话的模型。
describe('sessionModels 快照', () => {
  const A = 'D:/proj/sess-a.jsonl';
  const B = 'D:/proj/sess-b.jsonl';
  const glm = { provider: 'openrouter', id: 'z-ai/glm-5.3-flash' };
  const deepseek = { provider: 'deepseek', id: 'deepseek-chat' };

  beforeEach(() => {
    useApp.setState({ sessionModels: {}, lastModelMap: {}, lastModel: undefined });
  });

  it('setSessionModel 只影响该会话', () => {
    useApp.getState().setSessionModel(A, deepseek);
    useApp.getState().setSessionModel(B, glm);
    expect(useApp.getState().sessionModels[A]).toEqual(deepseek);
    expect(useApp.getState().sessionModels[B]).toEqual(glm);
  });

  it('tempKey 迁移时快照跟随；删除会话时清理', () => {
    useApp.getState().setSessionModel('__new_x', deepseek);
    useApp.getState().migrateLastModelKey('__new_x', A);
    expect(useApp.getState().sessionModels['__new_x']).toBeUndefined();
    expect(useApp.getState().sessionModels[A]).toEqual(deepseek);
    useApp.getState().removeLastModelKey(A);
    expect(useApp.getState().sessionModels[A]).toBeUndefined();
  });
});

// 新会话身份与侧栏去重（2026-10-25）：omp 在 spawn 后就分配真实 sessionFile（文件稍后才建），
// 于是「假占位 `__new_x`」与「它自己的真文件」曾在侧栏同时出现，并且继续对话时又裂出第三个 id。
describe('tempKey → 真实 sessionFile 绑定', () => {
  const REAL = 'D:/sessions/2026-10-25T04-10-46-541Z_01a17140.jsonl';
  const OTHER = 'D:/sessions/2026-10-25T04-13-16-919Z_01a17143.jsonl';
  const TEMP = '__new_6d4f45dc';

  beforeEach(() => {
    useApp.setState({
      tempRealPath: {}, pendingLocalSessions: {}, uncommittedSessions: {},
      sessions: [], sessionsMap: {}, procStateMap: {}, currentSessionPath: undefined,
      composerDrafts: {},
    });
  });

  it('bindTempRealPath：忽略非 tempKey 与仍是 tempKey 的值，同一真文件只绑一个', () => {
    const st = useApp.getState();
    st.bindTempRealPath('D:/x.jsonl', REAL);           // 非 tempKey → 忽略
    st.bindTempRealPath(TEMP, '__new_other');          // 还是假 key → 忽略
    st.bindTempRealPath(TEMP, REAL);
    expect(useApp.getState().tempRealPath[TEMP]).toBe(REAL);
    // 另一个 tempKey 想绑同一个真文件 → 不允许
    st.bindTempRealPath('__new_second', REAL);
    expect(useApp.getState().tempRealPath['__new_second']).toBeUndefined();
  });

  it('setSessions 隐藏被绑定过的真实条目（避免"假占位 + 真文件"两条）', () => {
    const st = useApp.getState();
    st.upsertSessionPlaceholder(TEMP, 'D:/proj');
    st.bindTempRealPath(TEMP, REAL);
    useApp.getState().setSessions([
      { path: REAL, id: REAL, cwd: 'D:/proj', title: 'a', mtime: 2, cwdExists: true },
      { path: OTHER, id: OTHER, cwd: 'D:/proj', title: 'b', mtime: 1, cwdExists: true },
    ]);
    const paths = useApp.getState().sessions.map((x) => x.path);
    expect(paths).toContain(TEMP);          // 占位在
    expect(paths).toContain(OTHER);         // 别的会话正常显示
    expect(paths).not.toContain(REAL);      // 自己的真文件被占位挡住，不重复
  });

  it('绑定解除后真实条目恢复显示（temp 占位由 rekey 负责移除，不是这里）', () => {
    const st = useApp.getState();
    st.upsertSessionPlaceholder(TEMP, 'D:/proj');
    st.bindTempRealPath(TEMP, REAL);
    useApp.getState().setSessions([{ path: REAL, id: REAL, cwd: 'D:/proj', title: 'a', mtime: 2, cwdExists: true }]);
    expect(useApp.getState().sessions.map((x) => x.path)).toEqual([TEMP]);
    useApp.getState().unbindTempRealPath(TEMP);
    useApp.getState().setSessions([{ path: REAL, id: REAL, cwd: 'D:/proj', title: 'a', mtime: 2, cwdExists: true }]);
    // 解绑后真实条目重新可见（temp 占位仍留着——真实迁移时由 applySessionRekey 移除）
    expect(useApp.getState().sessions.map((x) => x.path)).toContain(REAL);
  });

  it('uncommitted 会话在扫盘看不到时也留在侧栏（.jsonl 要等首条消息才创建）', () => {
    const st = useApp.getState();
    st.markUncommitted(REAL);
    st.upsertSessionPlaceholder(REAL, 'D:/proj');
    // 扫盘为空（文件还没创建）
    useApp.getState().setSessions([]);
    expect(useApp.getState().sessions.map((x) => x.path)).toEqual([REAL]);
    // 提交过消息 → 不再靠 uncommitted 保留；pending 过期后交给扫盘
    useApp.getState().commitSession(REAL);
    useApp.setState({ pendingLocalSessions: {} });
    useApp.getState().setSessions([]);
    expect(useApp.getState().sessions).toEqual([]);
  });

  it('pendingLocalSessions 过期后不再保留（防陈旧条目滞留）', () => {
    const st = useApp.getState();
    st.markPendingLocalSession(REAL, -1); // 已过期
    useApp.getState().setSessions([]);    // 但 sessions 里本来也没有它
    expect(useApp.getState().sessions).toEqual([]);
    // 未过期 + 条目存在 → 保留
    useApp.getState().upsertSessionPlaceholder(OTHER, 'D:/proj');
    useApp.getState().commitSession(OTHER);
    useApp.getState().markPendingLocalSession(OTHER, 60_000);
    useApp.getState().setSessions([]);
    expect(useApp.getState().sessions.map((x) => x.path)).toEqual([OTHER]);
  });

  it('migrateUncommitted：换 key 时标记跟随（新建会话 spawn 后换成真实 id）', () => {
    const st = useApp.getState();
    st.markUncommitted(TEMP);
    useApp.getState().migrateUncommitted(TEMP, REAL);
    expect(useApp.getState().uncommittedSessions[TEMP]).toBeUndefined();
    expect(useApp.getState().uncommittedSessions[REAL]).toBe(true);
  });
});

// 删除墓碑（2026-10-25）：右键删除后扫盘可能把旧条目带回来（文件删除是异步的 /
// 进程退出前 flush），表现为"删不掉"。
describe('已删除会话的墓碑', () => {
  const REAL = 'D:/sessions/x_01a1715d.jsonl';
  const row = { path: REAL, id: REAL, cwd: 'D:/proj', title: 't', mtime: 1, cwdExists: true };

  beforeEach(() => {
    useApp.setState({
      suppressedSessions: {}, uncommittedSessions: {}, pendingLocalSessions: {},
      sessions: [], sessionsMap: {}, procStateMap: {}, currentSessionPath: undefined, composerDrafts: {},
    });
  });

  it('墓碑有效期内：扫盘扫到也不显示（即使 uncommitted 还留着）', () => {
    useApp.getState().markUncommitted(REAL);
    useApp.getState().upsertSessionPlaceholder(REAL, 'D:/proj');
    useApp.getState().suppressSession(REAL, 60_000);
    useApp.getState().setSessions([row]);
    expect(useApp.getState().sessions).toEqual([]);
  });

  it('墓碑过期后恢复正常显示', () => {
    useApp.getState().suppressSession(REAL, -1); // 已过期
    useApp.getState().setSessions([row]);
    expect(useApp.getState().sessions.map((x) => x.path)).toEqual([REAL]);
    // 过期项会被顺手清理掉，不留垃圾
    expect(useApp.getState().suppressedSessions[REAL]).toBeUndefined();
  });
});

describe('切会话清压缩提示', () => {
  it('切走后原会话的 auto_compaction_end 不再生效 → 切会话时必须清掉，否则新会话常亮「压缩中」', () => {
    ev({ type: 'auto_compaction_start' });
    expect(useApp.getState().isCompacting).toBe(true);
    useApp.getState().setCurrentSessionPath('D:/proj/other.jsonl');
    ev({ type: 'auto_compaction_end' }); // 原会话（已非显示）的结束帧
    expect(useApp.getState().isCompacting).toBe(false);
    expect(useApp.getState().compactionInfo).toBe('');
  });
});

// 多进程：每会话一进程，setOmpExited 只能影响当前显示会话（onReady 对任意会话都会调 setOmpExited(null)）
describe('setOmpExited（多进程隔离）', () => {
  const BG = 'D:/proj/bg-session.jsonl';
  beforeEach(() => {
    useApp.setState({
      currentSessionPath: SP,
      ompExited: false,
      isStreaming: true,
      isAborting: false,
      procStateMap: {
        [SP]: { status: 'online', isStreaming: true, isAborting: false },
        [BG]: { status: 'online', isStreaming: true, isAborting: false },
      },
    });
  });

  it('别的会话进程 ready（code=null）不清掉当前会话仍在进行的流式标志', () => {
    useApp.getState().setOmpExited(null);
    expect(useApp.getState().ompExited).toBeNull();
    expect(useApp.getState().isStreaming).toBe(true);
  });

  it('当前会话进程退出只重置该会话，后台会话的进程状态不受影响', () => {
    useApp.getState().setOmpExited(1);
    const s = useApp.getState();
    expect(s.ompExited).toBe(1);
    expect(s.isStreaming).toBe(false);
    expect(s.procStateMap[SP]).toMatchObject({ status: 'offline', isStreaming: false });
    expect(s.procStateMap[BG]).toMatchObject({ status: 'online', isStreaming: true });
  });
});

describe('loadSessionMessages', () => {
  const A = 'D:/proj/a.jsonl';
  const B = 'D:/proj/b.jsonl';
  const g = globalThis as { window?: unknown };
  let prevWindow: unknown;
  const resolvers = new Map<string, (msgs: unknown[]) => void>();

  beforeEach(() => {
    prevWindow = g.window;
    resolvers.clear();
    g.window = {
      omp: {
        readSessionMessages: (p: string) => new Promise((r) => { resolvers.set(p, r); }),
        saveWorkspaces: () => Promise.resolve(),
      },
    };
    useApp.setState({ currentSessionPath: A, messages: [], sessionsMap: {}, procStateMap: {} });
  });
  afterEach(() => {
    g.window = prevWindow;
  });

  it('别的会话的读盘不会让当前会话的读盘结果被丢弃', async () => {
    useApp.getState().loadSessionMessages(A);
    useApp.getState().loadSessionMessages(B); // 如看门狗对后台会话的 healFromDisk
    await vi.waitFor(() => expect(resolvers.has(A) && resolvers.has(B)).toBe(true));
    resolvers.get(A)!([{ role: 'user', content: [{ type: 'text', text: 'hi A' }] }]);
    resolvers.get(B)!([{ role: 'user', content: [{ type: 'text', text: 'hi B' }] }]);
    await vi.waitFor(() => expect(useApp.getState().sessionsMap[B]).toHaveLength(1));
    await vi.waitFor(() => expect(useApp.getState().messages).toHaveLength(1));
    expect(useApp.getState().sessionsMap[A]).toHaveLength(1);
  });

  it('同一会话的旧读盘结果仍被新一次加载取代', async () => {
    useApp.getState().loadSessionMessages(A);
    await vi.waitFor(() => expect(resolvers.has(A)).toBe(true));
    const first = resolvers.get(A)!;
    resolvers.delete(A);
    useApp.getState().loadSessionMessages(A);
    await vi.waitFor(() => expect(resolvers.has(A)).toBe(true));
    resolvers.get(A)!([{ role: 'user', content: [{ type: 'text', text: 'new' }] }, { role: 'user', content: [{ type: 'text', text: 'new2' }] }]);
    await vi.waitFor(() => expect(useApp.getState().messages).toHaveLength(2));
    first([{ role: 'user', content: [{ type: 'text', text: 'old' }] }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(useApp.getState().messages).toHaveLength(2);
  });
});

describe('hexToHslTriplet', () => {
  it('把自定义强调色 hex 转成 styles.css --accent-* 需要的 HSL 分量', () => {
    expect(hexToHslTriplet('#0a84ff')).toBe('210 100% 52%');
    expect(hexToHslTriplet('#fff')).toBe('0 0% 100%');
    expect(hexToHslTriplet('red')).toBeNull();
  });
});

describe('OMP 19.1.1 适配事件与工具函数', () => {
  beforeEach(() => {
    useApp.setState({
      currentSessionPath: SP,
      messages: [],
      sessionsMap: { [SP]: [] },
      procStateMap: {},
      subagents: [],
      queuedMessagesMap: {},
      btwPanel: null,
      isCompacting: false,
      compactionInfo: '',
    });
  });

  it('delta 模式 message_update（无 content[]）能正确累积 thinking_delta 和 text_delta', () => {
    ev({ type: 'message_start', message: { role: 'assistant', content: [] } });
    ev({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'thinking_delta', delta: '思考' },
    });
    ev({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'thinking_delta', delta: '完成' },
    });
    ev({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', delta: '你好，' },
    });
    ev({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', delta: '世界！' },
    });
    const parts = useApp.getState().messages[0]?.parts ?? [];
    expect(parts).toEqual([
      { kind: 'thinking', text: '思考完成' },
      { kind: 'text', text: '你好，世界！' },
    ]);
  });

  it('manual_compaction_start / manual_compaction_end 正确切换压缩状态', () => {
    ev({ type: 'manual_compaction_start' });
    expect(useApp.getState().isCompacting).toBe(true);
    expect(useApp.getState().compactionInfo).toContain('手动压缩');
    ev({ type: 'manual_compaction_end' });
    expect(useApp.getState().isCompacting).toBe(false);
    expect(useApp.getState().compactionInfo).toBe('');
  });

  it('queue_update 同步原生 steering / followUp 排队列表', () => {
    ev({
      type: 'queue_update',
      queuedMessages: { steering: ['先看测试'], followUp: ['再更新文档', '最后提交'] },
    });
    expect(useApp.getState().queuedMessagesMap[SP]).toEqual({
      steering: ['先看测试'],
      followUp: ['再更新文档', '最后提交'],
    });
  });

  it('btw_delta / btw_record 驱动 /btw 旁路回答流', () => {
    ev({ type: 'btw_delta', delta: '答案是 ', topicId: 't1' });
    ev({ type: 'btw_delta', delta: '42', topicId: 't1' });
    expect(useApp.getState().btwPanel).toMatchObject({
      open: true,
      streaming: true,
      topicId: 't1',
      answer: '答案是 42',
    });
    ev({ type: 'btw_record', question: '生命的意义', answer: '答案是 42', topicId: 't1' });
    expect(useApp.getState().btwPanel).toMatchObject({
      open: true,
      streaming: false,
      question: '生命的意义',
      answer: '答案是 42',
    });
  });

  it('wait 工具（omp 18.8+ 取代 hub）也能更新子智能体作业状态', () => {
    ev({
      type: 'tool_execution_start',
      toolCallId: 'w1',
      toolName: 'wait',
      args: { jobs: ['job-1'] },
    });
    ev({
      type: 'tool_execution_end',
      toolCallId: 'w1',
      toolName: 'wait',
      isError: false,
      result: {
        details: {
          jobs: [{ id: 'job-1', type: 'task', status: 'completed', durationMs: 1200, resolvedModel: 'claude' }],
        },
      },
    });
    expect(useApp.getState().subagents).toHaveLength(1);
    expect(useApp.getState().subagents[0]).toMatchObject({
      id: 'job-1',
      status: 'completed',
      durationMs: 1200,
    });
  });
});
