/**
 * Pipeline Engine — Configurable phase execution with agent routing.
 *
 * Phases are declared as an ordered array. Each phase specifies:
 *   - Which agents participate
 *   - Whether they run in parallel
 *   - Under what condition the phase executes
 *   - A built-in handler that implements the logic
 *
 * The executor walks the phase array, checks conditions, resolves agents,
 * runs the handler, persists state, and evaluates loop-back rules.
 * State is fully serializable — resume from any point.
 */

import type {
  IntentClassification,
  MergedPlan,
  PlanContribution,
  CodingOutput,
  CodeReview,
} from './schemas.ts';
import type { AssembledContext } from './context-assembler.ts';
// Pipeline uses a simple token summary, not per-call TokenUsage
interface TokenSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// Phase condition — when to run a phase
// ---------------------------------------------------------------------------

export type PhaseCondition =
  | { type: 'always' }
  | { type: 'has-issues' }
  | { type: 'score-below'; threshold: number }
  | { type: 'input-vague' }
  | { type: 'user-approved' }
  | { type: 'files-changed' };

// ---------------------------------------------------------------------------
// Agent assignment to a phase
// ---------------------------------------------------------------------------

export interface AgentAssignment {
  agentId: string;
  required: boolean;
}

// ---------------------------------------------------------------------------
// Phase definition
// ---------------------------------------------------------------------------

/** Built-in handler names. Custom handlers can use any string. */
export type BuiltinHandler =
  | 'classify'
  | 'plan'
  | 'merge'
  | 'pick'
  | 'code'
  | 'review'
  | 'fix'
  | 'ship'
  | 'clarify'
  | 'fresh-eyes';

export interface PhaseConfig {
  id: string;
  name: string;
  handler: string;
  agents: AgentAssignment[];
  parallel: boolean;
  condition: PhaseCondition;
  /** If true, agents are selected dynamically at runtime (e.g. reviewers based on file types) */
  dynamicAgents: boolean;
}

// ---------------------------------------------------------------------------
// Loop configuration — which phases to repeat and when to stop
// ---------------------------------------------------------------------------

export type ExitCondition =
  | { type: 'score-threshold'; threshold: number }
  | { type: 'no-issues' }
  | { type: 'stagnation'; delta: number }
  | { type: 'max-rounds'; max: number };

export interface LoopConfig {
  /** Phase ID where the loop starts (inclusive) */
  startPhase: string;
  /** Phase ID where the loop ends (inclusive, then jumps back to startPhase) */
  endPhase: string;
  maxRounds: number;
  exitWhen: ExitCondition[];
}

// ---------------------------------------------------------------------------
// Pipeline configuration — the full pipeline spec
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  phases: PhaseConfig[];
  loops: LoopConfig[];
}

// ---------------------------------------------------------------------------
// Pipeline state — fully serializable, drives resume
// ---------------------------------------------------------------------------

export interface PipelineState {
  sessionId: string;
  startedAt: string;
  currentPhaseId: string;
  round: number;
  idea: string;
  guidance?: string;

  // Accumulated outputs from each phase
  classification?: IntentClassification;
  context?: AssembledContext;
  contributions?: PlanContribution[];
  plan?: MergedPlan;
  codingOutputs?: CodingOutput[];
  reviews?: CodeReview[];
  scores: number[];

  // Generic bag for custom phase outputs
  phaseOutputs: Record<string, unknown>;
  completedPhases: string[];
  tokenUsage: TokenSummary;
}

// ---------------------------------------------------------------------------
// Phase handler interface — what each phase handler receives and returns
// ---------------------------------------------------------------------------

export interface PhaseContext {
  state: PipelineState;
  phase: PhaseConfig;
  pipeline: PipelineConfig;
  agentIds: string[];
}

export interface PhaseResult {
  /** Fields to merge into pipeline state */
  stateUpdates: Partial<PipelineState>;
  /** Override next phase (skip ahead, loop back, etc.) */
  nextPhaseId?: string;
  /** If true, the pipeline should stop (user cancelled, fatal error) */
  halt?: boolean;
}

export type PhaseHandler = (ctx: PhaseContext) => Promise<PhaseResult>;

// ---------------------------------------------------------------------------
// Phase handler registry
// ---------------------------------------------------------------------------

const handlerRegistry = new Map<string, PhaseHandler>();

export function registerPhaseHandler(name: string, handler: PhaseHandler): void {
  handlerRegistry.set(name, handler);
}

export function getPhaseHandler(name: string): PhaseHandler | undefined {
  return handlerRegistry.get(name);
}

// ---------------------------------------------------------------------------
// Default pipeline — the Ralph Loop
// ---------------------------------------------------------------------------

export const DEFAULT_PIPELINE: PipelineConfig = {
  phases: [
    {
      id: 'classify',
      name: 'Classify Intent',
      handler: 'classify',
      agents: [],
      parallel: false,
      condition: { type: 'always' },
      dynamicAgents: false,
    },
    {
      id: 'plan',
      name: 'Plan (Parallel)',
      handler: 'plan',
      agents: [
        { agentId: 'architect', required: false },
        { agentId: 'planner', required: false },
        { agentId: 'researcher', required: false },
      ],
      parallel: true,
      condition: { type: 'always' },
      dynamicAgents: false,
    },
    {
      id: 'merge',
      name: 'Merge Plan',
      handler: 'merge',
      agents: [{ agentId: 'executor', required: true }],
      parallel: false,
      condition: { type: 'always' },
      dynamicAgents: false,
    },
    {
      id: 'pick',
      name: 'User Selection',
      handler: 'pick',
      agents: [],
      parallel: false,
      condition: { type: 'always' },
      dynamicAgents: false,
    },
    {
      id: 'code',
      name: 'Code (Parallel)',
      handler: 'code',
      agents: [{ agentId: 'coder', required: true }],
      parallel: true,
      condition: { type: 'always' },
      dynamicAgents: true,
    },
    {
      id: 'review',
      name: 'Review (Parallel)',
      handler: 'review',
      agents: [
        { agentId: 'reviewer', required: true },
      ],
      parallel: true,
      condition: { type: 'always' },
      dynamicAgents: true,
    },
    {
      id: 'fix',
      name: 'Fix Issues',
      handler: 'fix',
      agents: [{ agentId: 'coder', required: true }],
      parallel: false,
      condition: { type: 'has-issues' },
      dynamicAgents: false,
    },
    {
      id: 'ship',
      name: 'Ship',
      handler: 'ship',
      agents: [],
      parallel: false,
      condition: { type: 'always' },
      dynamicAgents: false,
    },
  ],
  loops: [
    {
      startPhase: 'code',
      endPhase: 'fix',
      maxRounds: 3,
      exitWhen: [
        { type: 'score-threshold', threshold: 7.5 },
        { type: 'no-issues' },
        { type: 'stagnation', delta: 0.5 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

export function evaluateCondition(condition: PhaseCondition, state: PipelineState): boolean {
  switch (condition.type) {
    case 'always':
      return true;
    case 'has-issues':
      return (state.reviews ?? []).some(r => r.issues.length > 0);
    case 'score-below':
      if (state.scores.length === 0) return true;
      return state.scores[state.scores.length - 1]! < condition.threshold;
    case 'input-vague':
      // Simple heuristic: very short idea or contains "something", "stuff", etc.
      return state.idea.split(/\s+/).length < 5;
    case 'user-approved':
      // Always true — the handler itself will prompt the user
      return true;
    case 'files-changed':
      return (state.codingOutputs ?? []).some(o => o.files.length > 0);
  }
}

// ---------------------------------------------------------------------------
// Exit condition evaluation
// ---------------------------------------------------------------------------

export function evaluateExitConditions(
  conditions: ExitCondition[],
  state: PipelineState,
): boolean {
  return conditions.some(cond => {
    switch (cond.type) {
      case 'score-threshold':
        if (state.scores.length === 0) return false;
        return state.scores[state.scores.length - 1]! >= cond.threshold;
      case 'no-issues':
        return (state.reviews ?? []).every(r => r.issues.length === 0);
      case 'stagnation': {
        if (state.scores.length < 2) return false;
        const last = state.scores[state.scores.length - 1]!;
        const prev = state.scores[state.scores.length - 2]!;
        return Math.abs(last - prev) < cond.delta;
      }
      case 'max-rounds':
        return state.round >= cond.max;
    }
  });
}

// ---------------------------------------------------------------------------
// Pipeline executor
// ---------------------------------------------------------------------------

export interface ExecutorCallbacks {
  onPhaseStart?: (phase: PhaseConfig, state: PipelineState) => void;
  onPhaseEnd?: (phase: PhaseConfig, state: PipelineState) => void;
  onLoopIteration?: (round: number, state: PipelineState) => void;
  onStateChange?: (state: PipelineState) => void;
  /** Called to persist state for resume. If not provided, state is not persisted. */
  persistState?: (state: PipelineState) => Promise<void>;
  /** Called to resolve dynamic agents for a phase (e.g. reviewers based on files) */
  resolveDynamicAgents?: (phase: PhaseConfig, state: PipelineState) => string[];
}

export function createInitialState(sessionId: string, idea: string, guidance?: string): PipelineState {
  return {
    sessionId,
    startedAt: new Date().toISOString(),
    currentPhaseId: '',
    round: 0,
    idea,
    guidance,
    scores: [],
    phaseOutputs: {},
    completedPhases: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

export async function executePipeline(
  pipeline: PipelineConfig,
  state: PipelineState,
  callbacks: ExecutorCallbacks = {},
): Promise<PipelineState> {
  const phaseIndex = new Map(pipeline.phases.map((p, i) => [p.id, i]));

  // Find starting phase — either from state or the first phase
  let startIdx = 0;
  if (state.currentPhaseId) {
    const idx = phaseIndex.get(state.currentPhaseId);
    if (idx !== undefined) startIdx = idx;
  }

  for (let i = startIdx; i < pipeline.phases.length; ) {
    const phase = pipeline.phases[i]!;

    // Update current phase
    state = { ...state, currentPhaseId: phase.id };
    callbacks.onStateChange?.(state);

    // Check condition
    if (!evaluateCondition(phase.condition, state)) {
      i++;
      continue;
    }

    // Resolve agents
    let agentIds = phase.agents.map(a => a.agentId);
    if (phase.dynamicAgents && callbacks.resolveDynamicAgents) {
      agentIds = callbacks.resolveDynamicAgents(phase, state);
    }

    // Get handler
    const handler = getPhaseHandler(phase.handler);
    if (!handler) {
      throw new Error(`No handler registered for phase "${phase.handler}". Register it with registerPhaseHandler().`);
    }

    // Execute
    callbacks.onPhaseStart?.(phase, state);

    const result = await handler({
      state,
      phase,
      pipeline,
      agentIds,
    });

    // Merge state updates
    state = { ...state, ...result.stateUpdates };
    state.completedPhases = [...state.completedPhases, phase.id];
    callbacks.onPhaseEnd?.(phase, state);

    // Persist state for resume
    if (callbacks.persistState) {
      await callbacks.persistState(state);
    }
    callbacks.onStateChange?.(state);

    // Check for halt
    if (result.halt) {
      return state;
    }

    // Check for explicit next phase override
    if (result.nextPhaseId) {
      const nextIdx = phaseIndex.get(result.nextPhaseId);
      if (nextIdx !== undefined) {
        i = nextIdx;
        continue;
      }
    }

    // Check loops — if we just finished the endPhase of a loop, evaluate exit
    for (const loop of pipeline.loops) {
      if (phase.id === loop.endPhase) {
        state = { ...state, round: state.round + 1 };
        callbacks.onLoopIteration?.(state.round, state);

        if (state.round >= loop.maxRounds || evaluateExitConditions(loop.exitWhen, state)) {
          // Exit the loop, continue to next phase after endPhase
          break;
        } else {
          // Loop back to startPhase
          const startIdx = phaseIndex.get(loop.startPhase);
          if (startIdx !== undefined) {
            i = startIdx;
            continue;
          }
        }
      }
    }

    i++;
  }

  return state;
}

// ---------------------------------------------------------------------------
// Pipeline validation
// ---------------------------------------------------------------------------

export function validatePipeline(pipeline: PipelineConfig): string[] {
  const errors: string[] = [];
  const phaseIds = new Set(pipeline.phases.map(p => p.id));

  // Check for duplicate phase IDs
  if (phaseIds.size !== pipeline.phases.length) {
    errors.push('Duplicate phase IDs found');
  }

  // Check loops reference valid phases
  for (const loop of pipeline.loops) {
    if (!phaseIds.has(loop.startPhase)) {
      errors.push(`Loop references unknown startPhase: ${loop.startPhase}`);
    }
    if (!phaseIds.has(loop.endPhase)) {
      errors.push(`Loop references unknown endPhase: ${loop.endPhase}`);
    }
    // startPhase must come before endPhase
    const startIdx = pipeline.phases.findIndex(p => p.id === loop.startPhase);
    const endIdx = pipeline.phases.findIndex(p => p.id === loop.endPhase);
    if (startIdx >= 0 && endIdx >= 0 && startIdx > endIdx) {
      errors.push(`Loop startPhase "${loop.startPhase}" must come before endPhase "${loop.endPhase}"`);
    }
  }

  // Check that handlers exist (if registry is populated)
  for (const phase of pipeline.phases) {
    if (!getPhaseHandler(phase.handler)) {
      // Only warn — handlers may be registered later
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Pipeline merging — merge user overrides into default
// ---------------------------------------------------------------------------

export function mergePipelines(base: PipelineConfig, overrides: Partial<PipelineConfig>): PipelineConfig {
  if (!overrides.phases && !overrides.loops) return base;

  // If user provides phases, they replace entirely (not merged per-phase)
  const phases = overrides.phases ?? base.phases;
  const loops = overrides.loops ?? base.loops;

  return { phases, loops };
}
