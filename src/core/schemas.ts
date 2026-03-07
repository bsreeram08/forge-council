import { z } from 'zod';

// ---------------------------------------------------------------------------
// Intent Classification — cheap pre-call classifier output
// ---------------------------------------------------------------------------

export const IntentClassificationSchema = z.object({
  taskType: z.enum([
    'greenfield',
    'feature',
    'bugfix',
    'refactor',
    'review',
    'docs',
    'infra',
  ]),
  domains: z.array(z.enum([
    'auth', 'api', 'database', 'ui', 'testing',
    'payments', 'email', 'storage', 'realtime',
    'deployment', 'monitoring', 'security',
  ])),
  contextNeeded: z.object({
    filePatterns: z.array(z.string()),
    gitLogCount: z.number(),
    gitLogFilter: z.string().nullable().default(null),
    includeProjectStructure: z.boolean(),
    includeDependencies: z.boolean(),
    externalDocs: z.array(z.string()),
  }),
  complexity: z.enum(['simple', 'moderate', 'complex']),
});

export type IntentClassification = z.infer<typeof IntentClassificationSchema>;

// ---------------------------------------------------------------------------
// Plan Contribution — each agent's Pass 1 output
// ---------------------------------------------------------------------------

export const PlanItemSchema = z.object({
  id: z.string(),
  category: z.string(),
  title: z.string().max(80),
  description: z.string().max(200),
  priority: z.enum(['must', 'should', 'could']),
  phase: z.number(),
});

export type PlanItem = z.infer<typeof PlanItemSchema>;

export const TechSuggestionSchema = z.object({
  tool: z.string(),
  reason: z.string().max(100),
  alternative: z.string().nullable().default(null),
});

export const PlanContributionSchema = z.object({
  agentId: z.string(),
  items: z.array(PlanItemSchema),
  techSuggestions: z.array(TechSuggestionSchema).default([]),
});

export type PlanContribution = z.infer<typeof PlanContributionSchema>;

// ---------------------------------------------------------------------------
// Merged Plan — Ford's merged output, shown to user
// ---------------------------------------------------------------------------

export const MergedPlanItemSchema = z.object({
  id: z.string(),
  title: z.string().max(80),
  description: z.string().max(200),
  priority: z.enum(['must', 'should', 'could']),
  phase: z.number(),
  source: z.string(),
  selected: z.boolean(),
});

export type MergedPlanItem = z.infer<typeof MergedPlanItemSchema>;

export const MergedPlanSchema = z.object({
  summary: z.string().max(500),
  categories: z.array(z.object({
    name: z.string(),
    items: z.array(MergedPlanItemSchema),
  })),
  techStack: z.record(z.string(), z.string()),
  phases: z.array(z.object({
    number: z.number(),
    title: z.string(),
    scope: z.string().max(200),
    effort: z.string(),
  })),
});

export type MergedPlan = z.infer<typeof MergedPlanSchema>;

// ---------------------------------------------------------------------------
// Plan Changes — Pass 2 per-agent additions/removals
// ---------------------------------------------------------------------------

export const PlanChangeSchema = z.object({
  agentId: z.string(),
  additions: z.array(z.object({
    item: PlanItemSchema,
    reason: z.string().max(100),
  })),
  removals: z.array(z.object({
    itemId: z.string(),
    reason: z.string().max(100),
  })),
});

export type PlanChange = z.infer<typeof PlanChangeSchema>;

// ---------------------------------------------------------------------------
// Code Review — schema-only review output
// ---------------------------------------------------------------------------

export const CodeReviewIssueSchema = z.object({
  id: z.string(),
  severity: z.enum(['critical', 'warning', 'suggestion']),
  file: z.string(),
  line: z.number().nullable().default(null),
  what: z.string().max(100),
  fix: z.string().max(200),
});

export type CodeReviewIssue = z.infer<typeof CodeReviewIssueSchema>;

export const CodeReviewSchema = z.object({
  score: z.number().min(1).max(10),
  verdict: z.enum(['approve', 'fix']),
  issues: z.array(CodeReviewIssueSchema).max(10),
});

export type CodeReview = z.infer<typeof CodeReviewSchema>;

// ---------------------------------------------------------------------------
// Contested Items — shown to user when 1/3 agents suggest a change
// ---------------------------------------------------------------------------

export interface ContestedItem {
  type: 'add' | 'remove';
  item?: PlanItem;
  itemId?: string;
  supporters: string[];
  reasons?: string[];
}

// ---------------------------------------------------------------------------
// Session types for v4 flow
// ---------------------------------------------------------------------------

export type FlowPhase = 'classify' | 'plan' | 'pick' | 'code' | 'review' | 'fix' | 'ship';

export interface SessionState {
  id: string;
  idea: string;
  phase: FlowPhase;
  classification?: IntentClassification;
  plan?: MergedPlan;
  contributions?: PlanContribution[];
  pass2Changes?: PlanChange[];
  contested?: ContestedItem[];
  reviews?: CodeReview[];
  selectedFixes?: string[];  // issue IDs the user picked
  round: number;
  createdAt: string;
  guidance?: string[];
}

// ---------------------------------------------------------------------------
// Code Output — what Carmack produces per file
// ---------------------------------------------------------------------------

export const CodeFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  action: z.enum(['create', 'modify', 'delete']),
});

export type CodeFile = z.infer<typeof CodeFileSchema>;

export const CodingOutputSchema = z.object({
  files: z.array(CodeFileSchema),
  commitMessage: z.string().max(72),
  summary: z.string().max(200),
});

export type CodingOutput = z.infer<typeof CodingOutputSchema>;
