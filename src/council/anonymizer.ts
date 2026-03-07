import type { AgentReview } from './schemas';

/**
 * An anonymized review strips agentId and codename from the original review.
 */
export type AnonymizedReview = Omit<AgentReview, 'agentId' | 'codename'>;

/**
 * Fisher-Yates shuffle (in-place, returns the same array).
 */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * Strips agentId and codename from reviews, rewrites summaries,
 * and randomizes order using Fisher-Yates shuffle.
 * Scores remain visible but unattributed.
 */
export function anonymizeReviews(reviews: AgentReview[]): AnonymizedReview[] {
  const anonymized: AnonymizedReview[] = reviews.map((review) => {
    const { agentId: _agentId, codename: _codename, ...rest } = review;
    return {
      ...rest,
      summary: `A council member noted: ${rest.summary}`,
    };
  });

  return shuffle(anonymized);
}

/**
 * Collects all unique concerns from all reviews, shuffled to prevent
 * attribution by ordering.
 */
export function anonymizeConcerns(reviews: AgentReview[]): string[] {
  const allConcerns = new Set<string>();

  for (const review of reviews) {
    for (const concern of review.concerns) {
      allConcerns.add(concern);
    }
  }

  return shuffle([...allConcerns]);
}
