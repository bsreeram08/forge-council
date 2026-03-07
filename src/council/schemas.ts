import { z } from 'zod';

// --- Goal Ancestry ---

export const GoalAncestrySchema = z.object({
  idea: z.string(),
  phase: z.string(),
  task: z.string(),
  round: z.number(),
  previousScores: z
    .object({
      mean: z.number(),
      concerns: z.array(z.string()),
    })
    .optional(),
});

export type GoalAncestry = z.infer<typeof GoalAncestrySchema>;

// --- Scoring Dimension ---

export const ScoringDimensionSchema = z.object({
  name: z.string(),
  score: z.number().min(1).max(10),
  weight: z.number().min(0).max(1).optional().default(0),
  reasoning: z.string(),
});

export type ScoringDimension = z.infer<typeof ScoringDimensionSchema>;

// --- Agent Review ---

export const AgentReviewSchema = z.object({
  agentId: z.string(),
  codename: z.string(),
  dimensions: z.array(ScoringDimensionSchema),
  weightedScore: z.number(),
  verdict: z.enum(['approve', 'request-changes', 'reject']),
  summary: z.string(),
  concerns: z.array(z.string()),
  suggestions: z.array(z.string()),
});

export type AgentReview = z.infer<typeof AgentReviewSchema>;

/**
 * Lenient review schema — accepts any shape from the LLM.
 * Use with normalizeAgentReview() to produce a valid AgentReview.
 */
export const RawAgentReviewSchema = z.object({
  agentId: z.any().optional(),
  codename: z.any().optional(),
  dimensions: z.any().optional(),
  weightedScore: z.any().optional(),
  verdict: z.any().optional(),
  summary: z.any().optional(),
  concerns: z.any().optional(),
  suggestions: z.any().optional(),
});

export type RawAgentReview = z.infer<typeof RawAgentReviewSchema>;

/**
 * Context passed by the caller so we can inject agentId/codename
 * rather than relying on the LLM to echo them back.
 */
export interface ReviewNormalizationContext {
  agentId: string;
  codename: string;
}

/**
 * Normalize a raw LLM review response into a valid AgentReview.
 * Handles: missing fields, objects-as-strings, type coercion, missing identity.
 */
export function normalizeAgentReview(
  raw: Record<string, unknown>,
  ctx: ReviewNormalizationContext,
): AgentReview {
  const toStr = (val: unknown): string =>
    val == null ? '' : typeof val === 'string' ? val : JSON.stringify(val, null, 2);

  const toStrArray = (val: unknown): string[] => {
    if (!Array.isArray(val)) return val ? [toStr(val)] : [];
    return val.map((item) =>
      typeof item === 'string' ? item : toStr(item),
    );
  };

  const toDimensions = (val: unknown): ScoringDimension[] => {
    if (!Array.isArray(val)) return [];
    return val
      .filter((d): d is Record<string, unknown> => d != null && typeof d === 'object')
      .map((d) => ({
        name: typeof d.name === 'string' ? d.name : toStr(d.name),
        score: Math.min(10, Math.max(1, Number(d.score) || 5)),
        weight: Math.min(1, Math.max(0, Number(d.weight) || 0)),
        reasoning: typeof d.reasoning === 'string' ? d.reasoning : toStr(d.reasoning),
      }));
  };

  const rawVerdict = typeof raw.verdict === 'string' ? raw.verdict.toLowerCase() : '';
  const validVerdicts = ['approve', 'request-changes', 'reject'] as const;
  const verdict = validVerdicts.includes(rawVerdict as typeof validVerdicts[number])
    ? (rawVerdict as AgentReview['verdict'])
    : 'request-changes';

  const dimensions = toDimensions(raw.dimensions);
  let weightedScore = Number(raw.weightedScore);
  if (isNaN(weightedScore) && dimensions.length > 0) {
    // Compute from dimensions if the LLM didn't provide a valid score
    const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);
    weightedScore = totalWeight > 0
      ? dimensions.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight
      : dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length;
  }
  if (isNaN(weightedScore)) weightedScore = 5;

  return {
    agentId: ctx.agentId,
    codename: ctx.codename,
    dimensions,
    weightedScore: Math.round(weightedScore * 10) / 10,
    verdict,
    summary: toStr(raw.summary),
    concerns: toStrArray(raw.concerns),
    suggestions: toStrArray(raw.suggestions),
  };
}

// --- Plan Output ---

export const PlanOutputSchema = z.object({
  executiveSummary: z.string(),
  architecture: z.string(),
  phasedRoadmap: z.string(),
  skeletonCode: z.string(),
  techStack: z.string(),
});

/**
 * Lenient schema that accepts any type (strings, arrays, objects).
 * Use this for LLM structured output, then normalize to PlanOutput.
 */
export const RawPlanOutputSchema = z.object({
  executiveSummary: z.any(),
  architecture: z.any(),
  phasedRoadmap: z.any(),
  skeletonCode: z.any(),
  techStack: z.any(),
});


export type RawPlanOutput = z.infer<typeof RawPlanOutputSchema>;


/**
 * Some models return nested objects for plan fields instead of strings.
 * This function normalizes the raw output to match PlanOutput.
 */
export function normalizePlanOutput(raw: Record<string, unknown>): PlanOutput {
  const normalize = (val: unknown): string =>
    typeof val === 'string' ? val : JSON.stringify(val, null, 2);

  return {
    executiveSummary: normalize(raw.executiveSummary),
    architecture: normalize(raw.architecture),
    phasedRoadmap: normalize(raw.phasedRoadmap),
    skeletonCode: normalize(raw.skeletonCode),
    techStack: normalize(raw.techStack),
  };
}

export type PlanOutput = z.infer<typeof PlanOutputSchema>;

// --- Score Card ---

export const ScoreCardSchema = z.object({
  round: z.number(),
  mean: z.number(),
  agentScores: z.record(z.string(), z.number()),
  reviews: z.array(AgentReviewSchema),
  passed: z.boolean(),
  stagnated: z.boolean(),
});

export type ScoreCard = z.infer<typeof ScoreCardSchema>;

// --- Notifications ---

/**
 * Notification — agents can request human attention/help via notifications.
 * Displayed in both CLI (terminal bell + clack prompt) and desktop app (toast panel).
 */
export const NotificationSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string(),
  detail: z.string(),
  timestamp: z.string(),
  dismissed: z.boolean(),
  actionRequired: z.boolean(),
  response: z.string().optional(),
});

export type Notification = z.infer<typeof NotificationSchema>;

// --- Session ---

/**
 * Pending action — when set, the workflow is waiting for user input.
 * The desktop app renders the appropriate UI and calls the corresponding API endpoint.
 */
export const PendingActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pick-items'),
    plan: z.any(), // MergedPlan — stored as-is for the desktop app
  }),
  z.object({
    type: z.literal('pick-action'),
    options: z.array(z.object({ value: z.string(), label: z.string(), hint: z.string().optional() })),
  }),
  z.object({
    type: z.literal('fix-select'),
    issues: z.array(z.any()),
  }),
  z.object({
    type: z.literal('confirm'),
    message: z.string(),
  }),
]);

export type PendingAction = z.infer<typeof PendingActionSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  idea: z.string(),
  port: z.number(),
  pid: z.number(),
  startedAt: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'stopped']),
  currentRound: z.number(),
  currentPhase: z.string().optional(),
  pendingAction: PendingActionSchema.optional(),
  scores: z.array(
    z.object({
      round: z.number(),
      mean: z.number(),
      agents: z.record(z.string(), z.number()),
    }),
  ),
  activeAgents: z.array(z.string()),
  guidance: z.array(z.string()).optional(),
  notifications: z.array(NotificationSchema).optional(),
});

export type Session = z.infer<typeof SessionSchema>;



// --- Clarification Output ---

export const ClarificationOutputSchema = z.object({
  isClear: z.boolean(),
  isVague: z.boolean(),
  questions: z.array(z.string()),
  clarifiedIdea: z.string(),
  reasoning: z.string(),
});

export type ClarificationOutput = z.infer<typeof ClarificationOutputSchema>;

// --- Clarified Requirements ---

export const ClarifiedRequirementsSchema = z.object({
  originalIdea: z.string(),
  whatToBuild: z.string(),
  targetUser: z.string(),
  constraints: z.object({
    tech: z.array(z.string()).optional(),
    timeline: z.string().optional(),
    scope: z.string().optional(),
  }),
  keyFeatures: z.array(z.string()),
  clarifyingQuestions: z.array(z.object({
    question: z.string(),
    answer: z.string().optional(),
  })),
  clarificationRounds: z.number().default(0),
});

export type ClarifiedRequirements = z.infer<typeof ClarifiedRequirementsSchema>;