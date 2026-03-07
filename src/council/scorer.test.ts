import { describe, expect, test, beforeEach } from 'bun:test';
import { calculateWeightedScore, calculateMeanScore, checkThreshold, buildScoreCard } from './scorer';
import type { AgentReview, ScoreCard, ScoringDimension } from './schemas';

describe('calculateWeightedScore', () => {
  test('calculates weighted average correctly', () => {
    const dimensions: ScoringDimension[] = [
      { name: 'design', score: 8, weight: 0.5, reasoning: '' },
      { name: 'code', score: 6, weight: 0.5, reasoning: '' },
    ];
    expect(calculateWeightedScore(dimensions)).toBe(7);
  });

  test('normalizes weights that do not sum to 1', () => {
    const dimensions: ScoringDimension[] = [
      { name: 'a', score: 10, weight: 30, reasoning: '' },
      { name: 'b', score: 5, weight: 70, reasoning: '' },
    ];
    expect(calculateWeightedScore(dimensions)).toBe(6.5);
  });

  test('falls back to simple average when all weights are 0', () => {
    const dimensions: ScoringDimension[] = [
      { name: 'a', score: 8, weight: 0, reasoning: '' },
      { name: 'b', score: 6, weight: 0, reasoning: '' },
    ];
    expect(calculateWeightedScore(dimensions)).toBe(7);
  });

  test('returns 0 for empty dimensions', () => {
    expect(calculateWeightedScore([])).toBe(0);
  });

  test('handles single dimension', () => {
    const dimensions: ScoringDimension[] = [
      { name: 'a', score: 9, weight: 1, reasoning: '' },
    ];
    expect(calculateWeightedScore(dimensions)).toBe(9);
  });

  test('rounds to 2 decimal places', () => {
    const dimensions: ScoringDimension[] = [
      { name: 'a', score: 7, weight: 1, reasoning: '' },
    ];
    expect(calculateWeightedScore(dimensions)).toBe(7);
  });
});

describe('calculateMeanScore', () => {
  test('calculates mean of multiple reviews', () => {
    const reviews: AgentReview[] = [
      { agentId: 'a', codename: 'A', dimensions: [], weightedScore: 8, verdict: 'approve', summary: '', concerns: [], suggestions: [] },
      { agentId: 'b', codename: 'B', dimensions: [], weightedScore: 6, verdict: 'request-changes', summary: '', concerns: [], suggestions: [] },
      { agentId: 'c', codename: 'C', dimensions: [], weightedScore: 7, verdict: 'approve', summary: '', concerns: [], suggestions: [] },
    ];
    expect(calculateMeanScore(reviews)).toBe(7);
  });

  test('returns 0 for empty reviews', () => {
    expect(calculateMeanScore([])).toBe(0);
  });

  test('handles single review', () => {
    const reviews: AgentReview[] = [
      { agentId: 'a', codename: 'A', dimensions: [], weightedScore: 9.5, verdict: 'approve', summary: '', concerns: [], suggestions: [] },
    ];
    expect(calculateMeanScore(reviews)).toBe(9.5);
  });

  test('rounds to 2 decimal places', () => {
    const reviews: AgentReview[] = [
      { agentId: 'a', codename: 'A', dimensions: [], weightedScore: 8, verdict: 'approve', summary: '', concerns: [], suggestions: [] },
      { agentId: 'b', codename: 'B', dimensions: [], weightedScore: 7, verdict: 'approve', summary: '', concerns: [], suggestions: [] },
    ];
    expect(calculateMeanScore(reviews)).toBe(7.5);
  });
});

describe('checkThreshold', () => {
  test('returns true when mean meets threshold', () => {
    expect(checkThreshold(7.5, 7.5)).toBe(true);
    expect(checkThreshold(8, 7.5)).toBe(true);
  });

  test('returns false when mean is below threshold', () => {
    expect(checkThreshold(7.4, 7.5)).toBe(false);
    expect(checkThreshold(5, 7.5)).toBe(false);
  });
});

describe('buildScoreCard', () => {
  const createReview = (agentId: string, score: number): AgentReview => ({
    agentId,
    codename: agentId,
    dimensions: [
      { name: 'design', score, weight: 0.5, reasoning: '' },
      { name: 'code', score, weight: 0.5, reasoning: '' },
    ],
    weightedScore: score,
    verdict: score >= 7 ? 'approve' : 'request-changes',
    summary: 'Test review',
    concerns: [],
    suggestions: [],
  });

  test('builds score card with passed=true when threshold met', () => {
    const reviews = [
      createReview('spec-agent', 8),
      createReview('planner', 7.5),
    ];
    const card = buildScoreCard(1, reviews, 7.5, []);
    
    expect(card.round).toBe(1);
    expect(card.passed).toBe(true);
    expect(card.mean).toBe(7.75);
    expect(card.stagnated).toBe(false);
    expect(card.agentScores).toEqual({ 'spec-agent': 8, 'planner': 7.5 });
  });

  test('builds score card with passed=false when below threshold', () => {
    const reviews = [
      createReview('designer', 6),
      createReview('researcher', 7),
    ];
    const card = buildScoreCard(1, reviews, 7.5, []);
    
    expect(card.passed).toBe(false);
    expect(card.mean).toBe(6.5);
  });

  test('detects stagnation when improvement is minimal', () => {
    const reviews = [
      createReview('qa', 7.6),
      createReview('security', 7.6),
    ];
    const previousCards: ScoreCard[] = [
      { round: 1, mean: 7.5, agentScores: { qa: 7.5, security: 7.5 }, reviews: [], passed: true, stagnated: false },
    ];
    
    const card = buildScoreCard(2, reviews, 7.5, previousCards);
    expect(card.stagnated).toBe(true);
  });

  test('does not detect stagnation when improvement is significant', () => {
    const reviews = [
      createReview('integrator', 8),
      createReview('docs', 8),
    ];
    const previousCards: ScoreCard[] = [
      { round: 1, mean: 7, agentScores: { integrator: 7, docs: 7 }, reviews: [], passed: false, stagnated: false },
    ];
    
    const card = buildScoreCard(2, reviews, 7.5, previousCards);
    expect(card.stagnated).toBe(false);
  });
});
