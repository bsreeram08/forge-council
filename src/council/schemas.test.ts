import { describe, expect, test } from 'bun:test';
import { normalizePlanOutput, normalizeAgentReview, PlanOutputSchema, AgentReviewSchema, ScoreCardSchema, RawAgentReviewSchema } from './schemas';
import type { ReviewNormalizationContext } from './schemas';

describe('normalizePlanOutput', () => {
  test('returns plan output as-is when all fields are strings', () => {
    const input = {
      executiveSummary: 'A simple todo app',
      architecture: 'Client-server',
      phasedRoadmap: 'Phase 1: MVP',
      skeletonCode: 'const app = ...',
      techStack: 'React, Node',
    };
    
    const result = normalizePlanOutput(input);
    expect(result.executiveSummary).toBe('A simple todo app');
    expect(result.architecture).toBe('Client-server');
    expect(result.phasedRoadmap).toBe('Phase 1: MVP');
    expect(result.skeletonCode).toBe('const app = ...');
    expect(result.techStack).toBe('React, Node');
  });

  test('stringifies nested objects', () => {
    const input = {
      executiveSummary: { text: 'A todo app', version: 1 },
      architecture: { components: ['client', 'server'] },
      phasedRoadmap: [{ phase: 1, tasks: ['setup'] }],
      skeletonCode: { main: { type: 'file', content: '...' } },
      techStack: ['react', 'node'],
    };
    
    const result = normalizePlanOutput(input);
    expect(result.executiveSummary).toContain('A todo app');
    expect(result.executiveSummary).toContain('version');
    expect(result.architecture).toContain('client');
    expect(result.architecture).toContain('server');
  });

  test('handles mixed string and object fields', () => {
    const input = {
      executiveSummary: 'Simple string',
      architecture: { complex: 'object' },
      phasedRoadmap: 'Phase 1 only',
      skeletonCode: { file: { name: 'app.ts' } },
      techStack: ['typescript'],
    };
    
    const result = normalizePlanOutput(input);
    expect(result.executiveSummary).toBe('Simple string');
    expect(result.phasedRoadmap).toBe('Phase 1 only');
    expect(result.architecture).toContain('complex');
    expect(result.skeletonCode).toContain('app.ts');
    // JSON.stringify adds formatting
    expect(result.techStack).toContain('typescript');
  });
});

describe('PlanOutputSchema', () => {
  test('validates valid plan output', () => {
    const valid = {
      executiveSummary: 'Build a todo app',
      architecture: 'MVC pattern',
      phasedRoadmap: 'Phase 1: MVP',
      skeletonCode: '// code here',
      techStack: 'React, Node, SQLite',
    };
    
    const result = PlanOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test('rejects missing required fields', () => {
    const invalid = {
      executiveSummary: 'Build a todo app',
      // missing other fields
    };
    
    const result = PlanOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test('rejects non-string values', () => {
    const invalid = {
      executiveSummary: 123,
      architecture: 'test',
      phasedRoadmap: 'test',
      skeletonCode: 'test',
      techStack: 'test',
    };
    
    const result = PlanOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

describe('AgentReviewSchema', () => {
  test('validates valid agent review', () => {
    const valid = {
      agentId: 'architect',
      codename: 'Torvalds',
      dimensions: [
        { name: 'design', score: 8, weight: 0.5, reasoning: 'Good design' },
      ],
      weightedScore: 8,
      verdict: 'approve',
      summary: 'Looks good',
      concerns: ['Minor issue'],
      suggestions: ['Fix X'],
    };
    
    const result = AgentReviewSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test('rejects invalid verdict', () => {
    const invalid = {
      agentId: 'architect',
      codename: 'Torvalds',
      dimensions: [],
      weightedScore: 8,
      verdict: 'invalid',
      summary: 'Test',
      concerns: [],
      suggestions: [],
    };
    
    const result = AgentReviewSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test('rejects score out of range', () => {
    const invalid = {
      agentId: 'architect',
      codename: 'Torvalds',
      dimensions: [
        { name: 'design', score: 11, weight: 1, reasoning: '' },
      ],
      weightedScore: 11,
      verdict: 'approve',
      summary: 'Test',
      concerns: [],
      suggestions: [],
    };
    
    const result = AgentReviewSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

describe('ScoreCardSchema', () => {
  test('validates valid score card', () => {
    const valid = {
      round: 1,
      mean: 7.5,
      agentScores: { architect: 8, coder: 7 },
      reviews: [],
      passed: true,
      stagnated: false,
    };
    
    const result = ScoreCardSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test('accepts zero mean', () => {
    const valid = {
      round: 1,
      mean: 0,
      agentScores: {},
      reviews: [],
      passed: false,
      stagnated: false,
    };
    
    const result = ScoreCardSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });
});

// --- normalizeAgentReview tests ---

const CTX: ReviewNormalizationContext = { agentId: 'architect', codename: 'Torvalds' };

describe('normalizeAgentReview', () => {
  test('passes through valid review data and injects identity from context', () => {
    const raw = {
      agentId: 'wrong-id',
      codename: 'wrong-name',
      dimensions: [{ name: 'Design', score: 8, weight: 0.5, reasoning: 'Good' }],
      weightedScore: 7.5,
      verdict: 'approve',
      summary: 'Solid plan',
      concerns: ['Scalability'],
      suggestions: ['Add caching'],
    };
    const result = normalizeAgentReview(raw, CTX);
    // Identity always comes from context, not from LLM output
    expect(result.agentId).toBe('architect');
    expect(result.codename).toBe('Torvalds');
    expect(result.weightedScore).toBe(7.5);
    expect(result.verdict).toBe('approve');
    expect(result.summary).toBe('Solid plan');
    expect(result.concerns).toEqual(['Scalability']);
    expect(result.suggestions).toEqual(['Add caching']);
    expect(result.dimensions).toHaveLength(1);
  });

  test('handles missing agentId and codename', () => {
    const raw = {
      weightedScore: 6,
      verdict: 'request-changes',
      summary: 'Needs work',
      concerns: [],
      suggestions: [],
    };
    const result = normalizeAgentReview(raw, CTX);
    expect(result.agentId).toBe('architect');
    expect(result.codename).toBe('Torvalds');
  });

  test('converts object suggestions to strings', () => {
    const raw = {
      weightedScore: 5,
      verdict: 'reject',
      summary: 'Poor',
      concerns: [],
      suggestions: [
        { title: 'Add tests', description: 'Unit tests needed' },
        { title: 'Fix auth', description: 'Security gap' },
        'Already a string',
      ],
    };
    const result = normalizeAgentReview(raw, CTX);
    expect(result.suggestions).toHaveLength(3);
    expect(typeof result.suggestions[0]).toBe('string');
    expect(result.suggestions[0]).toContain('Add tests');
    expect(result.suggestions[2]).toBe('Already a string');
  });

  test('handles missing dimensions with empty array', () => {
    const raw = {
      weightedScore: 6,
      verdict: 'approve',
      summary: 'OK',
      concerns: [],
      suggestions: [],
    };
    const result = normalizeAgentReview(raw, CTX);
    expect(result.dimensions).toEqual([]);
  });

  test('coerces string weightedScore to number', () => {
    const raw = {
      weightedScore: '8.5',
      verdict: 'approve',
      summary: 'Great',
      concerns: [],
      suggestions: [],
    };
    const result = normalizeAgentReview(raw, CTX);
    expect(result.weightedScore).toBe(8.5);
  });

  test('computes weightedScore from dimensions when missing', () => {
    const raw = {
      dimensions: [
        { name: 'A', score: 8, weight: 0.5, reasoning: 'Good' },
        { name: 'B', score: 6, weight: 0.5, reasoning: 'OK' },
      ],
      verdict: 'approve',
      summary: 'Mixed',
      concerns: [],
      suggestions: [],
    };
    const result = normalizeAgentReview(raw, CTX);
    expect(result.weightedScore).toBe(7);
  });

  test('defaults to 5 when weightedScore is missing and no dimensions', () => {
    const raw = {
      verdict: 'approve',
      summary: 'Unknown',
      concerns: [],
      suggestions: [],
    };
    const result = normalizeAgentReview(raw, CTX);
    expect(result.weightedScore).toBe(5);
  });

  test('defaults invalid verdict to request-changes', () => {
    const raw = {
      weightedScore: 7,
      verdict: 'maybe',
      summary: 'Hmm',
      concerns: [],
      suggestions: [],
    };
    const result = normalizeAgentReview(raw, CTX);
    expect(result.verdict).toBe('request-changes');
  });

  test('handles completely empty raw object', () => {
    const result = normalizeAgentReview({}, CTX);
    expect(result.agentId).toBe('architect');
    expect(result.codename).toBe('Torvalds');
    expect(result.weightedScore).toBe(5);
    expect(result.verdict).toBe('request-changes');
    expect(result.summary).toBe('');
    expect(result.concerns).toEqual([]);
    expect(result.suggestions).toEqual([]);
    expect(result.dimensions).toEqual([]);
  });

  test('clamps dimension scores to 1-10', () => {
    const raw = {
      dimensions: [
        { name: 'X', score: 15, weight: 1, reasoning: 'Over' },
        { name: 'Y', score: -3, weight: 1, reasoning: 'Under' },
      ],
      weightedScore: 5,
      verdict: 'approve',
      summary: 'Test',
      concerns: [],
      suggestions: [],
    };
    const result = normalizeAgentReview(raw, CTX);
    expect(result.dimensions[0]!.score).toBe(10);
    expect(result.dimensions[1]!.score).toBe(1);
  });

  test('converts object concerns to strings', () => {
    const raw = {
      weightedScore: 4,
      verdict: 'reject',
      summary: 'Bad',
      concerns: [{ issue: 'No auth', severity: 'high' }, 'Plain string concern'],
      suggestions: [],
    };
    const result = normalizeAgentReview(raw, CTX);
    expect(result.concerns).toHaveLength(2);
    expect(typeof result.concerns[0]).toBe('string');
    expect(result.concerns[0]).toContain('No auth');
    expect(result.concerns[1]).toBe('Plain string concern');
  });

  test('result validates against strict AgentReviewSchema', () => {
    const raw = {
      dimensions: [{ name: 'Quality', score: 7, weight: 1, reasoning: 'Decent' }],
      weightedScore: 7,
      verdict: 'approve',
      summary: 'Good enough',
      concerns: ['Minor issues'],
      suggestions: [{ title: 'Refactor', detail: 'Split modules' }],
    };
    const normalized = normalizeAgentReview(raw, CTX);
    const parsed = AgentReviewSchema.safeParse(normalized);
    expect(parsed.success).toBe(true);
  });
});

describe('RawAgentReviewSchema', () => {
  test('accepts any shape without validation errors', () => {
    const result = RawAgentReviewSchema.safeParse({
      weightedScore: 'not a number',
      suggestions: [{ nested: true }],
      randomField: 'ignored',
    });
    expect(result.success).toBe(true);
  });

  test('accepts completely empty object', () => {
    const result = RawAgentReviewSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
