import type { IntentClassification } from './schemas.ts';
import type { ForgeCouncilConfig } from '../config/schema.ts';
import { estimateTokens } from './token-counter.ts';
import { getQmdStore, type QmdStoreManager } from './qmd-store.ts';

// ---------------------------------------------------------------------------
// Assembled Context — static, frozen after assembly
// ---------------------------------------------------------------------------

export interface FileEntry {
  path: string;
  content: string;
  tokens: number;
}

export interface AssembledContext {
  files: FileEntry[];
  gitLog: string[];
  projectStructure: string;
  dependencies: string;
  externalDocs: string[];
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// Model context window limits (used to budget context assembly)
// ---------------------------------------------------------------------------

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
  'gpt-5.1': 128_000,
  'gpt-5.1-mini': 128_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
};

// Overhead: system prompt (~2K) + tools schema (~3K) + output reservation (~4K) + safety margin
const PROMPT_OVERHEAD_TOKENS = 12_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_CONTEXT_TOKENS = 80_000;

/**
 * Look up the context window for a model reference string.
 * Returns the usable budget after subtracting prompt overhead.
 */
export function getContextBudget(modelRef?: string): number {
  if (!modelRef) return DEFAULT_MAX_CONTEXT_TOKENS;

  // Extract model ID from "provider/modelId" format
  const modelId = modelRef.includes('/') ? modelRef.split('/').pop()! : modelRef;

  // Try exact match, then partial match
  let contextWindow = MODEL_CONTEXT_WINDOWS[modelId];
  if (!contextWindow) {
    for (const [key, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      if (modelId.includes(key)) {
        contextWindow = window;
        break;
      }
    }
  }

  const window = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  // Use at most 60% of context window for supporting context, leave room for
  // system prompt, tools, and output
  const budget = Math.floor(window * 0.6) - PROMPT_OVERHEAD_TOKENS;
  return Math.max(budget, 20_000); // Never go below 20K
}

/**
 * Look up a model's context window from the config's provider model list.
 * Returns undefined if not found.
 */
export function getConfigContextWindow(modelRef: string, config: ForgeCouncilConfig): number | undefined {
  const slashIdx = modelRef.indexOf('/');
  if (slashIdx === -1) return undefined;
  const provider = modelRef.slice(0, slashIdx);
  const modelId = modelRef.slice(slashIdx + 1);
  const providerConfig = config.models.providers[provider];
  if (!providerConfig) return undefined;
  const model = providerConfig.models.find(m => m.id === modelId);
  return model?.contextWindow;
}

/**
 * Get the smallest context budget across a set of model references.
 * Uses config-based lookup first, falls back to hardcoded table.
 */
export function getSmallestContextBudget(modelRefs: string[], config?: ForgeCouncilConfig): number {
  const budgets = modelRefs.map(ref => {
    if (config) {
      const configWindow = getConfigContextWindow(ref, config);
      if (configWindow) {
        return Math.max(Math.floor(configWindow * 0.6) - PROMPT_OVERHEAD_TOKENS, 20_000);
      }
    }
    return getContextBudget(ref);
  });
  return Math.min(...budgets);
}

// ---------------------------------------------------------------------------
// Context Assembly — runs once before agent calls, then frozen
// ---------------------------------------------------------------------------

export interface AssembleContextOptions {
  /** Model reference (e.g. "anthropic/claude-sonnet-4-6") for budget calculation */
  modelRef?: string;
  /** Explicit token budget override (takes precedence over modelRef) */
  maxTokens?: number;
  /** Config-provided context window (from ProviderModel.contextWindow) — overrides hardcoded lookup */
  configContextWindow?: number;
}

export async function assembleContext(
  classification: IntentClassification,
  projectRoot?: string,
  options?: AssembleContextOptions,
): Promise<AssembledContext> {
  const maxContextTokens = options?.maxTokens
    ?? (options?.configContextWindow
      ? Math.max(Math.floor(options.configContextWindow * 0.6) - PROMPT_OVERHEAD_TOKENS, 20_000)
      : getContextBudget(options?.modelRef));
  const root = projectRoot ?? process.cwd();
  const context: AssembledContext = {
    files: [],
    gitLog: [],
    projectStructure: '',
    dependencies: '',
    externalDocs: [],
    totalTokens: 0,
  };

  // Load files matching patterns from intent classifier
  if (classification.contextNeeded.filePatterns.length > 0) {
    const { Glob } = await import('bun');
    for (const pattern of classification.contextNeeded.filePatterns) {
      const glob = new Glob(pattern);
      for await (const path of glob.scan({ cwd: root, absolute: false })) {
        // Skip node_modules, .git, binary files
        if (path.includes('node_modules') || path.includes('.git/')) continue;
        if (/\.(png|jpg|gif|ico|woff|ttf|eot|svg|zip|tar|gz)$/i.test(path)) continue;

        try {
          const fullPath = `${root}/${path}`;
          const content = await Bun.file(fullPath).text();
          const tokens = estimateTokens(content);

          // Skip if would exceed budget
          if (context.totalTokens + tokens > maxContextTokens) continue;

          context.files.push({ path, content, tokens });
          context.totalTokens += tokens;
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  // Load git history
  if (classification.contextNeeded.gitLogCount > 0) {
    try {
      const args = [
        'git', 'log',
        `--max-count=${classification.contextNeeded.gitLogCount}`,
        '--oneline',
        '--no-decorate',
      ];
      if (classification.contextNeeded.gitLogFilter) {
        args.push(`--grep=${classification.contextNeeded.gitLogFilter}`);
      }
      const proc = Bun.spawn(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const output = await new Response(proc.stdout).text();
      if (output.trim()) {
        context.gitLog = output.trim().split('\n');
        context.totalTokens += estimateTokens(output);
      }
    } catch {
      // Not a git repo or git not available
    }
  }

  // Load project structure (file tree, depth 3)
  if (classification.contextNeeded.includeProjectStructure) {
    try {
      const proc = Bun.spawn(
        ['find', '.', '-maxdepth', '3', '-not', '-path', '*/node_modules/*',
         '-not', '-path', '*/.git/*', '-not', '-path', '*/dist/*'],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' },
      );
      const output = await new Response(proc.stdout).text();
      if (output.trim()) {
        // Sort and format as tree-like structure
        const files = output.trim().split('\n').sort();
        context.projectStructure = files.join('\n');
        context.totalTokens += estimateTokens(context.projectStructure);
      }
    } catch {
      // find not available
    }
  }

  // Load dependencies
  if (classification.contextNeeded.includeDependencies) {
    try {
      const pkgPath = `${root}/package.json`;
      const content = await Bun.file(pkgPath).text();
      const pkg = JSON.parse(content);
      // Only include name, deps, devDeps — not scripts or config
      const slim = {
        name: pkg.name,
        dependencies: pkg.dependencies,
        devDependencies: pkg.devDependencies,
      };
      context.dependencies = JSON.stringify(slim, null, 2);
      context.totalTokens += estimateTokens(context.dependencies);
    } catch {
      // No package.json
    }
  }

  // External docs — placeholder for now, will implement web fetching later
  // For Phase 1, we just note them so the agent knows what was requested
  if (classification.contextNeeded.externalDocs.length > 0) {
    context.externalDocs = classification.contextNeeded.externalDocs.map(
      doc => `[External doc requested: ${doc}]`,
    );
  }

  return context;
}

// ---------------------------------------------------------------------------
// QMD-based Context Assembly — uses semantic search for relevance-ranked loading
// ---------------------------------------------------------------------------

export async function assembleContextFromQmd(
  classification: IntentClassification,
  qmdStore: QmdStoreManager,
  projectRoot?: string,
  options?: AssembleContextOptions,
): Promise<AssembledContext> {
  const maxContextTokens = options?.maxTokens
    ?? (options?.configContextWindow
      ? Math.max(Math.floor(options.configContextWindow * 0.6) - PROMPT_OVERHEAD_TOKENS, 20_000)
      : getContextBudget(options?.modelRef));
  const root = projectRoot ?? process.cwd();
  const context: AssembledContext = {
    files: [],
    gitLog: [],
    projectStructure: '',
    dependencies: '',
    externalDocs: [],
    totalTokens: 0,
  };

  // Build search queries from classification
  const queries: string[] = [];

  // Use domains as search concepts
  if (classification.domains.length > 0) {
    queries.push(classification.domains.join(' '));
  }

  // Use file patterns as path-based queries
  for (const pattern of classification.contextNeeded.filePatterns) {
    // Convert glob to a search-friendly query
    const cleaned = pattern.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\//g, ' ').trim();
    if (cleaned) queries.push(cleaned);
  }

  // Use task type as a query
  queries.push(classification.taskType);

  // Search QMD for each query and collect unique files
  const seenPaths = new Set<string>();
  for (const query of queries) {
    if (context.totalTokens >= maxContextTokens) break;

    const results = await qmdStore.search(query, { limit: 15 });
    for (const result of results) {
      if (seenPaths.has(result.path)) continue;
      if (context.totalTokens >= maxContextTokens) break;

      // Fetch full content
      const doc = await qmdStore.get(result.path);
      if (!doc) continue;

      const tokens = estimateTokens(doc.content);
      if (context.totalTokens + tokens > maxContextTokens) continue;

      seenPaths.add(result.path);
      context.files.push({ path: result.path, content: doc.content, tokens });
      context.totalTokens += tokens;
    }
  }

  // Load git history (same as glob-based)
  if (classification.contextNeeded.gitLogCount > 0) {
    try {
      const args = [
        'git', 'log',
        `--max-count=${classification.contextNeeded.gitLogCount}`,
        '--oneline', '--no-decorate',
      ];
      if (classification.contextNeeded.gitLogFilter) {
        args.push(`--grep=${classification.contextNeeded.gitLogFilter}`);
      }
      const proc = Bun.spawn(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const output = await new Response(proc.stdout).text();
      if (output.trim()) {
        context.gitLog = output.trim().split('\n');
        context.totalTokens += estimateTokens(output);
      }
    } catch { /* not a git repo */ }
  }

  // Load dependencies
  if (classification.contextNeeded.includeDependencies) {
    try {
      const pkgPath = `${root}/package.json`;
      const content = await Bun.file(pkgPath).text();
      const pkg = JSON.parse(content);
      const slim = {
        name: pkg.name,
        dependencies: pkg.dependencies,
        devDependencies: pkg.devDependencies,
      };
      context.dependencies = JSON.stringify(slim, null, 2);
      context.totalTokens += estimateTokens(context.dependencies);
    } catch { /* no package.json */ }
  }

  // External docs
  if (classification.contextNeeded.externalDocs.length > 0) {
    context.externalDocs = classification.contextNeeded.externalDocs.map(
      doc => `[External doc requested: ${doc}]`,
    );
  }

  return context;
}

// ---------------------------------------------------------------------------
// Smart Context Assembly — uses QMD when available, falls back to glob
// ---------------------------------------------------------------------------

export async function assembleContextSmart(
  classification: IntentClassification,
  projectRoot?: string,
  options?: AssembleContextOptions,
): Promise<AssembledContext> {
  const qmdStore = getQmdStore();
  if (qmdStore?.isReady()) {
    return assembleContextFromQmd(classification, qmdStore, projectRoot, options);
  }
  return assembleContext(classification, projectRoot, options);
}

// ---------------------------------------------------------------------------
// Format context as a string for Layer 3
// ---------------------------------------------------------------------------

export function formatContext(context: AssembledContext): string {
  const sections: string[] = [];

  if (context.projectStructure) {
    sections.push(`## Project Structure\n\`\`\`\n${context.projectStructure}\n\`\`\``);
  }

  if (context.dependencies) {
    sections.push(`## Dependencies\n\`\`\`json\n${context.dependencies}\n\`\`\``);
  }

  if (context.files.length > 0) {
    sections.push(`## Source Files (${context.files.length} files)`);
    for (const file of context.files) {
      const ext = file.path.split('.').pop() ?? '';
      sections.push(`### ${file.path}\n\`\`\`${ext}\n${file.content}\n\`\`\``);
    }
  }

  if (context.gitLog.length > 0) {
    sections.push(`## Recent Git History\n${context.gitLog.join('\n')}`);
  }

  if (context.externalDocs.length > 0) {
    sections.push(`## External References\n${context.externalDocs.join('\n')}`);
  }

  return sections.join('\n\n');
}
