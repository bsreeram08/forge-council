import { describe, expect, test } from 'bun:test';
import { detectOscillation, detectStagnation } from './stagnation';
import type { ScoreCard } from './schemas';

describe('detectOscillation', () => {
  test('returns false for less than 3 scores', () => {
    expect(detectOscillation([5])).toBe(false);
    expect(detectOscillation([5, 6])).toBe(false);
  });

  test('returns false for flat scores (no oscillation)', () => {
    expect(detectOscillation([5, 5, 5])).toBe(false);
    expect(detectOscillation([6, 6, 7, 7])).toBe(false);
  });

  test('returns false for monotonic increase', () => {
    expect(detectOscillation([5, 6, 7, 8])).toBe(false);
  });

  test('returns false for monotonic decrease', () => {
    expect(detectOscillation([8, 7, 6, 5])).toBe(false);
  });

  test('detects oscillation with up-down-up-down pattern (4 direction changes)', () => {
    expect(detectOscillation([5, 7, 6, 8])).toBe(true);
  });

  test('detects oscillation with longer pattern', () => {
    expect(detectOscillation([8, 6, 7, 5, 6])).toBe(true);
  });

  test('returns false when direction only changes once', () => {
    expect(detectOscillation([5, 7, 7])).toBe(false);
    expect(detectOscillation([7, 5, 5])).toBe(false);
    expect(detectOscillation([5, 7, 8])).toBe(false);
  });

  test('returns false for short up-down pattern', () => {
    expect(detectOscillation([5, 7, 6])).toBe(false);
    expect(detectOscillation([7, 5, 6])).toBe(false);
  });
});

describe('detectStagnation', () => {
  const createScoreCard = (mean: number, round: number): ScoreCard => ({
    round,
    mean,
    agentScores: {},
    reviews: [],
    passed: mean >= 7.5,
    stagnated: false,
  });

  test('returns false when no previous cards', () => {
    expect(detectStagnation(7, [], 0.5)).toBe(false);
  });

  test('detects stagnation when improvement is below delta', () => {
    const previousCards = [createScoreCard(7.5, 1)];
    expect(detectStagnation(7.6, previousCards, 0.5)).toBe(true); // 0.1 < 0.5
  });

  test('detects stagnation when no improvement', () => {
    const previousCards = [createScoreCard(7.5, 1)];
    expect(detectStagnation(7.5, previousCards, 0.5)).toBe(true);
  });

  test('detects stagnation when score decreases', () => {
    const previousCards = [createScoreCard(7.5, 1)];
    expect(detectStagnation(7.0, previousCards, 0.5)).toBe(true);
  });

  test('does not detect stagnation when improvement exceeds delta', () => {
    const previousCards = [createScoreCard(6.5, 1)];
    expect(detectStagnation(7.5, previousCards, 0.5)).toBe(false); // 1.0 > 0.5
  });

  test('detects oscillation stagnation', () => {
    const previousCards = [
      createScoreCard(6.0, 1),
      createScoreCard(7.0, 2),
    ];
    expect(detectStagnation(6.5, previousCards, 0.5)).toBe(true);
  });

  test('does not detect stagnation with improving trend', () => {
    const previousCards = [
      createScoreCard(6.0, 1),
      createScoreCard(6.5, 2),
    ];
    expect(detectStagnation(7.2, previousCards, 0.5)).toBe(false);
  });

  test('handles multiple previous cards', () => {
    const previousCards = [
      createScoreCard(5.0, 1),
      createScoreCard(5.5, 2),
      createScoreCard(6.0, 3),
    ];
    expect(detectStagnation(6.3, previousCards, 0.5)).toBe(true); // 0.3 < 0.5
  });
});
