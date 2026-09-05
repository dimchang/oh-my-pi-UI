/**
 * available-models.test.ts — fetchAvailableModels 合并链路回归测试：
 * omp RPC 成功但目录不含自定义 provider 模型时（真实发生过的 bug），
 * 必须并入 yml 显式 models，并对缺失的 provider 按 discovery 直拉补齐，
 * 而不是把残缺的 RPC 结果原样展示（UI 全部 0/0）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

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
    expect(res.models.map((m: { provider: string; id: string }) => `${m.provider}/${m.id}`))
      .toEqual(['builtin/gpt', 'gemini/gemini-a', 'deepseek/deepseek-v4-flash']);
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
