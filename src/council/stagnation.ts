import type { ScoreCard } from './schemas';

/**
 * Detects whether scores are oscillating (alternating up-down-up pattern)
 * across 3 or more consecutive rounds.
 *
 * An oscillation is detected when the direction of change alternates
 * for at least 3 consecutive transitions (requiring 4+ data points).
 */
export function detectOscillation(scores: number[]): boolean {
  if (scores.length < 3) return false;

  // Calculate direction changes: +1 = up, -1 = down, 0 = no change
  const directions: number[] = [];
  for (let i = 1; i < scores.length; i++) {
    const diff = scores[i]! - scores[i - 1]!;
    if (diff > 0) directions.push(1);
    else if (diff < 0) directions.push(-1);
    else directions.push(0);
  }

  // Check for alternating pattern across at least 2 direction changes
  // (which means 3 score points showing up-down or down-up)
  let alternatingCount = 0;
  for (let i = 1; i < directions.length; i++) {
    if (
      directions[i] !== 0 &&
      directions[i - 1] !== 0 &&
      directions[i] !== directions[i - 1]
    ) {
      alternatingCount++;
    } else {
      alternatingCount = 0;
    }

    // 2 alternations = 3 direction changes = up-down-up or down-up-down
    if (alternatingCount >= 2) return true;
  }

  return false;
}

/**
 * Detects stagnation in the scoring process.
 *
 * Returns true if:
 * 1. The current score hasn't improved by more than `delta` compared to
 *    the previous round, OR
 * 2. Scores are oscillating (up-down-up pattern across 3+ rounds)
 */
export function detectStagnation(
  currentMean: number,
  previousCards: ScoreCard[],
  delta: number,
): boolean {
  if (previousCards.length === 0) return false;

  // Check insufficient improvement from previous round
  const lastCard = previousCards[previousCards.length - 1]!;
  const improvement = currentMean - lastCard.mean;

  if (improvement <= delta) {
    return true;
  }

  // Check for oscillation across all rounds including current
  const allScores = [...previousCards.map((c) => c.mean), currentMean];
  if (detectOscillation(allScores)) {
    return true;
  }

  return false;
}
