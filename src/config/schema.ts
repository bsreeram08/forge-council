import { z } from 'zod';

// --- Provider schemas ---

export const ProviderModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  input: z.array(z.enum(['text', 'image', 'audio'])),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  contextWindow: z.number(),
  maxTokens: z.number(),
});

export type ProviderModel = z.infer<typeof ProviderModelSchema>;

export const ProviderConfigSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  api: z.enum(['anthropic-messages', 'openai-completions', 'openai-chat']),
  models: z.array(ProviderModelSchema),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// --- Model reference ---

export const ModelRefSchema = z.object({
  primary: z.string(),
  fallbacks: z.array(z.string()).optional(),
});

export type ModelRef = z.infer<typeof ModelRefSchema>;

// --- Agent overrides ---

export const AgentOverrideSchema = z.object({
  model: ModelRefSchema.optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  enabled: z.boolean().default(true).optional(),
});

export type AgentOverride = z.infer<typeof AgentOverrideSchema>;

// --- Compaction ---

export const CompactionModeSchema = z.enum(['safeguard', 'aggressive', 'off']);

export type CompactionMode = z.infer<typeof CompactionModeSchema>;

// --- Agent defaults ---

export const AgentDefaultsSchema = z.object({
  model: ModelRefSchema,
  compaction: z.object({
    mode: CompactionModeSchema,
  }),
  maxConcurrent: z.number(),
});

export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;

// --- Council config ---

export const CouncilConfigSchema = z.object({
  scoreThreshold: z.number().default(7.5),
  maxRounds: z.number().default(3),
  stagnationDelta: z.number().default(0.5),
  freshEyes: z.boolean().default(true),
  anonymizeReviews: z.boolean().default(true),
});

export type CouncilConfig = z.infer<typeof CouncilConfigSchema>;

// --- Git config ---

export const GitConfigSchema = z.object({
  commitPerMicrotask: z.boolean().default(true),
  messageFormat: z.string().default('[{agentId}] {type}: {message}'),
});

export type GitConfig = z.infer<typeof GitConfigSchema>;

// --- Pipeline config (configurable work phases) ---

export const PhaseConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('always') }),
  z.object({ type: z.literal('has-issues') }),
  z.object({ type: z.literal('score-below'), threshold: z.number() }),
  z.object({ type: z.literal('input-vague') }),
  z.object({ type: z.literal('user-approved') }),
  z.object({ type: z.literal('files-changed') }),
]);

export const AgentAssignmentSchema = z.object({
  agentId: z.string(),
  required: z.boolean().default(false),
});

export const PhaseConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  handler: z.string(),
  agents: z.array(AgentAssignmentSchema).default([]),
  parallel: z.boolean().default(false),
  condition: PhaseConditionSchema.default({ type: 'always' }),
  dynamicAgents: z.boolean().default(false),
});

export const ExitConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('score-threshold'), threshold: z.number() }),
  z.object({ type: z.literal('no-issues') }),
  z.object({ type: z.literal('stagnation'), delta: z.number() }),
  z.object({ type: z.literal('max-rounds'), max: z.number() }),
]);

export const LoopConfigSchema = z.object({
  startPhase: z.string(),
  endPhase: z.string(),
  maxRounds: z.number().default(3),
  exitWhen: z.array(ExitConditionSchema).default([]),
});

export const PipelineConfigSchema = z.object({
  phases: z.array(PhaseConfigSchema),
  loops: z.array(LoopConfigSchema).default([]),
});

export type PipelineConfigType = z.infer<typeof PipelineConfigSchema>;

// --- Edit review config (accept/reject AI changes) ---

export const EditReviewConfigSchema = z.object({
  /** Whether to show diffs for user approval before applying */
  enabled: z.boolean().default(true),
  /** Auto-accept changes below this number of lines */
  autoAcceptThreshold: z.number().default(0),
  /** Group changes by file or show individually */
  groupBy: z.enum(['file', 'individual', 'commit']).default('file'),
});

export type EditReviewConfig = z.infer<typeof EditReviewConfigSchema>;

// --- Parallel coding config ---

export const CodingConfigSchema = z.object({
  /** Number of parallel coder agents (1 = serial, like before) */
  parallelAgents: z.number().min(1).max(8).default(3),
  /** Max tool call steps per agent */
  maxStepsPerAgent: z.number().default(25),
});

export type CodingConfig = z.infer<typeof CodingConfigSchema>;

// --- Top-level config ---

export const ForgeCouncilConfigSchema = z.object({
  models: z.object({
    mode: z.enum(['merge', 'override']),
    providers: z.record(z.string(), ProviderConfigSchema),
  }),
  agents: z.object({
    defaults: AgentDefaultsSchema,
    overrides: z.record(z.string(), AgentOverrideSchema).optional(),
  }),
  council: CouncilConfigSchema,
  git: GitConfigSchema,
  pipeline: PipelineConfigSchema.optional(),
  editReview: EditReviewConfigSchema.optional(),
  coding: CodingConfigSchema.optional(),
});

export type ForgeCouncilConfig = z.infer<typeof ForgeCouncilConfigSchema>;
