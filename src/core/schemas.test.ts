import { describe, test, expect } from 'bun:test';
import {
  IntentClassificationSchema,
  PlanContributionSchema,
  MergedPlanSchema,
  PlanChangeSchema,
  CodeReviewSchema,
  CodingOutputSchema,
  PlanItemSchema,
} from './schemas.ts';

describe('IntentClassificationSchema', () => {
  test('accepts valid greenfield classification', () => {
    const result = IntentClassificationSchema.parse({
      taskType: 'greenfield',
      domains: ['api', 'database'],
      contextNeeded: {
        filePatterns: [],
        gitLogCount: 0,
        includeProjectStructure: false,
        includeDependencies: false,
        externalDocs: [],
      },
      complexity: 'moderate',
    });
    expect(result.taskType).toBe('greenfield');
    expect(result.domains).toEqual(['api', 'database']);
  });

  test('accepts valid feature classification', () => {
    const result = IntentClassificationSchema.parse({
      taskType: 'feature',
      domains: ['auth', 'security'],
      contextNeeded: {
        filePatterns: ['src/auth/**'],
        gitLogCount: 10,
        gitLogFilter: 'auth',
        includeProjectStructure: true,
        includeDependencies: true,
        externalDocs: ['passport'],
      },
      complexity: 'complex',
    });
    expect(result.contextNeeded.filePatterns).toHaveLength(1);
    expect(result.contextNeeded.gitLogFilter).toBe('auth');
  });

  test('rejects invalid task type', () => {
    expect(() =>
      IntentClassificationSchema.parse({
        taskType: 'invalid',
        domains: [],
        contextNeeded: {
          filePatterns: [],
          gitLogCount: 0,
          includeProjectStructure: false,
          includeDependencies: false,
          externalDocs: [],
        },
        complexity: 'simple',
      }),
    ).toThrow();
  });
});

describe('PlanContributionSchema', () => {
  test('accepts valid contribution', () => {
    const result = PlanContributionSchema.parse({
      agentId: 'architect',
      items: [
        {
          id: 'arch-1',
          category: 'Architecture',
          title: 'Set up monolith structure',
          description: 'Create a single-service architecture with clear module boundaries',
          priority: 'must',
          phase: 1,
        },
      ],
      techSuggestions: [
        {
          tool: 'hono',
          reason: 'Lightweight, fast HTTP framework',
          alternative: 'express',
        },
      ],
    });
    expect(result.items).toHaveLength(1);
    expect(result.techSuggestions).toHaveLength(1);
  });

  test('accepts contribution without tech suggestions', () => {
    const result = PlanContributionSchema.parse({
      agentId: 'planner',
      items: [{
        id: 'plan-1',
        category: 'Scope',
        title: 'Define MVP',
        description: 'Minimal viable product scope',
        priority: 'must',
        phase: 1,
      }],
    });
    expect(result.techSuggestions).toEqual([]);
  });
});

describe('MergedPlanSchema', () => {
  test('accepts valid merged plan', () => {
    const result = MergedPlanSchema.parse({
      summary: 'Build a billing system with Stripe integration',
      categories: [
        {
          name: 'Architecture',
          items: [
            {
              id: 'arch-1',
              title: 'API layer',
              description: 'REST API with Hono',
              priority: 'must',
              phase: 1,
              source: 'architect',
              selected: true,
            },
          ],
        },
      ],
      techStack: { framework: 'hono', database: 'sqlite' },
      phases: [
        { number: 1, title: 'Walking skeleton', scope: 'Basic API + DB', effort: '2 days' },
      ],
    });
    expect(result.categories).toHaveLength(1);
    expect(result.techStack['framework']).toBe('hono');
  });

  test('rejects summary over 500 chars', () => {
    expect(() =>
      MergedPlanSchema.parse({
        summary: 'a'.repeat(501),
        categories: [],
        techStack: {},
        phases: [],
      }),
    ).toThrow();
  });
});

describe('PlanChangeSchema', () => {
  test('accepts valid pass 2 changes', () => {
    const result = PlanChangeSchema.parse({
      agentId: 'architect',
      additions: [
        {
          item: {
            id: 'new-1',
            category: 'Security',
            title: 'Add rate limiting',
            description: 'Rate limit API endpoints',
            priority: 'should',
            phase: 2,
          },
          reason: 'Prevents abuse of public endpoints',
        },
      ],
      removals: [
        { itemId: 'scope-3', reason: 'Not needed for MVP' },
      ],
    });
    expect(result.additions).toHaveLength(1);
    expect(result.removals).toHaveLength(1);
  });
});

describe('CodeReviewSchema', () => {
  test('accepts valid review', () => {
    const result = CodeReviewSchema.parse({
      score: 8,
      verdict: 'approve',
      issues: [],
    });
    expect(result.score).toBe(8);
    expect(result.verdict).toBe('approve');
  });

  test('accepts review with issues', () => {
    const result = CodeReviewSchema.parse({
      score: 5,
      verdict: 'fix',
      issues: [
        {
          id: 'issue-1',
          severity: 'critical',
          file: 'src/auth.ts',
          line: 42,
          what: 'Hardcoded JWT secret',
          fix: 'Use environment variable for JWT_SECRET',
        },
        {
          id: 'issue-2',
          severity: 'warning',
          file: 'src/api.ts',
          what: 'No input validation on POST body',
          fix: 'Add Zod schema validation',
        },
      ],
    });
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]!.severity).toBe('critical');
    expect(result.issues[1]!.line).toBeNull();
  });

  test('rejects score out of range', () => {
    expect(() =>
      CodeReviewSchema.parse({ score: 0, verdict: 'approve', issues: [] }),
    ).toThrow();
    expect(() =>
      CodeReviewSchema.parse({ score: 11, verdict: 'approve', issues: [] }),
    ).toThrow();
  });

  test('rejects more than 10 issues', () => {
    const issues = Array.from({ length: 11 }, (_, i) => ({
      id: `issue-${i}`,
      severity: 'warning' as const,
      file: 'src/test.ts',
      what: `Issue ${i}`,
      fix: `Fix ${i}`,
    }));
    expect(() =>
      CodeReviewSchema.parse({ score: 3, verdict: 'fix', issues }),
    ).toThrow();
  });
});

describe('CodingOutputSchema', () => {
  test('accepts valid coding output', () => {
    const result = CodingOutputSchema.parse({
      files: [
        { path: 'src/index.ts', content: 'console.log("hello")', action: 'create' },
        { path: 'src/old.ts', content: '', action: 'delete' },
      ],
      commitMessage: 'feat: add entry point',
      summary: 'Created main entry point',
    });
    expect(result.files).toHaveLength(2);
  });

  test('rejects commit message over 72 chars', () => {
    expect(() =>
      CodingOutputSchema.parse({
        files: [],
        commitMessage: 'a'.repeat(73),
        summary: 'test',
      }),
    ).toThrow();
  });
});
