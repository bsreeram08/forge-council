import { describe, test, expect, beforeEach } from 'bun:test';
import { createCommTools } from './agent-comms.ts';
import { TaskBoard } from './task-board.ts';
import type { MergedPlanItem } from './schemas.ts';

function makeItem(overrides: Partial<MergedPlanItem> = {}): MergedPlanItem {
  return {
    id: 'item-1',
    title: 'Test item',
    description: 'A test item',
    priority: 'must',
    phase: 1,
    source: 'test',
    selected: true,
    ...overrides,
  };
}

describe('Agent Communication Tools', () => {
  let board: TaskBoard;
  let tools: ReturnType<typeof createCommTools>;

  beforeEach(() => {
    board = new TaskBoard();
    const items = [
      makeItem({ id: 'task-a', title: 'Build auth', priority: 'must', phase: 1 }),
      makeItem({ id: 'task-b', title: 'Build API', priority: 'should', phase: 1 }),
      makeItem({ id: 'task-c', title: 'Build tests', priority: 'could', phase: 2 }),
    ];
    board.seedFromPlan(items, [{ name: 'Backend', items }]);
    tools = createCommTools('agent-1', board);
  });

  test('getBoard returns board snapshot', async () => {
    const result = await tools.getBoard.execute({}, { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal });
    expect(result.total).toBe(3);
    expect(result.pending).toBe(3); // all pending (task-c blocked but still pending status)
    expect(result.tasks).toHaveLength(3);
  });

  test('claimTask claims a specific task', async () => {
    const result = await tools.claimTask.execute(
      { taskId: 'task-a' },
      { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.success).toBe(true);
    expect((result as any).task.id).toBe('task-a');
  });

  test('claimTask fails for blocked task', async () => {
    const result = await tools.claimTask.execute(
      { taskId: 'task-c' },
      { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.success).toBe(false);
  });

  test('claimNextTask picks highest priority', async () => {
    const result = await tools.claimNextTask.execute(
      {},
      { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.success).toBe(true);
    expect((result as any).task.id).toBe('task-a');
  });

  test('completeTask marks task done', async () => {
    await tools.claimTask.execute(
      { taskId: 'task-a' },
      { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal },
    );

    const result = await tools.completeTask.execute(
      { taskId: 'task-a', files: ['src/auth.ts'], commitMessage: 'feat: add auth', summary: 'Built auth' },
      { toolCallId: 'tc2', messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.success).toBe(true);
    expect(board.getTask('task-a')?.status).toBe('done');
  });

  test('completeTask rejects if not claimed by this agent', async () => {
    board.claim('task-a', 'other-agent');

    const result = await tools.completeTask.execute(
      { taskId: 'task-a', files: [], commitMessage: 'x', summary: 'x' },
      { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.success).toBe(false);
  });

  test('failTask returns task to pool', async () => {
    await tools.claimTask.execute(
      { taskId: 'task-a' },
      { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal },
    );

    const result = await tools.failTask.execute(
      { taskId: 'task-a', error: 'out of tokens' },
      { toolCallId: 'tc2', messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.success).toBe(true);
    expect(board.getTask('task-a')?.status).toBe('pending');
  });

  test('postMessage and readMessages round-trip', async () => {
    await tools.postMessage.execute(
      { content: 'Working on auth', toAgent: null, taskId: 'task-a' },
      { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal },
    );

    const result = await tools.readMessages.execute(
      { sinceTimestamp: 0, limit: 10 },
      { toolCallId: 'tc2', messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.count).toBe(1);
    expect(result.messages[0]!.from).toBe('agent-1');
    expect(result.messages[0]!.content).toBe('Working on auth');
  });

  test('addTask creates dynamic task', async () => {
    const result = await tools.addTask.execute(
      {
        id: 'dynamic-util',
        title: 'Shared util',
        description: 'Create shared utility',
        category: 'Infra',
        phase: 0,
        priority: 'must',
        dependsOn: [],
      },
      { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.success).toBe(true);
    expect(board.totalCount).toBe(4);
    expect(board.getTask('dynamic-util')?.dynamic).toBe(true);
  });

  test('addTask rejects duplicate ID', async () => {
    const result = await tools.addTask.execute(
      {
        id: 'task-a', // already exists
        title: 'Dup',
        description: 'x',
        category: 'X',
        phase: 1,
        priority: 'must',
        dependsOn: [],
      },
      { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.success).toBe(false);
  });

  test('cross-agent communication', async () => {
    const tools2 = createCommTools('agent-2', board);

    // Agent 1 posts a message
    await tools.postMessage.execute(
      { content: 'I am doing auth, do not touch src/auth.ts', toAgent: null, taskId: null },
      { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal },
    );

    // Agent 2 reads it
    const result = await tools2.readMessages.execute(
      { sinceTimestamp: 0, limit: 10 },
      { toolCallId: 'tc2', messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.count).toBe(1);
    expect(result.messages[0]!.from).toBe('agent-1');
  });
});
