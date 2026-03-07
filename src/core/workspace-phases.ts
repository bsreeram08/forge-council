/**
 * Workspace Phase Handlers — plugs the workspace engine into the pipeline.
 *
 * Registers handlers for:
 *   - 'decompose' — Architect breaks idea into subtasks
 *   - 'workspace' — Parallel coding + QA validation
 *   - 'integrate' — Ford merges all outputs
 *
 * These replace the old monolithic plan→code→review flow with a
 * collaborative workspace where multiple coders work simultaneously.
 */

import { registerPhaseHandler, type PhaseHandler } from './pipeline.ts';
import {
  createWorkspace,
  runWorkspace,
  getWorkspaceSummary,
  type WorkspaceState,
  type WorkspaceCallbacks,
  type Decomposition,
  type SubtaskOutput,
  type TestResult,
  type TrackedSubtask,
} from './workspace.ts';

// ---------------------------------------------------------------------------
// Callback factory — wired externally (e.g. by the main orchestrator)
// ---------------------------------------------------------------------------

export interface WorkspaceAgentCallbacks {
  decompose: (idea: string, guidance: string[]) => Promise<Decomposition>;
  code: (subtask: TrackedSubtask, coderId: string) => Promise<SubtaskOutput>;
  validate: (subtask: TrackedSubtask, output: SubtaskOutput) => Promise<TestResult>;
  integrate: (state: WorkspaceState) => Promise<void>;
}

let _agentCallbacks: WorkspaceAgentCallbacks | null = null;

/**
 * Set the agent callbacks used by workspace phases.
 * Must be called before the pipeline runs.
 */
export function setWorkspaceCallbacks(callbacks: WorkspaceAgentCallbacks): void {
  _agentCallbacks = callbacks;
}

function getCallbacks(): WorkspaceAgentCallbacks {
  if (!_agentCallbacks) {
    throw new Error(
      'Workspace agent callbacks not set. Call setWorkspaceCallbacks() before running the pipeline.'
    );
  }
  return _agentCallbacks;
}

// ---------------------------------------------------------------------------
// Phase: decompose
// ---------------------------------------------------------------------------

const decomposeHandler: PhaseHandler = async (ctx) => {
  const cbs = getCallbacks();
  const guidance = ctx.state.guidance ? [ctx.state.guidance] : [];

  const decomposition = await cbs.decompose(ctx.state.idea, guidance.filter(Boolean) as string[]);

  return {
    stateUpdates: {
      phaseOutputs: {
        ...ctx.state.phaseOutputs,
        decomposition,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Phase: workspace (parallel coding + QA)
// ---------------------------------------------------------------------------

const workspaceHandler: PhaseHandler = async (ctx) => {
  const cbs = getCallbacks();
  const decomposition = ctx.state.phaseOutputs.decomposition as Decomposition | undefined;

  if (!decomposition) {
    throw new Error('No decomposition found. Run the "decompose" phase first.');
  }

  const ws = createWorkspace(
    ctx.state.sessionId,
    ctx.state.idea,
    ctx.state.guidance ? [ctx.state.guidance].filter(Boolean) as string[] : [],
  );

  // Apply the pre-computed decomposition so runWorkspace skips the decompose step.
  // We call runWorkspace with a decompose callback that returns the stored result.
  const coderIds = ctx.agentIds.length > 0 ? ctx.agentIds : ['coder'];

  const callbacks: WorkspaceCallbacks = {
    decompose: async () => decomposition,
    code: cbs.code,
    validate: cbs.validate,
    integrate: cbs.integrate,
  };

  const result = await runWorkspace(ws, coderIds, callbacks);
  const summary = getWorkspaceSummary(result);

  return {
    stateUpdates: {
      phaseOutputs: {
        ...ctx.state.phaseOutputs,
        workspace: result,
        workspaceSummary: summary,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Phase: integrate
// ---------------------------------------------------------------------------

const integrateHandler: PhaseHandler = async (ctx) => {
  const cbs = getCallbacks();
  const wsState = ctx.state.phaseOutputs.workspace as WorkspaceState | undefined;

  if (!wsState) {
    throw new Error('No workspace state found. Run the "workspace" phase first.');
  }

  await cbs.integrate(wsState);

  return {
    stateUpdates: {
      phaseOutputs: {
        ...ctx.state.phaseOutputs,
        integrated: true,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWorkspaceHandlers(): void {
  registerPhaseHandler('decompose', decomposeHandler);
  registerPhaseHandler('workspace', workspaceHandler);
  registerPhaseHandler('integrate', integrateHandler);
}
