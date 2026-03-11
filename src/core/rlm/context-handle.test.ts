import { describe, it, expect, beforeEach } from 'bun:test';
import { getHandleStore, resetHandleStore, type ContextHandle } from './context-handle.ts';
import type { AssembledContext, FileEntry } from '../context-assembler.ts';

function makeContext(files: FileEntry[], overrides: Partial<AssembledContext> = {}): AssembledContext {
  const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
  return {
    files,
    gitLog: [],
    projectStructure: '',
    dependencies: '',
    externalDocs: [],
    totalTokens,
    ...overrides,
  };
}

function makeFile(path: string, content: string, tokens?: number): FileEntry {
  return { path, content, tokens: tokens ?? Math.ceil(content.length / 4) };
}

describe('HandleStore', () => {
  beforeEach(() => {
    resetHandleStore();
  });

  describe('createFromContext', () => {
    it('creates a handle with correct metadata', () => {
      const store = getHandleStore();
      const context = makeContext([
        makeFile('src/index.ts', 'export const x = 1;', 10),
        makeFile('src/utils.ts', 'export function foo() {}', 15),
      ]);

      const handle = store.createFromContext(context);
      expect(handle.id).toBeTruthy();
      expect(handle.type).toBe('codebase');
      expect(handle.depth).toBe(0);
      expect(handle.metadata.totalTokens).toBe(25);
      expect(handle.metadata.totalFiles).toBe(2);
      expect(handle.metadata.summary).toContain('2 files');
    });

    it('generates structure from file paths', () => {
      const store = getHandleStore();
      const context = makeContext([
        makeFile('src/a.ts', 'a', 5),
        makeFile('src/b.ts', 'b', 5),
        makeFile('lib/c.ts', 'c', 5),
      ]);

      const handle = store.createFromContext(context);
      expect(handle.metadata.structure).toContain('src/a.ts');
      expect(handle.metadata.structure).toContain('lib/c.ts');
    });
  });

  describe('createFromText', () => {
    it('creates a handle for raw text', () => {
      const store = getHandleStore();
      const handle = store.createFromText('Hello world', 'document', 'Test document');
      expect(handle.type).toBe('document');
      expect(handle.metadata.summary).toBe('Test document');
      expect(handle.metadata.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('searchFiles', () => {
    it('finds files matching query terms', () => {
      const store = getHandleStore();
      const context = makeContext([
        makeFile('src/auth.ts', 'export function authenticate(user, password) { ... }', 20),
        makeFile('src/db.ts', 'export function query(sql: string) { ... }', 15),
        makeFile('src/utils.ts', 'export function formatDate(d: Date) { ... }', 10),
      ]);

      const handle = store.createFromContext(context);
      const results = store.searchFiles(handle.id, 'authenticate');
      expect(results).toHaveLength(1);
      expect(results[0]!.path).toBe('src/auth.ts');
    });

    it('scores path matches higher', () => {
      const store = getHandleStore();
      const context = makeContext([
        makeFile('src/auth.ts', 'some code here', 10),
        makeFile('src/utils.ts', 'auth related utility', 10),
      ]);

      const handle = store.createFromContext(context);
      const results = store.searchFiles(handle.id, 'auth');
      expect(results).toHaveLength(2);
      expect(results[0]!.path).toBe('src/auth.ts'); // Path match scores higher
    });

    it('returns empty for no matches', () => {
      const store = getHandleStore();
      const context = makeContext([makeFile('a.ts', 'hello', 5)]);
      const handle = store.createFromContext(context);
      const results = store.searchFiles(handle.id, 'nonexistent');
      expect(results).toHaveLength(0);
    });
  });

  describe('readChunk', () => {
    it('reads a specific file', () => {
      const store = getHandleStore();
      const context = makeContext([
        makeFile('a.ts', 'line1\nline2\nline3', 10),
      ]);
      const handle = store.createFromContext(context);
      const content = store.readChunk(handle.id, 'a.ts');
      expect(content).toBe('line1\nline2\nline3');
    });

    it('reads with offset and limit', () => {
      const store = getHandleStore();
      const context = makeContext([
        makeFile('a.ts', 'line0\nline1\nline2\nline3\nline4', 15),
      ]);
      const handle = store.createFromContext(context);
      const content = store.readChunk(handle.id, 'a.ts', 1, 2);
      expect(content).toBe('line1\nline2');
    });

    it('returns null for unknown handle', () => {
      const store = getHandleStore();
      expect(store.readChunk('nonexistent', 'a.ts')).toBeNull();
    });

    it('returns null for unknown file path', () => {
      const store = getHandleStore();
      const context = makeContext([makeFile('a.ts', 'hello', 5)]);
      const handle = store.createFromContext(context);
      expect(store.readChunk(handle.id, 'nonexistent.ts')).toBeNull();
    });
  });

  describe('decomposeByDirectory', () => {
    it('splits files by top-level directory', () => {
      const store = getHandleStore();
      const context = makeContext([
        makeFile('src/a.ts', 'a', 5),
        makeFile('src/b.ts', 'b', 5),
        makeFile('lib/c.ts', 'c', 5),
        makeFile('test/d.ts', 'd', 5),
      ]);

      const handle = store.createFromContext(context);
      const chunks = store.decomposeByDirectory(handle.id);
      expect(chunks).toHaveLength(3); // src, lib, test
      expect(chunks.every(c => c.type === 'chunk')).toBe(true);
      expect(chunks.every(c => c.parentId === handle.id)).toBe(true);
      expect(chunks.every(c => c.depth === 1)).toBe(true);
    });

    it('groups root-level files under "."', () => {
      const store = getHandleStore();
      const context = makeContext([
        makeFile('index.ts', 'root', 5),
        makeFile('package.json', '{}', 5),
      ]);

      const handle = store.createFromContext(context);
      const chunks = store.decomposeByDirectory(handle.id);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.metadata.totalFiles).toBe(2);
    });
  });

  describe('decomposeBySize', () => {
    it('splits files into chunks by token budget', () => {
      const store = getHandleStore();
      const context = makeContext([
        makeFile('a.ts', 'a', 100),
        makeFile('b.ts', 'b', 100),
        makeFile('c.ts', 'c', 100),
        makeFile('d.ts', 'd', 100),
      ]);

      const handle = store.createFromContext(context);
      const chunks = store.decomposeBySize(handle.id, 200);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]!.metadata.totalTokens).toBe(200);
      expect(chunks[1]!.metadata.totalTokens).toBe(200);
    });

    it('handles single file exceeding target', () => {
      const store = getHandleStore();
      const context = makeContext([
        makeFile('big.ts', 'x'.repeat(1000), 500),
        makeFile('small.ts', 'y', 5),
      ]);

      const handle = store.createFromContext(context);
      const chunks = store.decomposeBySize(handle.id, 100);
      // big.ts alone exceeds the target, but still gets its own chunk
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });
});
