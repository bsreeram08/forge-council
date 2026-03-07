import { describe, test, expect } from 'bun:test';
import { applyPass2Changes, selectReviewAgents, buildMergeInstructions } from './plan-merger.ts';
import type { MergedPlan, PlanChange, PlanContribution } from './schemas.ts';

describe('selectReviewAgents', () => {
  test('always includes reviewer (Guido)', () => {
    const result = selectReviewAgents(['src/index.ts']);
    expect(result.agentIds).toContain('reviewer');
  });

  test('adds security for auth files', () => {
    const result = selectReviewAgents(['src/auth/login.ts', 'src/middleware/jwt.ts']);
    expect(result.agentIds).toContain('security');
    expect(result.reasons['security']).toBeDefined();
  });

  test('adds qa for test files', () => {
    const result = selectReviewAgents(['src/utils.test.ts', 'src/api.ts']);
    expect(result.agentIds).toContain('qa');
  });

  test('adds integrator for docker files', () => {
    const result = selectReviewAgents(['Dockerfile', 'docker-compose.yml']);
    expect(result.agentIds).toContain('integrator');
  });

  test('adds designer for UI files', () => {
    const result = selectReviewAgents(['src/components/Button.tsx', 'src/app.css']);
    expect(result.agentIds).toContain('designer');
  });

  test('caps at 3 reviewers', () => {
    // File that triggers all reviewers
    const result = selectReviewAgents([
      'src/auth/login.tsx',
      'src/auth/login.test.ts',
      'Dockerfile',
      'src/components/Button.tsx',
    ]);
    expect(result.agentIds.length).toBeLessThanOrEqual(3);
  });
});

describe('applyPass2Changes', () => {
  const basePlan: MergedPlan = {
    summary: 'Test plan',
    categories: [
      {
        name: 'Core',
        items: [
          {
            id: 'core-1',
            title: 'API layer',
            description: 'Build REST API',
            priority: 'must',
            phase: 1,
            source: 'architect',
            selected: true,
          },
          {
            id: 'core-2',
            title: 'Database',
            description: 'Set up SQLite',
            priority: 'should',
            phase: 1,
            source: 'planner',
            selected: true,
          },
        ],
      },
    ],
    techStack: { framework: 'hono' },
    phases: [{ number: 1, title: 'Phase 1', scope: 'MVP', effort: '1 week' }],
  };

  test('applies addition with 2/3 agreement', () => {
    const changes: PlanChange[] = [
      {
        agentId: 'architect',
        additions: [{
          item: { id: 'new-1', category: 'Security', title: 'Rate limiting', description: 'Add rate limits', priority: 'should', phase: 2 },
          reason: 'Prevents abuse',
        }],
        removals: [],
      },
      {
        agentId: 'planner',
        additions: [{
          item: { id: 'new-1b', category: 'Security', title: 'rate limiting', description: 'Rate limit endpoints', priority: 'should', phase: 2 },
          reason: 'Security requirement',
        }],
        removals: [],
      },
      {
        agentId: 'researcher',
        additions: [],
        removals: [],
      },
    ];

    const { updatedPlan, contested } = applyPass2Changes(basePlan, changes);
    // 2/3 agreed on rate limiting (deduped by title lowercase)
    const securityCat = updatedPlan.categories.find(c => c.name === 'Security');
    expect(securityCat).toBeDefined();
    expect(securityCat!.items).toHaveLength(1);
    expect(contested).toHaveLength(0);
  });

  test('applies removal with 2/3 agreement', () => {
    const changes: PlanChange[] = [
      {
        agentId: 'architect',
        additions: [],
        removals: [{ itemId: 'core-2', reason: 'SQLite not needed yet' }],
      },
      {
        agentId: 'researcher',
        additions: [],
        removals: [{ itemId: 'core-2', reason: 'Defer database to phase 2' }],
      },
      {
        agentId: 'planner',
        additions: [],
        removals: [],
      },
    ];

    const { updatedPlan } = applyPass2Changes(basePlan, changes);
    const core = updatedPlan.categories.find(c => c.name === 'Core');
    expect(core!.items).toHaveLength(1);
    expect(core!.items[0]!.id).toBe('core-1');
  });

  test('marks items as contested with only 1/3 agreement', () => {
    const changes: PlanChange[] = [
      {
        agentId: 'architect',
        additions: [{
          item: { id: 'new-2', category: 'Perf', title: 'Caching layer', description: 'Add Redis cache', priority: 'could', phase: 3 },
          reason: 'Performance optimization',
        }],
        removals: [],
      },
      {
        agentId: 'planner',
        additions: [],
        removals: [],
      },
      {
        agentId: 'researcher',
        additions: [],
        removals: [],
      },
    ];

    const { updatedPlan, contested } = applyPass2Changes(basePlan, changes);
    expect(contested).toHaveLength(1);
    expect(contested[0]!.type).toBe('add');
    expect(contested[0]!.supporters).toEqual(['architect']);
    // Should NOT be in the plan
    const perfCat = updatedPlan.categories.find(c => c.name === 'Perf');
    expect(perfCat).toBeUndefined();
  });
});

describe('buildMergeInstructions', () => {
  test('produces merge instructions string', () => {
    const contributions: PlanContribution[] = [
      {
        agentId: 'architect',
        items: [{ id: 'a1', category: 'Arch', title: 'API', description: 'Build API', priority: 'must', phase: 1 }],
        techSuggestions: [{ tool: 'hono', reason: 'Fast', alternative: null }],
      },
      {
        agentId: 'planner',
        items: [{ id: 'p1', category: 'Scope', title: 'MVP', description: 'Define MVP', priority: 'must', phase: 1 }],
        techSuggestions: [],
      },
    ];

    const result = buildMergeInstructions(contributions);
    expect(result).toContain('architect');
    expect(result).toContain('planner');
    expect(result).toContain('2 contributions');
    expect(result).toContain('hono');
  });
});
