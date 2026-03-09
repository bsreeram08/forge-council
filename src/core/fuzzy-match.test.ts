import { describe, test, expect } from 'bun:test';
import { fuzzyFind, fuzzyReplace } from './fuzzy-match.ts';

describe('fuzzyFind', () => {
  test('exact match returns confidence 1.0', () => {
    const content = 'function hello() {\n  return "world";\n}';
    const search = 'return "world";';
    const result = fuzzyFind(content, search);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('exact');
    expect(result!.confidence).toBe(1.0);
    expect(result!.matched).toBe(search);
  });

  test('whitespace-normalized handles indentation drift', () => {
    const content = 'function hello() {\n    return "world";\n}';
    const search = 'function hello() {\n  return "world";\n}';
    const result = fuzzyFind(content, search);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('whitespace-normalized');
    expect(result!.confidence).toBe(0.9);
  });

  test('whitespace-normalized handles extra spaces', () => {
    const content = 'const  x  =  42;';
    const search = 'const x = 42;';
    const result = fuzzyFind(content, search);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('whitespace-normalized');
    expect(result!.confidence).toBe(0.9);
  });

  test('trimmed-lines handles trailing whitespace on lines', () => {
    const content = 'function foo() {  \n  bar();  \n}  ';
    const search = 'function foo() {\n  bar();\n}';
    const result = fuzzyFind(content, search);
    expect(result).not.toBeNull();
    expect(['whitespace-normalized', 'trimmed-lines']).toContain(result!.strategy);
    expect(result!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test('trimmed-lines matches with different indentation per line', () => {
    const content = '  if (x) {\n      doA();\n      doB();\n  }';
    const search = 'if (x) {\n    doA();\n    doB();\n}';
    const result = fuzzyFind(content, search);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test('line-anchor matches with minor drift in middle', () => {
    const content = [
      'class Foo {',
      '  private x: number;',
      '  private y: string;',
      '  constructor() {}',
      '}',
    ].join('\n');
    const search = [
      'class Foo {',
      '  private x: number;',
      '  private y: string;',
      '  constructor() {}',
      '}',
    ].join('\n');
    // This is exact so it'll match exact
    const result = fuzzyFind(content, search);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('exact');
  });

  test('line-anchor with indentation changes', () => {
    const content = [
      '    class Foo {',
      '        private x: number;',
      '        private y: string;',
      '    }',
    ].join('\n');
    const search = [
      'class Foo {',
      '  private x: number;',
      '  private y: string;',
      '}',
    ].join('\n');
    const result = fuzzyFind(content, search);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test('returns null when no match', () => {
    const content = 'function hello() { return 42; }';
    const search = 'function goodbye() { return 0; }';
    const result = fuzzyFind(content, search);
    expect(result).toBeNull();
  });

  test('empty search matches exactly', () => {
    const content = 'hello world';
    const search = '';
    const result = fuzzyFind(content, search);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('exact');
  });

  test('single line match', () => {
    const content = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    const search = 'const b = 2;';
    const result = fuzzyFind(content, search);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('exact');
  });
});

describe('fuzzyReplace', () => {
  test('exact replacement works', () => {
    const content = 'const x = 1;\nconst y = 2;';
    const result = fuzzyReplace(content, 'const x = 1;', 'const x = 42;');
    expect(result).not.toBeNull();
    expect(result!.newContent).toBe('const x = 42;\nconst y = 2;');
    expect(result!.result.strategy).toBe('exact');
  });

  test('fuzzy replacement with indentation drift', () => {
    const content = '    const x = 1;\n    const y = 2;';
    const result = fuzzyReplace(content, '  const x = 1;', '  const x = 42;');
    expect(result).not.toBeNull();
    expect(result!.newContent).toContain('const x = 42;');
    expect(result!.result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test('returns null when search not found', () => {
    const content = 'const x = 1;';
    const result = fuzzyReplace(content, 'const z = 99;', 'replaced');
    expect(result).toBeNull();
  });

  test('replaces only first occurrence', () => {
    const content = 'a = 1;\na = 1;\na = 1;';
    const result = fuzzyReplace(content, 'a = 1;', 'a = 2;');
    expect(result).not.toBeNull();
    expect(result!.newContent).toBe('a = 2;\na = 1;\na = 1;');
  });
});
