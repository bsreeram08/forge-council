import type { Agent } from '@mastra/core/agent';
import type { ForgeCouncilConfig } from '../config/schema';
import { RawAgentReviewSchema, normalizeAgentReview } from './schemas';
import type { AgentReview, PlanOutput, GoalAncestry } from './schemas';
import { logBuffer } from '../server/session.ts';
import { logError } from '../errors/logger.ts';
import { consumeStructuredStream } from '../cli/stream-display.ts';
import { eventBus } from '../server/routes/ws.ts';

/**
 * Simple semaphore for limiting concurrency.
 */
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    while (this.active >= this.max) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/**
 * Builds the structured review prompt sent to each agent.
 */
function buildReviewPrompt(plan: PlanOutput, ancestry: GoalAncestry): string {
  const parts = [
    `## Review Task`,
    ``,
    `You are reviewing a plan for the following idea:`,
    `"${ancestry.idea}"`,
    ``,
    `**Phase:** ${ancestry.phase}`,
    `**Task:** ${ancestry.task}`,
    `**Round:** ${ancestry.round}`,
  ];

  if (ancestry.previousScores) {
    parts.push(
      ``,
      `### Previous Round Feedback`,
      `**Mean Score:** ${ancestry.previousScores.mean}`,
      `**Key Concerns:**`,
      ...ancestry.previousScores.concerns.map((c) => `- ${c}`),
    );
  }

  parts.push(
    ``,
    `### Plan to Review`,
    ``,
    `**Executive Summary:**`,
    plan.executiveSummary,
    ``,
    `**Architecture:**`,
    plan.architecture,
    ``,
    `**Phased Roadmap:**`,
    plan.phasedRoadmap,
    ``,
    `**Tech Stack:**`,
    plan.techStack,
    ``,
    `**Skeleton Code:**`,
    plan.skeletonCode,
    ``,
    `### Instructions`,
    ``,
    `Review this plan according to your expertise. Score each dimension from 1-10.`,
    `Respond with a JSON object containing: weightedScore (number), verdict ("approve"/"request-changes"/"reject"), summary (string), dimensions (array of {name, score, weight, reasoning}), concerns (array of strings), and suggestions (array of strings).`,
    `Be specific and actionable in your feedback.`,
  );

  return parts.join('\n');
}

/**
 * Attempt a single review from one agent. Uses the lenient schema and
 * normalizes the result, injecting agentId/codename from context.
 */
async function attemptAgentReview(
  agent: Agent,
  prompt: string,
): Promise<AgentReview> {
  const streamResult = await agent.stream(prompt, {
    structuredOutput: { schema: RawAgentReviewSchema },
  });

  const raw = await consumeStructuredStream(streamResult, agent.name ?? agent.id ?? 'unknown');

  return normalizeAgentReview(raw as Record<string, unknown>, {
    agentId: agent.id ?? 'unknown',
    codename: agent.name ?? agent.id ?? 'unknown',
  });
}

/**
 * Fans out review requests to all agents in parallel, respecting maxConcurrent
 * from config via a semaphore. Uses Promise.allSettled so one agent's failure
 * doesn't abort all reviews. Each failed agent gets one retry.
 */
export async function runParallelReviews(
  agents: Agent[],
  plan: PlanOutput,
  ancestry: GoalAncestry,
  config: ForgeCouncilConfig,
): Promise<AgentReview[]> {
  const maxConcurrent = config.agents.defaults.maxConcurrent;
  const semaphore = new Semaphore(maxConcurrent);
  const prompt = buildReviewPrompt(plan, ancestry);

  const reviewPromises = agents.map(async (agent) => {
    await semaphore.acquire();
    try {
      const agentId = agent.id ?? 'unknown';
      const agentName = agent.name ?? agentId;

      logBuffer.append('agent', agentId, `${agentName} starting review...`);
      eventBus.publish('agent-progress', { agentId, name: agentName, status: 'working', action: 'starting review...' });

      try {
        const review = await attemptAgentReview(agent, prompt);
        logBuffer.append('agent', agentId, `${agentName} review complete: ${review.weightedScore.toFixed(1)}/10`);
        eventBus.publish('agent-progress', { agentId, name: agentName, status: 'done', score: review.weightedScore, verdict: review.verdict });
        return review;
      } catch (firstErr) {
        // Retry once with a clearer prompt
        const retryMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        logBuffer.append('info', agentId, `${agentName} review failed, retrying... (${retryMsg.slice(0, 100)})`);
        logError('parallel-review.first-attempt', firstErr, { agentId: agent.id, agentName: agent.name });
        eventBus.publish('agent-progress', { agentId, name: agentName, status: 'working', action: 'retrying...' });

        try {
          const review = await attemptAgentReview(agent, prompt);
          logBuffer.append('agent', agentId, `${agentName} review complete on retry: ${review.weightedScore.toFixed(1)}/10`);
          eventBus.publish('agent-progress', { agentId, name: agentName, status: 'done', score: review.weightedScore, verdict: review.verdict });
          return review;
        } catch (retryErr) {
          const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          logBuffer.append('error', agentId, `${agentName} review failed after retry: ${msg.slice(0, 200)}`);
          logError('parallel-review.retry', retryErr, { agentId: agent.id, agentName: agent.name });
          eventBus.publish('agent-progress', { agentId, name: agentName, status: 'failed', error: msg.slice(0, 200) });
          throw retryErr;
        }
      }
    } finally {
      semaphore.release();
    }
  });

  const results = await Promise.allSettled(reviewPromises);

  const reviews: AgentReview[] = [];
  const failures: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const agent = agents[i]!;
    if (result.status === 'fulfilled') {
      reviews.push(result.value);
    } else {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(`${agent.name ?? agent.id}: ${msg.slice(0, 100)}`);
    }
  }

  if (failures.length > 0) {
    logBuffer.append('error', 'council', `${failures.length}/${agents.length} reviews failed: ${failures.join('; ')}`);
  }

  if (reviews.length === 0) {
    throw new Error(`All ${agents.length} agent reviews failed. Failures: ${failures.join('; ')}`);
  }

  logBuffer.append('info', 'council', `${reviews.length}/${agents.length} reviews collected successfully`);
  return reviews;
}
