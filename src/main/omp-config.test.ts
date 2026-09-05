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
