/**
 * RLM Tools — Tools for agents to interact with context handles.
 *
 * These tools implement the "REPL" part of the RLM paper:
 * agents use tool calls to examine, search, decompose, and
 * recursively process large contexts without stuffing them
 * into the context window.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getHandleStore } from './context-handle.ts';

// ---------------------------------------------------------------------------
// peekContext — lightweight metadata inspection
// ---------------------------------------------------------------------------

export const peekContextTool = tool({
  description: [
    'Inspect a context handle without loading its content.',
    'Returns metadata: total tokens, file count, summary, and structure.',
    'Use this FIRST to understand what a context handle contains before diving deeper.',
  ].join(' '),
  inputSchema: z.object({
    handleId: z.string().describe('The context handle ID to inspect'),
    aspect: z.enum(['summary', 'structure', 'stats', 'all']).describe('What aspect to inspect').default('all'),
  }),
  execute: async ({ handleId, aspect }) => {
    const store = getHandleStore();
    const handle = store.getHandle(handleId);
    if (!handle) {
      return { error: `Context handle not found: ${handleId}` };
    }

    const meta = handle.metadata;
    switch (aspect) {
      case 'summary':
        return { handleId, summary: meta.summary };
      case 'structure':
        return { handleId, structure: meta.structure ?? 'No structure available' };
      case 'stats':
        return {
          handleId,
          totalTokens: meta.totalTokens,
          totalFiles: meta.totalFiles ?? 0,
          type: handle.type,
          depth: handle.depth,
        };
      case 'all':
      default:
        return {
          handleId,
          type: handle.type,
          depth: handle.depth,
          totalTokens: meta.totalTokens,
          totalFiles: meta.totalFiles ?? 0,
          summary: meta.summary,
          structure: meta.structure ?? 'No structure available',
          domains: meta.domains ?? [],
        };
    }
  },
});

// ---------------------------------------------------------------------------
// searchContext — search within a specific context handle
// ---------------------------------------------------------------------------

export const searchContextTool = tool({
  description: [
    'Search within a specific context handle for relevant files or content.',
    'Uses keyword matching to find relevant sections.',
    'Returns ranked results with snippets. More targeted than searchCodebase.',
  ].join(' '),
  inputSchema: z.object({
    handleId: z.string().describe('The context handle to search within'),
    query: z.string().describe('Search query (keywords or concepts)'),
    maxResults: z.number().describe('Maximum results to return').default(10),
  }),
  execute: async ({ handleId, query, maxResults }) => {
    const store = getHandleStore();
    const results = store.searchFiles(handleId, query, maxResults);

    if (results.length === 0) {
      return { handleId, results: [], message: 'No matches found. Try different keywords.' };
    }

    return {
      handleId,
      results: results.map(r => ({
        path: r.path,
        score: r.score,
        snippet: r.snippet,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// readChunk — read specific content from a handle
// ---------------------------------------------------------------------------

export const readChunkTool = tool({
  description: [
    'Read specific content from a context handle.',
    'Can read a specific file by path, or read text with offset/limit.',
    'Use after searchContext identifies a relevant file.',
  ].join(' '),
  inputSchema: z.object({
    handleId: z.string().describe('The context handle to read from'),
    path: z.string().describe('File path within the handle (from searchContext results)').default(''),
    offset: z.number().describe('Start line (0-based)').default(0),
    limit: z.number().describe('Max lines to read (0 = all)').default(0),
  }),
  execute: async ({ handleId, path: filePath, offset, limit }) => {
    const store = getHandleStore();
    const content = store.readChunk(handleId, filePath || undefined, offset, limit);

    if (content === null) {
      return { error: `Could not read from handle ${handleId}${filePath ? ` at path ${filePath}` : ''}` };
    }

    return {
      handleId,
      path: filePath || undefined,
      content,
      lines: content.split('\n').length,
    };
  },
});

// ---------------------------------------------------------------------------
// decomposeContext — break a handle into sub-handles
// ---------------------------------------------------------------------------

export const decomposeContextTool = tool({
  description: [
    'Decompose a large context handle into smaller sub-handles.',
    'Strategies: "directory" splits by top-level directory, "size" splits into equal chunks.',
    'Sub-handles can be independently searched and processed.',
  ].join(' '),
  inputSchema: z.object({
    handleId: z.string().describe('The context handle to decompose'),
    strategy: z.enum(['directory', 'size']).describe('Decomposition strategy').default('directory'),
    targetChunkTokens: z.number().describe('Target tokens per chunk (for "size" strategy)').default(10_000),
  }),
  execute: async ({ handleId, strategy, targetChunkTokens }) => {
    const store = getHandleStore();
    const handle = store.getHandle(handleId);
    if (!handle) {
      return { error: `Context handle not found: ${handleId}` };
    }

    let subHandles;
    switch (strategy) {
      case 'directory':
        subHandles = store.decomposeByDirectory(handleId);
        break;
      case 'size':
        subHandles = store.decomposeBySize(handleId, targetChunkTokens);
        break;
    }

    return {
      parentHandleId: handleId,
      strategy,
      chunks: subHandles.map(h => ({
        handleId: h.id,
        type: h.type,
        tokens: h.metadata.totalTokens,
        files: h.metadata.totalFiles ?? 0,
        summary: h.metadata.summary,
      })),
      totalChunks: subHandles.length,
    };
  },
});

// ---------------------------------------------------------------------------
// RLM tool set for injection into agent tools
// ---------------------------------------------------------------------------

export const RLM_TOOLS = {
  peekContext: peekContextTool,
  searchContext: searchContextTool,
  readChunk: readChunkTool,
  decomposeContext: decomposeContextTool,
};
