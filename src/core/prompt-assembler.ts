import type { ModelMessage } from 'ai';
import { loadPersona, type PersonaConfig } from './persona.ts';
import type { IntentClassification, MergedPlan, PlanContribution } from './schemas.ts';
import type { AssembledContext } from './context-assembler.ts';
import { formatContext } from './context-assembler.ts';

// ---------------------------------------------------------------------------
// Prompt Layers — the 4-layer architecture
// ---------------------------------------------------------------------------

export interface PromptLayers {
  general: string;           // Layer 1: sys prompt + skills + persona
  intent: string;            // Layer 2: user idea + classification + phase
  supportingContext: string;  // Layer 3: code files + git + docs (static)
  plan?: string;             // Layer 4: only on Pass 2
}

// ---------------------------------------------------------------------------
// Layer 1 — General (per-persona, static per session)
// ---------------------------------------------------------------------------

function buildLayer1(persona: PersonaConfig): string {
  return [
    `You are ${persona.codename}, ${persona.displayName}.`,
    `Archetype: ${persona.archetype}.`,
    '',
    persona.systemPrompt,
    '',
    `Your skills: ${persona.skills.join(', ')}.`,
    '',
    'Rules you ALWAYS follow:',
    ...persona.behavioralRules.map(r => `- ${r}`),
    '',
    '',
    'WORKFLOW:',
    '1. EXPLORE BRIEFLY — Use readFile, listDir, searchFiles to understand the codebase. Budget your exploration: use at most 5 tool calls to explore, then produce your output. Do not exhaustively read every file.',
    '2. Read files before editing — You MUST call readFile on a file before using editFile or writeFile on it.',
    '3. Use editFile for targeted changes to existing files. Use writeFile only for new files.',
    '4. editFile rules:',
    '   - The "search" field must be an EXACT copy of text currently in the file.',
    '   - Include 2-3 lines of surrounding context to uniquely identify the edit location.',
    '   - Put ALL edits for the same file in one editFile call (multiple entries in the edits array).',
    '   - If an edit fails, re-read the file — it may have changed from a previous edit.',
    '5. Do NOT guess about code structure — read the actual files first.',
    '6. When done, call the submit tool to produce your structured result. Do NOT delay submitting — once you have enough context, submit immediately.',
    '7. Avoid repeating the same tool call — if it fails, try a different approach.',
    '8. Call checkGuidance periodically (every 3-5 tool calls) to see if the user has sent you steering instructions. If guidance is returned, incorporate it into your next actions.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Layer 2 — Intent (changes per call)
// ---------------------------------------------------------------------------

function buildLayer2(
  idea: string,
  classification: IntentClassification,
  phase: string,
  guidance?: string,
): string {
  const parts = [
    '## Task',
    idea,
    '',
    `## Phase: ${phase}`,
    `Task type: ${classification.taskType}`,
    `Domains: ${classification.domains.join(', ')}`,
    `Complexity: ${classification.complexity}`,
  ];

  if (guidance) {
    parts.push('', '## User Guidance', guidance);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Layer 4 — Plan (Pass 2 only)
// ---------------------------------------------------------------------------

function buildLayer4(
  plan: MergedPlan,
  contributions?: PlanContribution[],
): string {
  const parts = [
    '## First Draft Plan (Protected)',
    'The following plan was produced in Pass 1. It is the baseline.',
    '',
    'RULES FOR THIS PASS:',
    '- Items can ONLY be added if 2 out of 3 agents agree to add them.',
    '- Items can ONLY be removed if 2 out of 3 agents agree to remove them.',
    '- You may suggest additions or removals, but they require consensus.',
    '- Return your suggestions in the PlanChange JSON schema.',
    '',
    '### Current Plan',
    JSON.stringify(plan, null, 2),
  ];

  if (contributions) {
    parts.push(
      '',
      '### Pass 1 Agent Contributions',
      'Each agent\'s original input is shown below for context:',
    );
    for (const c of contributions) {
      parts.push('', `#### ${c.agentId}`, JSON.stringify(c.items, null, 2));
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Prompt Assembly — the main pipeline
// ---------------------------------------------------------------------------

export interface AssembleOptions {
  agentId: string;
  idea: string;
  phase: 'plan' | 'code' | 'review' | 'fix';
  classification: IntentClassification;
  context: AssembledContext;
  pass2Plan?: MergedPlan;
  pass1Contributions?: PlanContribution[];
  userGuidance?: string;
  /** Extra instructions appended to the user message (e.g. plan items to code, issues to fix) */
  taskInstructions?: string;
}

export function assemblePrompt(options: AssembleOptions): PromptLayers {
  const {
    agentId, idea, phase, classification, context,
    pass2Plan, pass1Contributions, userGuidance,
  } = options;

  const persona = loadPersona(agentId);
  const general = buildLayer1(persona);
  const intent = buildLayer2(idea, classification, phase, userGuidance);
  const supportingContext = formatContext(context);
  const plan = pass2Plan
    ? buildLayer4(pass2Plan, pass1Contributions)
    : undefined;

  return { general, intent, supportingContext, plan };
}

// ---------------------------------------------------------------------------
// Build final messages array from layers
// ---------------------------------------------------------------------------

export function buildMessages(layers: PromptLayers, taskInstructions?: string): ModelMessage[] {
  const messages: ModelMessage[] = [
    { role: 'system', content: layers.general },
  ];

  let userContent = layers.intent;

  if (layers.supportingContext) {
    userContent += '\n\n---\n\n' + layers.supportingContext;
  }

  if (layers.plan) {
    userContent += '\n\n---\n\n' + layers.plan;
  }

  if (taskInstructions) {
    userContent += '\n\n---\n\n' + taskInstructions;
  }

  messages.push({ role: 'user', content: userContent });

  return messages;
}

// ---------------------------------------------------------------------------
// Convenience: assemble + build messages in one call
// ---------------------------------------------------------------------------

export function buildAgentMessages(options: AssembleOptions): ModelMessage[] {
  const layers = assemblePrompt(options);
  return buildMessages(layers, options.taskInstructions);
}
