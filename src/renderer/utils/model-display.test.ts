/**
 * model-display.test.ts — 同名模型显示名消歧 + 倍率文案。
 * 场景来自真实上游：LocalWBAPI 的 /v1/models 里 Hy3 有 4 个 id、Hy4 preview 有 3 个、
 * Hy4 有 2 个（hy4free / hy4std），name 全相同 → 不做消歧用户无法选择。
 */
import { describe, expect, it } from 'vitest';
import { formatCredits, modelDisplayNames, shortModelId } from './model-display';

describe('shortModelId', () => {
  it('去掉命名空间前缀', () => {
    expect(shortModelId('cn:hy4free')).toBe('hy4free');
    expect(shortModelId('openai/gpt-5')).toBe('openai/gpt-5'); // 没有 ':' 原样
    expect(shortModelId('cn:a:b')).toBe('b'); // 取最后一个 ':'
  });
});

describe('modelDisplayNames', () => {
  it('Hy3 四通道：一个保持原名，其余追加短 id', () => {
    const names = modelDisplayNames([
      { id: 'cn:hy3', name: 'Hy3' },
      { id: 'cn:hy3-b', name: 'Hy3' },
      { id: 'cn:hy3-c', name: 'Hy3' },
      { id: 'cn:hy3-x', name: 'Hy3' },
    ]);
    expect(names.get('cn:hy3')).toBe('Hy3'); // 短 id 与 name 相同 → 不加后缀
    expect(names.get('cn:hy3-b')).toBe('Hy3 · hy3-b');
    expect(names.get('cn:hy3-x')).toBe('Hy3 · hy3-x');
  });

  it('hy4free / hy4std 都是 "Hy4" → 必须能看出哪个 free', () => {
    const names = modelDisplayNames([
      { id: 'cn:hy4free', name: 'Hy4' },
      { id: 'cn:hy4std', name: 'Hy4' },
    ]);
    expect(names.get('cn:hy4free')).toBe('Hy4 · hy4free');
    expect(names.get('cn:hy4std')).toBe('Hy4 · hy4std');
  });

  it('唯一的 name 原样返回（不做无谓装饰）', () => {
    const names = modelDisplayNames([
      { id: 'cn:auto', name: 'Auto' },
      { id: 'cn:minimax-m2.5', name: 'MiniMax-M2.5' },
    ]);
    expect(names.get('cn:auto')).toBe('Auto');
    expect(names.get('cn:minimax-m2.5')).toBe('MiniMax-M2.5');
  });

  it('没有 name → 显示 id；name === id 也按无真名处理', () => {
    const names = modelDisplayNames([{ id: 'mimo-v2.5-asr' }]);
    expect(names.get('mimo-v2.5-asr')).toBe('mimo-v2.5-asr');
    const same = modelDisplayNames([{ id: 'cn:hy3', name: 'cn:hy3' }]);
    expect(same.get('cn:hy3')).toBe('cn:hy3');
  });

  it('短 id 也撞车 → 退化为完整 id（不产生新的一对重名）', () => {
    const names = modelDisplayNames([
      { id: 'v1:dup', name: 'X' },
      { id: 'v2:dup', name: 'X' },
    ]);
    const values = [...names.values()];
    expect(new Set(values).size).toBe(2);
    expect(values).toEqual(['X · v1:dup', 'X · v2:dup']);
  });

  it('空 name 字符串按缺失处理', () => {
    const names = modelDisplayNames([{ id: 'a1', name: '   ' }, { id: 'a2', name: 'A' }]);
    expect(names.get('a1')).toBe('a1');
    expect(names.get('a2')).toBe('A');
  });
});

describe('formatCredits', () => {
  it('x0.00 → 免费', () => {
    expect(formatCredits('x0.00')).toBe('免费');
    expect(formatCredits('0')).toBe('免费');
  });
  it('非零倍率保留原样', () => {
    expect(formatCredits('x0.29')).toBe('x0.29');
    expect(formatCredits('1.00')).toBe('x1.00');
  });
  it('缺失或无法识别 → 空串（UI 不渲染）', () => {
    expect(formatCredits(undefined)).toBe('');
    expect(formatCredits('')).toBe('');
    expect(formatCredits('0.00000008')).toBe('x0.00000008'); // 数值合法就照实显示
    expect(formatCredits('free')).toBe('');
  });
});
