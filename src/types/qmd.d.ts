/**
 * Type declarations for @tobilu/qmd
 *
 * QMD is an optional runtime dependency. This declaration allows TypeScript
 * to compile without the package installed. At runtime, the dynamic import
 * in qmd-store.ts will fail gracefully if the package is not available.
 */
declare module '@tobilu/qmd' {
  export interface StoreOptions {
    dbPath: string;
    config?: {
      collections: Record<string, {
        path: string;
        pattern?: string;
        ignore?: string[];
      }>;
    };
    configPath?: string;
  }

  export interface SearchOptions {
    query?: string;
    queries?: Array<{ type: 'lex' | 'vec' | 'hyde'; query: string }>;
    collection?: string;
    collections?: string[];
    limit?: number;
    minScore?: number;
    intent?: string;
    explain?: boolean;
    rerank?: boolean;
  }

  export interface SearchResult {
    path: string;
    displayPath: string;
    title: string;
    score: number;
    content: string;
    snippet?: string;
    context?: string;
    docId?: string;
  }

  export interface DocumentResult {
    path: string;
    displayPath?: string;
    title: string;
    content: string;
    context?: string;
    error?: string;
  }

  export interface MultiGetResult {
    docs: DocumentResult[];
    errors: string[];
  }

  export interface CollectionInfo {
    name: string;
    path: string;
    documentCount?: number;
  }

  export interface QMDStore {
    search(options: SearchOptions): Promise<SearchResult[]>;
    searchLex(query: string, options?: { collection?: string; limit?: number }): Promise<SearchResult[]>;
    searchVector(query: string, options?: { collection?: string; limit?: number }): Promise<SearchResult[]>;
    get(pathOrId: string): Promise<DocumentResult>;
    multiGet(pattern: string, options?: { maxBytes?: number }): Promise<MultiGetResult>;
    update(options?: { collections?: string[]; onProgress?: (info: any) => void }): Promise<{ added?: number }>;
    embed(options?: { force?: boolean; onProgress?: (info: any) => void }): Promise<any>;
    addCollection(name: string, config: { path: string; pattern?: string; ignore?: string[] }): Promise<void>;
    listCollections(): Promise<CollectionInfo[]>;
    removeCollection(name: string): Promise<void>;
    addContext(collection: string, path: string, context: string): Promise<void>;
    listContexts(): Promise<any[]>;
    close(): Promise<void>;
  }

  export function createStore(options: StoreOptions): Promise<QMDStore>;
}
