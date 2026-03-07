import { describe, test, expect, beforeEach } from 'bun:test';
import { TaskBoard, type BoardEvent, type CodingTask } from './task-board.ts';
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

describe('TaskBoard', () => {
  let board: TaskBoard;

  beforeEach(() => {
    board = new TaskBoard();
  });

  describe('seedFromPlan', () => {
    test('creates tasks from plan items', () => {
      const items = [
        makeItem({ id: 'a', phase: 1 }),
        makeItem({ id: 'b', phase: 1 }),
        makeItem({ id: 'c', phase: 2 }),
      ];
      const categories = [{ name: 'API', items }];

      board.seedFromPlan(items, categories);

      expect(board.totalCount).toBe(3);
      expect(board.pendingCount).toBe(3);
    });

    test('infers dependencies from phase ordering within category', () => {
      const items = [
        makeItem({ id: 'a', phase: 1 }),
        makeItem({ id: 'b', phase: 2 }),
      ];
      const categories = [{ name: 'API', items }];

      board.seedFromPlan(items, categories);

      const taskB = board.getTask('b');
      expect(taskB?.dependsOn).toEqual(['a']);
    });

    test('does not create cross-category dependencies', () => {
      const apiItems = [makeItem({ id: 'api-1', phase: 1 })];
      const uiItems = [makeItem({ id: 'ui-1', phase: 2 })];
      const categories = [
        { name: 'API', items: apiItems },
        { name: 'UI', items: uiItems },
      ];

      board.seedFromPlan([...apiItems, ...uiItems], categories);

      const uiTask = board.getTask('ui-1');
      expect(uiTask?.dependsOn).toEqual([]);
    });
  });

  describe('claiming tasks', () => {
    beforeEach(() => {
      const items = [
        makeItem({ id: 'must-1', priority: 'must', phase: 1 }),
        makeItem({ id: 'should-1', priority: 'should', phase: 1 }),
        makeItem({ id: 'could-1', priority: 'could', phase: 1 }),
      ];
      board.seedFromPlan(items, [{ name: 'General', items }]);
    });

    test('claimNext picks highest priority first', () => {
      const task = board.claimNext('agent-1');
      expect(task?.id).toBe('must-1');
      expect(task?.status).toBe('claimed');
      expect(task?.claimedBy).toBe('agent-1');
    });

    test('claimNext returns null when no tasks available', () => {
      board.claimNext('a');
      board.claimNext('b');
      board.claimNext('c');
      expect(board.claimNext('d')).toBeNull();
    });

    test('claim specific task by ID', () => {
      const task = board.claim('should-1', 'agent-1');
      expect(task?.id).toBe('should-1');
    });

    test('cannot claim already-claimed task', () => {
      board.claim('must-1', 'agent-1');
      expect(board.claim('must-1', 'agent-2')).toBeNull();
    });

    test('cannot claim task with unmet dependencies', () => {
      const items = [
        makeItem({ id: 'dep', phase: 1 }),
        makeItem({ id: 'blocked', phase: 2 }),
      ];
      const board2 = new TaskBoard();
      board2.seedFromPlan(items, [{ name: 'Cat', items }]);

      expect(board2.claim('blocked', 'agent-1')).toBeNull();
    });
  });

  describe('completing and failing tasks', () => {
    beforeEach(() => {
      const items = [makeItem({ id: 't1', phase: 1 })];
      board.seedFromPlan(items, [{ name: 'Cat', items }]);
      board.claim('t1', 'agent-1');
    });

    test('complete marks task as done', () => {
      const ok = board.complete('t1', 'agent-1', {
        files: ['src/foo.ts'],
        commitMessage: 'feat: add foo',
        summary: 'Added foo',
      });
      expect(ok).toBe(true);
      expect(board.getTask('t1')?.status).toBe('done');
      expect(board.doneCount).toBe(1);
    });

    test('complete rejects wrong agent', () => {
      const ok = board.complete('t1', 'agent-2', {
        files: [],
        commitMessage: 'x',
        summary: 'x',
      });
      expect(ok).toBe(false);
    });

    test('fail returns task to pending pool', () => {
      const ok = board.fail('t1', 'agent-1', 'ran out of tokens');
      expect(ok).toBe(true);
      expect(board.getTask('t1')?.status).toBe('pending');
      expect(board.getTask('t1')?.error).toBe('ran out of tokens');
    });

    test('completing a dependency unblocks downstream tasks', () => {
      const items = [
        makeItem({ id: 'upstream', phase: 1 }),
        makeItem({ id: 'downstream', phase: 2 }),
      ];
      const board2 = new TaskBoard();
      board2.seedFromPlan(items, [{ name: 'Cat', items }]);

      // downstream should be blocked
      expect(board2.getAvailableTasks().map(t => t.id)).toEqual(['upstream']);

      // Complete upstream
      board2.claim('upstream', 'a');
      board2.complete('upstream', 'a', { files: [], commitMessage: 'x', summary: 'x' });

      // Now downstream is available
      expect(board2.getAvailableTasks().map(t => t.id)).toEqual(['downstream']);
    });
  });

  describe('dynamic tasks', () => {
    test('addTask creates a new task', () => {
      const task = board.addTask('agent-1', {
        id: 'dynamic-1',
        title: 'Shared utility',
        description: 'Create shared util',
        category: 'Infra',
        phase: 0,
        priority: 'must',
      });
      expect(task.dynamic).toBe(true);
      expect(board.totalCount).toBe(1);
    });

    test('dynamic task can have dependencies', () => {
      board.addTask('a', { id: 'base', title: 'Base', description: 'x', category: 'X', phase: 1, priority: 'must' });
      board.addTask('a', { id: 'dep', title: 'Dep', description: 'x', category: 'X', phase: 2, priority: 'must', dependsOn: ['base'] });

      expect(board.getAvailableTasks().map(t => t.id)).toEqual(['base']);
    });
  });

  describe('messaging', () => {
    test('post and read messages', () => {
      board.postMessage('agent-1', 'Working on auth module');
      board.postMessage('agent-2', 'Got it, I will handle DB');

      const msgs = board.readMessages();
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.fromAgent).toBe('agent-1');
    });

    test('targeted messages are filtered', () => {
      board.postMessage('agent-1', 'Hey agent-2', { toAgent: 'agent-2' });
      board.postMessage('agent-1', 'Broadcast');

      const forAgent2 = board.readMessages({ forAgent: 'agent-2' });
      expect(forAgent2).toHaveLength(2); // Targeted + broadcast

      const forAgent3 = board.readMessages({ forAgent: 'agent-3' });
      expect(forAgent3).toHaveLength(1); // Only broadcast
    });

    test('sinceTimestamp filters messages', async () => {
      board.postMessage('a', 'old message');
      const cutoff = Date.now();
      await new Promise(r => setTimeout(r, 5));
      board.postMessage('b', 'new message');

      const msgs = board.readMessages({ sinceTimestamp: cutoff });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.content).toBe('new message');
    });
  });

  describe('events', () => {
    test('emits task-claimed event', () => {
      const events: BoardEvent[] = [];
      board.subscribe(e => events.push(e));

      board.addTask('a', { id: 't1', title: 'X', description: 'x', category: 'X', phase: 1, priority: 'must' });
      board.claim('t1', 'agent-1');

      expect(events).toHaveLength(2); // task-added + task-claimed
      expect(events[1]!.type).toBe('task-claimed');
    });

    test('emits all-done when last task completes', () => {
      const events: BoardEvent[] = [];

      board.addTask('a', { id: 't1', title: 'X', description: 'x', category: 'X', phase: 1, priority: 'must' });
      board.claim('t1', 'agent-1');

      board.subscribe(e => events.push(e));
      board.complete('t1', 'agent-1', { files: [], commitMessage: 'x', summary: 'x' });

      expect(events.some(e => e.type === 'all-done')).toBe(true);
    });

    test('unsubscribe works', () => {
      const events: BoardEvent[] = [];
      const unsub = board.subscribe(e => events.push(e));

      board.addTask('a', { id: 't1', title: 'X', description: 'x', category: 'X', phase: 1, priority: 'must' });
      unsub();
      board.addTask('a', { id: 't2', title: 'Y', description: 'y', category: 'Y', phase: 1, priority: 'must' });

      expect(events).toHaveLength(1);
    });
  });

  describe('snapshot', () => {
    test('produces correct summary', () => {
      const items = [
        makeItem({ id: 'a', phase: 1 }),
        makeItem({ id: 'b', phase: 1 }),
      ];
      board.seedFromPlan(items, [{ name: 'Cat', items }]);
      board.claim('a', 'agent-1');
      board.complete('a', 'agent-1', { files: ['f.ts'], commitMessage: 'x', summary: 'x' });

      const snap = board.snapshot();
      expect(snap.total).toBe(2);
      expect(snap.done).toBe(1);
      expect(snap.pending).toBe(1);
      expect(snap.tasks).toHaveLength(2);
    });
  });
});
