/**
 * available-models.test.ts — fetchAvailableModels 合并链路回归测试：
 * omp RPC 成功但目录不含自定义 provider 模型时（真实发生过的 bug），
 * 必须并入 yml 显式 models，并对缺失的 provider 按 discovery 直拉补齐，
 * 而不是把残缺的 RPC 结果原样展示（UI 全部 0/0）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mergeModelFields, mergeProviderScoped } from './available-models';

const getAvailableModels = vi.fn();

vi.mock('../rpc-client', () => ({
  rpc: { getAvailableModels: (...a: unknown[]) => getAvailableModels(...a) },
}));

type OmpStub = {
  readModelsConfig: () => Promise<unknown>;
  fetchProviderModels: (pid?: string) => Promise<unknown[]>;
  loadModelsCache: () => Promise<unknown[]>;
  saveModelsCache: (m: unknown[]) => Promise<void>;
};

function stubOmp(over: Partial<OmpStub>) {
  (globalThis as { window?: unknown }).window = {
    omp: {
      readModelsConfig: async () => ({ providers: {} }),
      fetchProviderModels: async () => [],
      loadModelsCache: async () => [],
      saveModelsCache: async () => {},
      ...over,
    },
  };
}

async function loadFresh() {
  vi.resetModules();
  return import('./available-models');
}

const YML = {
  providers: {
    gemini: { baseUrl: 'https://x', api: 'openai-completions', models: [{ id: 'gemini-a' }] },
    deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', discovery: { type: 'openai-models-list' } },
  },
};

beforeEach(() => {
  getAvailableModels.mockReset();
  stubOmp({ readModelsConfig: async () => YML });
});

describe('fetchAvailableModels 合并链路', () => {
  it('RPC 成功但缺自定义 provider → 并入 yml models + 直拉补齐', async () => {
    getAvailableModels.mockResolvedValue({ success: true, data: { models: [{ provider: 'builtin', id: 'gpt' }] } });
    const fetched: string[] = [];
    stubOmp({
      readModelsConfig: async () => YML,
      fetchProviderModels: async () => {
        fetched.push('pull');
        return [{ provider: 'deepseek', id: 'deepseek-v4-flash' }];
      },
    });
    const { fetchAvailableModels } = await loadFresh();
    const res = await fetchAvailableModels('s1');
    expect(fetched).toEqual(['pull']); // 缺失 provider 触发了直拉
    // 顺序规则：本次新鲜结果（RPC → 直拉补齐）在前，yml 显式 models 在后
    expect(res.models.map((m: { provider: string; id: string }) => `${m.provider}/${m.id}`))
      .toEqual(['builtin/gpt', 'deepseek/deepseek-v4-flash', 'gemini/gemini-a']);
    expect(res.fallback).toBe(false);
  });

  it('RPC 成功且目录完整 → 不打直拉网络请求', async () => {
    getAvailableModels.mockResolvedValue({
      success: true,
      data: { models: [{ provider: 'gemini', id: 'gemini-a' }, { provider: 'deepseek', id: 'm1' }] },
    });
    let pulls = 0;
    stubOmp({
      readModelsConfig: async () => YML,
      fetchProviderModels: async () => { pulls += 1; return []; },
    });
    const { fetchAvailableModels } = await loadFresh();
    const res = await fetchAvailableModels('s1');
    expect(pulls).toBe(0);
    expect(res.fallback).toBe(false);
  });

  it('RPC 失败 → 缓存 + yml + 直拉兜底，标记 fallback', async () => {
    getAvailableModels.mockRejectedValue(new Error('transport limit'));
    stubOmp({
      readModelsConfig: async () => YML,
      fetchProviderModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro' }],
      loadModelsCache: async () => [{ provider: 'old', id: 'cached' }],
    });
    const { fetchAvailableModels } = await loadFresh();
    const res = await fetchAvailableModels('s1');
    expect(res.models.map((m: { provider: string }) => m.provider).sort())
      .toEqual(['deepseek', 'gemini', 'old']);
    expect(res.fallback).toBe(true);
    expect(res.reason).toContain('transport limit');
  });

  it('cacheOnly：只读缓存 + yml，不打 RPC、不直拉', async () => {
    let rpcCalls = 0;
    getAvailableModels.mockImplementation(() => { rpcCalls += 1; return Promise.reject(new Error('should not')); });
    stubOmp({
      readModelsConfig: async () => YML,
      fetchProviderModels: async () => { throw new Error('should not pull'); },
      loadModelsCache: async () => [{ provider: 'cache', id: 'c1' }],
    });
    const { fetchAvailableModels } = await loadFresh();
    const res = await fetchAvailableModels('s1', { cacheOnly: true });
    expect(rpcCalls).toBe(0);
    expect(res.models.map((m: { provider: string }) => m.provider).sort()).toEqual(['cache', 'gemini']);
  });
});

describe('mergeProviderScoped — 幽灵模型淘汰', () => {
  it('上游删掉的 id 会消失（缓存 60 条 vs 上游 49 条的真实场景）', () => {
    const cached = [
      { provider: 'LocalWBAPI', id: 'cn:hy4free', name: 'Hy4' },
      { provider: 'LocalWBAPI', id: 'cn:hy4-preview-dev', name: 'Hy4 preview' },
      { provider: 'LocalWBAPI', id: 'cn:glm-5.1', name: 'GLM-5.1' },
    ];
    const fresh = [
      { provider: 'LocalWBAPI', id: 'cn:hy4free', name: 'Hy4' },
      { provider: 'LocalWBAPI', id: 'cn:hy4std', name: 'Hy4' },
    ];
    const out = mergeProviderScoped(cached, fresh);
    expect(out.map((m) => m.id)).toEqual(['cn:hy4free', 'cn:hy4std']);
  });

  it('本次没拿到数据的 provider → 旧缓存原样保留（403/超时不误删）', () => {
    const cached = [
      { provider: 'openrouter', id: 'a/b', name: 'AB' },
      { provider: 'xiaomi', id: 'mimo', name: 'MiMo' },
    ];
    const fresh = [{ provider: 'LocalWBAPI', id: 'cn:auto', name: 'Auto' }];
    const out = mergeProviderScoped(cached, fresh);
    expect(out.map((m) => `${m.provider}/${m.id}`))
      .toEqual(['LocalWBAPI/cn:auto', 'openrouter/a/b', 'xiaomi/mimo']);
  });

  it('yml 显式 models 只做并集，不替换同 provider 的其它模型', () => {
    const fresh = [
      { provider: 'deepseek', id: 'm1' },
      { provider: 'deepseek', id: 'm2' },
    ];
    const extra = [{ provider: 'deepseek', id: 'm3', name: 'M3' }];
    const out = mergeProviderScoped([], fresh, extra);
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('prune=true：权威目录里没有、yml 也没声明的 provider → 淘汰（删除提供商后不残留）', () => {
    const cached = [
      { provider: 'deleted-provider', id: 'x' },
      { provider: 'LocalWBAPI', id: 'cn:auto' },
    ];
    const fresh = [{ provider: 'LocalWBAPI', id: 'cn:auto' }];
    const out = mergeProviderScoped(cached, fresh, [], { pruneMissingProviders: true });
    expect(out.map((m) => `${m.provider}/${m.id}`)).toEqual(['LocalWBAPI/cn:auto']);
  });

  it('prune=true 但 provider 在 yml 里声明过（只配了 discovery）→ 保留缓存', () => {
    const cached = [{ provider: 'gemini-balancer', id: 'g1' }];
    const out = mergeProviderScoped(cached, [{ provider: 'other', id: 'o1' }], [], {
      pruneMissingProviders: true,
      keepProviders: ['gemini-balancer'],
    });
    expect(out.map((m) => `${m.provider}/${m.id}`)).toEqual(['other/o1', 'gemini-balancer/g1']);
  });
});

describe('mergeModelFields — 信息只增不减', () => {
  it('新结果 name 只是 id 占位时，沿用旧的真名 / ctx / 倍率', () => {
    const prev = {
      provider: 'LocalWBAPI', id: 'cn:hy4free', name: 'Hy4',
      contextWindow: 960000, maxTokens: 64000, credits: 'x0.00',
    };
    // omp RPC 形态：name === id，且不带 credits
    const fresh = { provider: 'LocalWBAPI', id: 'cn:hy4free', name: 'cn:hy4free', contextWindow: 960000 };
    const out = mergeModelFields(fresh, prev);
    expect(out.name).toBe('Hy4');
    expect(out.contextWindow).toBe(960000);
    expect(out.maxTokens).toBe(64000);
    expect(out.credits).toBe('x0.00');
  });

  it('新结果带了真名 → 覆盖旧名（不固执保留缓存）', () => {
    const prev = { provider: 'p', id: 'x', name: 'x', contextWindow: 8000 };
    const fresh = { provider: 'p', id: 'x', name: 'X Model', contextWindow: 32000 };
    expect(mergeModelFields(fresh, prev).name).toBe('X Model');
    expect(mergeModelFields(fresh, prev).contextWindow).toBe(32000);
  });

  it('新结果缺 ctx → 保留旧值，不写成 0/undefined 覆盖', () => {
    const prev = { provider: 'p', id: 'x', name: 'X', contextWindow: 192000, credits: 'x0.29' };
    const fresh = { provider: 'p', id: 'x', name: 'X' };
    const out = mergeModelFields(fresh, prev);
    expect(out.contextWindow).toBe(192000);
    expect(out.credits).toBe('x0.29');
  });
});
