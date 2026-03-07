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
import { assembleContext, formatContext, type AssembledContext } from './context-assembler.ts';
import { buildAgentMessages } from './prompt-assembler.ts';
import { buildMergeInstructions, applyPass2Changes, selectReviewAgents } from './plan-merger.ts';
import { TokenCounter, estimateTokens, type TokenUsage } from './token-counter.ts';
import { resolveModel, resolveModelWithFallbacks } from '../config/resolver.ts';
import type { ForgeCouncilConfig } from '../config/schema.ts';
import { getAgentTools } from './agent-tools.ts';
import { reviewAndApply } from './edit-review.ts';
import { registerBuiltinHandlers } from './pipeline-handlers.ts';
import type { z } from 'zod';

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

import type { ProgressCallback } from './agent-display.ts';

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
}

async function generateWithTools<T>(
  options: GenerateWithToolsOptions<T>,
): Promise<{ object: T; modelUsed: LanguageModel }> {
  const {
    models, outputSchema, outputName, outputDescription,
    messages, agentId, temperature, maxOutputTokens,
    maxSteps = 10, onProgress,
  } = options;

  // Get the agent's allowed tools
  const agentTools = getAgentTools(agentId);

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
    try {
      onProgress?.(agentId, 'start', `using ${models.indexOf(model) === 0 ? 'primary' : 'fallback'} model`);

      const result = await generateText({
        model,
        messages,
        tools: allTools,
        stopWhen: stepCountIs(maxSteps),
        temperature,
        maxOutputTokens,
        toolChoice: 'auto',
        experimental_onToolCallStart: (event) => {
          const name = event.toolCall.toolName;
          const args = event.toolCall.input;
          if (name === outputName) {
            onProgress?.(agentId, 'submit', 'producing structured output');
          } else {
            const detail = formatToolCallDetail(name, args);
            onProgress?.(agentId, 'tool', detail);
          }
        },
      });

      // Find the submit tool call in the steps
      for (const step of result.steps) {
        for (const tc of step.toolCalls) {
          if (tc.toolName === outputName && 'input' in tc) {
            return { object: tc.input as T, modelUsed: model };
          }
        }
      }

      // If no submit tool call found, the model may have responded with text only.
      // This is a failure — we need structured output.
      throw new Error(
        `Agent ${agentId} did not call ${outputName} tool. It responded with text instead of structured output.`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(msg);
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

import { AgentDisplay } from './agent-display.ts';

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
  const tokenCounter = new TokenCounter();

  // Determine which agents to use for planning based on mode
  const planningAgents: readonly string[] = mode === 'council'
    ? COUNCIL_AGENT_IDS
    : mode === 'custom' && customAgentIds?.length
      ? customAgentIds
      : PLANNING_AGENT_IDS;

  // --- Phase 1: CLASSIFY ---
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
  context = await assembleContext(classification, projectRoot);
  if (context.files.length > 0) {
    p.log.info(`Loaded ${context.files.length} files (${context.totalTokens.toLocaleString()} tokens)`);
  }

  // --- Phase 2: PLAN (Pass 1) ---
  p.log.step(`② Planning — ${planningAgents.length} agents drafting in parallel...`);

  const contributions = await runPlanningPass1(
    idea, classification, context, config, tokenCounter, guidance, planningAgents,
  );

  p.log.info(`Received ${contributions.length} contributions with ${contributions.reduce((n, c) => n + c.items.length, 0)} total items.`);

  // --- Ford merges ---
  p.log.step('③ Ford merging contributions...');
  let plan = await fordMerge(idea, classification, context, contributions, config, tokenCounter);

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
  p.log.step('④ Carmack is coding...');

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

  const codeContext = await assembleContext(codeClassification, projectRoot);
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

  const reviewContext = await assembleContext(reviewClassification, projectRoot);
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

  const promises = agentIds.map(async (agentId) => {
    const persona = loadPersona(agentId);
    const models = resolveAgentModels(agentId, persona.model, config);

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
        onProgress: display.callback,
      });

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
      display.callback(agentId, 'done', `${contribution.items.length} items`);
      return contribution;
    } catch (error) {
      display.callback(agentId, 'failed', error instanceof Error ? error.message.slice(0, 60) : 'unknown error');
      throw error;
    }
  });

  const results = await Promise.allSettled(promises);

  // Finalize the display — replace live panels with a static summary
  display.finalize();

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

  const promises = PLANNING_AGENT_IDS.map(async (agentId) => {
    const persona = loadPersona(agentId);
    const models = resolveAgentModels(agentId, persona.model, config);

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
        onProgress: display.callback,
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
      display.callback(agentId, 'done', `+${adds} -${rems} changes`);
      return change;
    } catch (error) {
      display.callback(agentId, 'failed', error instanceof Error ? error.message.slice(0, 60) : 'unknown error');
      throw error;
    }
  });

  const results = await Promise.allSettled(promises);
  display.finalize();

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
  const outputs: CodingOutput[] = [];

  // Get selected items grouped by phase
  const selectedItems = (plan.categories ?? [])
    .flatMap(cat => cat.items.filter(item => item.selected))
    .sort((a, b) => a.phase - b.phase);

  if (selectedItems.length === 0) {
    p.log.warn('No items selected for implementation.');
    return outputs;
  }

  // Build coding task — send all selected items at once for Carmack to implement
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
      maxSteps: 20, // Coder may need many tool calls
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

  const promises = reviewerIds.map(async (agentId) => {
    const persona = loadPersona(agentId);
    const models = resolveAgentModels(agentId, persona.model, config);

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
        onProgress: display.callback,
      });

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

      display.callback(agentId, 'done', `score: ${result.object.score}/10, ${result.object.issues.length} issues`);
      return result.object;
    } catch (error) {
      display.callback(agentId, 'failed', error instanceof Error ? error.message.slice(0, 60) : 'unknown error');
      throw error;
    }
  });

  const results = await Promise.allSettled(promises);

  // Finalize the display
  display.finalize();

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
