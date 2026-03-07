import { describe, expect, test } from 'bun:test';
import { anonymizeReviews, anonymizeConcerns } from './anonymizer';
import type { AgentReview } from './schemas';

describe('anonymizeReviews', () => {
  const createReview = (agentId: string, codename: string): AgentReview => ({
    agentId,
    codename,
    dimensions: [],
    weightedScore: 7.5,
    verdict: 'approve',
    summary: `This is ${codename}'s review.`,
    concerns: [`${codename} is concerned about X`, `${codename} noted Y`],
    suggestions: [`${codename} suggests Z`],
  });

  test('strips agentId from reviews', () => {
    const reviews = [createReview('architect', 'Torvalds')];
    const anonymized = anonymizeReviews(reviews);
    
    expect(anonymized[0]).not.toHaveProperty('agentId');
  });

  test('strips codename from reviews', () => {
    const reviews = [createReview('architect', 'Torvalds')];
    const anonymized = anonymizeReviews(reviews);
    
    expect(anonymized[0]).not.toHaveProperty('codename');
  });

  test('preserves other fields', () => {
    const reviews = [createReview('architect', 'Torvalds')];
    const anonymized = anonymizeReviews(reviews);
    
    expect(anonymized[0]).toHaveProperty('weightedScore');
    expect(anonymized[0]).toHaveProperty('verdict');
    expect(anonymized[0]).toHaveProperty('summary');
    expect(anonymized[0]).toHaveProperty('concerns');
    expect(anonymized[0]).toHaveProperty('suggestions');
  });

  test('rewrites summary with anonymous prefix', () => {
    const reviews = [createReview('architect', 'Torvalds')];
    const anonymized = anonymizeReviews(reviews);
    
    expect(anonymized[0]!.summary).toContain('A council member noted:');
  });

  test('preserves length of reviews array', () => {
    const reviews = [
      createReview('a', 'A'),
      createReview('b', 'B'),
      createReview('c', 'C'),
    ];
    const anonymized = anonymizeReviews(reviews);
    
    expect(anonymized.length).toBe(3);
  });

  test('handles empty reviews array', () => {
    const anonymized = anonymizeReviews([]);
    expect(anonymized.length).toBe(0);
  });

  test('handles reviews with no concerns or suggestions', () => {
    const review: AgentReview = {
      agentId: 'test',
      codename: 'Test',
      dimensions: [],
      weightedScore: 5,
      verdict: 'request-changes',
      summary: 'No concerns',
      concerns: [],
      suggestions: [],
    };
    const anonymized = anonymizeReviews([review]);
    
    expect(anonymized[0]!.concerns).toEqual([]);
    expect(anonymized[0]!.suggestions).toEqual([]);
  });
});

describe('anonymizeConcerns', () => {
  test('collects all unique concerns from all reviews', () => {
    const reviews: AgentReview[] = [
      {
        agentId: 'a', codename: 'A', dimensions: [], weightedScore: 7, verdict: 'approve', summary: '',
        concerns: ['concern 1', 'concern 2'],
        suggestions: [],
      },
      {
        agentId: 'b', codename: 'B', dimensions: [], weightedScore: 6, verdict: 'request-changes', summary: '',
        concerns: ['concern 2', 'concern 3'],
        suggestions: [],
      },
    ];
    
    const concerns = anonymizeConcerns(reviews);
    expect(concerns).toContain('concern 1');
    expect(concerns).toContain('concern 2');
    expect(concerns).toContain('concern 3');
  });

  test('handles empty reviews', () => {
    const concerns = anonymizeConcerns([]);
    expect(concerns).toEqual([]);
  });

  test('handles reviews with no concerns', () => {
    const reviews: AgentReview[] = [
      {
        agentId: 'a', codename: 'A', dimensions: [], weightedScore: 8, verdict: 'approve', summary: '',
        concerns: [],
        suggestions: [],
      },
    ];
    
    const concerns = anonymizeConcerns(reviews);
    expect(concerns).toEqual([]);
  });

  test('returns array (shuffled order)', () => {
    const reviews: AgentReview[] = [
      {
        agentId: 'a', codename: 'A', dimensions: [], weightedScore: 7, verdict: 'approve', summary: '',
        concerns: ['a', 'b', 'c'],
        suggestions: [],
      },
    ];
    
    const concerns = anonymizeConcerns(reviews);
    expect(Array.isArray(concerns)).toBe(true);
    expect(concerns.length).toBe(3);
  });
});
