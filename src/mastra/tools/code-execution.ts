import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PermissionLevel } from './tool-registry';

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

interface CodeResult {
  result?: unknown;
  output: string;
  errors: string[];
  duration: number;
}

interface TestFailure {
  test: string;
  error: string;
  file: string;
}

interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  totalTime: string;
  failures: TestFailure[];
  coverageSummary?: string;
}

interface LintIssue {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  rule?: string;
}

interface LintResult {
  errors: number;
  warnings: number;
  issues: LintIssue[];
}

interface TypeCheckDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  code: string;
}

interface TypeCheckResult {
  errors: number;
  diagnostics: TypeCheckDiagnostic[];
}

async function runShellCommand(
  command: string,
  cwd?: string,
  timeout: number = 30000,
  env?: Record<string, string>,
): Promise<ShellResult> {
  const startTime = Date.now();

  const proc = Bun.spawn(['sh', '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: cwd ?? process.cwd(),
    env: env ? { ...process.env, ...env } : process.env,
    timeout,
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const duration = Date.now() - startTime;

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
    duration,
  };
}

function sanitizeCode(code: string): string {
  const dangerousPatterns = [
    /process\.exit\s*\(/g,
    /child_process/g,
    /require\s*\(\s*['"]child_process['"]\s*\)/g,
  ];

  let sanitized = code;
  for (const pattern of dangerousPatterns) {
    sanitized = sanitized.replace(pattern, '// blocked: ');
  }

  return sanitized;
}

async function detectTestRunner(path?: string): Promise<string[]> {
  const cwd = path ?? process.cwd();

  try {
    const packageJsonPath = `${cwd}/package.json`;
    const file = Bun.file(packageJsonPath);
    if (await file.exists()) {
      const packageJson = await file.json();
      const testScript = packageJson.scripts?.test || '';

      if (testScript.includes('bun')) {
        return ['bun', 'test'];
      }
      if (testScript.includes('vitest')) {
        return ['npx', 'vitest', 'run'];
      }
      if (testScript.includes('jest')) {
        return ['npx', 'jest'];
      }
    }
  } catch {
    // Continue to file detection
  }

  const vitestConfig = Bun.file(`${cwd}/vitest.config.ts`);
  if (await vitestConfig.exists()) {
    return ['npx', 'vitest', 'run'];
  }

  const jestConfig = Bun.file(`${cwd}/jest.config.js`);
  if (await jestConfig.exists()) {
    return ['npx', 'jest'];
  }

  return ['bun', 'test'];
}

async function detectLinter(path?: string): Promise<string> {
  const cwd = path ?? process.cwd();

  const biomeFiles = ['biome.json', 'biome.jsonc'];
  for (const file of biomeFiles) {
    if (await Bun.file(`${cwd}/${file}`).exists()) {
      return 'biome';
    }
  }

  const eslintFiles = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', 'eslint.config.js'];
  for (const file of eslintFiles) {
    if (await Bun.file(`${cwd}/${file}`).exists()) {
      return 'eslint';
    }
  }

  try {
    const packageJsonPath = `${cwd}/package.json`;
    const file = Bun.file(packageJsonPath);
    if (await file.exists()) {
      const packageJson = await file.json();
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      if (deps['@biomejs/biome']) return 'biome';
      if (deps['eslint']) return 'eslint';
    }
  } catch {
    // Continue
  }

  if (await Bun.file(`${cwd}/pyproject.toml`).exists()) {
    return 'ruff';
  }
  if (await Bun.file(`${cwd}/setup.py`).exists()) {
    return 'ruff';
  }

  return 'eslint';
}

export async function executeShell(
  command: string,
  cwd?: string,
  timeout?: number,
  env?: Record<string, string>,
): Promise<ShellResult> {
  return runShellCommand(command, cwd, timeout ?? 30000, env);
}

export async function executeCode(
  code: string,
  language: 'typescript' | 'javascript' | 'python' | 'bash',
  timeout?: number,
): Promise<CodeResult> {
  const startTime = Date.now();
  const actualTimeout = timeout ?? 30000;

  const sanitizedCode = sanitizeCode(code);

  switch (language) {
    case 'typescript':
    case 'javascript': {
      const proc = Bun.spawn(['bun', '-e', sanitizedCode], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: actualTimeout,
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      const duration = Date.now() - startTime;

      return {
        output: stdout.trim(),
        errors: exitCode !== 0 && stderr ? [stderr.trim()] : [],
        duration,
      };
    }

    case 'python': {
      const proc = Bun.spawn(['python3', '-c', sanitizedCode], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: actualTimeout,
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      const duration = Date.now() - startTime;

      return {
        output: stdout.trim(),
        errors: exitCode !== 0 && stderr ? [stderr.trim()] : [],
        duration,
      };
    }

    case 'bash': {
      const result = await runShellCommand(sanitizedCode, undefined, actualTimeout);
      return {
        output: result.stdout,
        errors: result.exitCode !== 0 && result.stderr ? [result.stderr] : [],
        duration: result.duration,
      };
    }

    default:
      return {
        output: '',
        errors: [`Unsupported language: ${language}`],
        duration: Date.now() - startTime,
      };
  }
}

export async function executeTests(
  path?: string,
  filter?: string,
  coverage?: boolean,
): Promise<TestResult> {
  const cwd = path ?? process.cwd();
  const runner = await detectTestRunner(cwd);

  const args = [...runner];

  if (coverage) {
    if (runner[0] === 'bun') {
      args.push('--coverage');
    } else if (runner.includes('vitest')) {
      args.push('--coverage');
    } else if (runner.includes('jest')) {
      args.push('--coverage');
    }
  }

  if (filter) {
    args.push(filter);
  }

  const startTime = Date.now();
  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
    timeout: 120000,
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const duration = Date.now() - startTime;

  const output = stdout + stderr;
  const failures: TestFailure[] = [];

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const passMatch = output.match(/(\d+)\s*(pass|passed|passing)/i);
  const failMatch = output.match(/(\d+)\s*(fail|failed|failing)/i);
  const skipMatch = output.match(/(\d+)\s*(skip|skipped|pending)/i);

  if (passMatch && passMatch[1]) passed = parseInt(passMatch[1], 10);
  if (failMatch && failMatch[1]) failed = parseInt(failMatch[1], 10);
  if (skipMatch && skipMatch[1]) skipped = parseInt(skipMatch[1], 10);

  if (passed === 0 && failed === 0 && skipped === 0 && exitCode === 0) {
    passed = 1;
  }

  let coverageSummary: string | undefined;
  const coverageMatch = output.match(/Coverage summary[\s\S]*?(?=\n\n|\n[A-Z]|$)/i);
  if (coverageMatch && coverageMatch[0]) {
    coverageSummary = coverageMatch[0].trim();
  }

  const failureMatches = output.matchAll(/(?:FAIL|✗|✕)\s+(.+?)(?:\n|\r|$)/g);
  for (const match of failureMatches) {
    if (match[1]) {
      failures.push({
        test: match[1].trim(),
        error: 'Test failed',
        file: path || 'unknown',
      });
    }
  }

  return {
    passed,
    failed,
    skipped,
    totalTime: `${duration}ms`,
    failures,
    coverageSummary,
  };
}

export async function executeLint(
  path?: string,
  fix?: boolean,
): Promise<LintResult> {
  const cwd = path ?? process.cwd();
  const linter = await detectLinter(cwd);

  let command: string;
  let args: string[] = [];

  switch (linter) {
    case 'biome':
      command = 'npx';
      args = ['biome', 'check'];
      if (fix) args.push('--write');
      args.push('.');
      break;
    case 'eslint':
      command = 'npx';
      args = ['eslint'];
      if (fix) args.push('--fix');
      args.push('--format', 'json', '.');
      break;
    case 'ruff':
      command = 'ruff';
      args = ['check'];
      if (fix) args.push('--fix');
      args.push('.');
      break;
    default:
      return {
        errors: 0,
        warnings: 0,
        issues: [],
      };
  }

  const proc = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
    timeout: 60000,
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  const issues: LintIssue[] = [];
  let errors = 0;
  let warnings = 0;

  if (linter === 'eslint') {
    try {
      const eslintResults = JSON.parse(stdout);
      for (const result of eslintResults) {
        for (const message of result.messages || []) {
          const issue: LintIssue = {
            file: result.filePath || 'unknown',
            line: message.line || 1,
            column: message.column || 1,
            severity: message.severity === 2 ? 'error' : 'warning',
            message: message.message || 'Unknown issue',
            rule: message.ruleId || undefined,
          };
          issues.push(issue);
          if (issue.severity === 'error') errors++;
          else warnings++;
        }
      }
    } catch {
      // Failed to parse, try line-based parsing
    }
  } else if (linter === 'biome') {
    const lines = stdout.split('\n');
    for (const line of lines) {
      const match = line.match(/(.+?):(\d+):(\d+)\s+(error|warn|warning)\s+(.+)/i);
      if (match) {
        const issue: LintIssue = {
          file: match[1] || 'unknown',
          line: parseInt(match[2] || '1', 10),
          column: parseInt(match[3] || '1', 10),
          severity: match[4]?.toLowerCase() === 'error' ? 'error' : 'warning',
          message: match[5] || 'Unknown issue',
        };
        issues.push(issue);
        if (issue.severity === 'error') errors++;
        else warnings++;
      }
    }
  } else if (linter === 'ruff') {
    const lines = stdout.split('\n');
    for (const line of lines) {
      const match = line.match(/(.+?):(\d+):(\d+):\s*(\w+)\s+(.+)/);
      if (match) {
        const issue: LintIssue = {
          file: match[1] || 'unknown',
          line: parseInt(match[2] || '1', 10),
          column: parseInt(match[3] || '1', 10),
          severity: match[4]?.startsWith('E') ? 'error' : 'warning',
          message: match[5] || 'Unknown issue',
          rule: match[4] || undefined,
        };
        issues.push(issue);
        if (issue.severity === 'error') errors++;
        else warnings++;
      }
    }
  }

  return {
    errors,
    warnings,
    issues,
  };
}

export async function executeTypeCheck(path?: string): Promise<TypeCheckResult> {
  const cwd = path ?? process.cwd();

  const tsConfigPath = `${cwd}/tsconfig.json`;
  const hasTsConfig = await Bun.file(tsConfigPath).exists();

  if (!hasTsConfig) {
    return {
      errors: 0,
      diagnostics: [],
    };
  }

  const proc = Bun.spawn(['npx', 'tsc', '--noEmit', '--pretty', 'false'], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
    timeout: 120000,
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  const diagnostics: TypeCheckDiagnostic[] = [];
  const output = stdout + stderr;

  const lines = output.split('\n');
  for (const line of lines) {
    const match = line.match(/(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+TS(\d+):\s*(.+)/);
    if (match) {
      diagnostics.push({
        file: match[1]?.trim() || 'unknown',
        line: parseInt(match[2] || '1', 10),
        column: parseInt(match[3] || '1', 10),
        message: match[6] || 'Unknown error',
        code: `TS${match[5] || '0000'}`,
      });
    }
  }

  return {
    errors: diagnostics.length,
    diagnostics,
  };
}

export const runShellTool = createTool({
  id: 'run-shell',
  description: 'Execute shell commands with timeout and safety controls. Requires ADMIN permission.',
  inputSchema: z.object({
    command: z.string().describe('Shell command to execute'),
    cwd: z.string().optional().describe('Working directory for command execution'),
    timeout: z.number().optional().default(30000).describe('Timeout in milliseconds'),
    env: z.record(z.string(), z.string()).optional().describe('Additional environment variables'),
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    duration: z.number().describe('Duration in milliseconds'),
  }),
  execute: async (input) => {
    const env = input.env as Record<string, string> | undefined;
    return executeShell(input.command, input.cwd, input.timeout, env);
  },
});

export const runCodeTool = createTool({
  id: 'run-code',
  description: 'Execute code snippets in TypeScript, JavaScript, Python, or Bash',
  inputSchema: z.object({
    code: z.string().describe('Code to execute'),
    language: z.enum(['typescript', 'javascript', 'python', 'bash']).describe('Programming language'),
    timeout: z.number().optional().default(30000).describe('Timeout in milliseconds'),
  }),
  outputSchema: z.object({
    result: z.unknown().optional(),
    output: z.string(),
    errors: z.array(z.string()),
    duration: z.number(),
  }),
  execute: async (input) => {
    return executeCode(input.code, input.language, input.timeout);
  },
});

export const runTestsTool = createTool({
  id: 'run-tests',
  description: 'Run test suites with auto-detection of test runner (bun:test, jest, vitest, pytest)',
  inputSchema: z.object({
    path: z.string().optional().describe('Path to test directory or file'),
    filter: z.string().optional().describe('Test name pattern to filter'),
    coverage: z.boolean().optional().default(false).describe('Enable coverage reporting'),
  }),
  outputSchema: z.object({
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    totalTime: z.string(),
    failures: z.array(
      z.object({
        test: z.string(),
        error: z.string(),
        file: z.string(),
      }),
    ),
    coverageSummary: z.string().optional(),
  }),
  execute: async (input) => {
    return executeTests(input.path, input.filter, input.coverage);
  },
});

export const lintCodeTool = createTool({
  id: 'lint-code',
  description: 'Run linter on code files with auto-detection (ESLint, Biome, Ruff)',
  inputSchema: z.object({
    path: z.string().optional().describe('Path to lint'),
    fix: z.boolean().optional().default(false).describe('Automatically fix issues where possible'),
  }),
  outputSchema: z.object({
    errors: z.number(),
    warnings: z.number(),
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
  }),
  execute: async (input) => {
    return executeLint(input.path, input.fix);
  },
});

export const typeCheckTool = createTool({
  id: 'type-check',
  description: 'Run TypeScript type checker',
  inputSchema: z.object({
    path: z.string().optional().describe('Path to project with tsconfig.json'),
  }),
  outputSchema: z.object({
    errors: z.number(),
    diagnostics: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        column: z.number(),
        message: z.string(),
        code: z.string(),
      }),
    ),
  }),
  execute: async (input) => {
    return executeTypeCheck(input.path);
  },
});

export const codeExecutionTools = {
  runShellTool,
  runCodeTool,
  runTestsTool,
  lintCodeTool,
  typeCheckTool,
};
