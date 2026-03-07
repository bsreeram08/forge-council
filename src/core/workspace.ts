/**
 * Workspace Engine — Parallel task execution with dependency-aware scheduling.
 *
 * The architect decomposes the idea into independent subtasks, each scoped to
 * specific files. Coders work in parallel (no two coders touch the same file).
 * QA validates each subtask as it completes. Ford integrates the final result.
 *
 * Flow:
 *   1. DECOMPOSE  — Architect splits idea into subtasks with file scopes
 *   2. ASSIGN     — Subtasks assigned to available coders (round-robin)
 *   3. EXECUTE    — Coders work in parallel, respecting dependency order
 *   4. VALIDATE   — QA tests each subtask output
 *   5. INTEGRATE  — Ford merges all outputs, resolves conflicts
 *   6. REVIEW     — Council reviews the integrated result (existing flow)
 */

import { z } from 'zod';
import { eventBus } from '../server/routes/ws.ts';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const SubtaskSchema = z.object({
  id: z.string(),
  title: z.string().max(80),
  description: z.string().max(500),
  spec: z.string().describe('Detailed implementation spec with examples'),
  files: z.array(z.string()).describe('Files this task will create or modify'),
  dependencies: z.array(z.string()).describe('Subtask IDs that must complete first'),
  priority: z.enum(['critical', 'high', 'normal', 'low']).default('normal'),
  estimatedComplexity: z.enum(['trivial', 'simple', 'moderate', 'complex']).default('moderate'),
});

export type Subtask = z.infer<typeof SubtaskSchema>;

export const SubtaskOutputSchema = z.object({
  subtaskId: z.string(),
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    action: z.enum(['create', 'modify', 'delete']),
  })),
  commitMessage: z.string().max(72),
  summary: z.string().max(200),
});

export type SubtaskOutput = z.infer<typeof SubtaskOutputSchema>;

export const TestResultSchema = z.object({
  subtaskId: z.string(),
  passed: z.boolean(),
  score: z.number().min(0).max(10),
  issues: z.array(z.object({
    severity: z.enum(['critical', 'warning', 'suggestion']),
    file: z.string(),
    description: z.string(),
    fix: z.string().nullable().default(null),
  })),
  summary: z.string().max(200),
});

export type TestResult = z.infer<typeof TestResultSchema>;

export const DecompositionSchema = z.object({
  subtasks: z.array(SubtaskSchema).min(1).max(20),
  summary: z.string().max(300),
  fileOwnership: z.record(z.string(), z.string())
    .describe('Map of file path → subtask ID that owns it'),
});

export type Decomposition = z.infer<typeof DecompositionSchema>;

// ---------------------------------------------------------------------------
// Workspace state
// ---------------------------------------------------------------------------

export type WorkspaceStatus =
  | 'idle'
  | 'decomposing'
  | 'working'
  | 'integrating'
  | 'reviewing'
  | 'done'
  | 'failed';

export type SubtaskStatus =
  | 'pending'
  | 'blocked'
  | 'assigned'
  | 'coding'
  | 'testing'
  | 'done'
  | 'failed';

export interface TrackedSubtask extends Subtask {
  status: SubtaskStatus;
  assignedTo: string | null;
  output: SubtaskOutput | null;
  testResult: TestResult | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface WorkspaceState {
  sessionId: string;
  idea: string;
  guidance: string[];
  status: WorkspaceStatus;
  subtasks: TrackedSubtask[];
  fileOwnership: Record<string, string>;
  round: number;
  decomposition: Decomposition | null;
}

// ---------------------------------------------------------------------------
// Workspace creation
// ---------------------------------------------------------------------------

export function createWorkspace(sessionId: string, idea: string, guidance: string[] = []): WorkspaceState {
  return {
    sessionId,
    idea,
    guidance,
    status: 'idle',
    subtasks: [],
    fileOwnership: {},
    round: 0,
    decomposition: null,
  };
}

export function applyDecomposition(state: WorkspaceState, decomposition: Decomposition): WorkspaceState {
  const tracked: TrackedSubtask[] = decomposition.subtasks.map(st => ({
    ...st,
    status: 'pending' as SubtaskStatus,
    assignedTo: null,
    output: null,
    testResult: null,
    startedAt: null,
    completedAt: null,
    error: null,
  }));

  return {
    ...state,
    status: 'working',
    subtasks: tracked,
    fileOwnership: decomposition.fileOwnership,
    decomposition,
  };
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

/**
 * Returns subtask IDs that are ready to execute (all deps satisfied).
 */
export function getReadySubtasks(state: WorkspaceState): string[] {
  const completedIds = new Set(
    state.subtasks
      .filter(st => st.status === 'done')
      .map(st => st.id)
  );

  return state.subtasks
    .filter(st =>
      st.status === 'pending' &&
      st.dependencies.every(dep => completedIds.has(dep))
    )
    .map(st => st.id);
}

/**
 * Check if all subtasks are complete (done or failed).
 */
export function isWorkComplete(state: WorkspaceState): boolean {
  return state.subtasks.every(st => st.status === 'done' || st.status === 'failed');
}

/**
 * Check for dependency cycles (returns cycle if found).
 */
export function detectCycles(subtasks: Subtask[]): string[] | null {
  const ids = new Set(subtasks.map(st => st.id));
  const visited = new Set<string>();
  const stack = new Set<string>();
  const taskMap = new Map(subtasks.map(st => [st.id, st]));

  function dfs(id: string, path: string[]): string[] | null {
    if (stack.has(id)) return [...path, id];
    if (visited.has(id)) return null;

    visited.add(id);
    stack.add(id);

    const task = taskMap.get(id);
    if (task) {
      for (const dep of task.dependencies) {
        if (!ids.has(dep)) continue;
        const cycle = dfs(dep, [...path, id]);
        if (cycle) return cycle;
      }
    }

    stack.delete(id);
    return null;
  }

  for (const st of subtasks) {
    const cycle = dfs(st.id, []);
    if (cycle) return cycle;
  }

  return null;
}

/**
 * Validate file ownership — no file claimed by multiple subtasks.
 */
export function validateFileOwnership(decomposition: Decomposition): string[] {
  const errors: string[] = [];
  const fileClaims = new Map<string, string[]>();

  for (const st of decomposition.subtasks) {
    for (const file of st.files) {
      const claims = fileClaims.get(file) ?? [];
      claims.push(st.id);
      fileClaims.set(file, claims);
    }
  }

  for (const [file, claimers] of fileClaims) {
    if (claimers.length > 1) {
      errors.push(`File "${file}" claimed by multiple subtasks: ${claimers.join(', ')}`);
    }
  }

  // Also check that fileOwnership map matches subtask declarations
  const ownershipIds = new Set(Object.values(decomposition.fileOwnership));
  const subtaskIds = new Set(decomposition.subtasks.map(st => st.id));
  for (const id of ownershipIds) {
    if (!subtaskIds.has(id)) {
      errors.push(`fileOwnership references unknown subtask: ${id}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * Round-robin assignment of ready subtasks to available coders.
 * Respects file scope — a coder already working on files won't get
 * a subtask that touches overlapping files.
 */
export function assignSubtasks(
  state: WorkspaceState,
  readyIds: string[],
  coderIds: string[],
): WorkspaceState {
  const updated = { ...state, subtasks: [...state.subtasks] };
  const busyCoders = new Set(
    updated.subtasks
      .filter(st => st.status === 'coding' || st.status === 'testing')
      .map(st => st.assignedTo)
      .filter((id): id is string => id !== null)
  );

  const availableCoders = coderIds.filter(id => !busyCoders.has(id));
  let coderIdx = 0;

  for (const taskId of readyIds) {
    if (coderIdx >= availableCoders.length) break;

    const idx = updated.subtasks.findIndex(st => st.id === taskId);
    if (idx === -1) continue;

    updated.subtasks[idx] = {
      ...updated.subtasks[idx]!,
      status: 'assigned',
      assignedTo: availableCoders[coderIdx]!,
    };
    coderIdx++;
  }

  return updated;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export function startSubtask(state: WorkspaceState, subtaskId: string): WorkspaceState {
  const idx = state.subtasks.findIndex(st => st.id === subtaskId);
  if (idx === -1) return state;

  const updated = { ...state, subtasks: [...state.subtasks] };
  updated.subtasks[idx] = {
    ...updated.subtasks[idx]!,
    status: 'coding',
    startedAt: new Date().toISOString(),
  };

  eventBus.publish('agent-progress', {
    agentId: updated.subtasks[idx]!.assignedTo ?? 'unknown',
    name: updated.subtasks[idx]!.assignedTo ?? 'unknown',
    status: 'working',
    action: `coding: ${updated.subtasks[idx]!.title}`,
  });

  return updated;
}

export function completeSubtask(
  state: WorkspaceState,
  subtaskId: string,
  output: SubtaskOutput,
): WorkspaceState {
  const idx = state.subtasks.findIndex(st => st.id === subtaskId);
  if (idx === -1) return state;

  const updated = { ...state, subtasks: [...state.subtasks] };
  updated.subtasks[idx] = {
    ...updated.subtasks[idx]!,
    status: 'testing',
    output,
  };

  return updated;
}

export function passSubtask(
  state: WorkspaceState,
  subtaskId: string,
  testResult: TestResult,
): WorkspaceState {
  const idx = state.subtasks.findIndex(st => st.id === subtaskId);
  if (idx === -1) return state;

  const updated = { ...state, subtasks: [...state.subtasks] };
  updated.subtasks[idx] = {
    ...updated.subtasks[idx]!,
    status: 'done',
    testResult,
    completedAt: new Date().toISOString(),
  };

  eventBus.publish('agent-progress', {
    agentId: updated.subtasks[idx]!.assignedTo ?? 'unknown',
    name: updated.subtasks[idx]!.assignedTo ?? 'unknown',
    status: 'done',
    action: `completed: ${updated.subtasks[idx]!.title}`,
  });

  return updated;
}

export function failSubtask(
  state: WorkspaceState,
  subtaskId: string,
  error: string,
): WorkspaceState {
  const idx = state.subtasks.findIndex(st => st.id === subtaskId);
  if (idx === -1) return state;

  const updated = { ...state, subtasks: [...state.subtasks] };
  updated.subtasks[idx] = {
    ...updated.subtasks[idx]!,
    status: 'failed',
    error,
    completedAt: new Date().toISOString(),
  };

  eventBus.publish('agent-progress', {
    agentId: updated.subtasks[idx]!.assignedTo ?? 'unknown',
    name: updated.subtasks[idx]!.assignedTo ?? 'unknown',
    status: 'failed',
    error,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Workspace summary
// ---------------------------------------------------------------------------

export interface WorkspaceSummary {
  total: number;
  pending: number;
  coding: number;
  testing: number;
  done: number;
  failed: number;
  progress: number;
}

export function getWorkspaceSummary(state: WorkspaceState): WorkspaceSummary {
  const counts = { pending: 0, blocked: 0, assigned: 0, coding: 0, testing: 0, done: 0, failed: 0 };
  for (const st of state.subtasks) {
    counts[st.status]++;
  }

  const total = state.subtasks.length;
  return {
    total,
    pending: counts.pending + counts.blocked + counts.assigned,
    coding: counts.coding,
    testing: counts.testing,
    done: counts.done,
    failed: counts.failed,
    progress: total > 0 ? (counts.done / total) * 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// Scheduler — the core parallel execution loop
// ---------------------------------------------------------------------------

export interface WorkspaceCallbacks {
  /** Called when the architect should decompose the idea into subtasks. */
  decompose: (idea: string, guidance: string[]) => Promise<Decomposition>;
  /** Called when a coder should work on a subtask. Returns the output. */
  code: (subtask: TrackedSubtask, coderId: string) => Promise<SubtaskOutput>;
  /** Called when QA should validate a subtask's output. */
  validate: (subtask: TrackedSubtask, output: SubtaskOutput) => Promise<TestResult>;
  /** Called when Ford should integrate all completed subtask outputs. */
  integrate: (state: WorkspaceState) => Promise<void>;
  /** Called on state changes for persistence / UI updates. */
  onStateChange?: (state: WorkspaceState) => void;
  /** Called on errors (non-fatal). */
  onError?: (subtaskId: string, error: Error) => void;
}

/**
 * Main workspace execution loop.
 *
 * Runs until all subtasks are done/failed or an unrecoverable error occurs.
 * Uses a task queue pattern — checks for ready subtasks, assigns to coders,
 * runs them in parallel, validates, and repeats.
 */
export async function runWorkspace(
  state: WorkspaceState,
  coderIds: string[],
  callbacks: WorkspaceCallbacks,
): Promise<WorkspaceState> {
  // Step 1: Decompose
  state = { ...state, status: 'decomposing' };
  callbacks.onStateChange?.(state);

  const decomposition = await callbacks.decompose(state.idea, state.guidance);

  // Validate decomposition
  const cycle = detectCycles(decomposition.subtasks);
  if (cycle) {
    throw new Error(`Dependency cycle detected: ${cycle.join(' → ')}`);
  }

  const fileErrors = validateFileOwnership(decomposition);
  if (fileErrors.length > 0) {
    throw new Error(`File ownership errors: ${fileErrors.join('; ')}`);
  }

  state = applyDecomposition(state, decomposition);
  callbacks.onStateChange?.(state);

  // Step 2: Execute subtasks in parallel, respecting dependencies
  while (!isWorkComplete(state)) {
    const readyIds = getReadySubtasks(state);

    if (readyIds.length === 0) {
      // Check if we're stuck (all remaining are blocked/failed)
      const remaining = state.subtasks.filter(
        st => st.status !== 'done' && st.status !== 'failed'
      );
      const allBlockedOrWorking = remaining.every(
        st => st.status === 'blocked' || st.status === 'coding' || st.status === 'testing'
      );

      if (remaining.length > 0 && !allBlockedOrWorking) {
        // Deadlocked — some tasks are pending but nothing is ready
        const pendingIds = remaining
          .filter(st => st.status === 'pending')
          .map(st => st.id);
        throw new Error(`Deadlock: tasks ${pendingIds.join(', ')} are pending but have unmet dependencies`);
      }

      // If tasks are still coding/testing, wait a tick
      if (remaining.some(st => st.status === 'coding' || st.status === 'testing')) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      break;
    }

    // Assign ready tasks to coders
    state = assignSubtasks(state, readyIds, coderIds);
    callbacks.onStateChange?.(state);

    // Run assigned tasks in parallel
    const assignedTasks = state.subtasks.filter(st => st.status === 'assigned');
    const promises = assignedTasks.map(async (task) => {
      const coderId = task.assignedTo!;

      // Start coding
      state = startSubtask(state, task.id);
      callbacks.onStateChange?.(state);

      try {
        // Coder works on subtask
        const output = await callbacks.code(task, coderId);

        // Mark as testing
        state = completeSubtask(state, task.id, output);
        callbacks.onStateChange?.(state);

        // QA validates
        const testResult = await callbacks.validate(task, output);

        if (testResult.passed) {
          state = passSubtask(state, task.id, testResult);
        } else {
          // QA found issues — mark as failed (could retry in future)
          state = failSubtask(state, task.id, `QA failed: ${testResult.summary}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        state = failSubtask(state, task.id, msg);
        callbacks.onError?.(task.id, err instanceof Error ? err : new Error(msg));
      }

      callbacks.onStateChange?.(state);
    });

    await Promise.allSettled(promises);
  }

  // Step 3: Integrate
  const summary = getWorkspaceSummary(state);
  if (summary.done > 0) {
    state = { ...state, status: 'integrating' };
    callbacks.onStateChange?.(state);
    await callbacks.integrate(state);
  }

  state = { ...state, status: summary.failed > 0 ? 'failed' : 'done' };
  callbacks.onStateChange?.(state);

  return state;
}
