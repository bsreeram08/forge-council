/**
 * QMD Store Manager — Integration with @tobilu/qmd for semantic search.
 *
 * QMD provides BM25 + vector + LLM reranking search, all running locally.
 * This module wraps the QMD SDK to serve as the primary context source
 * for the context assembler, replacing glob-based file loading.
 */

import * as path from 'path';
import * as fs from 'fs';
import type { QmdConfig } from '../config/schema.ts';

// ---------------------------------------------------------------------------
// Types (aligned with QMD SDK but not imported to avoid hard dependency)
// ---------------------------------------------------------------------------

export interface QmdSearchResult {
  /** Document path (relative to collection root) */
  path: string;
  /** Display path (collection:path format) */
  displayPath: string;
  /** Title/heading of the matched document or section */
  title: string;
  /** Relevance score (0-1) */
  score: number;
  /** Matched snippet / content */
  content: string;
  /** Context breadcrumbs from QMD context tree */
  context?: string;
  /** Document ID */
  docId?: string;
}

export interface QmdDocumentResult {
  path: string;
  title: string;
  content: string;
  context?: string;
}

export interface QmdIndexStats {
  ready: boolean;
  collections: number;
  documents: number;
  lastIndexed?: string;
  storePath: string;
}

// ---------------------------------------------------------------------------
// QMD Store Manager
// ---------------------------------------------------------------------------

export class QmdStoreManager {
  private store: any = null;
  private config: QmdConfig;
  private projectRoot: string;
  private initialized = false;

  constructor(config: QmdConfig, projectRoot: string) {
    this.config = config;
    this.projectRoot = projectRoot;
  }

  /** Initialize the QMD store, creating it if needed */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const { createStore } = await import('@tobilu/qmd');
      const dbPath = path.resolve(this.projectRoot, this.config.storePath, 'index.sqlite');

      // Ensure directory exists
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Build collections config
      const collections: Record<string, { path: string; pattern?: string; ignore?: string[] }> = {};

      if (Object.keys(this.config.collections).length > 0) {
        // Use explicit collections from config
        for (const [name, collPath] of Object.entries(this.config.collections)) {
          collections[name] = {
            path: path.resolve(this.projectRoot, collPath),
            pattern: this.config.includePatterns.join(','),
            ignore: this.config.excludePatterns,
          };
        }
      } else {
        // Default: index the project root as a single collection
        collections['project'] = {
          path: this.projectRoot,
          pattern: '**/*.{ts,tsx,js,jsx,md,json,yaml,yml}',
          ignore: this.config.excludePatterns,
        };
      }

      this.store = await createStore({
        dbPath,
        config: { collections },
      });

      this.initialized = true;
    } catch (e) {
      // QMD not installed — fall back gracefully
      console.warn(`QMD initialization failed: ${e instanceof Error ? e.message : String(e)}`);
      this.store = null;
      this.initialized = false;
    }
  }

  /** Whether the store is ready for queries */
  isReady(): boolean {
    return this.initialized && this.store !== null;
  }

  /** Index/re-index project files */
  async indexProject(onProgress?: (info: { collection: string; file: string; current: number; total: number }) => void): Promise<{ indexed: number }> {
    if (!this.store) return { indexed: 0 };

    try {
      const result = await this.store.update({ onProgress });
      // Generate embeddings for vector search
      await this.store.embed({ force: false });
      return { indexed: result?.added ?? 0 };
    } catch (e) {
      console.warn(`QMD indexing failed: ${e instanceof Error ? e.message : String(e)}`);
      return { indexed: 0 };
    }
  }

  /** Hybrid search (BM25 + vector + reranking) */
  async search(query: string, options?: {
    collection?: string;
    limit?: number;
    minScore?: number;
  }): Promise<QmdSearchResult[]> {
    if (!this.store) return [];

    try {
      const results = await this.store.search({
        query,
        collection: options?.collection,
        limit: options?.limit ?? 20,
        minScore: options?.minScore ?? this.config.minScore,
      });

      return results.map((r: any) => ({
        path: r.path ?? r.displayPath ?? '',
        displayPath: r.displayPath ?? r.path ?? '',
        title: r.title ?? '',
        score: r.score ?? 0,
        content: r.content ?? r.snippet ?? '',
        context: r.context,
        docId: r.docId,
      }));
    } catch (e) {
      console.warn(`QMD search failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /** BM25 keyword search (fast, no LLM) */
  async searchKeyword(query: string, options?: {
    collection?: string;
    limit?: number;
  }): Promise<QmdSearchResult[]> {
    if (!this.store) return [];

    try {
      const results = await this.store.searchLex(query, {
        collection: options?.collection,
        limit: options?.limit ?? 20,
      });

      return results.map((r: any) => ({
        path: r.path ?? r.displayPath ?? '',
        displayPath: r.displayPath ?? r.path ?? '',
        title: r.title ?? '',
        score: r.score ?? 0,
        content: r.content ?? r.snippet ?? '',
        context: r.context,
        docId: r.docId,
      }));
    } catch (e) {
      console.warn(`QMD keyword search failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /** Vector similarity search */
  async searchSemantic(query: string, options?: {
    collection?: string;
    limit?: number;
  }): Promise<QmdSearchResult[]> {
    if (!this.store) return [];

    try {
      const results = await this.store.searchVector(query, {
        collection: options?.collection,
        limit: options?.limit ?? 20,
      });

      return results.map((r: any) => ({
        path: r.path ?? r.displayPath ?? '',
        displayPath: r.displayPath ?? r.path ?? '',
        title: r.title ?? '',
        score: r.score ?? 0,
        content: r.content ?? r.snippet ?? '',
        context: r.context,
        docId: r.docId,
      }));
    } catch (e) {
      console.warn(`QMD semantic search failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /** Get a specific document by path or docId */
  async get(pathOrId: string): Promise<QmdDocumentResult | null> {
    if (!this.store) return null;

    try {
      const doc = await this.store.get(pathOrId);
      if (!doc || 'error' in doc) return null;

      return {
        path: doc.path ?? doc.displayPath ?? pathOrId,
        title: doc.title ?? '',
        content: doc.content ?? '',
        context: doc.context,
      };
    } catch {
      return null;
    }
  }

  /** Batch retrieve by glob pattern */
  async multiGet(pattern: string, options?: {
    maxBytes?: number;
  }): Promise<QmdDocumentResult[]> {
    if (!this.store) return [];

    try {
      const result = await this.store.multiGet(pattern, {
        maxBytes: options?.maxBytes ?? 20480,
      });

      return (result.docs ?? []).map((doc: any) => ({
        path: doc.path ?? doc.displayPath ?? '',
        title: doc.title ?? '',
        content: doc.content ?? '',
        context: doc.context,
      }));
    } catch {
      return [];
    }
  }

  /** Get index stats */
  async getStats(): Promise<QmdIndexStats> {
    if (!this.store) {
      return {
        ready: false,
        collections: 0,
        documents: 0,
        storePath: path.resolve(this.projectRoot, this.config.storePath),
      };
    }

    try {
      const collections = await this.store.listCollections();
      const totalDocs = collections.reduce((sum: number, c: any) => sum + (c.documentCount ?? 0), 0);

      return {
        ready: true,
        collections: collections.length,
        documents: totalDocs,
        storePath: path.resolve(this.projectRoot, this.config.storePath),
      };
    } catch {
      return {
        ready: false,
        collections: 0,
        documents: 0,
        storePath: path.resolve(this.projectRoot, this.config.storePath),
      };
    }
  }

  /** Close the store */
  async close(): Promise<void> {
    if (this.store) {
      try {
        await this.store.close();
      } catch { /* ignore */ }
      this.store = null;
      this.initialized = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton per session
// ---------------------------------------------------------------------------

let globalStore: QmdStoreManager | undefined;

export function getQmdStore(): QmdStoreManager | undefined {
  return globalStore;
}

export function setQmdStore(store: QmdStoreManager): void {
  globalStore = store;
}

export async function initializeQmdStore(
  config: QmdConfig,
  projectRoot: string,
): Promise<QmdStoreManager> {
  const store = new QmdStoreManager(config, projectRoot);
  await store.initialize();

  if (store.isReady() && config.indexOnStart) {
    await store.indexProject();
  }

  globalStore = store;
  return store;
}
