/**
 * Built-in Plugins — ship with ForgeCouncil out of the box.
 *
 * These solve the core problems:
 *   1. validation-gate: Auto-typecheck after every file write, feed errors back
 *   2. task-scope-guard: Reject tasks that are too broad, enforce granularity
 */

import type { ForgeCouncilPlugin, ToolHookData, HookResult, CodeTaskHookData } from './plugin.ts';

// ---------------------------------------------------------------------------
// 1. Validation Gate Plugin
//
// After every writeFile or editFile, runs tsc --noEmit on the project.
// If there are type errors, feeds them back as feedback that gets injected
// into the agent's context — so the agent self-corrects immediately instead
// of moving on to the next task with a broken codebase.
// ---------------------------------------------------------------------------

export const validationGatePlugin: ForgeCouncilPlugin = {
  name: 'validation-gate',
  version: '1.0.0',
  description: 'Auto-runs typecheck after file writes and feeds errors back to the agent',

  meta: {
    tags: ['builtin', 'quality', 'validation'],
  },

  setup(ctx) {
    let lastCheckTime = 0;
    const MIN_INTERVAL_MS = 3_000; // Don't spam typecheck faster than 3s

    // Track files changed since last typecheck
    const pendingFiles: string[] = [];

    ctx.onToolPost(/^(writeFile|editFile)$/, async (data: ToolHookData): Promise<HookResult> => {
      const filePath = (data.input as { path?: string })?.path;
      if (filePath) pendingFiles.push(filePath);

      // Throttle — don't typecheck on every single edit
      const now = Date.now();
      if (now - lastCheckTime < MIN_INTERVAL_MS) {
        return { action: 'continue' };
      }
      lastCheckTime = now;

      // Only typecheck TypeScript files
      const hasTsFiles = pendingFiles.some(f =>
        f.endsWith('.ts') || f.endsWith('.tsx'),
      );
      if (!hasTsFiles) {
        pendingFiles.length = 0;
        return { action: 'continue' };
      }

      const changedFiles = [...pendingFiles];
      pendingFiles.length = 0;

      try {
        const proc = Bun.spawn(['bun', 'run', 'tsc', '--noEmit'], {
          cwd: ctx.projectRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const timeoutId = setTimeout(() => proc.kill(), 30_000);
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        clearTimeout(timeoutId);

        if (exitCode !== 0) {
          const errors = (stdout + stderr).trim();

          // Filter errors to only show ones related to changed files
          const relevantErrors = filterRelevantErrors(errors, changedFiles);

          if (relevantErrors) {
            ctx.log(`Type errors after editing ${changedFiles.join(', ')}`, 'warn');
            return {
              action: 'continue',
              feedback: [
                '⚠️ TYPE ERRORS DETECTED after your recent edit(s):',
                '```',
                relevantErrors,
                '```',
                'Fix these errors before moving on to the next task.',
                'Re-read the file and correct the type errors.',
              ].join('\n'),
            };
          }
        }

        return { action: 'continue' };
      } catch (error) {
        // Don't block on typecheck failures
        ctx.log(`Typecheck failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
        return { action: 'continue' };
      }
    });

    // Also run tests after task completion if tests exist for the changed files
    ctx.on('code:task-end', async (data): Promise<HookResult> => {
      const taskData = data as CodeTaskHookData;
      const files = taskData.files ?? [];

      // Only run tests if there are test files nearby
      const testFiles = files.filter(f =>
        f.endsWith('.test.ts') || f.endsWith('.spec.ts'),
      );

      if (testFiles.length === 0) {
        return { action: 'continue' };
      }

      try {
        const proc = Bun.spawn(['bun', 'test', ...testFiles], {
          cwd: ctx.projectRoot,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, FORCE_COLOR: '0' },
        });

        const timeoutId = setTimeout(() => proc.kill(), 60_000);
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        clearTimeout(timeoutId);

        if (exitCode !== 0) {
          const output = (stdout + stderr).trim();
          return {
            action: 'continue',
            feedback: [
              '⚠️ TEST FAILURES after completing task:',
              '```',
              output.slice(0, 2000), // Cap output
              '```',
              'Fix failing tests before moving to the next task.',
            ].join('\n'),
          };
        }

        return { action: 'continue' };
      } catch {
        return { action: 'continue' };
      }
    });
  },
};

/** Filter tsc output to only show errors from the changed files */
function filterRelevantErrors(errors: string, changedFiles: string[]): string {
  const lines = errors.split('\n');
  const relevant: string[] = [];
  let includeNext = false;

  for (const line of lines) {
    // tsc errors look like: src/core/foo.ts(10,5): error TS2345: ...
    const isErrorLine = changedFiles.some(f => line.includes(f));
    if (isErrorLine) {
      relevant.push(line);
      includeNext = true;
    } else if (includeNext && (line.startsWith(' ') || line === '')) {
      relevant.push(line); // continuation of previous error
    } else {
      includeNext = false;
    }
  }

  // If no relevant errors found, return all errors (might be indirect breakage)
  if (relevant.length === 0 && errors.length > 0) {
    // Return first 20 lines of all errors
    return lines.slice(0, 20).join('\n');
  }

  return relevant.join('\n');
}

// ---------------------------------------------------------------------------
// 2. Task Scope Guard Plugin
//
// Enforces task granularity. Monitors plan items and warns when tasks are
// too broad. Provides feedback to the merge agent to decompose large items.
// ---------------------------------------------------------------------------

export const taskScopeGuardPlugin: ForgeCouncilPlugin = {
  name: 'task-scope-guard',
  version: '1.0.0',
  description: 'Enforces task granularity — rejects overly broad tasks and suggests decomposition',

  meta: {
    tags: ['builtin', 'quality', 'planning'],
  },

  hooks: {
    'plan:merge': async (data): Promise<HookResult> => {
      const planData = data as { plan?: { items?: Array<{ title: string; description: string; id: string }> } };
      const items = planData.plan?.items ?? [];
      const warnings: string[] = [];

      for (const item of items) {
        const issues = checkTaskScope(item.title, item.description);
        if (issues.length > 0) {
          warnings.push(`Task "${item.title}" (${item.id}): ${issues.join('; ')}`);
        }
      }

      if (warnings.length > 0) {
        return {
          action: 'continue',
          feedback: [
            '⚠️ TASK SCOPE WARNINGS — Some tasks may be too broad:',
            ...warnings.map(w => `  • ${w}`),
            '',
            'Consider decomposing broad tasks into smaller, specific items.',
            'Good tasks: "Add login endpoint to auth-router.ts", "Write tests for TokenCounter"',
            'Bad tasks: "Implement authentication system", "Set up the backend"',
          ].join('\n'),
        };
      }

      return { action: 'continue' };
    },

    // Monitor coding — warn if an agent is touching too many files in one task
    'code:task-end': async (data): Promise<HookResult> => {
      const taskData = data as CodeTaskHookData;
      const files = taskData.files ?? [];

      if (files.length > 5) {
        return {
          action: 'continue',
          feedback: [
            `⚠️ Task "${taskData.title}" touched ${files.length} files.`,
            'Tasks should ideally change 1-3 files. Consider breaking this into smaller tasks.',
            `Files changed: ${files.join(', ')}`,
          ].join('\n'),
        };
      }

      return { action: 'continue' };
    },
  },
};

/** Heuristic checks for task scope */
export function checkTaskScope(title: string, description: string): string[] {
  const issues: string[] = [];
  const text = `${title} ${description}`;

  // Too vague — no specific file or function mentioned
  const vaguePatterns = [
    /^(implement|create|build|set up|add) .*(system|framework|architecture|infrastructure|module)/i,
    /^(refactor|rewrite|redesign) .*(entire|whole|all|complete)/i,
  ];
  for (const pattern of vaguePatterns) {
    if (pattern.test(title)) {
      issues.push('Too broad — specify the exact file, function, or endpoint to change');
    }
  }

  // Compound tasks (multiple actions in one)
  const compoundIndicators = [' and ', ' + ', ', then ', ' also ', ' as well as '];
  for (const indicator of compoundIndicators) {
    if (text.toLowerCase().includes(indicator)) {
      issues.push(`Compound task (contains "${indicator.trim()}") — split into separate items`);
      break;
    }
  }

  // Too short to be actionable
  if (title.split(/\s+/).length < 3) {
    issues.push('Title too short to be actionable — add specifics about what to change and where');
  }

  return issues;
}

// ---------------------------------------------------------------------------
// All built-in plugins
// ---------------------------------------------------------------------------

export const BUILTIN_PLUGINS: ForgeCouncilPlugin[] = [
  validationGatePlugin,
  taskScopeGuardPlugin,
];
