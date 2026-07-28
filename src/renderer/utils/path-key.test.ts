import { describe, it, expect } from 'vitest';
import { cwdKey, pathsEqual, basename, makeWorkspaceId, modelKey } from './path-key';

describe('cwdKey', () => {
  it('normalizes backslashes to forward slashes', () => {
    expect(cwdKey('D:\\code\\project')).toBe('d:/code/project');
  });

  it('lowercases the path', () => {
    expect(cwdKey('D:/Code/PROJECT')).toBe('d:/code/project');
  });

  it('removes trailing slashes', () => {
    expect(cwdKey('d:/code/project/')).toBe('d:/code/project');
    expect(cwdKey('d:/code/project///')).toBe('d:/code/project');
  });

  it('collapses multiple slashes', () => {
    expect(cwdKey('d:/code//project')).toBe('d:/code/project');
    expect(cwdKey('d:\\code\\\\project')).toBe('d:/code/project');
  });

  it('handles unix paths', () => {
    expect(cwdKey('/home/user/project')).toBe('/home/user/project');
  });

  it('handles mixed separators', () => {
    expect(cwdKey('D:\\code/mixed\\path')).toBe('d:/code/mixed/path');
  });
});

describe('makeWorkspaceId', () => {
  it('returns same as cwdKey', () => {
    expect(makeWorkspaceId('D:\\code\\project')).toBe(cwdKey('D:\\code\\project'));
  });
});

describe('pathsEqual', () => {
  it('compares paths case-insensitively', () => {
    expect(pathsEqual('D:/Code/Project', 'd:/code/project')).toBe(true);
  });

  it('compares paths with different separators', () => {
    expect(pathsEqual('D:\\code\\project', 'D:/code/project')).toBe(true);
  });

  it('returns false for different paths', () => {
    expect(pathsEqual('d:/code/a', 'd:/code/b')).toBe(false);
  });

  it('handles trailing slashes', () => {
    expect(pathsEqual('d:/code/project/', 'd:/code/project')).toBe(true);
  });
});

describe('basename', () => {
  it('extracts basename from unix path', () => {
    expect(basename('/home/user/project')).toBe('project');
  });

  it('extracts basename from windows path', () => {
    expect(basename('D:\\code\\project')).toBe('project');
  });

  it('handles trailing slashes', () => {
    expect(basename('d:/code/project/')).toBe('project');
    expect(basename('d:\\code\\project\\')).toBe('project');
  });

  it('returns original for single segment', () => {
    expect(basename('project')).toBe('project');
  });

  it('handles root paths', () => {
    // Root path edge case - returns empty after strip, falls back to original
    expect(basename('/')).toBe('/');
  });
});

describe('modelKey', () => {
  it('creates key with null separator', () => {
    const key = modelKey({ provider: 'openai', id: 'gpt-4' });
    expect(key).toBe('openai\u0000gpt-4');
  });

  it('avoids collision between provider/id combos', () => {
    // "a/b" + "c" vs "a" + "b/c" should be different
    const key1 = modelKey({ provider: 'a/b', id: 'c' });
    const key2 = modelKey({ provider: 'a', id: 'b/c' });
    expect(key1).not.toBe(key2);
  });

  it('handles empty strings', () => {
    expect(modelKey({ provider: '', id: '' })).toBe('\u0000');
  });
});
