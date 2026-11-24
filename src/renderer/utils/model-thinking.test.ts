/**
 * model-thinking.test.ts — 「omp 把模型当不支持思考」的检测与修复方案生成。
 * 真实场景：LocalWBAPI 的 cn:hy4free 上游声明 supports_reasoning + efforts=['high']，
 * 但 omp discovery 只按 id 猜能力 → reasoning:false, thinking:null → 选任何档位都被 clamp 回 off。
 */
import { describe, expect, it } from 'vitest';
import {
  buildThinkingModelEntry,
  hasRuntimeThinking,
  planProviderThinkingSync,
  planThinkingRepair,
} from '../../shared/model-thinking';

describe('hasRuntimeThinking', () => {
  it('reasoning=true 且 efforts 非空 → 可调档位', () => {
    expect(hasRuntimeThinking({ reasoning: true, thinking: { efforts: ['low', 'high'] } })).toBe(true);
  });
  it('reasoning=false → 不可调（omp 会 clamp 回 off）', () => {
    expect(hasRuntimeThinking({ reasoning: false, thinking: { efforts: ['low'] } })).toBe(false);
    expect(hasRuntimeThinking({ reasoning: false })).toBe(false);
  });
  it('reasoning=true 但 efforts 为空 → 同样不可调（Mu() 返回 []）', () => {
    expect(hasRuntimeThinking({ reasoning: true, thinking: {} })).toBe(false);
    expect(hasRuntimeThinking({ reasoning: true, thinking: { efforts: [] } })).toBe(false);
  });
  it('模型还没拿到 → false', () => {
    expect(hasRuntimeThinking(undefined)).toBe(false);
    expect(hasRuntimeThinking(null)).toBe(false);
  });
});

describe('planThinkingRepair', () => {
  it('上游声明支持 + 给了档位 → 按上游档位生成，默认 high', () => {
    const plan = planThinkingRepair({ upstreamReasoning: true, upstreamEfforts: ['low', 'high'] });
    expect(plan).toEqual({ efforts: ['low', 'high'], defaultLevel: 'high' });
  });

  it('hy4free 实际声明：只有 high 档', () => {
    const plan = planThinkingRepair({ upstreamReasoning: true, upstreamEfforts: ['high'] });
    expect(plan).toEqual({ efforts: ['high'], defaultLevel: 'high' });
  });

  it('上游只说支持、不给档位 → 保守用 low/high', () => {
    expect(planThinkingRepair({ upstreamReasoning: true })).toEqual({
      efforts: ['low', 'high'],
      defaultLevel: 'high',
    });
  });

  it('上游没声明支持 → null（不给非思考模型硬开 reasoning）', () => {
    expect(planThinkingRepair({})).toBeNull();
    expect(planThinkingRepair({ upstreamReasoning: false })).toBeNull();
    expect(planThinkingRepair(undefined)).toBeNull();
  });

  it('上游档位里混入非法值 → 过滤掉', () => {
    const plan = planThinkingRepair({ upstreamReasoning: true, upstreamEfforts: ['low', 'bogus' as never] });
    expect(plan?.efforts).toEqual(['low']);
    expect(plan?.defaultLevel).toBe('low');
  });
});

describe('buildThinkingModelEntry', () => {
  const meta = { id: 'cn:hy4free', name: 'Hy4', contextWindow: 960000, maxTokens: 64000 };
  const plan = { efforts: ['low', 'high'] as const, defaultLevel: 'high' as const };

  it('新建条目：带上 reasoning + thinking + 直拉到的 ctx/name', () => {
    const out = buildThinkingModelEntry(undefined, meta, { ...plan, efforts: [...plan.efforts] });
    expect(out).toMatchObject({
      id: 'cn:hy4free',
      name: 'Hy4',
      contextWindow: 960000,
      maxTokens: 64000,
      reasoning: true,
      thinking: { mode: 'effort', efforts: ['low', 'high'], defaultLevel: 'high' },
    });
  });

  it('已有条目：保留旧字段（cost/input/未识别的 extra）只覆盖思考能力', () => {
    const prev = {
      id: 'cn:hy4free',
      name: 'Hy4 自定义名',
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      input: ['text', 'image'],
      reasoning: false,
      thinking: { mode: 'effort', efforts: ['low'], requiresEffort: true },
      extra: { customField: 'keep-me' },
    };
    const out = buildThinkingModelEntry(prev as never, meta, { ...plan, efforts: [...plan.efforts] });
    expect(out.name).toBe('Hy4 自定义名'); // 用户手写的名字优先
    expect(out.cost).toEqual(prev.cost);
    expect(out.input).toEqual(['text', 'image']);
    expect((out as unknown as Record<string, unknown>).customField).toBe('keep-me'); // extra 展开回顶层
    expect(out.reasoning).toBe(true);
    expect(out.thinking).toMatchObject({ mode: 'effort', efforts: ['low', 'high'], defaultLevel: 'high' });
  });

  it('旧条目有 ctx、上游没给 → 保留旧 ctx（不被清空）', () => {
    const prev = { id: 'cn:hy4free', contextWindow: 900000 };
    const out = buildThinkingModelEntry(prev as never, { id: 'cn:hy4free' }, { ...plan, efforts: [...plan.efforts] });
    expect(out.contextWindow).toBe(900000);
  });
});

describe('planProviderThinkingSync — 一次补齐整个 provider', () => {
  const discovered = [
    { provider: 'p', id: 'a', name: 'A', upstreamReasoning: true, upstreamEfforts: ['low', 'high'] as never },
    { provider: 'p', id: 'b', name: 'B', upstreamReasoning: true, upstreamEfforts: ['high'] as never },
    { provider: 'p', id: 'c', name: 'C' }, // 上游没声明 → 不动
  ];

  it('空 yml → 只给上游声明支持的模型新增条目', () => {
    const out = planProviderThinkingSync(undefined, discovered as never);
    expect(out.added).toBe(2);
    expect(out.updated).toBe(0);
    expect(out.models.map((m) => m.id)).toEqual(['a', 'b']);
    expect(Object.keys(out.changed).sort()).toEqual(['a', 'b']);
  });

  it('幂等：已一致的条目不再改写（重复点按钮不会反复写盘重启）', () => {
    const first = planProviderThinkingSync(undefined, discovered as never);
    const second = planProviderThinkingSync(first.models, discovered as never);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.changed).toEqual({});
  });

  it('档位变化（上游调整了 efforts）→ 就地更新同一 id，不重复新增', () => {
    const first = planProviderThinkingSync(undefined, discovered as never);
    const changedUpstream = [
      { provider: 'p', id: 'a', name: 'A', upstreamReasoning: true, upstreamEfforts: ['low'] as never },
    ];
    const out = planProviderThinkingSync(first.models, changedUpstream as never);
    expect(out.added).toBe(0);
    expect(out.updated).toBe(1);
    expect(out.models.filter((m) => m.id === 'a')).toHaveLength(1);
    expect((out.models.find((m) => m.id === 'a') as { thinking?: { efforts?: string[] } }).thinking?.efforts).toEqual(['low']);
  });

  it('only=[id] 只处理指定模型（单模型修复复用批量逻辑）', () => {
    const out = planProviderThinkingSync(undefined, discovered as never, { only: ['b'] });
    expect(out.models.map((m) => m.id)).toEqual(['b']);
  });

  it('上游沉默 + 用户强制档位 → 按强制档位写入（「我知道它能思考」逃生口）', () => {
    const out = planProviderThinkingSync(undefined, [{ provider: 'p', id: 'x' }] as never, {
      forceEfforts: ['low', 'high'],
    });
    expect(out.added).toBe(1);
    expect(out.changed.x).toEqual(['low', 'high']);
    expect(out.models[0]?.reasoning).toBe(true);
  });

  it('上游沉默 + 没强制 → 不写（保持不臆断）', () => {
    const out = planProviderThinkingSync(undefined, [{ provider: 'p', id: 'x' }] as never);
    expect(out.added).toBe(0);
    expect(out.models).toEqual([]);
  });

  it('强制也走幂等：已经一致的条目不会被反复重写', () => {
    const first = planProviderThinkingSync(undefined, [{ provider: 'p', id: 'x' }] as never, {
      forceEfforts: ['low', 'high'],
    });
    const again = planProviderThinkingSync(first.models, [{ provider: 'p', id: 'x' }] as never, {
      forceEfforts: ['low', 'high'],
    });
    expect(again.added + again.updated).toBe(0);
  });

  it('已有条目的其它字段（cost/input/自定义键）在同步时保留', () => {
    const prev = [
      {
        id: 'a',
        name: 'A 手写名',
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        input: ['text', 'image'],
        extra: { keep: true },
      },
    ];
    const out = planProviderThinkingSync(prev as never, discovered as never);
    const a = out.models.find((m) => m.id === 'a') as unknown as Record<string, unknown>;
    expect(a.name).toBe('A 手写名');
    expect(a.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect(a.keep).toBe(true);
    expect(a.reasoning).toBe(true);
  });
});
