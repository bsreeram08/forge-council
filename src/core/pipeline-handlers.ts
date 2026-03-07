/**
 * Pipeline Phase Handlers — Registers the built-in phase handlers
 * that bridge the pipeline engine (pipeline.ts) to the workflow
 * functions (workflow.ts).
 *
 * Call `registerBuiltinHandlers()` before executing a pipeline.
 */

import * as p from '@clack/prompts';
import {
  registerPhaseHandler,
  type PhaseContext,
  type PhaseResult,
} from './pipeline.ts';

// ---------------------------------------------------------------------------
// Built-in phase handlers
// ---------------------------------------------------------------------------

/**
 * Classify handler — runs the intent classifier.
 * This is a no-op placeholder since classification is done
 * inline in workflow.ts before pipeline execution.
 */
const classifyHandler = async (ctx: PhaseContext): Promise<PhaseResult> => {
  p.log.step(`① ${ctx.phase.name}`);
  // Classification happens before the pipeline in workflow.ts.
  // The result is already stored in state.classification.
  return { stateUpdates: {} };
};

/**
 * Plan handler — agents draft plan contributions in parallel.
 * Actual logic is in workflow.ts runPlanningPass1().
 */
const planHandler = async (ctx: PhaseContext): Promise<PhaseResult> => {
  p.log.step(`② ${ctx.phase.name} — ${ctx.agentIds.length} agents`);
  // Contributions are populated by workflow.ts before pipeline
  return { stateUpdates: {} };
};

/**
 * Merge handler — Ford merges agent contributions.
 */
const mergeHandler = async (ctx: PhaseContext): Promise<PhaseResult> => {
  p.log.step(`③ ${ctx.phase.name}`);
  return { stateUpdates: {} };
};

/**
 * Pick handler — user selects plan items.
 */
const pickHandler = async (ctx: PhaseContext): Promise<PhaseResult> => {
  p.log.step(`③b ${ctx.phase.name}`);
  return { stateUpdates: {} };
};

/**
 * Code handler — Carmack writes code.
 */
const codeHandler = async (ctx: PhaseContext): Promise<PhaseResult> => {
  p.log.step(`④ ${ctx.phase.name}`);
  return { stateUpdates: {} };
};

/**
 * Review handler — targeted agents review code.
 */
const reviewHandler = async (ctx: PhaseContext): Promise<PhaseResult> => {
  p.log.step(`⑤ ${ctx.phase.name} — ${ctx.agentIds.length} reviewers`);
  return { stateUpdates: {} };
};

/**
 * Fix handler — Carmack fixes selected issues.
 */
const fixHandler = async (ctx: PhaseContext): Promise<PhaseResult> => {
  const hasIssues = (ctx.state.reviews ?? []).some(
    r => r != null && Array.isArray(r.issues) && r.issues.length > 0,
  );
  if (!hasIssues) {
    return { stateUpdates: {} };
  }
  p.log.step(`⑥ ${ctx.phase.name}`);
  return { stateUpdates: {} };
};

/**
 * Ship handler — final summary and output.
 */
const shipHandler = async (ctx: PhaseContext): Promise<PhaseResult> => {
  p.log.step(`⑦ ${ctx.phase.name}`);
  return { stateUpdates: {} };
};

/**
 * Fresh Eyes handler — independent review with zero context (council mode only).
 */
const freshEyesHandler = async (ctx: PhaseContext): Promise<PhaseResult> => {
  p.log.step(`Fresh Eyes — independent validation`);
  return { stateUpdates: {} };
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let registered = false;

/**
 * Register all built-in phase handlers with the pipeline engine.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function registerBuiltinHandlers(): void {
  if (registered) return;
  registered = true;

  registerPhaseHandler('classify', classifyHandler);
  registerPhaseHandler('plan', planHandler);
  registerPhaseHandler('merge', mergeHandler);
  registerPhaseHandler('pick', pickHandler);
  registerPhaseHandler('code', codeHandler);
  registerPhaseHandler('review', reviewHandler);
  registerPhaseHandler('fix', fixHandler);
  registerPhaseHandler('ship', shipHandler);
  registerPhaseHandler('fresh-eyes', freshEyesHandler);
}
