import { describe, test, expect } from 'bun:test';
import { computeUnifiedDiff } from './edit-review.ts';

describe('computeUnifiedDiff', () => {
  test('identical files produce no hunks', () => {
    const content = 'line 1\nline 2\nline 3';
    const result = computeUnifiedDiff(content, content, 'test.ts');
    expect(result).toBe('  (no changes)');
  });

  test('single line change shows context', () => {
    const original = 'line 1\nline 2\nline 3\nline 4\nline 5';
    const modified = 'line 1\nline 2\nline THREE\nline 4\nline 5';
    const result = computeUnifiedDiff(original, modified, 'test.ts');

    expect(result).toContain('--- a/test.ts');
    expect(result).toContain('+++ b/test.ts');
    expect(result).toContain('-line 3');
    expect(result).toContain('+line THREE');
    expect(result).toContain(' line 2');
    expect(result).toContain(' line 4');
  });

  test('multiple separate changes produce multiple hunks', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const modified = [...lines];
    modified[2] = 'CHANGED 3';
    modified[17] = 'CHANGED 18';

    const result = computeUnifiedDiff(lines.join('\n'), modified.join('\n'), 'test.ts');

    expect(result).toContain('-line 3');
    expect(result).toContain('+CHANGED 3');
    expect(result).toContain('-line 18');
    expect(result).toContain('+CHANGED 18');
    // Should have two @@ headers since changes are far apart
    const hhCount = (result.match(/^@@/gm) || []).length;
    expect(hhCount).toBe(2);
  });

  test('file creation shows all lines as additions', () => {
    const result = computeUnifiedDiff('', 'new line 1\nnew line 2', 'new.ts');
    expect(result).toContain('+new line 1');
    expect(result).toContain('+new line 2');
  });

  test('file deletion shows all lines as removals', () => {
    const result = computeUnifiedDiff('old line 1\nold line 2', '', 'del.ts');
    expect(result).toContain('-old line 1');
    expect(result).toContain('-old line 2');
  });

  test('added lines at end', () => {
    const original = 'line 1\nline 2';
    const modified = 'line 1\nline 2\nline 3\nline 4';
    const result = computeUnifiedDiff(original, modified, 'test.ts');
    expect(result).toContain('+line 3');
    expect(result).toContain('+line 4');
  });

  test('removed lines at end', () => {
    const original = 'line 1\nline 2\nline 3\nline 4';
    const modified = 'line 1\nline 2';
    const result = computeUnifiedDiff(original, modified, 'test.ts');
    expect(result).toContain('-line 3');
    expect(result).toContain('-line 4');
  });
});
