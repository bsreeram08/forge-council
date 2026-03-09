import { z } from 'zod';

/** Strip numeric suffix from agent IDs (e.g. 'coder-1' → 'coder') for permission lookup. */
function resolveBaseAgentId(agentId: string): string {
  return agentId.replace(/-\d+$/, '');
}

// ============================================================================
// Permission System
// ============================================================================

export enum PermissionLevel {
  READ_ONLY = 'READ_ONLY',
  READ_WRITE = 'READ_WRITE',
  ADMIN = 'ADMIN',
}

export type ToolCategory =
  | 'code'
  | 'filesystem'
  | 'git'
  | 'web'
  | 'analysis'
  | 'infra'
  | 'codebase';

// ============================================================================
// Tool Definition Interface
// ============================================================================

export interface ToolDefinition {
  id: string;
  description: string;
  category: ToolCategory;
  permissionRequired: PermissionLevel;
  inputSchema: z.ZodType<unknown>;
  outputSchema: z.ZodType<unknown>;
}

// ============================================================================
// Common Schemas
// ============================================================================

const FilePathSchema = z.object({
  path: z.string().describe('Absolute or relative file path'),
});

const FileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
});

const SearchPatternSchema = z.object({
  pattern: z.string().describe('Search pattern (regex supported)'),
  path: z.string().optional().describe('Directory or file to search in'),
  include: z.array(z.string()).optional().describe('File patterns to include'),
  exclude: z.array(z.string()).optional().describe('File patterns to exclude'),
});

const CommandSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeout: z.number().optional().describe('Timeout in milliseconds'),
  env: z.record(z.string(), z.string()).optional(),
});

const CommandResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  duration: z.number().describe('Duration in milliseconds'),
});

// ============================================================================
// Built-in Tools Registry (30 Tools)
// ============================================================================

export const BUILTIN_TOOLS: Record<string, ToolDefinition> = {
  // --------------------------------------------------------------------------
  // Code Execution (5 tools)
  // --------------------------------------------------------------------------
  'run-shell': {
    id: 'run-shell',
    description: 'Execute shell commands with safety controls',
    category: 'code',
    permissionRequired: PermissionLevel.ADMIN,
    inputSchema: CommandSchema,
    outputSchema: CommandResultSchema,
  },
  'run-code': {
    id: 'run-code',
    description: 'Execute code in a sandboxed environment',
    category: 'code',
    permissionRequired: PermissionLevel.READ_WRITE,
    inputSchema: z.object({
      code: z.string(),
      language: z.enum(['typescript', 'javascript', 'python', 'bash']),
      timeout: z.number().optional().default(30000),
    }),
    outputSchema: z.object({
      result: z.unknown(),
      output: z.string(),
      errors: z.array(z.string()),
      duration: z.number(),
    }),
  },
  'run-tests': {
    id: 'run-tests',
    description: 'Run test suites and report results',
    category: 'code',
    permissionRequired: PermissionLevel.READ_WRITE,
    inputSchema: z.object({
      pattern: z.string().optional().describe('Test file pattern'),
      testName: z.string().optional(),
      watch: z.boolean().optional().default(false),
      coverage: z.boolean().optional().default(false),
    }),
    outputSchema: z.object({
      passed: z.boolean(),
      total: z.number(),
      failed: z.number(),
      skipped: z.number(),
      duration: z.number(),
      failures: z.array(
        z.object({
          test: z.string(),
          error: z.string(),
          file: z.string(),
        }),
      ),
    }),
  },
  'lint-code': {
    id: 'lint-code',
    description: 'Run linting checks on code files',
    category: 'code',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      paths: z.array(z.string()).optional(),
      fix: z.boolean().optional().default(false),
      formatter: z.enum(['eslint', 'prettier', 'biome']).optional(),
    }),
    outputSchema: z.object({
      issues: z.array(
        z.object({
          file: z.string(),
          line: z.number(),
          column: z.number(),
          severity: z.enum(['error', 'warning', 'info']),
          message: z.string(),
          rule: z.string().optional(),
        }),
      ),
      fixed: z.number().optional(),
    }),
  },
  'type-check': {
    id: 'type-check',
    description: 'Run TypeScript type checking',
    category: 'code',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      project: z.string().optional().describe('Path to tsconfig.json'),
      paths: z.array(z.string()).optional(),
      strict: z.boolean().optional().default(true),
    }),
    outputSchema: z.object({
      errors: z.array(
        z.object({
          file: z.string(),
          line: z.number(),
          column: z.number(),
          code: z.string(),
          message: z.string(),
        }),
      ),
    }),
  },

  // --------------------------------------------------------------------------
  // File System (6 tools)
  // --------------------------------------------------------------------------
  'read-file': {
    id: 'read-file',
    description: 'Read file contents',
    category: 'filesystem',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      path: z.string(),
      offset: z.number().optional(),
      limit: z.number().optional(),
      encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
    }),
    outputSchema: z.object({
      content: z.string(),
      size: z.number(),
      modified: z.string(),
      encoding: z.string(),
    }),
  },
  'write-file': {
    id: 'write-file',
    description: 'Create or overwrite files',
    category: 'filesystem',
    permissionRequired: PermissionLevel.READ_WRITE,
    inputSchema: FileContentSchema,
    outputSchema: z.object({
      path: z.string(),
      bytesWritten: z.number(),
      success: z.boolean(),
    }),
  },
  'edit-file': {
    id: 'edit-file',
    description: 'Apply targeted edits to files',
    category: 'filesystem',
    permissionRequired: PermissionLevel.READ_WRITE,
    inputSchema: z.object({
      path: z.string(),
      edits: z.array(
        z.object({
          search: z.string(),
          replace: z.string(),
          occurrences: z.number().optional().default(1),
        }),
      ),
    }),
    outputSchema: z.object({
      path: z.string(),
      editsApplied: z.number(),
      success: z.boolean(),
    }),
  },
  'list-dir': {
    id: 'list-dir',
    description: 'List directory contents',
    category: 'filesystem',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      path: z.string(),
      recursive: z.boolean().optional().default(false),
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      path: z.string(),
      entries: z.array(
        z.object({
          name: z.string(),
          type: z.enum(['file', 'directory', 'symlink']),
          size: z.number().optional(),
          modified: z.string().optional(),
        }),
      ),
    }),
  },
  'search-files': {
    id: 'search-files',
    description: 'Search file contents across the codebase',
    category: 'filesystem',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: SearchPatternSchema,
    outputSchema: z.object({
      matches: z.array(
        z.object({
          file: z.string(),
          line: z.number(),
          column: z.number(),
          content: z.string(),
          context: z.array(z.string()).optional(),
        }),
      ),
      totalFiles: z.number(),
      totalMatches: z.number(),
    }),
  },
  'delete-file': {
    id: 'delete-file',
    description: 'Delete files or directories',
    category: 'filesystem',
    permissionRequired: PermissionLevel.ADMIN,
    inputSchema: z.object({
      path: z.string(),
      recursive: z.boolean().optional().default(false),
      permanent: z.boolean().optional().default(false),
    }),
    outputSchema: z.object({
      path: z.string(),
      deleted: z.boolean(),
      bytesFreed: z.number().optional(),
    }),
  },

  // --------------------------------------------------------------------------
  // Git (5 tools)
  // --------------------------------------------------------------------------
  'git-commit': {
    id: 'git-commit',
    description: 'Stage changes and create commits',
    category: 'git',
    permissionRequired: PermissionLevel.READ_WRITE,
    inputSchema: z.object({
      message: z.string(),
      files: z.array(z.string()).optional(),
      amend: z.boolean().optional().default(false),
      noVerify: z.boolean().optional().default(false),
    }),
    outputSchema: z.object({
      hash: z.string(),
      message: z.string(),
      files: z.array(z.string()),
      timestamp: z.string(),
    }),
  },
  'git-log': {
    id: 'git-log',
    description: 'View commit history',
    category: 'git',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      limit: z.number().optional().default(20),
      path: z.string().optional(),
      author: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      format: z.enum(['short', 'full', 'oneline']).optional().default('short'),
    }),
    outputSchema: z.object({
      commits: z.array(
        z.object({
          hash: z.string(),
          message: z.string(),
          author: z.string(),
          timestamp: z.string(),
          files: z.array(z.string()).optional(),
        }),
      ),
    }),
  },
  'git-diff': {
    id: 'git-diff',
    description: 'Show differences between commits or working directory',
    category: 'git',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      path: z.string().optional(),
      staged: z.boolean().optional().default(false),
    }),
    outputSchema: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          status: z.enum(['added', 'modified', 'deleted', 'renamed']),
          additions: z.number(),
          deletions: z.number(),
          patch: z.string().optional(),
        }),
      ),
    }),
  },
  'git-branch': {
    id: 'git-branch',
    description: 'Manage git branches',
    category: 'git',
    permissionRequired: PermissionLevel.READ_WRITE,
    inputSchema: z.object({
      action: z.enum(['list', 'create', 'delete', 'checkout', 'merge']),
      branch: z.string().optional(),
      from: z.string().optional(),
    }),
    outputSchema: z.object({
      branches: z.array(
        z.object({
          name: z.string(),
          current: z.boolean(),
          remote: z.boolean(),
          commit: z.string().optional(),
        }),
      ),
      success: z.boolean(),
    }),
  },
  'git-stash': {
    id: 'git-stash',
    description: 'Stash changes for later',
    category: 'git',
    permissionRequired: PermissionLevel.READ_WRITE,
    inputSchema: z.object({
      action: z.enum(['push', 'pop', 'apply', 'drop', 'list', 'clear']),
      message: z.string().optional(),
      stash: z.string().optional(),
      keepIndex: z.boolean().optional().default(false),
    }),
    outputSchema: z.object({
      stashes: z.array(
        z.object({
          index: z.number(),
          message: z.string(),
          timestamp: z.string(),
        }),
      ),
      success: z.boolean(),
    }),
  },

  // --------------------------------------------------------------------------
  // Web (3 tools)
  // --------------------------------------------------------------------------
  'web-fetch': {
    id: 'web-fetch',
    description: 'Fetch content from URLs',
    category: 'web',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      url: z.string(),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().default('GET'),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      timeout: z.number().optional().default(30000),
    }),
    outputSchema: z.object({
      status: z.number(),
      statusText: z.string(),
      headers: z.record(z.string(), z.string()),
      body: z.string(),
      url: z.string(),
      duration: z.number(),
    }),
  },
  'web-search': {
    id: 'web-search',
    description: 'Search the web for information',
    category: 'web',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      query: z.string(),
      limit: z.number().optional().default(10),
      safeSearch: z.boolean().optional().default(true),
      recency: z.enum(['day', 'week', 'month', 'year', 'any']).optional().default('any'),
    }),
    outputSchema: z.object({
      results: z.array(
        z.object({
          title: z.string(),
          url: z.string(),
          snippet: z.string(),
          source: z.string(),
          timestamp: z.string().optional(),
        }),
      ),
      total: z.number(),
    }),
  },
  'fetch-docs': {
    id: 'fetch-docs',
    description: 'Fetch and parse documentation from common sources',
    category: 'web',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      source: z.enum(['npm', 'github', 'mdn', 'stackoverflow', 'custom']),
      package: z.string().optional(),
      version: z.string().optional(),
      url: z.string().optional(),
      query: z.string().optional(),
    }),
    outputSchema: z.object({
      title: z.string(),
      content: z.string(),
      url: z.string(),
      sections: z.array(
        z.object({
          heading: z.string(),
          content: z.string(),
        }),
      ),
    }),
  },

  // --------------------------------------------------------------------------
  // Analysis (4 tools)
  // --------------------------------------------------------------------------
  'dependency-audit': {
    id: 'dependency-audit',
    description: 'Audit dependencies for vulnerabilities',
    category: 'analysis',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      path: z.string().optional(),
      severity: z.enum(['low', 'moderate', 'high', 'critical']).optional().default('low'),
      fix: z.boolean().optional().default(false),
    }),
    outputSchema: z.object({
      vulnerabilities: z.array(
        z.object({
          package: z.string(),
          severity: z.enum(['low', 'moderate', 'high', 'critical']),
          cve: z.string().optional(),
          description: z.string(),
          fixAvailable: z.boolean(),
          fixedIn: z.string().optional(),
        }),
      ),
      summary: z.object({
        total: z.number(),
        critical: z.number(),
        high: z.number(),
        moderate: z.number(),
        low: z.number(),
      }),
    }),
  },
  'secrets-scan': {
    id: 'secrets-scan',
    description: 'Scan for exposed secrets in code',
    category: 'analysis',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      path: z.string().optional(),
      patterns: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      findings: z.array(
        z.object({
          file: z.string(),
          line: z.number(),
          type: z.string(),
          pattern: z.string(),
          match: z.string(),
          severity: z.enum(['low', 'medium', 'high']),
        }),
      ),
      scannedFiles: z.number(),
    }),
  },
  'code-complexity': {
    id: 'code-complexity',
    description: 'Analyze code complexity metrics',
    category: 'analysis',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      paths: z.array(z.string()).optional(),
      metrics: z
        .array(z.enum(['cyclomatic', 'cognitive', 'halstead', 'lines']))
        .optional()
        .default(['cyclomatic']),
      threshold: z.number().optional().default(10),
    }),
    outputSchema: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          functions: z.array(
            z.object({
              name: z.string(),
              line: z.number(),
              cyclomatic: z.number(),
              cognitive: z.number().optional(),
              lines: z.number(),
            }),
          ),
          averageComplexity: z.number(),
          violations: z.number(),
        }),
      ),
      summary: z.object({
        totalFiles: z.number(),
        totalFunctions: z.number(),
        averageComplexity: z.number(),
        violations: z.number(),
      }),
    }),
  },
  'test-coverage': {
    id: 'test-coverage',
    description: 'Generate and analyze test coverage reports',
    category: 'analysis',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      paths: z.array(z.string()).optional(),
      reporter: z.enum(['text', 'json', 'html', 'lcov']).optional().default('json'),
      threshold: z
        .object({
          global: z.number().optional(),
          functions: z.number().optional(),
          branches: z.number().optional(),
          lines: z.number().optional(),
        })
        .optional(),
    }),
    outputSchema: z.object({
      summary: z.object({
        statements: z.object({
          total: z.number(),
          covered: z.number(),
          pct: z.number(),
        }),
        branches: z.object({
          total: z.number(),
          covered: z.number(),
          pct: z.number(),
        }),
        functions: z.object({
          total: z.number(),
          covered: z.number(),
          pct: z.number(),
        }),
        lines: z.object({
          total: z.number(),
          covered: z.number(),
          pct: z.number(),
        }),
      }),
      files: z.array(
        z.object({
          path: z.string(),
          statements: z.number(),
          branches: z.number(),
          functions: z.number(),
          lines: z.number(),
          uncovered: z.array(z.number()).optional(),
        }),
      ),
      passed: z.boolean(),
    }),
  },

  // --------------------------------------------------------------------------
  // Infrastructure (4 tools)
  // --------------------------------------------------------------------------
  'docker': {
    id: 'docker',
    description: 'Docker container operations',
    category: 'infra',
    permissionRequired: PermissionLevel.ADMIN,
    inputSchema: z.object({
      action: z.enum(['build', 'run', 'stop', 'logs', 'exec', 'compose']),
      image: z.string().optional(),
      container: z.string().optional(),
      command: z.string().optional(),
      ports: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      volumes: z.array(z.string()).optional(),
      file: z.string().optional().describe('Path to Dockerfile or compose.yml'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      output: z.string(),
      containerId: z.string().optional(),
      exitCode: z.number().optional(),
    }),
  },
  'env-manager': {
    id: 'env-manager',
    description: 'Manage environment variables and secrets',
    category: 'infra',
    permissionRequired: PermissionLevel.ADMIN,
    inputSchema: z.object({
      action: z.enum(['get', 'set', 'delete', 'list', 'validate']),
      key: z.string().optional(),
      value: z.string().optional(),
      file: z.string().optional().default('.env'),
      encrypt: z.boolean().optional().default(false),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      variables: z.record(z.string(), z.string()).optional(),
      value: z.string().optional(),
      errors: z.array(z.string()).optional(),
    }),
  },
  'package-manager': {
    id: 'package-manager',
    description: 'Manage package dependencies',
    category: 'infra',
    permissionRequired: PermissionLevel.READ_WRITE,
    inputSchema: z.object({
      action: z.enum(['install', 'add', 'remove', 'update', 'audit', 'outdated']),
      packages: z.array(z.string()).optional(),
      dev: z.boolean().optional().default(false),
      manager: z.enum(['npm', 'yarn', 'pnpm', 'bun']).optional(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      added: z.array(z.string()).optional(),
      removed: z.array(z.string()).optional(),
      updated: z.array(z.string()).optional(),
      vulnerabilities: z.number().optional(),
      output: z.string(),
    }),
  },
  'port-check': {
    id: 'port-check',
    description: 'Check port availability and bindings',
    category: 'infra',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      port: z.number().optional(),
      range: z
        .object({
          start: z.number(),
          end: z.number(),
        })
        .optional(),
      host: z.string().optional().default('localhost'),
    }),
    outputSchema: z.object({
      available: z.boolean(),
      port: z.number(),
      process: z
        .object({
          pid: z.number(),
          name: z.string(),
          command: z.string(),
        })
        .optional(),
    }),
  },

  // --------------------------------------------------------------------------
  // Codebase Intelligence (3 tools)
  // --------------------------------------------------------------------------
  'codebase-index': {
    id: 'codebase-index',
    description: 'Build and query codebase index',
    category: 'codebase',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      action: z.enum(['build', 'query', 'status']),
      path: z.string().optional(),
      query: z.string().optional(),
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      indexedFiles: z.number().optional(),
      results: z
        .array(
          z.object({
            file: z.string(),
            relevance: z.number(),
            context: z.string(),
          }),
        )
        .optional(),
      status: z
        .object({
          ready: z.boolean(),
          lastIndexed: z.string().optional(),
          fileCount: z.number(),
        })
        .optional(),
    }),
  },
  'find-symbol': {
    id: 'find-symbol',
    description: 'Find symbols (functions, classes, variables) across codebase',
    category: 'codebase',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      name: z.string().describe('Symbol name or pattern'),
      type: z.enum(['function', 'class', 'interface', 'variable', 'type', 'any']).optional().default('any'),
      file: z.string().optional(),
    }),
    outputSchema: z.object({
      symbols: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
          file: z.string(),
          line: z.number(),
          column: z.number(),
          signature: z.string().optional(),
          references: z.number().optional(),
        }),
      ),
    }),
  },
  'analyze-imports': {
    id: 'analyze-imports',
    description: 'Analyze import dependencies and detect circular references',
    category: 'codebase',
    permissionRequired: PermissionLevel.READ_ONLY,
    inputSchema: z.object({
      path: z.string().optional(),
      detectCircular: z.boolean().optional().default(true),
      detectUnused: z.boolean().optional().default(true),
    }),
    outputSchema: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          imports: z.array(z.string()),
          exports: z.array(z.string()),
          circular: z.boolean().optional(),
          unused: z.array(z.string()).optional(),
        }),
      ),
      circularChains: z.array(z.array(z.string())).optional(),
      summary: z.object({
        totalFiles: z.number(),
        circularDeps: z.number(),
        unusedImports: z.number(),
      }),
    }),
  },
};

// ============================================================================
// Agent Tool Access Matrix (13 Agents)
// ============================================================================

export interface AgentToolAccess {
  permission: PermissionLevel;
  tools: string[] | '*';
  deniedTools?: string[];
}

export const AGENT_TOOL_ACCESS: Record<string, AgentToolAccess> = {
  // Executor (Ford) - Full access
  executor: {
    permission: PermissionLevel.ADMIN,
    tools: '*',
  },

  // Architect (Torvalds) - READ_WRITE, no delete/docker/shell
  architect: {
    permission: PermissionLevel.READ_WRITE,
    tools: [
      'read-file',
      'write-file',
      'edit-file',
      'list-dir',
      'search-files',
      'run-code',
      'run-tests',
      'lint-code',
      'type-check',
      'git-commit',
      'git-log',
      'git-diff',
      'git-branch',
      'git-stash',
      'web-fetch',
      'web-search',
      'fetch-docs',
      'dependency-audit',
      'secrets-scan',
      'code-complexity',
      'test-coverage',
      'package-manager',
      'port-check',
      'codebase-index',
      'find-symbol',
      'analyze-imports',
    ],
  },

  // Coder (Carmack) - READ_WRITE, no delete/docker
  coder: {
    permission: PermissionLevel.READ_WRITE,
    tools: [
      'read-file',
      'write-file',
      'edit-file',
      'list-dir',
      'search-files',
      'run-code',
      'run-tests',
      'lint-code',
      'type-check',
      'git-commit',
      'git-log',
      'git-diff',
      'git-branch',
      'git-stash',
      'web-fetch',
      'fetch-docs',
      'dependency-audit',
      'secrets-scan',
      'code-complexity',
      'test-coverage',
      'package-manager',
      'port-check',
      'codebase-index',
      'find-symbol',
      'analyze-imports',
    ],
  },

  // Reviewer (Guido) - READ_ONLY
  reviewer: {
    permission: PermissionLevel.READ_ONLY,
    tools: [
      'read-file',
      'list-dir',
      'search-files',
      'lint-code',
      'type-check',
      'git-log',
      'git-diff',
      'web-fetch',
      'fetch-docs',
      'dependency-audit',
      'secrets-scan',
      'code-complexity',
      'test-coverage',
      'codebase-index',
      'find-symbol',
      'analyze-imports',
    ],
  },

  // Spec Agent (Fowler) - READ_WRITE for docs
  'spec-agent': {
    permission: PermissionLevel.READ_WRITE,
    tools: [
      'read-file',
      'write-file',
      'edit-file',
      'list-dir',
      'search-files',
      'git-commit',
      'git-log',
      'git-diff',
      'web-fetch',
      'web-search',
      'fetch-docs',
      'codebase-index',
      'find-symbol',
    ],
  },

  // Planner (Doshi) - READ_ONLY
  planner: {
    permission: PermissionLevel.READ_ONLY,
    tools: [
      'read-file',
      'list-dir',
      'search-files',
      'git-log',
      'git-diff',
      'web-fetch',
      'web-search',
      'fetch-docs',
      'dependency-audit',
      'code-complexity',
      'codebase-index',
      'analyze-imports',
    ],
  },

  // Designer (Jobs) - READ_ONLY + web
  designer: {
    permission: PermissionLevel.READ_ONLY,
    tools: [
      'read-file',
      'list-dir',
      'search-files',
      'web-fetch',
      'web-search',
      'fetch-docs',
      'codebase-index',
    ],
  },

  // Researcher (Scott) - READ_ONLY + extensive web
  researcher: {
    permission: PermissionLevel.READ_ONLY,
    tools: [
      'read-file',
      'list-dir',
      'search-files',
      'web-fetch',
      'web-search',
      'fetch-docs',
      'dependency-audit',
      'code-complexity',
      'codebase-index',
      'find-symbol',
    ],
  },

  // QA (Whittaker) - READ_WRITE for tests
  qa: {
    permission: PermissionLevel.READ_WRITE,
    tools: [
      'read-file',
      'write-file',
      'edit-file',
      'list-dir',
      'search-files',
      'run-code',
      'run-tests',
      'lint-code',
      'type-check',
      'git-commit',
      'git-log',
      'git-diff',
      'web-fetch',
      'fetch-docs',
      'dependency-audit',
      'secrets-scan',
      'code-complexity',
      'test-coverage',
      'package-manager',
      'port-check',
      'codebase-index',
      'find-symbol',
      'analyze-imports',
    ],
  },

  // Security (Schneier) - READ_ONLY + security tools
  security: {
    permission: PermissionLevel.READ_ONLY,
    tools: [
      'read-file',
      'list-dir',
      'search-files',
      'lint-code',
      'type-check',
      'git-log',
      'git-diff',
      'web-fetch',
      'fetch-docs',
      'dependency-audit',
      'secrets-scan',
      'code-complexity',
      'codebase-index',
      'find-symbol',
      'analyze-imports',
    ],
  },

  // Integrator (Tesla) - READ_WRITE + infra
  integrator: {
    permission: PermissionLevel.READ_WRITE,
    tools: [
      'read-file',
      'write-file',
      'edit-file',
      'list-dir',
      'search-files',
      'run-shell',
      'run-code',
      'run-tests',
      'lint-code',
      'type-check',
      'git-commit',
      'git-log',
      'git-diff',
      'git-branch',
      'git-stash',
      'web-fetch',
      'fetch-docs',
      'dependency-audit',
      'secrets-scan',
      'code-complexity',
      'test-coverage',
      'docker',
      'env-manager',
      'package-manager',
      'port-check',
      'codebase-index',
      'find-symbol',
      'analyze-imports',
    ],
  },

  // Docs (Knuth) - READ_WRITE for docs
  docs: {
    permission: PermissionLevel.READ_WRITE,
    tools: [
      'read-file',
      'write-file',
      'edit-file',
      'list-dir',
      'search-files',
      'git-commit',
      'git-log',
      'git-diff',
      'web-fetch',
      'web-search',
      'fetch-docs',
      'lint-code',
      'type-check',
      'codebase-index',
      'find-symbol',
    ],
  },

  // Scout - READ_ONLY (minimal access)
  scout: {
    permission: PermissionLevel.READ_ONLY,
    tools: [
      'read-file',
      'list-dir',
      'search-files',
      'git-log',
      'web-fetch',
      'codebase-index',
    ],
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

const PERMISSION_HIERARCHY: Record<PermissionLevel, number> = {
  [PermissionLevel.READ_ONLY]: 1,
  [PermissionLevel.READ_WRITE]: 2,
  [PermissionLevel.ADMIN]: 3,
};

/**
 * Check if an agent has permission to use a specific tool
 */
export function canUseTool(agentId: string, toolId: string): boolean {
  const access = AGENT_TOOL_ACCESS[resolveBaseAgentId(agentId)];
  if (!access) return false;

  // Wildcard access (executor)
  if (access.tools === '*') return true;

  const tool = BUILTIN_TOOLS[toolId];
  if (!tool) return false;

  // Check if tool is in allowed list
  if (!access.tools.includes(toolId)) return false;

  // Check permission level hierarchy
  const agentLevel = PERMISSION_HIERARCHY[access.permission];
  const requiredLevel = PERMISSION_HIERARCHY[tool.permissionRequired];

  return agentLevel >= requiredLevel;
}

/**
 * Get all tools an agent is allowed to use
 */
export function getAllowedTools(agentId: string): ToolDefinition[] {
  const access = AGENT_TOOL_ACCESS[resolveBaseAgentId(agentId)];
  if (!access) return [];

  // Wildcard access (executor)
  if (access.tools === '*') {
    return Object.values(BUILTIN_TOOLS);
  }

  return access.tools
    .filter((toolId) => {
      const tool = BUILTIN_TOOLS[toolId];
      if (!tool) return false;

      const agentLevel = PERMISSION_HIERARCHY[access.permission];
      const requiredLevel = PERMISSION_HIERARCHY[tool.permissionRequired];

      return agentLevel >= requiredLevel;
    })
    .map((toolId) => BUILTIN_TOOLS[toolId])
    .filter((tool): tool is ToolDefinition => tool !== undefined);
}

/**
 * Get tools filtered by category
 */
export function getToolsByCategory(category: ToolCategory): ToolDefinition[] {
  return Object.values(BUILTIN_TOOLS).filter((tool) => tool.category === category);
}

/**
 * Validate tool input against its schema
 */
export function validateToolInput(toolId: string, input: unknown): { success: true; data: unknown } | { success: false; error: z.ZodError } {
  const tool = BUILTIN_TOOLS[toolId];
  if (!tool) {
    const error = new z.ZodError([{ code: 'custom', message: `Tool ${toolId} not found`, path: [] }]);
    return { success: false, error };
  }

  return tool.inputSchema.safeParse(input);
}

/**
 * Get permission level for an agent
 */
export function getAgentPermissionLevel(agentId: string): PermissionLevel | undefined {
  return AGENT_TOOL_ACCESS[resolveBaseAgentId(agentId)]?.permission;
}

/**
 * List all available tool IDs
 */
export function listToolIds(): string[] {
  return Object.keys(BUILTIN_TOOLS);
}

/**
 * List all available tool categories
 */
export function listToolCategories(): ToolCategory[] {
  return ['code', 'filesystem', 'git', 'web', 'analysis', 'infra', 'codebase'];
}
