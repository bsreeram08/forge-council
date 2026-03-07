import { describe, test, expect } from 'bun:test';
import {
  createWorkspace,
  applyDecomposition,
  getReadySubtasks,
  isWorkComplete,
  detectCycles,
  validateFileOwnership,
  assignSubtasks,
  startSubtask,
  completeSubtask,
  passSubtask,
  failSubtask,
  getWorkspaceSummary,
  runWorkspace,
  type Decomposition,
  type SubtaskOutput,
  type TestResult,
} from './workspace.ts';

// ---------------------------------------------------------------------------
// Decomposition and workspace creation
// ---------------------------------------------------------------------------

const SAMPLE_DECOMPOSITION: Decomposition = {
  summary: 'Build a todo app with API and UI',
  subtasks: [
    {
      id: 'setup',
      title: 'Project setup',
      description: 'Initialize project, install deps, create folder structure',
      spec: 'Create package.json, tsconfig, src/ directory',
      files: ['package.json', 'tsconfig.json'],
      dependencies: [],
      priority: 'critical',
      estimatedComplexity: 'trivial',
    },
    {
      id: 'db',
      title: 'Database schema',
      description: 'SQLite schema and helpers',
      spec: 'Create todos table with id, title, done, created_at',
      files: ['src/db.ts'],
      dependencies: ['setup'],
      priority: 'critical',
      estimatedComplexity: 'simple',
    },
    {
      id: 'api',
      title: 'REST API',
      description: 'Hono routes for CRUD operations',
      spec: 'GET /todos, POST /todos, PATCH /todos/:id, DELETE /todos/:id',
      files: ['src/api.ts', 'src/server.ts'],
      dependencies: ['db'],
      priority: 'high',
      estimatedComplexity: 'moderate',
    },
    {
      id: 'tests',
      title: 'API tests',
      description: 'Test all CRUD endpoints',
      spec: 'Use bun:test, test each endpoint with happy and error paths',
      files: ['src/api.test.ts'],
      dependencies: ['api'],
      priority: 'high',
      estimatedComplexity: 'simple',
    },
  ],
  fileOwnership: {
    'package.json': 'setup',
    'tsconfig.json': 'setup',
    'src/db.ts': 'db',
    'src/api.ts': 'api',
    'src/server.ts': 'api',
    'src/api.test.ts': 'tests',
  },
};

describe('createWorkspace', () => {
  test('creates idle workspace', () => {
    const ws = createWorkspace('s1', 'Build a todo app');
    expect(ws.status).toBe('idle');
    expect(ws.subtasks).toHaveLength(0);
    expect(ws.idea).toBe('Build a todo app');
  });
});

describe('applyDecomposition', () => {
  test('converts subtasks to tracked subtasks', () => {
    const ws = createWorkspace('s1', 'test');
    const applied = applyDecomposition(ws, SAMPLE_DECOMPOSITION);

    expect(applied.status).toBe('working');
    expect(applied.subtasks).toHaveLength(4);
    expect(applied.subtasks[0]!.status).toBe('pending');
    expect(applied.subtasks[0]!.assignedTo).toBeNull();
    expect(applied.fileOwnership['src/db.ts']).toBe('db');
  });
});

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

describe('getReadySubtasks', () => {
  test('returns tasks with no dependencies initially', () => {
    const ws = applyDecomposition(createWorkspace('s1', 'test'), SAMPLE_DECOMPOSITION);
    const ready = getReadySubtasks(ws);
    expect(ready).toEqual(['setup']);
  });

  test('returns dependent tasks after deps complete', () => {
    let ws = applyDecomposition(createWorkspace('s1', 'test'), SAMPLE_DECOMPOSITION);
    // Mark setup as done
    ws = passSubtask(
      completeSubtask(
        startSubtask(assignSubtasks(ws, ['setup'], ['coder']), 'setup'),
        'setup',
        { subtaskId: 'setup', files: [], commitMessage: 'setup', summary: 'done' },
      ),
      'setup',
      { subtaskId: 'setup', passed: true, score: 9, issues: [], summary: 'ok' },
    );

    const ready = getReadySubtasks(ws);
    expect(ready).toEqual(['db']);
  });

  test('returns empty when all tasks done', () => {
    const ws = applyDecomposition(createWorkspace('s1', 'test'), {
      summary: 'test',
      subtasks: [{
        id: 'a', title: 'A', description: 'a', spec: 'a',
        files: ['a.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial',
      }],
      fileOwnership: { 'a.ts': 'a' },
    });

    const ready = getReadySubtasks(
      passSubtask(
        completeSubtask(
          startSubtask(assignSubtasks(ws, ['a'], ['coder']), 'a'),
          'a',
          { subtaskId: 'a', files: [], commitMessage: 'a', summary: 'a' },
        ),
        'a',
        { subtaskId: 'a', passed: true, score: 9, issues: [], summary: 'ok' },
      ),
    );
    expect(ready).toEqual([]);
  });
});

describe('isWorkComplete', () => {
  test('false when tasks pending', () => {
    const ws = applyDecomposition(createWorkspace('s1', 'test'), SAMPLE_DECOMPOSITION);
    expect(isWorkComplete(ws)).toBe(false);
  });

  test('true when all done or failed', () => {
    let ws = applyDecomposition(createWorkspace('s1', 'test'), {
      summary: 'test',
      subtasks: [
        { id: 'a', title: 'A', description: 'a', spec: 'a', files: ['a.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
        { id: 'b', title: 'B', description: 'b', spec: 'b', files: ['b.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
      ],
      fileOwnership: { 'a.ts': 'a', 'b.ts': 'b' },
    });

    ws = passSubtask(
      completeSubtask(startSubtask(assignSubtasks(ws, ['a'], ['c1']), 'a'), 'a',
        { subtaskId: 'a', files: [], commitMessage: 'a', summary: 'a' }),
      'a', { subtaskId: 'a', passed: true, score: 9, issues: [], summary: 'ok' },
    );
    ws = failSubtask(ws, 'b', 'broke');

    expect(isWorkComplete(ws)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe('detectCycles', () => {
  test('returns null for acyclic graph', () => {
    expect(detectCycles(SAMPLE_DECOMPOSITION.subtasks)).toBeNull();
  });

  test('detects simple cycle', () => {
    const cycle = detectCycles([
      { id: 'a', title: 'A', description: '', spec: '', files: [], dependencies: ['b'], priority: 'normal', estimatedComplexity: 'trivial' },
      { id: 'b', title: 'B', description: '', spec: '', files: [], dependencies: ['a'], priority: 'normal', estimatedComplexity: 'trivial' },
    ]);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThan(2);
  });

  test('detects transitive cycle', () => {
    const cycle = detectCycles([
      { id: 'a', title: 'A', description: '', spec: '', files: [], dependencies: ['b'], priority: 'normal', estimatedComplexity: 'trivial' },
      { id: 'b', title: 'B', description: '', spec: '', files: [], dependencies: ['c'], priority: 'normal', estimatedComplexity: 'trivial' },
      { id: 'c', title: 'C', description: '', spec: '', files: [], dependencies: ['a'], priority: 'normal', estimatedComplexity: 'trivial' },
    ]);
    expect(cycle).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// File ownership validation
// ---------------------------------------------------------------------------

describe('validateFileOwnership', () => {
  test('passes for clean ownership', () => {
    expect(validateFileOwnership(SAMPLE_DECOMPOSITION)).toEqual([]);
  });

  test('detects overlapping files', () => {
    const bad: Decomposition = {
      summary: 'test',
      subtasks: [
        { id: 'a', title: 'A', description: '', spec: '', files: ['shared.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
        { id: 'b', title: 'B', description: '', spec: '', files: ['shared.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
      ],
      fileOwnership: { 'shared.ts': 'a' },
    };
    const errors = validateFileOwnership(bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('shared.ts');
  });
});

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

describe('assignSubtasks', () => {
  test('assigns ready tasks to available coders', () => {
    const ws = applyDecomposition(createWorkspace('s1', 'test'), {
      summary: 'test',
      subtasks: [
        { id: 'a', title: 'A', description: '', spec: '', files: ['a.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
        { id: 'b', title: 'B', description: '', spec: '', files: ['b.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
        { id: 'c', title: 'C', description: '', spec: '', files: ['c.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
      ],
      fileOwnership: { 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c' },
    });

    const assigned = assignSubtasks(ws, ['a', 'b', 'c'], ['coder1', 'coder2']);

    expect(assigned.subtasks[0]!.assignedTo).toBe('coder1');
    expect(assigned.subtasks[1]!.assignedTo).toBe('coder2');
    // Third task not assigned — only 2 coders available
    expect(assigned.subtasks[2]!.assignedTo).toBeNull();
  });

  test('skips busy coders', () => {
    let ws = applyDecomposition(createWorkspace('s1', 'test'), {
      summary: 'test',
      subtasks: [
        { id: 'a', title: 'A', description: '', spec: '', files: ['a.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
        { id: 'b', title: 'B', description: '', spec: '', files: ['b.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
      ],
      fileOwnership: { 'a.ts': 'a', 'b.ts': 'b' },
    });

    // Assign and start 'a' with coder1
    ws = assignSubtasks(ws, ['a'], ['coder1', 'coder2']);
    ws = startSubtask(ws, 'a');

    // Now assign 'b' — coder1 is busy, should get coder2
    ws = assignSubtasks(ws, ['b'], ['coder1', 'coder2']);
    expect(ws.subtasks[1]!.assignedTo).toBe('coder2');
  });
});

// ---------------------------------------------------------------------------
// Workspace summary
// ---------------------------------------------------------------------------

describe('getWorkspaceSummary', () => {
  test('calculates progress correctly', () => {
    let ws = applyDecomposition(createWorkspace('s1', 'test'), {
      summary: 'test',
      subtasks: [
        { id: 'a', title: 'A', description: '', spec: '', files: ['a.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
        { id: 'b', title: 'B', description: '', spec: '', files: ['b.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
      ],
      fileOwnership: { 'a.ts': 'a', 'b.ts': 'b' },
    });

    ws = passSubtask(
      completeSubtask(startSubtask(assignSubtasks(ws, ['a'], ['c1']), 'a'), 'a',
        { subtaskId: 'a', files: [], commitMessage: 'a', summary: 'a' }),
      'a', { subtaskId: 'a', passed: true, score: 9, issues: [], summary: 'ok' },
    );

    const summary = getWorkspaceSummary(ws);
    expect(summary.total).toBe(2);
    expect(summary.done).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.progress).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Full workspace run
// ---------------------------------------------------------------------------

describe('runWorkspace', () => {
  test('executes linear dependency chain', async () => {
    const ws = createWorkspace('s1', 'build a thing');
    const codingLog: string[] = [];

    const result = await runWorkspace(ws, ['coder1'], {
      decompose: async () => ({
        summary: 'two tasks',
        subtasks: [
          { id: 'a', title: 'First', description: 'a', spec: 'a', files: ['a.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
          { id: 'b', title: 'Second', description: 'b', spec: 'b', files: ['b.ts'], dependencies: ['a'], priority: 'normal', estimatedComplexity: 'trivial' },
        ],
        fileOwnership: { 'a.ts': 'a', 'b.ts': 'b' },
      }),
      code: async (subtask) => {
        codingLog.push(subtask.id);
        return { subtaskId: subtask.id, files: [], commitMessage: `feat: ${subtask.id}`, summary: 'done' };
      },
      validate: async (subtask) => ({
        subtaskId: subtask.id, passed: true, score: 9, issues: [], summary: 'ok',
      }),
      integrate: async () => {},
    });

    expect(result.status).toBe('done');
    expect(codingLog).toEqual(['a', 'b']); // b after a due to dependency
  });

  test('executes independent tasks in parallel', async () => {
    const ws = createWorkspace('s1', 'parallel work');
    const startTimes: Record<string, number> = {};

    const result = await runWorkspace(ws, ['coder1', 'coder2'], {
      decompose: async () => ({
        summary: 'parallel tasks',
        subtasks: [
          { id: 'a', title: 'A', description: 'a', spec: 'a', files: ['a.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
          { id: 'b', title: 'B', description: 'b', spec: 'b', files: ['b.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
        ],
        fileOwnership: { 'a.ts': 'a', 'b.ts': 'b' },
      }),
      code: async (subtask) => {
        startTimes[subtask.id] = Date.now();
        await new Promise(r => setTimeout(r, 50));
        return { subtaskId: subtask.id, files: [], commitMessage: `feat: ${subtask.id}`, summary: 'done' };
      },
      validate: async (subtask) => ({
        subtaskId: subtask.id, passed: true, score: 9, issues: [], summary: 'ok',
      }),
      integrate: async () => {},
    });

    expect(result.status).toBe('done');
    // Both should have started within ~10ms of each other (parallel)
    const diff = Math.abs(startTimes['a']! - startTimes['b']!);
    expect(diff).toBeLessThan(30);
  });

  test('handles subtask failure gracefully', async () => {
    const ws = createWorkspace('s1', 'failing task');

    const result = await runWorkspace(ws, ['coder1'], {
      decompose: async () => ({
        summary: 'one failing task',
        subtasks: [
          { id: 'a', title: 'A', description: 'a', spec: 'a', files: ['a.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
        ],
        fileOwnership: { 'a.ts': 'a' },
      }),
      code: async () => {
        throw new Error('compile error');
      },
      validate: async (subtask) => ({
        subtaskId: subtask.id, passed: true, score: 9, issues: [], summary: 'ok',
      }),
      integrate: async () => {},
    });

    expect(result.status).toBe('failed');
    expect(result.subtasks[0]!.status).toBe('failed');
    expect(result.subtasks[0]!.error).toContain('compile error');
  });

  test('rejects cyclic dependencies', async () => {
    const ws = createWorkspace('s1', 'cyclic');

    await expect(
      runWorkspace(ws, ['coder1'], {
        decompose: async () => ({
          summary: 'cycle',
          subtasks: [
            { id: 'a', title: 'A', description: '', spec: '', files: ['a.ts'], dependencies: ['b'], priority: 'normal', estimatedComplexity: 'trivial' },
            { id: 'b', title: 'B', description: '', spec: '', files: ['b.ts'], dependencies: ['a'], priority: 'normal', estimatedComplexity: 'trivial' },
          ],
          fileOwnership: { 'a.ts': 'a', 'b.ts': 'b' },
        }),
        code: async () => ({ subtaskId: '', files: [], commitMessage: '', summary: '' }),
        validate: async () => ({ subtaskId: '', passed: true, score: 9, issues: [], summary: '' }),
        integrate: async () => {},
      }),
    ).rejects.toThrow('cycle');
  });

  test('QA failure marks subtask as failed', async () => {
    const ws = createWorkspace('s1', 'qa fail');

    const result = await runWorkspace(ws, ['coder1'], {
      decompose: async () => ({
        summary: 'one task',
        subtasks: [
          { id: 'a', title: 'A', description: 'a', spec: 'a', files: ['a.ts'], dependencies: [], priority: 'normal', estimatedComplexity: 'trivial' },
        ],
        fileOwnership: { 'a.ts': 'a' },
      }),
      code: async (subtask) => ({
        subtaskId: subtask.id, files: [], commitMessage: 'feat: a', summary: 'done',
      }),
      validate: async (subtask) => ({
        subtaskId: subtask.id, passed: false, score: 3, issues: [
          { severity: 'critical', file: 'a.ts', description: 'no error handling', fix: 'add try/catch' },
        ], summary: 'Missing error handling',
      }),
      integrate: async () => {},
    });

    expect(result.status).toBe('failed');
    expect(result.subtasks[0]!.status).toBe('failed');
    expect(result.subtasks[0]!.error).toContain('QA failed');
  });
});
