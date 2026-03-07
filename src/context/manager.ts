import { z } from 'zod';

export const CompactionModeSchema = z.enum(['safeguard', 'aggressive', 'off']);
export type CompactionMode = z.infer<typeof CompactionModeSchema>;

export const ContextScopeSchema = z.object({
  codebase: z.string(),
  git: z.string(),
  docs: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
});

export type ContextScope = z.infer<typeof ContextScopeSchema>;

export interface ContextEntry {
  id: string;
  type: 'system' | 'task' | 'review' | 'feedback' | 'code' | 'git' | 'doc';
  content: string;
  tokens: number;
  timestamp: number;
  agentId?: string;
}

export interface AgentContextState {
  entries: ContextEntry[];
  totalTokens: number;
  lastCompacted?: number;
}

export interface ContextManagerConfig {
  maxTokens: number;
  compactionThreshold: number;
  mode: CompactionMode;
  scopes: Record<string, ContextScope>;
}

const DEFAULT_SCOPES: Record<string, ContextScope> = {
  architect: {
    codebase: 'full-tree-with-signatures',
    git: 'last-20-commits-with-diffs',
    docs: ['tech-docs', 'adrs'],
    decisions: ['architecture-decisions'],
  },
  security: {
    codebase: 'auth-api-data-files-only',
    git: 'security-related-commits',
    docs: ['owasp', 'cve-databases'],
    decisions: ['security-decisions'],
  },
  qa: {
    codebase: 'test-files-and-tested-code',
    git: 'test-related-commits',
    docs: ['test-frameworks'],
    decisions: ['bug-history'],
  },
  coder: {
    codebase: 'full-codebase',
    git: 'full-history-with-diffs',
    docs: ['api-docs'],
    decisions: ['implementation-decisions'],
  },
  reviewer: {
    codebase: 'changed-files-with-neighbors',
    git: 'current-pr-diff',
    docs: ['style-guides'],
    decisions: ['code-review-history'],
  },
  planner: {
    codebase: 'file-tree-only',
    git: 'commit-frequency',
    docs: [],
    decisions: ['sprint-decisions'],
  },
  designer: {
    codebase: 'ui-related-files',
    git: 'ui-related-commits',
    docs: ['design-systems'],
    decisions: ['ux-decisions'],
  },
  researcher: {
    codebase: 'full-tree',
    git: 'last-10-commits',
    docs: ['all-external-docs'],
    decisions: ['tech-choices'],
  },
  integrator: {
    codebase: 'config-ci-docker-files',
    git: 'infra-commits',
    docs: ['cloud-provider-docs'],
    decisions: ['infra-decisions'],
  },
  docs: {
    codebase: 'public-apis-readme',
    git: 'doc-related-commits',
    docs: ['style-guides'],
    decisions: ['documentation-standards'],
  },
  'spec-agent': {
    codebase: 'file-tree',
    git: 'last-5-commits',
    docs: ['api-docs', 'rfcs'],
    decisions: ['product-decisions'],
  },
  executor: {
    codebase: 'everything',
    git: 'everything',
    docs: ['everything'],
    decisions: ['everything'],
  },
};

export class ContextManager {
  private agentStates: Map<string, AgentContextState> = new Map();
  private config: ContextManagerConfig;
  private compactionCallbacks: Map<string, ( compacted: ContextEntry[] ) => void> = new Map();

  constructor(config: Partial<ContextManagerConfig> = {}) {
    this.config = {
      maxTokens: config.maxTokens ?? 16000,
      compactionThreshold: config.compactionThreshold ?? 0.8,
      mode: config.mode ?? 'safeguard',
      scopes: config.scopes ?? DEFAULT_SCOPES,
    };
  }

  getScope(agentId: string): ContextScope {
    return this.config.scopes[agentId] ?? DEFAULT_SCOPES.default ?? {
      codebase: 'full-tree',
      git: 'last-10-commits',
      docs: [],
      decisions: [],
    };
  }

  addEntry(agentId: string, entry: Omit<ContextEntry, 'id' | 'tokens' | 'timestamp'>): void {
    const state = this.getOrCreateState(agentId);
    
    const newEntry: ContextEntry = {
      ...entry,
      id: crypto.randomUUID(),
      tokens: this.estimateTokens(entry.content),
      timestamp: Date.now(),
    };
    
    state.entries.push(newEntry);
    state.totalTokens += newEntry.tokens;
    
    this.checkCompaction(agentId);
  }

  getEntries(agentId: string): ContextEntry[] {
    return this.getOrCreateState(agentId).entries;
  }

  getTotalTokens(agentId: string): number {
    return this.getOrCreateState(agentId).totalTokens;
  }

  getUsagePercentage(agentId: string): number {
    const state = this.getOrCreateState(agentId);
    return state.totalTokens / this.config.maxTokens;
  }

  needsCompaction(agentId: string): boolean {
    const usage = this.getUsagePercentage(agentId);
    return usage >= this.config.compactionThreshold;
  }

  registerCompactionCallback(agentId: string, callback: (compacted: ContextEntry[]) => void): void {
    this.compactionCallbacks.set(agentId, callback);
  }

  compact(agentId: string): ContextEntry[] {
    const state = this.getOrCreateState(agentId);
    
    if (this.config.mode === 'off' || state.entries.length === 0) {
      return state.entries;
    }

    const fixedEntries: ContextEntry[] = [];
    const compactableEntries: ContextEntry[] = [];
    
    for (const entry of state.entries) {
      if (entry.type === 'system') {
        fixedEntries.push(entry);
      } else {
        compactableEntries.push(entry);
      }
    }

    let compactedTokens = fixedEntries.reduce((sum, e) => sum + e.tokens, 0);
    const keptEntries: ContextEntry[] = [];
    const compactedSummaries: ContextEntry[] = [];

    const sortedCompactable = [...compactableEntries].sort((a, b) => b.timestamp - a.timestamp);

    for (const entry of sortedCompactable) {
      if (compactedTokens + entry.tokens <= this.config.maxTokens * this.config.compactionThreshold) {
        keptEntries.push(entry);
        compactedTokens += entry.tokens;
      } else {
        const summary = this.summarizeEntry(entry);
        compactedSummaries.push(summary);
        compactedTokens += summary.tokens;
      }
    }

    const result = [...keptEntries, ...compactedSummaries];
    
    state.entries = result;
    state.totalTokens = compactedTokens;
    state.lastCompacted = Date.now();

    const callback = this.compactionCallbacks.get(agentId);
    if (callback) {
      callback(compactedSummaries);
    }

    return result;
  }

  private summarizeEntry(entry: ContextEntry): ContextEntry {
    const summaryText = `[Compacted ${entry.type}] ${entry.content.slice(0, 200)}...`;
    return {
      id: crypto.randomUUID(),
      type: 'system',
      content: summaryText,
      tokens: this.estimateTokens(summaryText),
      timestamp: entry.timestamp,
      agentId: entry.agentId,
    };
  }

  private checkCompaction(agentId: string): void {
    if (this.config.mode === 'off') return;
    
    if (this.needsCompaction(agentId)) {
      if (this.config.mode === 'aggressive') {
        this.compact(agentId);
      } else if (this.config.mode === 'safeguard') {
        const callback = this.compactionCallbacks.get(agentId);
        if (callback) {
          callback([]);
        }
      }
    }
  }

  private getOrCreateState(agentId: string): AgentContextState {
    let state = this.agentStates.get(agentId);
    if (!state) {
      state = {
        entries: [],
        totalTokens: 0,
      };
      this.agentStates.set(agentId, state);
    }
    return state;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  clear(agentId: string): void {
    this.agentStates.delete(agentId);
  }

  clearAll(): void {
    this.agentStates.clear();
  }
}

let contextManager: ContextManager | null = null;

export function getContextManager(config?: Partial<ContextManagerConfig>): ContextManager {
  if (!contextManager) {
    contextManager = new ContextManager(config);
  }
  return contextManager;
}

export function resetContextManager(): void {
  contextManager = null;
}
