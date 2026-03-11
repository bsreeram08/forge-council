/**
 * Context Handle — Symbolic reference to large context.
 *
 * Based on the Recursive Language Models paper (arXiv 2512.24601v2):
 * Instead of stuffing large context into the prompt, agents receive a
 * symbolic handle with metadata. They use tools to examine, search,
 * and decompose the context on demand.
 *
 * This is the core abstraction that enables processing codebases
 * 10-100x beyond the model's context window.
 */

import { estimateTokens } from '../token-counter.ts';
import type { AssembledContext, FileEntry } from '../context-assembler.ts';

// ---------------------------------------------------------------------------
// Context Handle types
// ---------------------------------------------------------------------------

export type ContextType = 'codebase' | 'document' | 'plan' | 'review-history' | 'chunk';

export interface ContextHandleMetadata {
  /** Total token count of the full content */
  totalTokens: number;
  /** Number of files (for codebase/chunk types) */
  totalFiles?: number;
  /** Short summary (~100 tokens) of what this handle contains */
  summary: string;
  /** High-level structure (file tree, section headers) */
  structure?: string;
  /** Categories/domains represented */
  domains?: string[];
}

export interface ContextHandle {
  /** Unique handle ID */
  id: string;
  /** What kind of context this represents */
  type: ContextType;
  /** Metadata about the content (this is what goes in the prompt) */
  metadata: ContextHandleMetadata;
  /** Parent handle ID (for chunks created by decomposition) */
  parentId?: string;
  /** Recursion depth (0 = top-level) */
  depth: number;
}

// ---------------------------------------------------------------------------
// Handle Store — maps handle IDs to actual content
// ---------------------------------------------------------------------------

interface HandleContent {
  handle: ContextHandle;
  files: FileEntry[];
  rawText?: string;
}

class HandleStore {
  private handles = new Map<string, HandleContent>();
  private counter = 0;

  private nextId(): string {
    return `ctx_${++this.counter}_${Date.now().toString(36)}`;
  }

  /** Create a handle from an assembled context */
  createFromContext(context: AssembledContext, type: ContextType = 'codebase'): ContextHandle {
    const id = this.nextId();

    // Build structure summary (file tree, depth 1)
    const dirs = new Set<string>();
    for (const file of context.files) {
      const parts = file.path.split('/');
      if (parts.length > 1) dirs.add(parts[0]!);
    }
    const structure = context.files.length <= 20
      ? context.files.map(f => f.path).join('\n')
      : [...dirs].sort().map(d => `${d}/`).join('\n') + `\n... (${context.files.length} files total)`;

    // Build summary
    const fileTypes = new Set(context.files.map(f => {
      const ext = f.path.split('.').pop();
      return ext ?? 'unknown';
    }));
    const summary = [
      `${context.files.length} files`,
      `(${[...fileTypes].join(', ')})`,
      context.gitLog.length > 0 ? `with ${context.gitLog.length} git commits` : '',
      context.dependencies ? 'and dependency info' : '',
    ].filter(Boolean).join(' ');

    const handle: ContextHandle = {
      id,
      type,
      metadata: {
        totalTokens: context.totalTokens,
        totalFiles: context.files.length,
        summary,
        structure,
      },
      depth: 0,
    };

    this.handles.set(id, { handle, files: context.files });
    return handle;
  }

  /** Create a handle from raw text */
  createFromText(text: string, type: ContextType, summary: string, parentId?: string, depth = 0): ContextHandle {
    const id = this.nextId();
    const tokens = estimateTokens(text);

    const handle: ContextHandle = {
      id,
      type,
      metadata: {
        totalTokens: tokens,
        summary,
      },
      parentId,
      depth,
    };

    this.handles.set(id, { handle, files: [], rawText: text });
    return handle;
  }

  /** Create a chunk handle from a subset of files */
  createChunk(
    files: FileEntry[],
    parentId: string,
    label: string,
    depth: number,
  ): ContextHandle {
    const id = this.nextId();
    const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);

    const handle: ContextHandle = {
      id,
      type: 'chunk',
      metadata: {
        totalTokens,
        totalFiles: files.length,
        summary: `${label} — ${files.length} files, ${totalTokens.toLocaleString()} tokens`,
        structure: files.map(f => f.path).join('\n'),
      },
      parentId,
      depth,
    };

    this.handles.set(id, { handle, files });
    return handle;
  }

  /** Get handle content */
  getContent(handleId: string): HandleContent | undefined {
    return this.handles.get(handleId);
  }

  /** Get handle metadata only */
  getHandle(handleId: string): ContextHandle | undefined {
    return this.handles.get(handleId)?.handle;
  }

  /** Search within a handle's files */
  searchFiles(handleId: string, query: string, maxResults = 10): Array<{ path: string; snippet: string; score: number }> {
    const content = this.handles.get(handleId);
    if (!content) return [];

    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/);

    // Simple relevance scoring: count query term matches per file
    const scored = content.files.map(file => {
      const contentLower = file.content.toLowerCase();
      const pathLower = file.path.toLowerCase();

      let score = 0;
      for (const term of queryTerms) {
        // Path match is worth more
        if (pathLower.includes(term)) score += 3;
        // Count content occurrences (capped)
        const matches = contentLower.split(term).length - 1;
        score += Math.min(matches, 5);
      }

      // Extract a relevant snippet
      let snippet = '';
      if (score > 0) {
        const idx = contentLower.indexOf(queryTerms[0]!);
        if (idx >= 0) {
          const start = Math.max(0, idx - 50);
          const end = Math.min(file.content.length, idx + 200);
          snippet = file.content.slice(start, end).trim();
        } else {
          snippet = file.content.slice(0, 200).trim();
        }
      }

      return { path: file.path, snippet, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /** Read a specific file or text chunk */
  readChunk(handleId: string, filePath?: string, offset = 0, limit = 0): string | null {
    const content = this.handles.get(handleId);
    if (!content) return null;

    if (filePath) {
      const file = content.files.find(f => f.path === filePath);
      if (!file) return null;
      const lines = file.content.split('\n');
      const sliced = limit > 0 ? lines.slice(offset, offset + limit) : lines.slice(offset);
      return sliced.join('\n');
    }

    if (content.rawText) {
      const lines = content.rawText.split('\n');
      const sliced = limit > 0 ? lines.slice(offset, offset + limit) : lines.slice(offset);
      return sliced.join('\n');
    }

    return null;
  }

  /** Decompose a handle into sub-handles by directory */
  decomposeByDirectory(handleId: string): ContextHandle[] {
    const content = this.handles.get(handleId);
    if (!content) return [];

    const parentHandle = content.handle;
    const dirMap = new Map<string, FileEntry[]>();

    for (const file of content.files) {
      const parts = file.path.split('/');
      const dir = parts.length > 1 ? parts[0]! : '.';
      const existing = dirMap.get(dir) ?? [];
      existing.push(file);
      dirMap.set(dir, existing);
    }

    return [...dirMap.entries()].map(([dir, files]) =>
      this.createChunk(files, handleId, dir, parentHandle.depth + 1),
    );
  }

  /** Decompose into roughly equal-sized chunks by token count */
  decomposeBySize(handleId: string, targetTokensPerChunk: number): ContextHandle[] {
    const content = this.handles.get(handleId);
    if (!content) return [];

    const parentHandle = content.handle;
    const chunks: ContextHandle[] = [];
    let currentFiles: FileEntry[] = [];
    let currentTokens = 0;
    let chunkIdx = 0;

    for (const file of content.files) {
      if (currentTokens + file.tokens > targetTokensPerChunk && currentFiles.length > 0) {
        chunks.push(this.createChunk(currentFiles, handleId, `chunk-${chunkIdx}`, parentHandle.depth + 1));
        currentFiles = [];
        currentTokens = 0;
        chunkIdx++;
      }
      currentFiles.push(file);
      currentTokens += file.tokens;
    }

    if (currentFiles.length > 0) {
      chunks.push(this.createChunk(currentFiles, handleId, `chunk-${chunkIdx}`, parentHandle.depth + 1));
    }

    return chunks;
  }

  /** Clear all handles */
  clear(): void {
    this.handles.clear();
    this.counter = 0;
  }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let globalHandleStore: HandleStore | undefined;

export function getHandleStore(): HandleStore {
  if (!globalHandleStore) {
    globalHandleStore = new HandleStore();
  }
  return globalHandleStore;
}

export function resetHandleStore(): void {
  globalHandleStore?.clear();
  globalHandleStore = undefined;
}
