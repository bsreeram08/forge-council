import type { IntentClassification } from './schemas.ts';
import { estimateTokens } from './token-counter.ts';

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
// Context Assembly — runs once before agent calls, then frozen
// ---------------------------------------------------------------------------

const MAX_CONTEXT_TOKENS = 80_000; // Cap to avoid blowing context window

export async function assembleContext(
  classification: IntentClassification,
  projectRoot?: string,
): Promise<AssembledContext> {
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
          if (context.totalTokens + tokens > MAX_CONTEXT_TOKENS) continue;

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
