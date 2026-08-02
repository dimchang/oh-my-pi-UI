import { describe, expect, it } from 'vitest';
import { stripDataUrlPrefix } from './image-data-url';

describe('stripDataUrlPrefix', () => {
  it('去掉 data:image/...;base64, 前缀，只留裸 base64', () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';
    const dataUrl = 'data:image/png;base64,' + b64;
    expect(stripDataUrlPrefix(dataUrl)).toBe(b64);
  });

  it('webp/jpeg 等其它 MIME 同样只按 ;base64, 切分', () => {
    const b64 = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
    expect(stripDataUrlPrefix('data:image/webp;base64,' + b64)).toBe(b64);
    expect(stripDataUrlPrefix('data:image/jpeg;base64,' + b64)).toBe(b64);
  });

  it('round-trip：strip 后 base64 解码应还原原始字节（与 omp 入库路径一致）', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    const dataUrl = 'data:image/png;base64,' + bytes.toString('base64');
    const decoded = Buffer.from(stripDataUrlPrefix(dataUrl), 'base64');
    expect(decoded.equals(bytes)).toBe(true);
  });

  it('无前缀时原样返回（path 兜底等场景）', () => {
    expect(stripDataUrlPrefix('abc123')).toBe('abc123');
    expect(stripDataUrlPrefix('')).toBe('');
  });

  it('不带 ;base64, 的 data: URL 原样返回', () => {
    expect(stripDataUrlPrefix('data:text/plain,hello')).toBe('data:text/plain,hello');
  });
});
