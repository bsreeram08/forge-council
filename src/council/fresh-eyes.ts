import type { Agent } from '@mastra/core/agent';
import { RawAgentReviewSchema, normalizeAgentReview } from './schemas';
import type { AgentReview, PlanOutput } from './schemas';
import { consumeStructuredStream } from '../cli/stream-display.ts';

/**
 * Builds a prompt for the Fresh Eyes validator.
 * This prompt intentionally excludes all debate context, previous reviews,
 * round information, and scoring history.
 */
function buildFreshEyesPrompt(plan: PlanOutput, idea: string): string {
  return [
    `## Fresh Independent Review`,
    ``,
    `You are performing a completely fresh, independent review. You have NO prior context,`,
    `NO knowledge of previous discussions, reviews, or scoring rounds. You are seeing this`,
    `plan for the very first time.`,
    ``,
    `Evaluate the plan solely on its own merits, as if you are an expert consultant`,
    `brought in to give an unbiased assessment.`,
    ``,
    `### Original Idea`,
    `"${idea}"`,
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
    `This is a fresh independent review with no prior context. Judge the plan purely on:`,
    `- Does it solve the stated idea effectively?`,
    `- Is the architecture sound and appropriate?`,
    `- Is the roadmap realistic and well-structured?`,
    `- Is the tech stack well-chosen?`,
    `- Is the skeleton code a solid foundation?`,
    ``,
    `Score each dimension from 1-10. Respond with a JSON object containing: weightedScore (number),`,
    `verdict ("approve"/"request-changes"/"reject"), summary (string), dimensions (array of`,
    `{name, score, weight, reasoning}), concerns (array of strings), and suggestions (array of strings).`,
    `Be honest and thorough — your fresh perspective is the final quality gate.`,
  ].join('\n');
}

/**
 * Runs a Fresh Eyes validation: the agent reviews the plan with ZERO debate context.
 * No previous reviews, no round information, no scoring history — only the original
 * idea and the final plan. Returns an independent review.
 */
export async function runFreshEyes(
  agent: Agent,
  plan: PlanOutput,
  idea: string,
): Promise<AgentReview> {
  const prompt = buildFreshEyesPrompt(plan, idea);

  const streamResult = await agent.stream(prompt, {
    structuredOutput: { schema: RawAgentReviewSchema },
  });

  const raw = await consumeStructuredStream(streamResult, `Fresh Eyes (${agent.name})`);

  return normalizeAgentReview(raw as Record<string, unknown>, {
    agentId: agent.id ?? 'fresh-eyes',
    codename: agent.name ?? 'Fresh Eyes',
  });
}
