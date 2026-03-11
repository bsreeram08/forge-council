import { generateText, tool, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';
import * as p from '@clack/prompts';
import {
  PlanContributionSchema,
  MergedPlanSchema,
  PlanChangeSchema,
  CodeReviewSchema,
  CodingOutputSchema,
  type PlanContribution,
  type MergedPlan,
  type MergedPlanItem,
  type PlanChange,
  type CodeReview,
  type CodingOutput,
  type ContestedItem,
  type IntentClassification,
  type FlowPhase,
} from './schemas.ts';
import { loadPersona, PLANNING_AGENT_IDS, COUNCIL_AGENT_IDS } from './persona.ts';
import { classifyIntent, greenfieldClassification } from './intent-classifier.ts';
import { assembleContext, assembleContextSmart, formatContext, getSmallestContextBudget, type AssembledContext } from './context-assembler.ts';
import { buildAgentMessages } from './prompt-assembler.ts';
import { buildMergeInstructions, applyPass2Changes, selectReviewAgents } from './plan-merger.ts';
import { TokenCounter, estimateTokens, type TokenUsage } from './token-counter.ts';
import { resolveModel, resolveModelWithFallbacks } from '../config/resolver.ts';
import type { ForgeCouncilConfig } from '../config/schema.ts';
import { getAgentTools, resetToolTracking, setProjectRoot } from './agent-tools.ts';
import { reviewAndApply } from './edit-review.ts';
import { registerBuiltinHandlers } from './pipeline-handlers.ts';
import { initializeSkillRegistry } from './skill-loader.ts';
import { initializeQmdStore } from './qmd-store.ts';
import { shouldUseRlm, setupRlm, clearSubAgentTracker } from './rlm/index.ts';
import { z } from 'zod';

// Ensure pipeline handlers are registered for future pipeline integration
registerBuiltinHandlers();

// ---------------------------------------------------------------------------
// ANSI color helpers (shared across display functions)
// ---------------------------------------------------------------------------

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD_MAGENTA = '\x1b[1;35m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

// ---------------------------------------------------------------------------
// generateText with tools + structured output via submit tool
// ---------------------------------------------------------------------------

interface GenerateWithToolsOptions<T> {
  models: LanguageModel[];
  outputSchema: z.ZodType<T>;
  outputName: string;
  outputDescription: string;
  messages: any[];
  agentId: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxSteps?: number;
  onProgress?: ProgressCallback;
  abortSignal?: AbortSignal;
  /** Extra tools to inject (e.g. RLM tools when in RLM mode) */
  extraTools?: Record<string, any>;
}

async function generateWithTools<T>(
  options: GenerateWithToolsOptions<T>,
): Promise<{ object: T; modelUsed: LanguageModel }> {
  const {
    models, outputSchema, outputName, outputDescription,
    messages, agentId, temperature, maxOutputTokens,
    maxSteps = 10, onProgress, abortSignal, extraTools,
  } = options;

  // Reset read tracking for this agent invocation
  resetToolTracking();

  // Get the agent's allowed tools (includes QMD tools when available)
  const agentTools = getAgentTools(agentId, extraTools);

  // Add a "submit" tool that produces the structured output
  const submitTool = tool({
    description: `Submit your final ${outputDescription}. Call this ONCE when you are done exploring and ready to provide your result.`,
    inputSchema: outputSchema,
  });

  const allTools = {
    ...agentTools,
    [outputName]: submitTool,
  };

  const errors: string[] = [];

  for (const model of models) {
    // Allow up to 2 attempts per model: first normal, then with a nudge if it didn't submit
    const modelLabel = (model as any).modelId ?? `model-${models.indexOf(model)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const isRetry = attempt > 0;
        if (!isRetry) {
          onProgress?.(agentId, 'start', `using ${models.indexOf(model) === 0 ? 'primary' : 'fallback'}: ${modelLabel}`);
        } else {
          onProgress?.(agentId, 'start', `retrying ${modelLabel} with submit nudge`);
        }

        // Doom loop detection
        const recentCalls: Array<{ name: string; hash: string }> = [];

        // On retry, append a nudge message telling the model to call submit NOW
        const attemptMessages = isRetry
          ? [
              ...messages,
              { role: 'user' as const, content: `You ran out of steps without calling ${outputName}. You MUST call the ${outputName} tool NOW with your result. Do not make any more exploration calls — submit immediately with the information you have.` },
            ]
          : messages;

        const result = await generateText({
          model,
          messages: attemptMessages,
          tools: allTools,
          stopWhen: stepCountIs(isRetry ? 3 : maxSteps),
          temperature,
          maxOutputTokens,
          toolChoice: 'auto',
          abortSignal,
          experimental_onToolCallStart: (event) => {
            const name = event.toolCall.toolName;
            const args = event.toolCall.input;

            // Track for doom loop detection
            const hash = JSON.stringify(args);
            recentCalls.push({ name, hash });
            if (recentCalls.length >= 3) {
              const last3 = recentCalls.slice(-3);
              if (last3.every(c => c.name === last3[0]!.name && c.hash === last3[0]!.hash)) {
                onProgress?.(agentId, 'warning', `Doom loop: ${last3[0]!.name} called 3x with identical input`);
              }
            }

            if (name === outputName) {
              onProgress?.(agentId, 'submit', 'producing structured output');
            } else {
              const detail = formatToolCallDetail(name, args);
              onProgress?.(agentId, 'tool', detail);
            }
          },
        });

        // Tool call summary
        const toolNames = result.steps.flatMap(s => s.toolCalls.map(tc => tc.toolName));
        const editCount = toolNames.filter(n => n === 'editFile').length;
        onProgress?.(agentId, 'tool-summary', `${toolNames.length} tool calls${editCount > 0 ? ` (${editCount} edits)` : ''}`);

        // Find the submit tool call in the steps
        for (const step of result.steps) {
          for (const tc of step.toolCalls) {
            if (tc.toolName === outputName && 'input' in tc) {
              return { object: tc.input as T, modelUsed: model };
            }
          }
        }

        // If no submit tool call found and this was the first attempt, retry with nudge
        if (!isRetry) {
          onProgress?.(agentId, 'warning', `${modelLabel}: did not call ${outputName}, retrying with nudge`);
          continue; // go to attempt 1
        }

        // Second attempt also failed — record error and try next model
        throw new Error(
          `[${modelLabel}] Agent ${agentId} did not call ${outputName} after retry.`,
        );
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        const msg = raw.startsWith('[') ? raw : `[${modelLabel}] ${raw}`;
        // Only record the error if this is the final attempt for this model
        if (attempt > 0 || !raw.includes('did not call')) {
          errors.push(msg);
          break; // move to next model
        }
        // For "did not call" on first attempt, the continue above handles retry
      }
    }
  }

  throw new Error(
    `All models failed for ${agentId}:\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}`,
  );
}

// ---------------------------------------------------------------------------
// Tool call formatting for progress display
// ---------------------------------------------------------------------------

function formatToolCallDetail(toolName: string, input: unknown): string {
  const args = input as Record<string, unknown>;
  switch (toolName) {
    case 'readFile':
      return `reading ${args.path ?? 'file'}`;
    case 'listDir':
      return `listing ${args.path ?? '.'}${args.recursive ? ' (recursive)' : ''}`;
    case 'searchFiles':
      return `searching for "${args.pattern}" in ${args.path ?? '.'}`;
    case 'gitLog':
      return `checking git history${args.path ? ` for ${args.path}` : ''}`;
    case 'gitDiff':
      return `viewing ${args.staged ? 'staged ' : ''}diff`;
    case 'writeFile':
      return `writing ${args.path ?? 'file'}`;
    case 'editFile':
      return `editing ${args.path ?? 'file'}`;
    case 'runTests':
      return `running tests${args.pattern ? ` (${args.pattern})` : ''}`;
    case 'typeCheck':
      return 'type checking';
    case 'gitCommit':
      return `committing: ${(args.message as string)?.slice(0, 40) ?? ''}`;
    default:
      return toolName;
  }
}

// ---------------------------------------------------------------------------
// Live progress display for parallel agents
// AgentDisplay provides per-agent panels with rolling tool call logs
// ---------------------------------------------------------------------------

import { AgentDisplay, type ProgressCallback } from './agent-display.ts';
import { eventBus } from '../server/routes/ws.ts';
import { sessionManager } from '../server/session.ts';
import { TaskBoard } from './task-board.ts';
import { createCommTools } from './agent-comms.ts';
import { startSteering, initInbox, createAbortSignal, cleanupAbort, type SteeringSession } from './agent-steering.ts';

// Module-level reference to the currently active AgentDisplay (if any).
// This allows the API layer to query agent status during execution.
let currentDisplay: AgentDisplay | null = null;

/** Get the current active AgentDisplay (null if no agents are running). */
export function getCurrentDisplay(): AgentDisplay | null {
  return currentDisplay;
}

/**
 * Creates a progress callback that feeds both the terminal AgentDisplay
 * and the eventBus (for desktop/web UI).
 */
function createDualCallback(display: AgentDisplay): ProgressCallback {
  return (agentId: string, event: string, detail?: string) => {
    // Feed terminal display
    display.callback(agentId, event, detail);

    // Map event types to agent-progress WebSocket events
    const persona = loadPersona(agentId);
    const suffixMatch = agentId.match(/-(\d+)$/);
    const name = suffixMatch ? `${persona.codename}-${suffixMatch[1]}` : persona.codename;
    if (event === 'start' || event === 'tool') {
      eventBus.publish('agent-progress', { agentId, name, status: 'working', action: detail });
    } else if (event === 'done') {
      eventBus.publish('agent-progress', { agentId, name, status: 'done', action: detail });
    } else if (event === 'failed') {
      eventBus.publish('agent-progress', { agentId, name, status: 'failed', error: detail });
    } else if (event === 'submit') {
      eventBus.publish('agent-progress', { agentId, name, status: 'working', action: detail ?? 'producing output' });
    }
  };
}

// ---------------------------------------------------------------------------
// Main v4 Workflow: Plan → Pick → Code → Review → Fix → Ship
// ---------------------------------------------------------------------------

export interface WorkflowOptions {
  idea: string;
  config: ForgeCouncilConfig;
  projectRoot?: string;
  guidance?: string;
  mode?: 'default' | 'council' | 'custom';
  customAgentIds?: string[];
}

export interface WorkflowResult {
  phase: FlowPhase;
  plan?: MergedPlan;
  codingOutputs?: CodingOutput[];
  reviews?: CodeReview[];
  tokenCounter: TokenCounter;
}

export async function runWorkflow(options: WorkflowOptions): Promise<WorkflowResult> {
  const { idea, config, projectRoot, guidance, mode, customAgentIds } = options;
  const root = projectRoot ?? process.cwd();
  setProjectRoot(root);
  const tokenCounter = new TokenCounter();

  // --- Initialize Skills, QMD, and RLM subsystems ---
  initializeSkillRegistry();

  // Initialize QMD store if configured
  const qmdConfig = config.qmd;
  if (qmdConfig?.enabled !== false) {
    try {
      await initializeQmdStore(qmdConfig ?? { enabled: true, storePath: '.forgecouncil/.qmd', indexOnStart: true, excludePatterns: ['node_modules', '.git', 'dist'], includePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.md', '**/*.json'], collections: {}, minScore: 0.2 }, root);
    } catch {
      // QMD not available — proceed without it
    }
  }

  // Determine which agents to use for planning based on mode
  const planningAgents: readonly string[] = mode === 'council'
    ? COUNCIL_AGENT_IDS
    : mode === 'custom' && customAgentIds?.length
      ? customAgentIds
      : PLANNING_AGENT_IDS;

  // --- Phase 1: CLASSIFY ---
  eventBus.publish('round', { round: 0, phase: 'classifying' });
  p.log.step('① Classifying intent...');

  let classification: IntentClassification = greenfieldClassification(idea);
  let context: AssembledContext;

  try {
    const classifierModels = resolveClassifierModels(config);
    for (const model of classifierModels) {
      try {
        const result = await classifyIntent({ model, idea, phase: 'plan' });
        classification = result.classification;
        tokenCounter.record(result.usage);
        break;
      } catch {
        continue;
      }
    }
  } catch {
    p.log.warn('Intent classifier failed, using keyword fallback.');
  }

  p.log.info(`Type: ${classification.taskType} | Domains: ${classification.domains.join(', ')} | Complexity: ${classification.complexity}`);

  // --- Assemble static context ---
  // Budget context for the smallest model across all planning agents
  const planningModelRefs = planningAgents.map(id => {
    const persona = loadPersona(id);
    const override = config.agents.overrides?.[id];
    return override?.model?.primary ?? persona.model;
  });
  const smallestBudget = getSmallestContextBudget(planningModelRefs, config);
  context = await assembleContextSmart(classification, projectRoot, { maxTokens: smallestBudget });
  if (context.files.length > 0) {
    p.log.info(`Loaded ${context.files.length} files (${context.totalTokens.toLocaleString()} tokens, budget: ${smallestBudget.toLocaleString()})`);
  }

  // --- Phase 2: PLAN (Pass 1) ---
  eventBus.publish('round', { round: 1, phase: 'planning' });
  p.log.step(`② Planning — ${planningAgents.length} agents drafting in parallel...`);

  const contributions = await runPlanningPass1(
    idea, classification, context, config, tokenCounter, guidance, planningAgents,
  );

  p.log.info(`Received ${contributions.length} contributions with ${contributions.reduce((n, c) => n + c.items.length, 0)} total items.`);

  // --- Ford merges (with retry on failure) ---
  eventBus.publish('round', { round: 1, phase: 'merging' });
  p.log.step('③ Ford merging contributions...');
  let plan: MergedPlan;
  while (true) {
    try {
      plan = await fordMerge(idea, classification, context, contributions, config, tokenCounter);
      break;
    } catch (mergeError) {
      const errMsg = mergeError instanceof Error ? mergeError.message : String(mergeError);
      p.log.error(`Merge failed: ${errMsg}`);

      const action = await p.select({
        message: 'Ford failed to merge the plan. What would you like to do?',
        options: [
          { value: 'retry', label: 'Retry merge', hint: 'Try again with the same models' },
          { value: 'skip', label: 'Skip merge — use raw contributions', hint: 'Auto-generate a plan from contributions' },
          { value: 'abort', label: 'Abort workflow' },
        ],
      });

      if (p.isCancel(action) || action === 'abort') {
        throw mergeError;
      }

      if (action === 'skip') {
        // Build a synthetic plan from raw contributions
        const allItems = contributions.flatMap((c, ci) =>
          c.items.map((item, ii) => ({
            id: `item-${ci}-${ii}`,
            title: item.title.slice(0, 80),
            description: item.description.slice(0, 200),
            priority: 'should' as const,
            phase: item.phase ?? 1,
            source: c.agentId,
            selected: true,
          }))
        );
        plan = {
          summary: `Auto-generated from ${contributions.length} agent contributions (merge skipped)`,
          categories: [{ name: 'All Items', items: allItems }],
          techStack: Object.fromEntries(
            contributions.flatMap(c => c.techSuggestions?.map(t => [t.tool, t.reason]) ?? [])
          ),
          phases: [{ number: 1, title: 'Implementation', scope: 'All items', effort: 'medium' }],
        };
        break;
      }
      // action === 'retry' → loop again
      p.log.step('③ Retrying merge...');
    }
  }

  // --- Phase 3: PICK (user selects items) ---
  const pickResult = await userPickItems(plan);

  if (pickResult.action === 'refine') {
    // --- Pass 2 ---
    p.log.step('③b Running Pass 2 — refining with 2/3 consensus...');
    const pass2Result = await runPlanningPass2(
      idea, classification, context, plan, contributions, config, tokenCounter, guidance,
    );
    plan = pass2Result.updatedPlan;

    if (pass2Result.contested.length > 0) {
      plan = await resolveContestedItems(plan, pass2Result.contested);
    }

    // Show updated plan for final approval
    const finalPick = await userPickItems(plan);
    plan = finalPick.plan;
  } else {
    plan = pickResult.plan;
  }

  // --- Phase 4: CODE ---
  eventBus.publish('round', { round: 1, phase: 'coding' });
  const parallelCount = Math.min(
    config.coding?.parallelAgents ?? 3,
    (plan.categories ?? []).flatMap(c => c.items.filter(i => i.selected)).length,
  );
  p.log.step(parallelCount > 1
    ? `④ Coding — ${parallelCount} agents in parallel...`
    : '④ Carmack is coding...');

  // Re-classify for code phase (may need different context)
  let codeClassification: IntentClassification = classification;
  try {
    const classifierModels = resolveClassifierModels(config);
    for (const model of classifierModels) {
      try {
        const result = await classifyIntent({ model, idea, phase: 'code', planSummary: plan.summary });
        codeClassification = result.classification;
        tokenCounter.record(result.usage);
        break;
      } catch {
        continue;
      }
    }
  } catch { /* keep default */ }

  const coderModelRef = config.agents.overrides?.['coder']?.model?.primary ?? loadPersona('coder').model;
  const coderBudget = getSmallestContextBudget([coderModelRef], config);
  const codeContext = await assembleContext(codeClassification, projectRoot, { maxTokens: coderBudget });
  const codingOutputs = await runCoding(idea, plan, codeClassification, codeContext, config, tokenCounter, guidance);

  // Collect all files that were created
  const allFiles = codingOutputs.flatMap(o => o.files.map(f => f.path));
  p.log.info(`Created ${allFiles.length} files across ${codingOutputs.length} commits.`);

  // --- Phase 4b: EDIT REVIEW (accept/reject file changes) ---
  if (codingOutputs.length > 0) {
    const editReviewResult = await reviewAndApply(
      codingOutputs,
      projectRoot ?? process.cwd(),
      config.editReview,
    );
    if (editReviewResult.rejected.length > 0) {
      p.log.info(`Rejected ${editReviewResult.rejected.length} file(s). They will not be reviewed.`);
    }
  }

  // --- Phase 5: REVIEW ---
  eventBus.publish('round', { round: 1, phase: 'reviewing' });
  p.log.step('⑤ Selecting reviewers...');

  const reviewSelection = selectReviewAgents(allFiles);
  p.log.info(`Reviewers: ${reviewSelection.agentIds.map(id => {
    const persona = loadPersona(id);
    return `${persona.codename} (${reviewSelection.reasons[id]})`;
  }).join(', ')}`);

  // Re-classify for review phase
  let reviewClassification: IntentClassification = classification;
  try {
    const classifierModels = resolveClassifierModels(config);
    for (const model of classifierModels) {
      try {
        const result = await classifyIntent({ model, idea, phase: 'review', existingFiles: allFiles });
        reviewClassification = result.classification;
        tokenCounter.record(result.usage);
        break;
      } catch {
        continue;
      }
    }
  } catch { /* keep default */ }

  const reviewModelRefs = reviewSelection.agentIds.map(id => {
    const persona = loadPersona(id);
    return config.agents.overrides?.[id]?.model?.primary ?? persona.model;
  });
  const reviewBudget = getSmallestContextBudget(reviewModelRefs, config);
  const reviewContext = await assembleContext(reviewClassification, projectRoot, { maxTokens: reviewBudget });
  const reviews = await runReview(
    idea, reviewClassification, reviewContext, reviewSelection.agentIds, config, tokenCounter,
  );

  // Show reviews to user
  displayReviews(reviews);

  // --- Phase 6: FIX (if needed) ---
  const fixableIssues = reviews.flatMap(r => r.issues.filter(i => i.severity !== 'suggestion'));
  let fixOutputs: CodingOutput[] = [];

  if (fixableIssues.length > 0) {
    const fixAction = await p.select({
      message: `${fixableIssues.length} issues found. What do you want to do?`,
      options: [
        { value: 'fix', label: 'Fix selected issues', hint: 'pick which issues to fix' },
        { value: 'ship', label: 'Ship anyway', hint: 'ignore issues and ship' },
        { value: 'review', label: 'Request more reviews', hint: 'add more reviewers' },
      ],
    });

    if (!p.isCancel(fixAction) && fixAction === 'fix') {
      const selectedIssues = await p.multiselect({
        message: 'Select issues to fix:',
        options: fixableIssues.map(issue => ({
          value: issue.id,
          label: `[${issue.severity}] ${issue.what}`,
          hint: `${issue.file}${issue.line ? `:${issue.line}` : ''} — ${issue.fix}`,
        })),
        required: false,
      });

      if (!p.isCancel(selectedIssues) && selectedIssues.length > 0) {
        p.log.step('⑥ Carmack is fixing issues...');
        const issuesToFix = fixableIssues.filter(i => selectedIssues.includes(i.id));
        const fixInstructions = issuesToFix.map(i =>
          `- [${i.severity}] ${i.file}${i.line ? `:${i.line}` : ''}: ${i.what}\n  Fix: ${i.fix}`
        ).join('\n');

        fixOutputs = await runFix(
          idea, fixInstructions, reviewClassification, reviewContext, config, tokenCounter,
        );
      }
    }
  }

  // --- Phase 7: SHIP ---
  eventBus.publish('round', { round: 1, phase: 'ship' });
  p.log.step('⑦ Ship!');

  // Ship summary
  const totalFiles = new Set(codingOutputs?.flatMap(o => o.files.map(f => f.path)) ?? []).size;
  const totalCommits = (codingOutputs?.length ?? 0) + fixOutputs.length;
  const reviewScores = reviews.map(r => `${r.score}/10`).join(', ');
  const costStr = `$${tokenCounter.estimatedCost.toFixed(2)}`;

  const shipSummary = [
    `📦 Files: ${totalFiles}`,
    `📝 Commits: ${totalCommits}`,
    `🔍 Reviews: ${reviews.length} (scores: ${reviewScores || 'none'})`,
    `💰 Cost: ~${costStr}`,
    `📊 Tokens: ${tokenCounter.totalInput.toLocaleString()} in / ${tokenCounter.totalOutput.toLocaleString()} out`,
  ].join('\n');

  p.note(shipSummary, '🚀 Ship Summary');

  p.note(tokenCounter.summary(), 'Token Usage');

  return {
    phase: 'ship',
    plan,
    codingOutputs: [...codingOutputs, ...fixOutputs],
    reviews,
    tokenCounter,
  };
}

// ---------------------------------------------------------------------------
// Planning Pass 1 — 3 agents in parallel
// ---------------------------------------------------------------------------

async function runPlanningPass1(
  idea: string,
  classification: IntentClassification,
  context: AssembledContext,
  config: ForgeCouncilConfig,
  tokenCounter: TokenCounter,
  guidance?: string,
  agentIds: readonly string[] = PLANNING_AGENT_IDS,
): Promise<PlanContribution[]> {
  const display = new AgentDisplay(agentIds);
  currentDisplay = display;
  const onProgress = createDualCallback(display);
  sessionManager.update({ activeAgents: [...agentIds] });

  // Start interactive steering (non-blocking keypresses)
  initInbox(agentIds);
  const steering = startSteering(display);

  const promises = agentIds.map(async (agentId) => {
    const persona = loadPersona(agentId);
    const models = resolveAgentModels(agentId, persona.model, config);
    const abortSignal = createAbortSignal(agentId);

    const messages = buildAgentMessages({
      agentId,
      idea,
      phase: 'plan',
      classification,
      context,
      userGuidance: guidance,
    });

    try {
      const result = await generateWithTools<PlanContribution>({
        models,
        outputSchema: PlanContributionSchema,
        outputName: 'submitPlan',
        outputDescription: 'plan contribution with items and tech suggestions',
        messages,
        agentId,
        temperature: persona.temperature,
        maxOutputTokens: persona.maxTokens,
        maxSteps: 20,
        onProgress,
        abortSignal,
      });

      cleanupAbort(agentId);

      const inputTokens = estimateTokens(messages.map(m =>
        typeof m.content === 'string' ? m.content : ''
      ).join(''));
      const outputTokens = estimateTokens(JSON.stringify(result.object));
      tokenCounter.record({
        inputTokens,
        outputTokens,
        modelId: agentId,
        phase: 'plan',
        agentId,
      });

      const contribution = { ...result.object, agentId } as PlanContribution;
      onProgress(agentId, 'done', `${contribution.items.length} items`);
      return contribution;
    } catch (error) {
      cleanupAbort(agentId);
      onProgress(agentId, 'failed', error instanceof Error ? error.message.slice(0, 60) : 'unknown error');
      throw error;
    }
  });

  const results = await Promise.allSettled(promises);

  // Stop steering and finalize display
  steering.stop();
  display.finalize();
  currentDisplay = null;
  sessionManager.update({ activeAgents: [] });

  const contributions: PlanContribution[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      contributions.push(result.value);
    } else {
      p.log.warn(`Planning agent failed: ${result.reason?.message ?? 'unknown error'}`);
    }
  }

  if (contributions.length === 0) {
    throw new Error('All planning agents failed. Cannot proceed.');
  }

  return contributions;
}

// ---------------------------------------------------------------------------
// Ford Merge
// ---------------------------------------------------------------------------

async function fordMerge(
  idea: string,
  classification: IntentClassification,
  context: AssembledContext,
  contributions: PlanContribution[],
  config: ForgeCouncilConfig,
  tokenCounter: TokenCounter,
): Promise<MergedPlan> {
  const persona = loadPersona('executor');
  const models = resolveAgentModels('executor', persona.model, config);
  sessionManager.update({ activeAgents: ['executor'] });
  const mergeInstructions = buildMergeInstructions(contributions);

  const messages = buildAgentMessages({
    agentId: 'executor',
    idea,
    phase: 'plan',
    classification,
    context,
    taskInstructions: mergeInstructions,
  });

  const result = await generateWithTools<MergedPlan>({
    models,
    outputSchema: MergedPlanSchema,
    outputName: 'submitMergedPlan',
    outputDescription: 'merged plan with categories, tech stack, and phases',
    messages,
    agentId: 'executor',
    temperature: persona.temperature,
    maxOutputTokens: persona.maxTokens,
    maxSteps: 15,
  });

  const inputTokens = estimateTokens(messages.map(m =>
    typeof m.content === 'string' ? m.content : ''
  ).join(''));
  const outputTokens = estimateTokens(JSON.stringify(result.object));
  tokenCounter.record({
    inputTokens,
    outputTokens,
    modelId: 'executor',
    phase: 'merge',
    agentId: 'executor',
  });

  sessionManager.update({ activeAgents: [] });
  return result.object;
}

// ---------------------------------------------------------------------------
// User Pick Items — checkbox UI
// ---------------------------------------------------------------------------

interface PickResult {
  action: 'approve' | 'refine';
  plan: MergedPlan;
}

async function userPickItems(plan: MergedPlan): Promise<PickResult> {
  p.note(plan.summary ?? '(No summary)', 'Plan Summary');

  // Show plan in categories
  const allItems: { item: MergedPlanItem; catName: string }[] = [];
  for (const cat of plan.categories ?? []) {
    for (const item of cat.items) {
      allItems.push({ item, catName: cat.name });
    }
  }

  if (allItems.length === 0) {
    p.log.warn('Plan has no items.');
    return { action: 'approve', plan };
  }

  // Show items grouped by category
  for (const cat of plan.categories ?? []) {
    const catItems = cat.items.map(item => {
      const check = item.selected ? '☑' : '☐';
      const priorityColor = item.priority === 'must' ? BOLD_MAGENTA
        : item.priority === 'should' ? YELLOW
        : DIM;
      const priorityLabel = `${priorityColor}[${item.priority}]${RESET}`;
      return `  ${check} ${priorityLabel}  ${item.title}  ${DIM}(${item.source})${RESET}`;
    }).join('\n');
    p.note(catItems, `📁 ${cat.name}`);
  }

  // Tech stack
  if (plan.techStack && Object.keys(plan.techStack).length > 0) {
    const techLines = Object.entries(plan.techStack)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');
    p.note(techLines, 'Tech Stack');
  }

  // Let user toggle items
  const selectedIds = await p.multiselect({
    message: 'Select items to build (pre-selected based on priority):',
    options: allItems.map(({ item, catName }) => ({
      value: item.id,
      label: `[${item.priority}] ${item.title}`,
      hint: `${catName} — ${item.description}`,
      initialValue: item.selected,
    })),
    required: false,
  });

  if (p.isCancel(selectedIds)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  // Update plan with user selections
  const updatedPlan = structuredClone(plan);
  for (const cat of updatedPlan.categories) {
    for (const item of cat.items) {
      item.selected = (selectedIds as string[]).includes(item.id);
    }
  }

  // Ask: approve or refine?
  const action = await p.select({
    message: 'What do you want to do?',
    options: [
      { value: 'approve', label: 'Approve and start coding', hint: 'Carmack will implement selected items' },
      { value: 'refine', label: 'Refine with Pass 2', hint: '3 agents review the plan, 2/3 consensus to change' },
      { value: 'edit', label: 'Edit plan directly', hint: 'modify items manually (coming soon)' },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  if (action === 'edit') {
    p.log.warn('Direct plan editing is coming in Phase 2. Using Refine instead.');
    return { action: 'refine', plan: updatedPlan };
  }

  return { action: action as 'approve' | 'refine', plan: updatedPlan };
}

// ---------------------------------------------------------------------------
// Planning Pass 2 — parallel with Layer 4
// ---------------------------------------------------------------------------

async function runPlanningPass2(
  idea: string,
  classification: IntentClassification,
  context: AssembledContext,
  plan: MergedPlan,
  contributions: PlanContribution[],
  config: ForgeCouncilConfig,
  tokenCounter: TokenCounter,
  guidance?: string,
): Promise<{ updatedPlan: MergedPlan; contested: ContestedItem[] }> {
  const display = new AgentDisplay(PLANNING_AGENT_IDS);
  currentDisplay = display;
  const onProgress = createDualCallback(display);
  sessionManager.update({ activeAgents: [...PLANNING_AGENT_IDS] });

  initInbox(PLANNING_AGENT_IDS);
  const steering = startSteering(display);

  const promises = PLANNING_AGENT_IDS.map(async (agentId) => {
    const persona = loadPersona(agentId);
    const models = resolveAgentModels(agentId, persona.model, config);
    const abortSignal = createAbortSignal(agentId);

    const messages = buildAgentMessages({
      agentId,
      idea,
      phase: 'plan',
      classification,
      context,
      pass2Plan: plan,
      pass1Contributions: contributions,
      userGuidance: guidance,
    });

    try {
      const result = await generateWithTools<PlanChange>({
        models,
        outputSchema: PlanChangeSchema,
        outputName: 'submitPlanChanges',
        outputDescription: 'plan changes (additions and removals)',
        messages,
        agentId,
        temperature: persona.temperature,
        maxOutputTokens: persona.maxTokens,
        maxSteps: 15,
        onProgress,
        abortSignal,
      });

      const inputTokens = estimateTokens(messages.map(m =>
        typeof m.content === 'string' ? m.content : ''
      ).join(''));
      const outputTokens = estimateTokens(JSON.stringify(result.object));
      tokenCounter.record({
        inputTokens,
        outputTokens,
        modelId: agentId,
        phase: 'plan-pass2',
        agentId,
      });

      const change = { ...result.object, agentId } as PlanChange;
      const adds = change.additions.length;
      const rems = change.removals.length;
      cleanupAbort(agentId);
      onProgress(agentId, 'done', `+${adds} -${rems} changes`);
      return change;
    } catch (error) {
      cleanupAbort(agentId);
      onProgress(agentId, 'failed', error instanceof Error ? error.message.slice(0, 60) : 'unknown error');
      throw error;
    }
  });

  const results = await Promise.allSettled(promises);
  steering.stop();
  display.finalize();
  currentDisplay = null;
  sessionManager.update({ activeAgents: [] });

  const changes: PlanChange[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      changes.push(result.value);
    } else {
      p.log.warn(`Pass 2 agent failed: ${result.reason?.message ?? 'unknown error'}`);
    }
  }

  return applyPass2Changes(plan, changes);
}

// ---------------------------------------------------------------------------
// Resolve contested items — user decides
// ---------------------------------------------------------------------------

async function resolveContestedItems(
  plan: MergedPlan,
  contested: ContestedItem[],
): Promise<MergedPlan> {
  if (contested.length === 0) return plan;

  p.log.info(`${contested.length} contested items need your decision:`);

  const updatedPlan = structuredClone(plan);

  for (const item of contested) {
    if (item.type === 'add' && item.item) {
      const accept = await p.confirm({
        message: `Add "${item.item.title}"? (suggested by ${item.supporters.join(', ')})`,
        initialValue: false,
      });

      if (!p.isCancel(accept) && accept) {
        // Add to plan
        let cat = updatedPlan.categories.find(
          c => c.name.toLowerCase() === (item.item!.category || 'general').toLowerCase(),
        );
        if (!cat) {
          cat = { name: item.item.category || 'General', items: [] };
          updatedPlan.categories.push(cat);
        }
        cat.items.push({
          id: item.item.id,
          title: item.item.title,
          description: item.item.description,
          priority: item.item.priority,
          phase: item.item.phase,
          source: 'user-accepted',
          selected: true,
        });
      }
    } else if (item.type === 'remove' && item.itemId) {
      const remove = await p.confirm({
        message: `Remove item "${item.itemId}"? (suggested by ${item.supporters.join(', ')}${item.reasons ? ': ' + item.reasons.join('; ') : ''})`,
        initialValue: false,
      });

      if (!p.isCancel(remove) && remove) {
        for (const cat of updatedPlan.categories) {
          const idx = cat.items.findIndex(i => i.id === item.itemId);
          if (idx !== -1) {
            cat.items.splice(idx, 1);
            break;
          }
        }
      }
    }
  }

  return updatedPlan;
}

// ---------------------------------------------------------------------------
// Coding — Carmack implements selected plan items
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Parallel Coding — Multiple coder agents working from a shared TaskBoard
// ---------------------------------------------------------------------------

/**
 * Schema for what each parallel coder submits when done with ALL their tasks.
 * This is a lightweight signal — actual file writes happen via tools during execution.
 */
const CoderDoneSchema = z.object({
  tasksCompleted: z.array(z.string()),
  totalFiles: z.number(),
  summary: z.string().max(300),
});

/**
 * Git commit mutex — only one agent can commit at a time to avoid conflicts.
 */
const gitMutex = {
  locked: false,
  queue: [] as (() => void)[],
  async acquire(): Promise<void> {
    while (this.locked) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.locked = true;
  },
  release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next();
  },
};

async function runCoding(
  idea: string,
  plan: MergedPlan,
  classification: IntentClassification,
  context: AssembledContext,
  config: ForgeCouncilConfig,
  tokenCounter: TokenCounter,
  guidance?: string,
): Promise<CodingOutput[]> {
  const persona = loadPersona('coder');
  const models = resolveAgentModels('coder', persona.model, config);

  // Get selected items
  const selectedItems = (plan.categories ?? [])
    .flatMap(cat => cat.items.filter(item => item.selected))
    .sort((a, b) => a.phase - b.phase);

  if (selectedItems.length === 0) {
    p.log.warn('No items selected for implementation.');
    return [];
  }

  // Determine parallelism
  const codingConfig = config.coding;
  const parallelAgents = Math.min(
    codingConfig?.parallelAgents ?? 3,
    selectedItems.length, // No more agents than tasks
  );

  // Fall back to serial if only 1 agent or 1 task
  if (parallelAgents <= 1 || selectedItems.length <= 1) {
    return runSerialCoding(idea, plan, classification, context, config, tokenCounter, guidance);
  }

  // --- Parallel mode ---

  // Create the shared task board
  const board = new TaskBoard();
  board.seedFromPlan(selectedItems, plan.categories ?? []);

  p.log.info(`Parallel coding: ${parallelAgents} agents, ${board.totalCount} tasks (${board.getAvailableTasks().length} immediately available)`);

  // Register board with session manager for API access
  sessionManager.setTaskBoard(board);

  // Publish board events to the UI
  board.subscribe((event) => {
    eventBus.publish('task-board', event);
  });

  const techStackStr = plan.techStack
    ? Object.entries(plan.techStack).map(([k, v]) => `- ${k}: ${v}`).join('\n')
    : '';

  // Spawn parallel coder agents
  const agentIds = Array.from({ length: parallelAgents }, (_, i) => `coder-${i + 1}`);
  const display = new AgentDisplay(agentIds);
  currentDisplay = display;
  const onProgress = createDualCallback(display);
  sessionManager.update({ activeAgents: [...agentIds] });
  // Steps per iteration — keep moderate so continuation context kicks in between tasks
  // ~15 steps is enough for: claim(1) + read(3-4) + write(2-3) + complete(1) + buffer
  const stepsPerIteration = codingConfig?.maxStepsPerAgent ?? 15;
  // Max total iterations per agent (each iteration ≈ 1 task)
  const maxIterations = codingConfig?.maxIterations ?? 15;

  initInbox(agentIds);
  const steering = startSteering(display);

  const agentPromises = agentIds.map(async (agentId) => {
    const commTools = createCommTools(agentId, board, {
      onHumanHelpRequest: (n) => {
        try { sessionManager.addNotification(n); } catch (_) {}
      },
    });
    const agentTools = getAgentTools('coder');

    // Merge comm tools with regular coder tools
    const allTools = { ...agentTools, ...commTools };

    // Build task instructions — agent uses the board to claim tasks
    const taskInstructions = buildParallelCoderInstructions(agentId, plan, techStackStr);

    const baseMessages = buildAgentMessages({
      agentId: 'coder', // Use 'coder' persona for prompt assembly
      idea,
      phase: 'code',
      classification,
      context,
      taskInstructions,
      userGuidance: guidance,
    });

    // Add the submit tool for final signal
    const submitTool = (await import('ai')).tool({
      description: 'Call this when there are NO more tasks available on the board. Reports your final status.',
      inputSchema: CoderDoneSchema,
    });

    // Doom loop detection state (persists across iterations)
    const readCounts = new Map<string, number>(); // filePath → read count
    let doomLoopDetected = false;

    const toolCallProgressHandler = (event: { toolCall: { toolName: string; input: unknown } }) => {
      const name = event.toolCall.toolName;
      const args = event.toolCall.input as Record<string, unknown>;

      // Track file reads for doom loop detection
      if (name === 'readFile') {
        const filePath = (args?.path ?? args?.filePath ?? '') as string;
        if (filePath) {
          const count = (readCounts.get(filePath) ?? 0) + 1;
          readCounts.set(filePath, count);
          if (count >= 4) {
            doomLoopDetected = true;
            onProgress(agentId, 'tool', `doom loop: read ${filePath} ${count} times — breaking`);
          }
        }
      }

      if (name === 'coderDone') {
        onProgress(agentId, 'submit', 'wrapping up');
      } else if (name === 'claimTask') {
        const taskId = args?.taskId as string | undefined;
        const task = taskId ? board.getTask(taskId) : undefined;
        onProgress(agentId, 'tool', task ? `claiming: ${task.title}` : 'claiming task');
      } else if (name === 'claimNextTask') {
        onProgress(agentId, 'tool', 'claiming next available task');
      } else if (name === 'completeTask') {
        const taskId = args?.taskId as string | undefined;
        const task = taskId ? board.getTask(taskId) : undefined;
        onProgress(agentId, 'tool', task ? `done: ${task.title}` : 'completing task');
      } else if (name === 'getBoard') {
        onProgress(agentId, 'tool', 'checking board');
      } else if (name === 'postMessage' || name === 'readMessages') {
        onProgress(agentId, 'tool', 'communicating');
      } else {
        onProgress(agentId, 'tool', formatToolCallDetail(name, args));
      }
    };

    /**
     * Build a rich continuation message with memory of what was already done.
     * This prevents the agent from re-exploring the same files every iteration.
     */
    function buildContinuationContext(): string {
      const myDone = board.getTasksByAgent(agentId).filter(t => t.status === 'done');
      const myClaimed = board.getTasksByAgent(agentId).filter(t => t.status === 'claimed');
      const remaining = board.getAvailableTasks();

      const parts: string[] = [];
      parts.push('## Continuation — Pick up where you left off\n');

      if (myDone.length > 0) {
        parts.push('### Tasks you already completed:');
        for (const t of myDone) {
          const files = t.producedFiles.length > 0 ? ` (files: ${t.producedFiles.join(', ')})` : '';
          parts.push(`- [done] ${t.title}${files}`);
        }
        parts.push('');
      }

      if (myClaimed.length > 0) {
        parts.push('### Tasks you currently have claimed (finish these first):');
        for (const t of myClaimed) {
          parts.push(`- [claimed] ${t.title}: ${t.description ?? ''}`);
        }
        parts.push('');
      }

      // Files already read — don't re-read them
      const filesRead = [...readCounts.entries()].filter(([, c]) => c > 0).map(([f]) => f);
      if (filesRead.length > 0) {
        parts.push(`### Files you already read (do NOT re-read these):`);
        parts.push(filesRead.join(', '));
        parts.push('');
      }

      if (remaining.length > 0) {
        parts.push(`### Remaining available tasks (${remaining.length}):`);
        for (const t of remaining.slice(0, 10)) {
          parts.push(`- ${t.title} [${t.priority}]`);
        }
        if (remaining.length > 10) {
          parts.push(`- ... and ${remaining.length - 10} more (use getBoard to see all)`);
        }
        parts.push('');
      }

      parts.push('**Action**: Claim the next available task, implement it with COMPLETE code (not placeholders), call `completeTask`, then repeat. If no tasks remain, call `coderDone`.');
      parts.push('**Do NOT** re-read files you already read. **Do NOT** explore excessively — focus on writing code.');

      return parts.join('\n');
    }

    onProgress(agentId, 'start', 'checking task board');
    let totalToolCalls = 0;
    let consecutiveErrors = 0;

    // Iterative loop — agent keeps running until no more tasks or it calls coderDone
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Check if there are remaining tasks worth working on
      const available = board.getAvailableTasks();
      const myClaimed = board.getTasksByAgent(agentId).filter(t => t.status === 'claimed');
      if (available.length === 0 && myClaimed.length === 0) {
        onProgress(agentId, 'tool', 'no more tasks available');
        break;
      }

      // Reset doom loop detection per iteration (allow re-reading once per iteration)
      doomLoopDetected = false;
      // Keep cumulative read counts but threshold per iteration is 4 total

      // Build messages — on continuation iterations, append rich context
      const messages = iteration === 0
        ? baseMessages
        : [
            ...baseMessages,
            { role: 'user' as const, content: buildContinuationContext() },
          ];

      try {
        const result = await generateText({
          model: models[0]!,
          messages,
          tools: { ...allTools, coderDone: submitTool },
          stopWhen: stepCountIs(stepsPerIteration),
          temperature: persona.temperature,
          maxOutputTokens: 16000, // Generous per-iteration budget for writing complete files
          toolChoice: 'auto',
          experimental_onToolCallStart: toolCallProgressHandler,
        });

        consecutiveErrors = 0; // Reset on success

        // Count tool calls across this iteration
        const iterToolCalls = result.steps.reduce((n, s) => n + s.toolCalls.length, 0);
        totalToolCalls += iterToolCalls;

        // Count tokens
        const inputTokens = estimateTokens(messages.map(m =>
          typeof m.content === 'string' ? m.content : ''
        ).join(''));
        const outputTokens = estimateTokens(JSON.stringify(result.steps.map(s => s.toolCalls)));
        tokenCounter.record({
          inputTokens,
          outputTokens,
          modelId: 'coder',
          phase: 'code',
          agentId,
        });

        // Check if the agent called coderDone (signals it's finished)
        const calledDone = result.steps.some(s =>
          s.toolCalls.some(tc => tc.toolName === 'coderDone')
        );
        if (calledDone) break;

        // If doom loop was detected, fail the current claimed task and move on
        if (doomLoopDetected) {
          const stuck = board.getTasksByAgent(agentId).filter(t => t.status === 'claimed');
          for (const task of stuck) {
            try { board.fail(task.id, agentId, 'Agent stuck in read loop'); } catch {}
          }
          onProgress(agentId, 'tool', 'skipping stuck task, trying next');
          continue; // try next iteration with a different task
        }

        // If the agent made zero tool calls, it's stuck — break
        if (iterToolCalls === 0) break;
      } catch (iterError) {
        consecutiveErrors++;
        const errMsg = iterError instanceof Error ? iterError.message : String(iterError);
        onProgress(agentId, 'tool', `error (attempt ${consecutiveErrors}/3): ${errMsg.slice(0, 80)}`);

        // Release any claimed task so other agents can pick it up
        const myCurrent = board.getTasksByAgent(agentId).filter(t => t.status === 'claimed');
        for (const task of myCurrent) {
          try { board.fail(task.id, agentId, errMsg.slice(0, 100)); } catch {}
        }

        // 3 consecutive errors = give up on this agent
        if (consecutiveErrors >= 3) {
          onProgress(agentId, 'failed', `${consecutiveErrors} consecutive errors: ${errMsg.slice(0, 80)}`);
          return [];
        }

        // Wait briefly before retrying (back off a bit for transient errors)
        await new Promise(r => setTimeout(r, 1000 * consecutiveErrors));
        continue;
      }
    }

    const agentTasks = board.getTasksByAgent(agentId).filter(t => t.status === 'done');
    onProgress(agentId, 'done', `${agentTasks.length} tasks completed (${totalToolCalls} tool calls)`);

    return agentTasks;
  });

  const results = await Promise.allSettled(agentPromises);
  steering.stop();
  display.finalize();
  currentDisplay = null;
  sessionManager.update({ activeAgents: [] });

  // Collect all completed tasks into CodingOutput format
  const outputs: CodingOutput[] = [];
  const allCompletedTasks = board.getTasksByStatus('done');

  for (const task of allCompletedTasks) {
    if (task.producedFiles.length > 0 && task.commitMessage) {
      outputs.push({
        files: task.producedFiles.map(filePath => ({
          path: filePath,
          content: '', // Files already written to disk by writeFile tool
          action: 'create' as const,
        })),
        commitMessage: task.commitMessage,
        summary: task.summary ?? task.title,
      });
    }
  }

  // Report any failed/pending tasks
  const failedTasks = board.getTasksByStatus('pending').filter(t => t.error);
  const unfinished = board.getTasksByStatus('pending').filter(t => !t.error);

  if (failedTasks.length > 0) {
    p.log.warn(`${failedTasks.length} task(s) failed: ${failedTasks.map(t => t.title).join(', ')}`);
  }
  if (unfinished.length > 0) {
    p.log.warn(`${unfinished.length} task(s) not started (blocked by dependencies or ran out of agents)`);
  }

  // Dynamic tasks summary
  const dynamicTasks = board.getAllTasks().filter(t => t.dynamic);
  if (dynamicTasks.length > 0) {
    p.log.info(`${dynamicTasks.length} task(s) added dynamically by agents`);
  }

  // Clear board from session manager (coding phase done)
  sessionManager.setTaskBoard(null);

  return outputs;
}

/**
 * Build the system instructions for a parallel coder agent.
 * Explains the task board workflow and comm tools.
 */
function buildParallelCoderInstructions(
  agentId: string,
  plan: MergedPlan,
  techStackStr: string,
): string {
  return [
    `## Parallel Coding — Agent ${agentId}`,
    '',
    'You are one of several coding agents working in parallel on a shared task board.',
    'Each task corresponds to a plan item. You claim tasks, implement them, and mark them done.',
    '',
    '### Workflow',
    '1. Call `getBoard` to see all tasks and their statuses',
    '2. Call `claimNextTask` (auto-picks highest priority) or `claimTask` (specific task)',
    '3. Read the codebase as needed (readFile, listDir, searchFiles)',
    '4. Write the implementation (writeFile, editFile)',
    '5. Call `completeTask` with the files you created and a commit message',
    '6. Check the board again — if more tasks are available, claim and implement them',
    '7. When no more tasks are available, call `coderDone`',
    '',
    '### Communication',
    '- Use `postMessage` to announce what you are working on (prevents file conflicts)',
    '- Use `readMessages` to see what other agents are doing',
    '- If you discover shared work needed (e.g., a utility file), use `addTask` to create it',
    '- If you cannot complete a task, use `failTask` so another agent can try',
    '',
    '### Rules',
    '- ALWAYS claim a task before implementing it',
    '- ALWAYS complete or fail a task — never leave it in "claimed" limbo',
    '- Write COMPLETE files — every file must have all imports, types, and full implementation',
    '- NEVER write empty or placeholder files. A "1 line" file is NOT implementation.',
    '- Read existing files before editing them. Use readFile first, then editFile or writeFile.',
    '- Each task should produce REAL, working code that integrates with the existing codebase.',
    '- Focus on implementation, not exploration. Limit codebase reading to what you need for the current task.',
    '- Post a message before writing to a file another agent might also touch',
    '- Do NOT implement tasks you have not claimed',
    '- After completing a task, immediately claim the next available task — keep working until the board is empty.',
    '',
    '## Tech Stack',
    techStackStr,
    '',
    '## Plan Summary',
    plan.summary ?? '',
  ].join('\n');
}

/**
 * Serial coding fallback — used when parallelism is 1 or only 1 task.
 * This is the original single-Carmack behavior.
 */
async function runSerialCoding(
  idea: string,
  plan: MergedPlan,
  classification: IntentClassification,
  context: AssembledContext,
  config: ForgeCouncilConfig,
  tokenCounter: TokenCounter,
  guidance?: string,
): Promise<CodingOutput[]> {
  const persona = loadPersona('coder');
  const models = resolveAgentModels('coder', persona.model, config);
  const outputs: CodingOutput[] = [];

  const selectedItems = (plan.categories ?? [])
    .flatMap(cat => cat.items.filter(item => item.selected))
    .sort((a, b) => a.phase - b.phase);

  if (selectedItems.length === 0) {
    p.log.warn('No items selected for implementation.');
    return outputs;
  }

  const taskLines = selectedItems.map((item, i) =>
    `${i + 1}. [Phase ${item.phase}] ${item.title}: ${item.description}`
  );

  const techStackStr = plan.techStack
    ? Object.entries(plan.techStack).map(([k, v]) => `- ${k}: ${v}`).join('\n')
    : '';

  const taskInstructions = [
    '## Items to Implement',
    '',
    taskLines.join('\n'),
    '',
    '## Tech Stack',
    techStackStr,
    '',
    '## Instructions',
    'Implement ALL selected items. For each logical group of files, produce a CodingOutput with:',
    '- files: array of {path, content, action} for each file',
    '- commitMessage: a conventional commit message (feat:, fix:, etc.)',
    '- summary: one-line summary of what was done',
    '',
    'Write COMPLETE files with all imports, types, and implementations.',
    'Use the tech stack specified above.',
  ].join('\n');

  const s = p.spinner();
  s.start(`Implementing ${selectedItems.length} items...`);
  sessionManager.update({ activeAgents: ['coder'] });

  try {
    const messages = buildAgentMessages({
      agentId: 'coder',
      idea,
      phase: 'code',
      classification,
      context,
      taskInstructions,
      userGuidance: guidance,
    });

    const coderProgress: ProgressCallback = (id, event, detail) => {
      if (event === 'tool' && detail) {
        s.message(`Carmack: ${detail}`);
      } else if (event === 'submit') {
        s.message('Carmack: assembling output...');
      }
    };

    const result = await generateWithTools<CodingOutput>({
      models,
      outputSchema: CodingOutputSchema,
      outputName: 'submitCode',
      outputDescription: 'coding output with files, commit message, and summary',
      messages,
      agentId: 'coder',
      temperature: persona.temperature,
      maxOutputTokens: persona.maxTokens,
      maxSteps: 20,
      onProgress: coderProgress,
    });

    const inputTokens = estimateTokens(messages.map(m =>
      typeof m.content === 'string' ? m.content : ''
    ).join(''));
    const outputTokens = estimateTokens(JSON.stringify(result.object));
    tokenCounter.record({
      inputTokens,
      outputTokens,
      modelId: 'coder',
      phase: 'code',
      agentId: 'coder',
    });

    outputs.push(result.object);

    // Write files to disk
    for (const file of result.object.files) {
      if (file.action === 'delete') continue;
      const fullPath = `${process.cwd()}/${file.path}`;
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      await Bun.spawn(['mkdir', '-p', dir], { stdout: 'pipe' }).exited;
      await Bun.write(fullPath, file.content);
    }

    // Git commit
    if (result.object.files.length > 0) {
      const filePaths = result.object.files
        .filter(f => f.action !== 'delete')
        .map(f => f.path);
      try {
        await Bun.spawn(['git', 'add', ...filePaths], { stdout: 'pipe', stderr: 'pipe' }).exited;
        await Bun.spawn(
          ['git', 'commit', '-m', result.object.commitMessage],
          { stdout: 'pipe', stderr: 'pipe' },
        ).exited;
      } catch {
        // Git operations are best-effort
      }
    }

    s.stop(`Implemented: ${result.object.summary}`);
  } catch (error) {
    s.stop('Coding failed.');
    p.log.error(`Carmack error: ${error instanceof Error ? error.message : String(error)}`);
  }

  sessionManager.update({ activeAgents: [] });
  return outputs;
}

// ---------------------------------------------------------------------------
// Review — targeted agents review the code
// ---------------------------------------------------------------------------

async function runReview(
  idea: string,
  classification: IntentClassification,
  context: AssembledContext,
  reviewerIds: string[],
  config: ForgeCouncilConfig,
  tokenCounter: TokenCounter,
): Promise<CodeReview[]> {
  const display = new AgentDisplay(reviewerIds);
  currentDisplay = display;
  const onProgress = createDualCallback(display);
  sessionManager.update({ activeAgents: [...reviewerIds] });

  initInbox(reviewerIds);
  const steering = startSteering(display);

  const promises = reviewerIds.map(async (agentId) => {
    const persona = loadPersona(agentId);
    const models = resolveAgentModels(agentId, persona.model, config);
    const abortSignal = createAbortSignal(agentId);

    const messages = buildAgentMessages({
      agentId,
      idea,
      phase: 'review',
      classification,
      context,
      taskInstructions: 'Review the code files in the supporting context. Produce a CodeReview with score, verdict, and issues.',
    });

    try {
      const result = await generateWithTools<CodeReview>({
        models,
        outputSchema: CodeReviewSchema,
        outputName: 'submitReview',
        outputDescription: 'code review with score, verdict, and issues',
        messages,
        agentId,
        temperature: persona.temperature,
        maxOutputTokens: persona.maxTokens,
        maxSteps: 15,
        onProgress,
        abortSignal,
      });

      cleanupAbort(agentId);

      const inputTokens = estimateTokens(messages.map(m =>
        typeof m.content === 'string' ? m.content : ''
      ).join(''));
      const outputTokens = estimateTokens(JSON.stringify(result.object));
      tokenCounter.record({
        inputTokens,
        outputTokens,
        modelId: agentId,
        phase: 'review',
        agentId,
      });

      onProgress(agentId, 'done', `score: ${result.object.score}/10, ${result.object.issues.length} issues`);
      return result.object;
    } catch (error) {
      cleanupAbort(agentId);
      onProgress(agentId, 'failed', error instanceof Error ? error.message.slice(0, 60) : 'unknown error');
      throw error;
    }
  });

  const results = await Promise.allSettled(promises);

  // Stop steering and finalize display
  steering.stop();
  display.finalize();
  currentDisplay = null;
  sessionManager.update({ activeAgents: [] });

  const reviews: CodeReview[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      reviews.push(result.value);
    } else {
      p.log.warn(`Reviewer failed: ${result.reason?.message ?? 'unknown error'}`);
    }
  }

  return reviews;
}

// ---------------------------------------------------------------------------
// Fix — Carmack fixes selected issues
// ---------------------------------------------------------------------------

async function runFix(
  idea: string,
  fixInstructions: string,
  classification: IntentClassification,
  context: AssembledContext,
  config: ForgeCouncilConfig,
  tokenCounter: TokenCounter,
): Promise<CodingOutput[]> {
  const persona = loadPersona('coder');
  const models = resolveAgentModels('coder', persona.model, config);
  sessionManager.update({ activeAgents: ['coder'] });

  const messages = buildAgentMessages({
    agentId: 'coder',
    idea,
    phase: 'fix',
    classification,
    context,
    taskInstructions: [
      '## Issues to Fix',
      '',
      fixInstructions,
      '',
      'Fix each issue. Produce a CodingOutput with the modified files.',
    ].join('\n'),
  });

  const result = await generateWithTools<CodingOutput>({
    models,
    outputSchema: CodingOutputSchema,
    outputName: 'submitCode',
    outputDescription: 'coding output with fixed files',
    messages,
    agentId: 'coder',
    temperature: persona.temperature,
    maxOutputTokens: persona.maxTokens,
    maxSteps: 20,
  });

  const inputTokens = estimateTokens(messages.map(m =>
    typeof m.content === 'string' ? m.content : ''
  ).join(''));
  const outputTokens = estimateTokens(JSON.stringify(result.object));
  tokenCounter.record({
    inputTokens,
    outputTokens,
    modelId: 'coder',
    phase: 'fix',
    agentId: 'coder',
  });

  // Write fixed files to disk
  for (const file of result.object.files) {
    if (file.action === 'delete') continue;
    const fullPath = `${process.cwd()}/${file.path}`;
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    await Bun.spawn(['mkdir', '-p', dir], { stdout: 'pipe' }).exited;
    await Bun.write(fullPath, file.content);
  }

  // Git commit fixes
  if (result.object.files.length > 0) {
    const filePaths = result.object.files
      .filter(f => f.action !== 'delete')
      .map(f => f.path);
    try {
      await Bun.spawn(['git', 'add', ...filePaths], { stdout: 'pipe', stderr: 'pipe' }).exited;
      await Bun.spawn(
        ['git', 'commit', '-m', result.object.commitMessage],
        { stdout: 'pipe', stderr: 'pipe' },
      ).exited;
    } catch {
      // Git operations are best-effort
    }
  }

  sessionManager.update({ activeAgents: [] });
  return [result.object];
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function displayReviews(reviews: CodeReview[]): void {
  for (const review of reviews) {
    const scoreColor = review.score >= 8 ? GREEN
      : review.score >= 6 ? YELLOW
      : RED;
    const verdictIcon = review.verdict === 'approve' ? '✓ APPROVE' : '✗ FIX';
    const verdictColor = review.verdict === 'approve' ? GREEN : YELLOW;

    const lines = [
      `${scoreColor}${review.score}/10${RESET}  ${verdictColor}${verdictIcon}${RESET}`,
    ];

    if (review.issues.length > 0) {
      lines.push('');
      for (const issue of review.issues) {
        const icon = issue.severity === 'critical' ? '✗ CRITICAL'
          : issue.severity === 'warning' ? '⚠ WARNING'
          : '💡 SUGGEST';
        const sevColor = issue.severity === 'critical' ? RED
          : issue.severity === 'warning' ? YELLOW
          : DIM;
        lines.push(`  ${sevColor}${icon}${RESET}  ${issue.file}${issue.line ? `:${issue.line}` : ''}`);
        lines.push(`    ${issue.what}`);
        lines.push(`    → ${issue.fix}`);
      }
    }

    p.note(lines.join('\n'), `Review (${review.score}/10)`);
  }
}

// ---------------------------------------------------------------------------
// Model resolution helpers
// ---------------------------------------------------------------------------

function resolveClassifierModels(config: ForgeCouncilConfig): LanguageModel[] {
  // Use cheapest available models for classification
  const defaults = config.agents.defaults;
  const refs = [
    defaults.model.primary,
    ...(defaults.model.fallbacks ?? []),
  ];
  const models: LanguageModel[] = [];
  for (const ref of refs) {
    try {
      models.push(resolveModel(ref, config));
    } catch {
      // Skip unavailable
    }
  }
  if (models.length === 0) {
    throw new Error('No models available for classification. Check your API keys and config.');
  }
  return models;
}

function resolveAgentModels(
  agentId: string,
  defaultRef: string,
  config: ForgeCouncilConfig,
): LanguageModel[] {
  const models: LanguageModel[] = [];
  const tried = new Set<string>();

  // Helper to try adding a model ref
  const tryAdd = (ref: string) => {
    if (tried.has(ref)) return;
    tried.add(ref);
    try {
      models.push(resolveModel(ref, config));
    } catch {
      // Skip unavailable models (missing API keys, etc.)
    }
  };

  // 1. Agent-specific override
  const override = config.agents.overrides?.[agentId];
  if (override?.model?.primary) tryAdd(override.model.primary);
  if (override?.model?.fallbacks) override.model.fallbacks.forEach(tryAdd);

  // 2. Persona default
  tryAdd(defaultRef);

  // 3. Config defaults
  tryAdd(config.agents.defaults.model.primary);
  if (config.agents.defaults.model.fallbacks) {
    config.agents.defaults.model.fallbacks.forEach(tryAdd);
  }

  if (models.length === 0) {
    throw new Error(`No available models for agent "${agentId}". Check your API keys and config.`);
  }

  return models;
}
