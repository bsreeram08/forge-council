import type { ScoringDimension, AgentReview, ScoreCard } from './schemas';
import { detectStagnation } from './stagnation';
import { AGENT_DEFS } from './agent-registry';

/**
 * Calculates the weighted average score from an array of scoring dimensions.
 * If the weights do not sum to 1.0, they are normalized first.
 * Falls back to simple average if all weights are 0.
 */
export function calculateWeightedScore(dimensions: ScoringDimension[]): number {
  if (dimensions.length === 0) return 0;

  const totalWeight = dimensions.reduce((sum, d) => sum + (d.weight ?? 0), 0);

  // If LLM didn't provide weights, use simple average
  if (totalWeight === 0) {
    const avg = dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length;
    return Math.round(avg * 100) / 100;
  }

  const weightedSum = dimensions.reduce((sum, d) => {
    const normalizedWeight = (d.weight ?? 0) / totalWeight;
    return sum + d.score * normalizedWeight;
  }, 0);

  return Math.round(weightedSum * 100) / 100;
}

/**
 * Apply the agent-defined weights to dimensions from the LLM response.
 * The LLM may not include weights correctly, so we use the authoritative
 * weights from the agent definition.
 */
function applyAgentWeights(review: AgentReview): AgentReview {
  const agentDef = AGENT_DEFS.find((d) => d.id === review.agentId);
  if (!agentDef || agentDef.dimensions.length === 0) return review;

  const updatedDimensions = review.dimensions.map((dim) => {
    const defDim = agentDef.dimensions.find(
      (d) => d.name.toLowerCase() === dim.name.toLowerCase(),
    );
    return { ...dim, weight: defDim?.weight ?? dim.weight ?? 0 };
  });

  const recalculated = calculateWeightedScore(updatedDimensions);

  return {
    ...review,
    dimensions: updatedDimensions,
    weightedScore: recalculated,
  };
}

/**
 * Calculates the mean of all reviews' weighted scores.
 */
export function calculateMeanScore(reviews: AgentReview[]): number {
  if (reviews.length === 0) return 0;

  const total = reviews.reduce((sum, r) => sum + r.weightedScore, 0);
  return Math.round((total / reviews.length) * 100) / 100;
}

/**
 * Returns true if the mean score meets or exceeds the threshold.
 */
export function checkThreshold(mean: number, threshold: number): boolean {
  return mean >= threshold;
}

/**
 * Builds a ScoreCard from a set of reviews, checking threshold and stagnation.
 */
export function buildScoreCard(
  round: number,
  reviews: AgentReview[],
  threshold: number,
  previousCards: ScoreCard[],
): ScoreCard {
  // Apply authoritative agent weights to fix LLM-provided weights
  const correctedReviews = reviews.map(applyAgentWeights);
  const mean = calculateMeanScore(correctedReviews);
  const passed = checkThreshold(mean, threshold);

  const agentScores: Record<string, number> = {};
  for (const review of correctedReviews) {
    agentScores[review.agentId] = review.weightedScore;
  }

  const stagnated = detectStagnation(mean, previousCards, 0.5);

  return {
    round,
    mean,
    agentScores,
    reviews: correctedReviews,
    passed,
    stagnated,
  };
}
