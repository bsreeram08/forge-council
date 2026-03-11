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
  /** Max tool call steps per agent per iteration (~1 task per iteration) */
  maxStepsPerAgent: z.number().default(15),
  /** Max iterations per agent (each iteration = one generateText call, roughly one task) */
  maxIterations: z.number().min(1).max(30).default(15),
});

export type CodingConfig = z.infer<typeof CodingConfigSchema>;

// --- Skills config ---

export const SkillsConfigSchema = z.object({
  /** Whether skill-based tool grants can escalate beyond base permission level */
  canEscalatePermission: z.boolean().default(false),
  /** Custom skill file directories (in addition to default locations) */
  extraDirs: z.array(z.string()).default([]),
});

export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

// --- QMD config (on-device semantic search for context assembly) ---

export const QmdConfigSchema = z.object({
  /** Enable QMD-based context assembly */
  enabled: z.boolean().default(true),
  /** Path to QMD SQLite store (relative to project root) */
  storePath: z.string().default('.forgecouncil/.qmd'),
  /** Auto-index project on first use */
  indexOnStart: z.boolean().default(true),
  /** Glob patterns to exclude from indexing */
  excludePatterns: z.array(z.string()).default(['node_modules', '.git', 'dist', 'coverage', '.forgecouncil/.qmd']),
  /** File patterns to include (empty = all text files) */
  includePatterns: z.array(z.string()).default(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.md', '**/*.json', '**/*.yaml', '**/*.yml']),
  /** Collections to create (name → path mapping) */
  collections: z.record(z.string(), z.string()).default({}),
  /** Min relevance score for search results (0-1) */
  minScore: z.number().min(0).max(1).default(0.2),
});

export type QmdConfig = z.infer<typeof QmdConfigSchema>;

// --- RLM config (Recursive Language Models for large context processing) ---

export const RlmConfigSchema = z.object({
  /** Enable RLM mode for large contexts */
  enabled: z.boolean().default(true),
  /** Token threshold above which RLM mode activates (inline below this) */
  contextThreshold: z.number().default(50_000),
  /** Max recursion depth for sub-agent calls */
  maxDepth: z.number().min(1).max(5).default(3),
  /** Max total sub-agent calls per top-level invocation */
  maxSubAgentCalls: z.number().min(1).max(50).default(10),
  /** Token budget fraction for sub-agents (relative to parent) */
  subAgentBudgetFraction: z.number().min(0.1).max(0.8).default(0.5),
});

export type RlmConfig = z.infer<typeof RlmConfigSchema>;

// --- Plugins config ---

export const PluginsConfigSchema = z.object({
  /** Whether the plugin system is enabled */
  enabled: z.boolean().default(true),
  /** Enable built-in plugins (validation-gate, task-scope-guard) */
  builtins: z.object({
    'validation-gate': z.boolean().default(true),
    'task-scope-guard': z.boolean().default(true),
  }).default({ 'validation-gate': true, 'task-scope-guard': true }),
  /** Extra directories to scan for plugins (in addition to default locations) */
  extraDirs: z.array(z.string()).default([]),
  /** Per-plugin config overrides keyed by plugin name */
  configs: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

export type PluginsConfig = z.infer<typeof PluginsConfigSchema>;

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
  skills: SkillsConfigSchema.optional(),
  qmd: QmdConfigSchema.optional(),
  rlm: RlmConfigSchema.optional(),
  plugins: PluginsConfigSchema.optional(),
});

export type ForgeCouncilConfig = z.infer<typeof ForgeCouncilConfigSchema>;
