/**
 * Task Board — Shared mutable state for parallel coding agents.
 *
 * Multiple coder agents claim tasks, report progress, communicate,
 * and dynamically add new tasks. The board is the single source of
 * truth for what's been done, what's in progress, and what's blocked.
 *
 * Design:
 *   - Tasks have statuses: pending → claimed → done | failed
 *   - Dependencies: a task can list other task IDs it depends on
 *   - Messages: agents post free-form messages visible to all
 *   - Events: subscribers get notified of state changes
 */

import type { MergedPlanItem } from './schemas.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'claimed' | 'done' | 'failed';

export interface CodingTask {
  id: string;
  title: string;
  description: string;
  category: string;
  phase: number;
  priority: 'must' | 'should' | 'could';
  status: TaskStatus;
  /** Agent ID that claimed this task */
  claimedBy: string | null;
  /** Task IDs that must complete before this one starts */
  dependsOn: string[];
  /** Files produced by this task */
  producedFiles: string[];
  /** Commit message when done */
  commitMessage: string | null;
  /** Summary of what was done */
  summary: string | null;
  /** Error message if failed */
  error: string | null;
  createdAt: number;
  claimedAt: number | null;
  completedAt: number | null;
  /** Whether this task was dynamically added by an agent */
  dynamic: boolean;
}

export interface AgentMessage {
  id: string;
  fromAgent: string;
  toAgent: string | null; // null = broadcast to all
  content: string;
  timestamp: number;
  taskId: string | null; // optional task context
}

export type BoardEvent =
  | { type: 'task-claimed'; taskId: string; agentId: string }
  | { type: 'task-done'; taskId: string; agentId: string; files: string[] }
  | { type: 'task-failed'; taskId: string; agentId: string; error: string }
  | { type: 'task-added'; taskId: string; addedBy: string }
  | { type: 'message'; message: AgentMessage }
  | { type: 'all-done' };

export type BoardListener = (event: BoardEvent) => void;

// ---------------------------------------------------------------------------
// TaskBoard
// ---------------------------------------------------------------------------

export class TaskBoard {
  private tasks = new Map<string, CodingTask>();
  private messages: AgentMessage[] = [];
  private listeners: BoardListener[] = [];
  private messageIdCounter = 0;

  /**
   * Seed the board from selected plan items.
   * Infers dependencies from phase ordering: items in phase N+1
   * depend on all items in phase N within the same category.
   */
  seedFromPlan(items: MergedPlanItem[], categories: { name: string; items: MergedPlanItem[] }[]): void {
    // Build a map of category -> phase -> task IDs for dependency inference
    const catPhaseMap = new Map<string, Map<number, string[]>>();

    // Find which category each item belongs to
    const itemCategoryMap = new Map<string, string>();
    for (const cat of categories) {
      for (const item of cat.items) {
        itemCategoryMap.set(item.id, cat.name);
      }
    }

    // Create tasks
    for (const item of items) {
      const category = itemCategoryMap.get(item.id) ?? 'General';
      const task: CodingTask = {
        id: item.id,
        title: item.title,
        description: item.description,
        category,
        phase: item.phase,
        priority: item.priority,
        status: 'pending',
        claimedBy: null,
        dependsOn: [],
        producedFiles: [],
        commitMessage: null,
        summary: null,
        error: null,
        createdAt: Date.now(),
        claimedAt: null,
        completedAt: null,
        dynamic: false,
      };
      this.tasks.set(item.id, task);

      // Track for dependency inference
      if (!catPhaseMap.has(category)) catPhaseMap.set(category, new Map());
      const phaseMap = catPhaseMap.get(category)!;
      if (!phaseMap.has(item.phase)) phaseMap.set(item.phase, []);
      phaseMap.get(item.phase)!.push(item.id);
    }

    // Infer dependencies: tasks in phase N depend on tasks in phase N-1 of the same category
    for (const [_category, phaseMap] of catPhaseMap) {
      const phases = [...phaseMap.keys()].sort((a, b) => a - b);
      for (let i = 1; i < phases.length; i++) {
        const prevIds = phaseMap.get(phases[i - 1]!)!;
        const currIds = phaseMap.get(phases[i]!)!;
        for (const currId of currIds) {
          const task = this.tasks.get(currId);
          if (task) task.dependsOn = [...prevIds];
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Task operations
  // -------------------------------------------------------------------------

  /**
   * Get all available tasks (pending + dependencies met).
   */
  getAvailableTasks(): CodingTask[] {
    return [...this.tasks.values()].filter(t =>
      t.status === 'pending' && this.dependenciesMet(t),
    );
  }

  /**
   * Claim the next available task for an agent.
   * Prioritizes: must > should > could, then lower phase first.
   */
  claimNext(agentId: string): CodingTask | null {
    const available = this.getAvailableTasks();
    if (available.length === 0) return null;

    // Sort by priority (must first) then phase
    const priorityOrder: Record<string, number> = { must: 0, should: 1, could: 2 };
    available.sort((a, b) => {
      const pDiff = (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2);
      if (pDiff !== 0) return pDiff;
      return a.phase - b.phase;
    });

    const task = available[0]!;
    task.status = 'claimed';
    task.claimedBy = agentId;
    task.claimedAt = Date.now();

    this.emit({ type: 'task-claimed', taskId: task.id, agentId });
    return task;
  }

  /**
   * Claim a specific task by ID.
   */
  claim(taskId: string, agentId: string): CodingTask | null {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending' || !this.dependenciesMet(task)) return null;

    task.status = 'claimed';
    task.claimedBy = agentId;
    task.claimedAt = Date.now();

    this.emit({ type: 'task-claimed', taskId: task.id, agentId });
    return task;
  }

  /**
   * Mark a task as completed.
   */
  complete(
    taskId: string,
    agentId: string,
    result: { files: string[]; commitMessage: string; summary: string },
  ): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.claimedBy !== agentId) return false;

    task.status = 'done';
    task.producedFiles = result.files;
    task.commitMessage = result.commitMessage;
    task.summary = result.summary;
    task.completedAt = Date.now();

    this.emit({ type: 'task-done', taskId, agentId, files: result.files });

    // Check if all tasks are done
    if (this.allDone) {
      this.emit({ type: 'all-done' });
    }

    return true;
  }

  /**
   * Mark a task as failed. It goes back to pending so another agent can try.
   */
  fail(taskId: string, agentId: string, error: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.claimedBy !== agentId) return false;

    task.status = 'pending'; // Return to pool for retry
    task.claimedBy = null;
    task.claimedAt = null;
    task.error = error;

    this.emit({ type: 'task-failed', taskId, agentId, error });
    return true;
  }

  /**
   * Add a dynamic task at runtime.
   */
  addTask(
    addedBy: string,
    task: {
      id: string;
      title: string;
      description: string;
      category: string;
      phase: number;
      priority: 'must' | 'should' | 'could';
      dependsOn?: string[];
    },
  ): CodingTask {
    const newTask: CodingTask = {
      ...task,
      dependsOn: task.dependsOn ?? [],
      status: 'pending',
      claimedBy: null,
      producedFiles: [],
      commitMessage: null,
      summary: null,
      error: null,
      createdAt: Date.now(),
      claimedAt: null,
      completedAt: null,
      dynamic: true,
    };
    this.tasks.set(newTask.id, newTask);
    this.emit({ type: 'task-added', taskId: newTask.id, addedBy });
    return newTask;
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /**
   * Post a message visible to other agents.
   */
  postMessage(fromAgent: string, content: string, options?: { toAgent?: string; taskId?: string }): AgentMessage {
    const msg: AgentMessage = {
      id: `msg-${++this.messageIdCounter}`,
      fromAgent,
      toAgent: options?.toAgent ?? null,
      content,
      timestamp: Date.now(),
      taskId: options?.taskId ?? null,
    };
    this.messages.push(msg);
    this.emit({ type: 'message', message: msg });
    return msg;
  }

  /**
   * Read messages, optionally filtered.
   */
  readMessages(options?: {
    forAgent?: string;
    sinceTimestamp?: number;
    taskId?: string;
    limit?: number;
  }): AgentMessage[] {
    let msgs = this.messages;

    if (options?.forAgent) {
      const agent = options.forAgent;
      msgs = msgs.filter(m => m.toAgent === null || m.toAgent === agent || m.fromAgent === agent);
    }
    if (options?.sinceTimestamp) {
      const since = options.sinceTimestamp;
      msgs = msgs.filter(m => m.timestamp > since);
    }
    if (options?.taskId) {
      const tid = options.taskId;
      msgs = msgs.filter(m => m.taskId === tid);
    }
    if (options?.limit) {
      msgs = msgs.slice(-options.limit);
    }

    return msgs;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getTask(id: string): CodingTask | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): CodingTask[] {
    return [...this.tasks.values()];
  }

  getTasksByAgent(agentId: string): CodingTask[] {
    return [...this.tasks.values()].filter(t => t.claimedBy === agentId);
  }

  getTasksByStatus(status: TaskStatus): CodingTask[] {
    return [...this.tasks.values()].filter(t => t.status === status);
  }

  get allDone(): boolean {
    return [...this.tasks.values()].every(t => t.status === 'done');
  }

  get pendingCount(): number {
    return [...this.tasks.values()].filter(t => t.status === 'pending').length;
  }

  get claimedCount(): number {
    return [...this.tasks.values()].filter(t => t.status === 'claimed').length;
  }

  get doneCount(): number {
    return [...this.tasks.values()].filter(t => t.status === 'done').length;
  }

  get totalCount(): number {
    return this.tasks.size;
  }

  /**
   * Get a summary snapshot of the board state — useful for agent context.
   */
  snapshot(): BoardSnapshot {
    const tasks = this.getAllTasks();
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      claimed: tasks.filter(t => t.status === 'claimed').length,
      done: tasks.filter(t => t.status === 'done').length,
      failed: tasks.filter(t => t.error !== null).length,
      tasks: tasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        claimedBy: t.claimedBy,
        phase: t.phase,
        priority: t.priority,
        producedFiles: t.producedFiles,
      })),
      recentMessages: this.messages.slice(-10).map(m => ({
        from: m.fromAgent,
        content: m.content,
        taskId: m.taskId,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  subscribe(listener: BoardListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private dependenciesMet(task: CodingTask): boolean {
    return task.dependsOn.every(depId => {
      const dep = this.tasks.get(depId);
      return dep?.status === 'done';
    });
  }

  private emit(event: BoardEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch { /* don't let listener errors break the board */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot type — lightweight board state for agent context injection
// ---------------------------------------------------------------------------

export interface BoardSnapshot {
  total: number;
  pending: number;
  claimed: number;
  done: number;
  failed: number;
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    claimedBy: string | null;
    phase: number;
    priority: string;
    producedFiles: string[];
  }>;
  recentMessages: Array<{
    from: string;
    content: string;
    taskId: string | null;
  }>;
}
