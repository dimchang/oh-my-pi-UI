/**
 * omp-config.test.ts — writeProvider 回归测试（丢 apiKey bug）：
 * 渲染层编辑模式故意把 apiKey 留空表示「保留原值」（issue 156），
 * writeProvider 整子树 setIn 替换时必须回填原 apiKey，否则原有 key
 * 被抹掉 → discovery/请求 401 → 该 provider 模型在 UI 全部「消失」。
 * 通过 OMP_HOME 指向临时目录隔离真实配置（getAgentDir 读取 OMP_HOME）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { writeProvider, readModelsConfig } from '../../electron/omp-config';
import { mergeDiscoveredModels } from '../../src/shared/model-merge';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-config-test-'));
const agentDir = path.join(tmpRoot, 'agent');

beforeEach(() => {
  process.env.OMP_HOME = tmpRoot;
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'models.yml'),
    [
      'providers:',
      '  deepseek:',
      '    baseUrl: https://api.deepseek.com',
      '    api: openai-completions',
      '    name: DeepSeek',
      '    apiKey: sk-orig',
      '    discovery:',
      '      type: openai-models-list',
      '  other:',
      '    baseUrl: https://example.com/v1',
      '    api: openai-completions',
      '    apiKey: sk-other',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe('writeProvider apiKey 保留语义', () => {
  it('cfg 无 apiKey 时保留原值（编辑模式留空 = 保留）', async () => {
    await writeProvider('deepseek', {
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
      name: 'DeepSeek',
      discovery: { type: 'openai-models-list' },
    });
    const cfg = await readModelsConfig();
    expect(cfg.providers?.deepseek?.apiKey).toBe('sk-orig');
    expect(cfg.providers?.deepseek?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(cfg.providers?.deepseek?.discovery).toBeDefined();
  });

  it('cfg 带 apiKey 时覆盖原值', async () => {
    await writeProvider('deepseek', { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: 'sk-new' });
    const cfg = await readModelsConfig();
    expect(cfg.providers?.deepseek?.apiKey).toBe('sk-new');
  });

  it('auth=none 时显式清除 apiKey', async () => {
    await writeProvider('deepseek', { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', auth: 'none' });
    const cfg = await readModelsConfig();
    expect(cfg.providers?.deepseek?.apiKey).toBeUndefined();
  });

  it('只动目标子树，其他 provider 原样保留', async () => {
    await writeProvider('deepseek', { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: 'sk-new' });
    const cfg = await readModelsConfig();
    expect(cfg.providers?.other?.apiKey).toBe('sk-other');
    expect(cfg.providers?.other?.baseUrl).toBe('https://example.com/v1');
  });
});

describe('models.yml 往返保留（omp 18.1.0→18.3.2 §3 P0）', () => {
  /** omp 18.x 新增字段：schema 校验收紧后，GUI 保存一次不能抹掉手工写的这些键 */
  const RICH_YML = [
    'providers:',
    '  rich:',
    '    baseUrl: https://example.com/v1',
    '    api: openai-completions',
    '    apiKey: sk-rich',
    '    transport: pi-native',
    '    compat:',
    '      stripImageInput: true',
    '    models:',
    '      - id: m1',
    '        name: Model One',
    '        contextWindow: 200000',
    '        maxTokens: 131072',
    '        input:',
    '          - text',
    '          - image',
    '        thinking:',
    '          mode: effort',
    '          efforts:',
    '            - low',
    '            - high',
    '          requiresEffort: false',
    '        compat:',
    '          supportsConfigurationUpdate: false',
    '        cost:',
    '          input: 1.5',
    '      - id: m-old',
    '        name: Old Model',
    '        contextWindow: 8192',
    '        thinking:',
    '          mode: effort',
    '          efforts:',
    '            - off',
    '',
  ].join('\n');

  beforeEach(() => {
    fs.writeFileSync(path.join(agentDir, 'models.yml'), RICH_YML, 'utf8');
  });

  it('读入 → mergeDiscoveredModels 合并（生产代码）→ GUI 保存 → 手写字段逐项保留', async () => {
    const yml = await readModelsConfig();
    const existing = yml.providers?.rich;
    expect(existing).toBeDefined();
    // 读入侧：未知/新增字段必须真实存在于运行时对象（渲染层靠 spread 透传）
    expect((existing as Record<string, unknown>).transport).toBe('pi-native');
    expect((existing as Record<string, unknown>).compat).toEqual({ stripImageInput: true });
    const prevModel = existing?.models?.[0] as unknown as Record<string, unknown>;
    expect(prevModel.thinking).toEqual({ mode: 'effort', efforts: ['low', 'high'], requiresEffort: false });
    expect(prevModel.input).toEqual(['text', 'image']);
    expect(prevModel.compat).toEqual({ supportsConfigurationUpdate: false });

    // 用生产代码合并（与 AddModelModal.onFinish 同一份实现，审查 P2-B）
    const merged = mergeDiscoveredModels(existing?.models, [
      { provider: 'rich', id: 'm1', name: 'Model One (renamed)', contextWindow: 262144 },
    ]);
    // 并集（审查 P2-C）：本次未发现的旧模型 m-old 必须保留
    expect(merged.map((m) => m.id)).toContain('m-old');

    const newCfg = { ...existing, models: merged } as Record<string, unknown>;
    delete newCfg.discovery;
    await writeProvider('rich', newCfg as Parameters<typeof writeProvider>[1]);

    // 写回侧：逐项断言
    const after = await readModelsConfig();
    const rich = after.providers?.rich as unknown as Record<string, unknown>;
    expect(rich.transport).toBe('pi-native');
    expect(rich.compat).toEqual({ stripImageInput: true });
    expect(rich.apiKey).toBe('sk-rich');
    const models = rich.models as Array<Record<string, unknown>>;
    const m1 = models.find((m) => m.id === 'm1')!;
    expect(m1.thinking).toEqual({ mode: 'effort', efforts: ['low', 'high'], requiresEffort: false });
    expect(m1.input).toEqual(['text', 'image']);
    expect(m1.compat).toEqual({ supportsConfigurationUpdate: false });
    expect(m1.cost).toEqual({ input: 1.5 });
    expect(m1.maxTokens).toBe(131072);
    expect(m1.contextWindow).toBe(262144);
    expect(m1.name).toBe('Model One (renamed)');
    // 旧模型并集保留 + 其手写字段不丢
    const mOld = models.find((m) => m.id === 'm-old')!;
    expect(mOld.name).toBe('Old Model');
    expect(mOld.contextWindow).toBe(8192);
    expect(mOld.thinking).toEqual({ mode: 'effort', efforts: ['off'] });
  });
});
