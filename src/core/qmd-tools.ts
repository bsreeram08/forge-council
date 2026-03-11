/**
 * QMD Agent Tools — Semantic search tools for agents.
 *
 * These tools wrap QMD operations into AI SDK tool() format
 * so agents can perform semantic search during generateText.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getQmdStore } from './qmd-store.ts';

// ---------------------------------------------------------------------------
// searchCodebase — semantic/hybrid search across indexed project
// ---------------------------------------------------------------------------

export const searchCodebaseTool = tool({
  description: [
    'Semantic search across the indexed codebase. Uses BM25 + vector embeddings + LLM reranking.',
    'Returns ranked results with relevance scores. More powerful than regex searchFiles.',
    'Use for concept-level queries like "authentication flow" or "error handling pattern".',
  ].join(' '),
  inputSchema: z.object({
    query: z.string().describe('Natural language search query'),
    collection: z.string().describe('Specific collection to search (empty = all)').default(''),
    limit: z.number().describe('Max results to return').default(10),
  }),
  execute: async ({ query, collection, limit }) => {
    const store = getQmdStore();
    if (!store?.isReady()) {
      return { results: [], error: 'QMD index not available. Falling back to searchFiles.' };
    }

    const results = await store.search(query, {
      collection: collection || undefined,
      limit,
    });

    return {
      results: results.map(r => ({
        path: r.path,
        title: r.title,
        score: Math.round(r.score * 100) / 100,
        snippet: r.content.slice(0, 500),
        context: r.context,
      })),
      totalResults: results.length,
    };
  },
});

// ---------------------------------------------------------------------------
// searchDocs — semantic search specifically for documentation
// ---------------------------------------------------------------------------

export const searchDocsTool = tool({
  description: [
    'Search documentation files semantically.',
    'Targets markdown files, READMEs, and doc folders.',
    'Use when you need reference material, API docs, or design decisions.',
  ].join(' '),
  inputSchema: z.object({
    query: z.string().describe('What to search for in documentation'),
    limit: z.number().describe('Max results').default(5),
  }),
  execute: async ({ query, limit }) => {
    const store = getQmdStore();
    if (!store?.isReady()) {
      return { results: [], error: 'QMD index not available.' };
    }

    // Search with a docs-focused query
    const results = await store.search(query, { limit });
    // Filter to likely documentation files
    const docResults = results.filter(r =>
      r.path.endsWith('.md') ||
      r.path.includes('docs/') ||
      r.path.includes('doc/') ||
      r.path.includes('README'),
    );

    return {
      results: docResults.map(r => ({
        path: r.path,
        title: r.title,
        score: Math.round(r.score * 100) / 100,
        snippet: r.content.slice(0, 800),
      })),
      totalResults: docResults.length,
    };
  },
});

// ---------------------------------------------------------------------------
// getFileContext — retrieve a file with surrounding QMD context
// ---------------------------------------------------------------------------

export const getFileContextTool = tool({
  description: [
    'Retrieve a file\'s content along with its QMD context breadcrumbs.',
    'Context breadcrumbs provide hierarchical understanding of where this file fits.',
    'Use after searchCodebase finds a relevant file and you want the full content.',
  ].join(' '),
  inputSchema: z.object({
    path: z.string().describe('File path or QMD document ID (e.g. "#abc123")'),
  }),
  execute: async ({ path: filePath }) => {
    const store = getQmdStore();
    if (!store?.isReady()) {
      return { error: 'QMD index not available.' };
    }

    const doc = await store.get(filePath);
    if (!doc) {
      return { error: `Document not found: ${filePath}` };
    }

    return {
      path: doc.path,
      title: doc.title,
      content: doc.content,
      context: doc.context,
    };
  },
});

// ---------------------------------------------------------------------------
// QMD tool set for injection into agent tools
// ---------------------------------------------------------------------------

export const QMD_TOOLS = {
  searchCodebase: searchCodebaseTool,
  searchDocs: searchDocsTool,
  getFileContext: getFileContextTool,
};
