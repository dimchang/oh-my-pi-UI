/**
 * workspace-reconcile 单测 —— 覆盖幽灵工作区事故的判定规则。
 * 事故等价场景 = 「会话 cwd 指向不存在且未注册的目录」→ 不得生成工作区（plan.toAdd 为空）。
 */
import { describe, it, expect } from 'vitest';
import { planWorkspaceReconcile } from './workspace-reconcile';
import { cwdKey, makeWorkspaceId } from './path-key';
import type { Workspace } from '../../shared/ipc-channels';

const ws = (cwd: string, over: Partial<Workspace> = {}): Workspace => ({
  id: makeWorkspaceId(cwd),
  cwd,
  displayName: cwd.split(/[\\/]/).pop() ?? cwd,
  collapsed: false,
  createdAt: 1,
  ...over,
});

const base = {
  workspaces: [] as Workspace[],
  archived: [] as Workspace[],
  removedCwds: [] as string[],
  staleCwds: [] as string[],
  currentId: null as string | null,
};

describe('planWorkspaceReconcile — 幽灵防护（R2）', () => {
  it('会话 cwd 指向不存在且未注册的目录 → 不生成工作区（事故等价场景）', () => {
    const plan = planWorkspaceReconcile({
      ...base,
      sessions: [{ cwd: 'D:\\code\\OMP-UI\\.temp\\scratch-ws', cwdExists: false }],
    });
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.changed).toBe(false);
  });

  it('cwdExists 为 true 且未注册 → 正常补全，displayName 取 basename', () => {
    const plan = planWorkspaceReconcile({
      ...base,
      sessions: [{ cwd: 'D:\\code\\my-proj', cwdExists: true }],
    });
    expect(plan.toAdd).toHaveLength(1);
    expect(plan.toAdd[0]).toMatchObject({
      id: 'd:/code/my-proj',
      cwd: 'D:\\code\\my-proj',
      displayName: 'my-proj',
    });
    expect(plan.changed).toBe(true);
  });

  it('cwdExists 缺省（占位会话/老数据）按存在处理，不跳过', () => {
    const plan = planWorkspaceReconcile({
      ...base,
      sessions: [{ cwd: 'D:\\code\\legacy' }],
    });
    expect(plan.toAdd).toHaveLength(1);
  });

  it('同 cwd 多个会话只补一个工作区', () => {
    const plan = planWorkspaceReconcile({
      ...base,
      sessions: [
        { cwd: 'D:\\code\\dup', cwdExists: true },
        { cwd: 'd:/code/dup', cwdExists: true },
      ],
    });
    expect(plan.toAdd).toHaveLength(1);
  });

  it('已注册 / 已归档 / 在 removedCwds 中的 cwd → 跳过', () => {
    const plan = planWorkspaceReconcile({
      ...base,
      sessions: [
        { cwd: 'D:\\code\\reg', cwdExists: true },
        { cwd: 'D:\\code\\arch', cwdExists: true },
        { cwd: 'D:\\code\\removed', cwdExists: true },
      ],
      workspaces: [ws('D:\\code\\reg')],
      archived: [ws('D:\\code\\arch')],
      removedCwds: ['d:\\code\\removed'],
    });
    expect(plan.toAdd).toHaveLength(0);
  });
});

describe('planWorkspaceReconcile — currentId 失效回退（R3 前置）', () => {
  const reg = [ws('D:\\code\\a'), ws('D:\\code\\b')];

  it('currentId 指向失效工作区 → 回退到第一个非失效工作区', () => {
    const plan = planWorkspaceReconcile({
      ...base,
      sessions: [],
      workspaces: reg,
      staleCwds: ['D:\\code\\a'],
      currentId: 'd:/code/a',
    });
    expect(plan.nextCurrentId).toBe('d:/code/b');
    expect(plan.changed).toBe(true);
  });

  it('全部工作区失效 → nextCurrentId 为 null（调用方提示用户重选）', () => {
    const plan = planWorkspaceReconcile({
      ...base,
      sessions: [],
      workspaces: reg,
      staleCwds: ['D:\\code\\a', 'D:\\code\\b'],
      currentId: 'd:/code/b',
    });
    expect(plan.nextCurrentId).toBeNull();
    expect(plan.changed).toBe(true);
  });

  it('currentId 有效 → 原样返回，changed 不因回退逻辑误报', () => {
    const plan = planWorkspaceReconcile({
      ...base,
      sessions: [],
      workspaces: reg,
      staleCwds: ['D:\\code\\a'],
      currentId: 'd:/code/b',
    });
    expect(plan.nextCurrentId).toBe('d:/code/b');
    expect(plan.changed).toBe(false);
  });

  it('staleCwds 大小写/斜杠差异不影响判定（cwdKey 归一）', () => {
    const plan = planWorkspaceReconcile({
      ...base,
      sessions: [],
      workspaces: reg,
      staleCwds: ['d:/CODE/A/'],
      currentId: 'd:/code/a',
    });
    expect(plan.nextCurrentId).toBe('d:/code/b');
  });
});

describe('不变量守护：Workspace.id === cwdKey(cwd)', () => {
  it('makeWorkspaceId 与 cwdKey 一致（staleCwds 比较 / staleIds 直接查 id 的前提）', () => {
    for (const p of [
      'D:\\code\\OMP-UI\\.temp\\scratch-ws',
      'd:/code/omp-ui',
      'D:\\code\\a\\',
      'C:\\Users\\17593\\AppData\\Local\\Temp\\probe-1',
    ]) {
      expect(makeWorkspaceId(p)).toBe(cwdKey(p));
    }
  });

  it('staleCwds（原始大小写/反斜杠）能直接命中对应工作区 id', () => {
    const plan = planWorkspaceReconcile({
      ...base,
      sessions: [],
      workspaces: [ws('D:\\code\\OMP-UI\\.temp\\scratch-ws')],
      staleCwds: ['D:\\code\\OMP-UI\\.temp\\scratch-ws'],
      currentId: 'd:/code/omp-ui/.temp/scratch-ws',
    });
    expect(plan.nextCurrentId).toBeNull();
  });
});
