import { generateObject } from 'ai';
import type { LanguageModel } from 'ai';
import { IntentClassificationSchema, type IntentClassification } from './schemas.ts';
import { estimateTokens, type TokenUsage } from './token-counter.ts';

// ---------------------------------------------------------------------------
// Intent Classifier — cheap, fast pre-call to decide what context to load
// ---------------------------------------------------------------------------

const CLASSIFIER_SYSTEM_PROMPT = `You are an intent classifier for a coding assistant. Given a user's idea and the current phase, return a structured classification that determines what context to load.

Rules:
- Be precise with filePatterns — use glob patterns that match relevant code
- For greenfield projects, filePatterns should be empty (no existing code)
- For features/bugfixes, include patterns for the relevant modules
- gitLogCount: 0 for greenfield, 5-10 for features, 10-20 for bugfixes
- externalDocs: only include if the idea explicitly mentions specific technologies
- Complexity: "simple" = 1-3 files, "moderate" = 4-10 files, "complex" = 10+ files
- Domains: only include domains that are directly relevant to the idea

Respond ONLY with the JSON schema. No commentary.`;

export interface ClassifierOptions {
  model: LanguageModel;
  idea: string;
  phase: 'plan' | 'code' | 'review' | 'fix';
  existingFiles?: string[];
  planSummary?: string;
}

export async function classifyIntent(
  options: ClassifierOptions,
): Promise<{ classification: IntentClassification; usage: TokenUsage }> {
  const { model, idea, phase, existingFiles, planSummary } = options;

  // Build the user message — keep it short for cheap classification
  const parts = [`Idea: ${idea}`, `Phase: ${phase}`];

  if (existingFiles && existingFiles.length > 0) {
    parts.push(`Existing project files (${existingFiles.length} total):`);
    // Show first 50 files max to keep tokens low
    const shown = existingFiles.slice(0, 50);
    parts.push(shown.join('\n'));
    if (existingFiles.length > 50) {
      parts.push(`... and ${existingFiles.length - 50} more`);
    }
  }

  if (planSummary) {
    parts.push(`Plan summary: ${planSummary}`);
  }

  const userMessage = parts.join('\n\n');
  const inputTokens = estimateTokens(CLASSIFIER_SYSTEM_PROMPT + userMessage);

  const result = await generateObject({
    model,
    schema: IntentClassificationSchema,
    system: CLASSIFIER_SYSTEM_PROMPT,
    prompt: userMessage,
    temperature: 0.1,
    maxOutputTokens: 500,
  });

  const outputTokens = estimateTokens(JSON.stringify(result.object));

  return {
    classification: result.object,
    usage: {
      inputTokens,
      outputTokens,
      modelId: typeof model === 'string' ? model : 'classifier',
      phase: 'classify',
      agentId: 'classifier',
    },
  };
}

// ---------------------------------------------------------------------------
// Greenfield fallback — skip classifier when we know it's a new project
// ---------------------------------------------------------------------------

/**
 * Detect whether we're in an existing project by checking for common markers.
 */
function detectExistingProject(): boolean {
  try {
    const fs = require('fs');
    // If any of these exist, it's not greenfield
    return ['package.json', 'tsconfig.json', 'src', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Makefile']
      .some(f => fs.existsSync(f));
  } catch {
    return false;
  }
}

/**
 * Detect task type from idea text + project state.
 */
function detectTaskType(text: string, isExisting: boolean): IntentClassification['taskType'] {
  if (!isExisting) return 'greenfield';

  // Check for bugfix indicators
  if (/\b(fix|bug|broken|crash|error|fail|issue|wrong|not working)\b/.test(text)) return 'bugfix';
  // Check for refactor indicators
  if (/\b(refactor|restructure|reorganize|clean ?up|architecture|rewrite|improve)\b/.test(text)) return 'refactor';
  // Check for docs indicators
  if (/\b(document|docs|readme|jsdoc|comment)\b/.test(text)) return 'docs';
  // Check for infra indicators
  if (/\b(deploy|docker|ci|cd|pipeline|infra|kubernetes)\b/.test(text)) return 'infra';
  // Default: feature work on existing project
  return 'feature';
}

export function greenfieldClassification(idea: string): IntentClassification {
  const isExisting = detectExistingProject();
  // Detect domains from keywords
  const text = idea.toLowerCase();
  const domains: IntentClassification['domains'] = [];

  const domainKeywords: Record<string, string[]> = {
    auth: ['auth', 'login', 'signup', 'password', 'oauth', 'jwt', 'session'],
    api: ['api', 'rest', 'graphql', 'endpoint', 'route'],
    database: ['database', 'db', 'sql', 'postgres', 'sqlite', 'mongo', 'redis'],
    ui: ['ui', 'frontend', 'react', 'svelte', 'vue', 'dashboard', 'interface'],
    testing: ['test', 'testing', 'coverage', 'spec'],
    payments: ['payment', 'billing', 'stripe', 'subscription', 'checkout'],
    email: ['email', 'mail', 'smtp', 'notification'],
    storage: ['storage', 'upload', 'file', 's3', 'bucket'],
    realtime: ['realtime', 'websocket', 'socket', 'live', 'streaming', 'chat'],
    deployment: ['deploy', 'docker', 'ci', 'cd', 'kubernetes', 'vercel'],
    monitoring: ['monitor', 'logging', 'metrics', 'alert', 'observ'],
    security: ['security', 'encrypt', 'audit', 'vulnerability'],
  };

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    if (keywords.some(kw => new RegExp(`\\b${kw}`).test(text))) {
      domains.push(domain as IntentClassification['domains'][number]);
    }
  }

  // Estimate complexity from idea length and domain count
  let complexity: IntentClassification['complexity'] = 'moderate';
  if (domains.length <= 1 && text.length < 100) complexity = 'simple';
  if (domains.length >= 4 || text.length > 300) complexity = 'complex';

  const taskType = detectTaskType(text, isExisting);

  return {
    taskType,
    domains: domains.length > 0 ? domains : ['api'],
    contextNeeded: {
      filePatterns: isExisting ? ['src/**/*.ts', 'src/**/*.tsx'] : [],
      gitLogCount: isExisting ? 10 : 0,
      gitLogFilter: null,
      includeProjectStructure: isExisting,
      includeDependencies: isExisting,
      externalDocs: [],
    },
    complexity,
  };
}
