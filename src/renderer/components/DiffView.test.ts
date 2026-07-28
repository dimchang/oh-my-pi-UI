import { describe, it, expect } from 'vitest';
import { extractDiff } from './DiffView';

describe('extractDiff', () => {
  it('returns null for null/undefined', () => {
    expect(extractDiff(null)).toBeNull();
    expect(extractDiff(undefined)).toBeNull();
  });

  it('returns null for non-diff strings', () => {
    expect(extractDiff('hello world')).toBeNull();
    expect(extractDiff('just some text\nwith lines')).toBeNull();
  });

  it('extracts diff from string with hunk headers', () => {
    const diff = `@@ -1,3 +1,4 @@
 line1
+added
 line2
 line3`;
    expect(extractDiff(diff)).toBe(diff);
  });

  it('extracts diff from string with file headers', () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,3 @@
 existing
+new line
 more`;
    expect(extractDiff(diff)).toBe(diff);
  });

  it('extracts diff from string with add/del lines', () => {
    const diff = `-removed line
+added line
 context`;
    expect(extractDiff(diff)).toBe(diff);
  });

  it('extracts diff from object with diff key', () => {
    const diffText = '@@ -1 +1 @@\n-old\n+new';
    const result = { diff: diffText };
    expect(extractDiff(result)).toBe(diffText);
  });

  it('extracts diff from object with patch key', () => {
    const diffText = '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y';
    const result = { patch: diffText };
    expect(extractDiff(result)).toBe(diffText);
  });

  it('extracts diff from nested result object', () => {
    const diffText = '@@ -1 +1 @@\n-old\n+new';
    const result = { result: { diff: diffText } };
    expect(extractDiff(result)).toBe(diffText);
  });

  it('extracts diff from nested output object', () => {
    const diffText = '@@ -1 +1 @@\n-old\n+new';
    const result = { output: { unified_diff: diffText } };
    expect(extractDiff(result)).toBe(diffText);
  });

  it('handles circular references safely', () => {
    const obj: Record<string, unknown> = { a: 'test' };
    obj.self = obj;
    expect(extractDiff(obj)).toBeNull();
  });

  it('respects max depth', () => {
    // Create deeply nested object beyond MAX_DIFF_DEPTH (6)
    let deep: Record<string, unknown> = { diff: '@@ -1 +1 @@\n-a\n+b' };
    for (let i = 0; i < 10; i++) {
      deep = { result: deep };
    }
    // Should return null because diff is too deep
    expect(extractDiff(deep)).toBeNull();
  });

  it('does not match markdown lists as diffs', () => {
    // Single + or - items (like markdown lists) should not be detected as diff
    const markdown = '+ item one';
    expect(extractDiff(markdown)).toBeNull();
  });

  it('prefers direct diff key over nested', () => {
    const directDiff = '@@ -1 +1 @@\n-direct\n+direct';
    const nestedDiff = '@@ -1 +1 @@\n-nested\n+nested';
    const result = { diff: directDiff, result: { diff: nestedDiff } };
    expect(extractDiff(result)).toBe(directDiff);
  });
});
