/**
 * model-merge.test.ts — 添加/编辑 provider 时，上游声明的思考能力要顺带写进 models.yml。
 * 场景：自定义 provider 的 discovery 不返回 reasoning/thinking（omp 只按 id 猜），
 * 若不在这里补齐，用户加完 provider 后还得为每个模型点一次「修复思考能力」。
 */
import { describe, expect, it } from 'vitest';
import { mergeDiscoveredModels } from './model-merge';
import type { ModelInfo } from './rpc-types';

const base = { provider: 'LocalWBAPI' };

describe('mergeDiscoveredModels — 思考能力自动补齐', () => {
  it('上游声明支持思考 → 条目写入 reasoning + thinking.efforts', () => {
    const discovered: ModelInfo[] = [
      { ...base, id: 'cn:hy4free', name: 'Hy4', upstreamReasoning: true, upstreamEfforts: ['high'] },
    ];
    const m = mergeDiscoveredModels(undefined, discovered)[0]!;
    expect(m.reasoning).toBe(true);
    expect(m.thinking).toMatchObject({ mode: 'effort', efforts: ['high'], defaultLevel: 'high' });
  });

  it('上游只说支持、没给档位 → 用 low/high', () => {
    const m = mergeDiscoveredModels(undefined, [{ ...base, id: 'x', upstreamReasoning: true }])[0]!;
    expect((m.thinking as { efforts?: string[] }).efforts).toEqual(['low', 'high']);
  });

  it('上游没声明（如 xiaomi 只返回 id/object/owned_by）→ 不臆断加 reasoning', () => {
    const m = mergeDiscoveredModels(undefined, [{ ...base, id: 'mimo' }])[0]!;
    expect(m.reasoning).toBeUndefined();
    expect(m.thinking).toBeUndefined();
  });

  it('omp 运行时已给出 efforts → 保持运行时结论，不被上游档位覆盖', () => {
    const discovered: ModelInfo[] = [
      {
        ...base, id: 'y', reasoning: true,
        thinking: { mode: 'effort', efforts: ['minimal', 'low', 'medium', 'high'] },
        upstreamReasoning: true, upstreamEfforts: ['high'],
      },
    ];
    const m = mergeDiscoveredModels(undefined, discovered)[0]!;
    expect((m.thinking as { efforts?: string[] }).efforts).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('已存在的条目（含手写 name/cost）在补齐时保留', () => {
    const prev = [
      { id: 'cn:hy3', name: '我手写的名字', cost: { input: 1 }, extra: { keep: 'yes' } },
    ] as never;
    const m = mergeDiscoveredModels(prev, [
      { ...base, id: 'cn:hy3', name: 'Hy3', upstreamReasoning: true, upstreamEfforts: ['low', 'high'] },
    ])[0]!;
    // 既有语义：discovery 的 name 覆盖旧名（重新发现 = 以上游为准），但手写的 cost/未知字段必须保留
    expect(m.name).toBe('Hy3');
    expect(m.cost).toEqual({ input: 1 });
    expect((m as unknown as Record<string, unknown>).keep).toBe('yes');
    expect(m.reasoning).toBe(true);
  });
});
