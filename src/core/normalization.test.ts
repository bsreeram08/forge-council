import { describe, it, expect } from 'bun:test';
import {
  normalizePlanContribution,
  normalizeCodeReview,
  type PlanContribution,
  type CodeReview,
} from './schemas.ts';

// ---------------------------------------------------------------------------
// normalizePlanContribution
// ---------------------------------------------------------------------------

describe('normalizePlanContribution', () => {
  it('normalizes a well-formed contribution', () => {
    const raw = {
      agentId: 'architect',
      items: [
        { id: 'item-1', category: 'api', title: 'Add REST endpoints', description: 'Create CRUD routes', priority: 'must', phase: 1 },
      ],
      techSuggestions: [
        { tool: 'Hono', reason: 'Fast, small', alternative: 'Express' },
      ],
    };
    const result = normalizePlanContribution(raw, 'fallback');

    expect(result.agentId).toBe('architect');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.priority).toBe('must');
    expect(result.techSuggestions).toHaveLength(1);
    expect(result.techSuggestions[0]!.tool).toBe('Hono');
  });

  it('uses fallback agentId when missing', () => {
    const raw = { items: [], techSuggestions: [] };
    const result = normalizePlanContribution(raw, 'my-agent');
    expect(result.agentId).toBe('my-agent');
  });

  it('normalizes missing items to empty array', () => {
    const raw = { agentId: 'planner' };
    const result = normalizePlanContribution(raw, 'planner');
    expect(result.items).toEqual([]);
    expect(result.techSuggestions).toEqual([]);
  });

  it('coerces invalid priority to "should"', () => {
    const raw = {
      agentId: 'test',
      items: [
        { id: '1', category: 'x', title: 'Test', description: 'Desc', priority: 'CRITICAL', phase: 1 },
      ],
    };
    const result = normalizePlanContribution(raw, 'test');
    expect(result.items[0]!.priority).toBe('should');
  });

  it('truncates long title and description', () => {
    const longStr = 'x'.repeat(300);
    const raw = {
      agentId: 'test',
      items: [
        { id: '1', category: 'x', title: longStr, description: longStr, priority: 'must', phase: 1 },
      ],
    };
    const result = normalizePlanContribution(raw, 'test');
    expect(result.items[0]!.title.length).toBeLessThanOrEqual(80);
    expect(result.items[0]!.description.length).toBeLessThanOrEqual(200);
  });

  it('generates fallback IDs when missing', () => {
    const raw = {
      agentId: 'test',
      items: [
        { category: 'x', title: 'No ID', description: 'Test', priority: 'must', phase: 1 },
      ],
    };
    const result = normalizePlanContribution(raw, 'test');
    expect(result.items[0]!.id).toBe('item-0');
  });

  it('handles non-array items gracefully', () => {
    const raw = { agentId: 'test', items: 'not an array' };
    const result = normalizePlanContribution(raw, 'test');
    expect(result.items).toEqual([]);
  });

  it('handles null techSuggestions gracefully', () => {
    const raw = { agentId: 'test', items: [], techSuggestions: null };
    const result = normalizePlanContribution(raw, 'test');
    expect(result.techSuggestions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeCodeReview
// ---------------------------------------------------------------------------

describe('normalizeCodeReview', () => {
  it('normalizes a well-formed review', () => {
    const raw = {
      score: 8,
      verdict: 'approve',
      issues: [
        { id: 'iss-1', severity: 'warning', file: 'src/index.ts', line: 10, what: 'Missing null check', fix: 'Add null check' },
      ],
    };
    const result = normalizeCodeReview(raw);

    expect(result.score).toBe(8);
    expect(result.verdict).toBe('approve');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.severity).toBe('warning');
  });

  it('clamps score to 1-10 range', () => {
    expect(normalizeCodeReview({ score: 0 }).score).toBe(1);
    expect(normalizeCodeReview({ score: 15 }).score).toBe(10);
    expect(normalizeCodeReview({ score: -5 }).score).toBe(1);
  });

  it('defaults score to 5 when NaN', () => {
    expect(normalizeCodeReview({ score: 'high' }).score).toBe(5);
    expect(normalizeCodeReview({}).score).toBe(5);
  });

  it('defaults verdict to "fix" for invalid values', () => {
    expect(normalizeCodeReview({ verdict: 'reject' }).verdict).toBe('fix');
    expect(normalizeCodeReview({ verdict: '' }).verdict).toBe('fix');
    expect(normalizeCodeReview({}).verdict).toBe('fix');
  });

  it('accepts "approve" verdict', () => {
    expect(normalizeCodeReview({ verdict: 'approve' }).verdict).toBe('approve');
    expect(normalizeCodeReview({ verdict: 'APPROVE' }).verdict).toBe('approve');
  });

  it('normalizes missing issues to empty array', () => {
    const result = normalizeCodeReview({ score: 7, verdict: 'approve' });
    expect(result.issues).toEqual([]);
  });

  it('handles non-array issues gracefully', () => {
    const result = normalizeCodeReview({ issues: 'some text' });
    expect(result.issues).toEqual([]);
  });

  it('limits issues to max 10', () => {
    const issues = Array.from({ length: 15 }, (_, i) => ({
      id: `iss-${i}`,
      severity: 'warning',
      file: `file${i}.ts`,
      what: `Issue ${i}`,
      fix: `Fix ${i}`,
    }));
    const result = normalizeCodeReview({ issues });
    expect(result.issues.length).toBeLessThanOrEqual(10);
  });

  it('coerces invalid severity to "suggestion"', () => {
    const result = normalizeCodeReview({
      issues: [{ id: '1', severity: 'high', file: 'x.ts', what: 'Test', fix: 'Fix' }],
    });
    expect(result.issues[0]!.severity).toBe('suggestion');
  });

  it('generates fallback issue IDs when missing', () => {
    const result = normalizeCodeReview({
      issues: [{ severity: 'critical', file: 'x.ts', what: 'Bad', fix: 'Fix' }],
    });
    expect(result.issues[0]!.id).toBe('issue-0');
  });

  it('truncates long what and fix fields', () => {
    const longStr = 'x'.repeat(500);
    const result = normalizeCodeReview({
      issues: [{ id: '1', severity: 'warning', file: 'x.ts', what: longStr, fix: longStr }],
    });
    expect(result.issues[0]!.what.length).toBeLessThanOrEqual(100);
    expect(result.issues[0]!.fix.length).toBeLessThanOrEqual(200);
  });

  it('handles null line gracefully', () => {
    const result = normalizeCodeReview({
      issues: [{ id: '1', severity: 'warning', file: 'x.ts', what: 'Test', fix: 'Fix' }],
    });
    expect(result.issues[0]!.line).toBeNull();
  });
});
