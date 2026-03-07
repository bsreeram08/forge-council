import type { Agent } from '@mastra/core/agent';
import {
  CodeReviewSchema,
  RawCodeReviewSchema,
  normalizeCodeReview,
  type CodeReview,
} from '../core/schemas.ts';
import { consumeStructuredStream } from '../cli/stream-display.ts';

/**
 * Builds a prompt for the Fresh Eyes validator.
 * This prompt intentionally excludes all debate context, previous reviews,
 * round information, and scoring history.
 *
 * Fresh Eyes is COUNCIL MODE ONLY — not used in the default flow.
 */
function buildFreshEyesPrompt(codeFiles: string[], idea: string): string {
  return [
    `## Fresh Independent Code Review`,
    ``,
    `You are performing a completely fresh, independent review. You have NO prior context,`,
    `NO knowledge of previous discussions, reviews, or scoring rounds. You are seeing this`,
    `code for the very first time.`,
    ``,
    `Evaluate the code solely on its own merits, as if you are an expert consultant`,
    `brought in to give an unbiased assessment.`,
    ``,
    `### Original Idea`,
    `"${idea}"`,
    ``,
    `### Code Files to Review`,
    ``,
    ...codeFiles.map(f => `- ${f}`),
    ``,
    `### Instructions`,
    ``,
    `This is a fresh independent review with no prior context. Judge the code purely on:`,
    `- Does it solve the stated idea effectively?`,
    `- Is the code correct and well-structured?`,
    `- Are there security, performance, or correctness issues?`,
    ``,
    `Return a JSON object with: score (1-10), verdict ("approve" or "fix"),`,
    `and issues (array of { id, severity, file, line, what, fix }). Max 10 issues.`,
  ].join('\n');
}

/**
 * Runs a Fresh Eyes validation: the agent reviews code with ZERO debate context.
 * No previous reviews, no round information, no scoring history — only the original
 * idea and the code files. Returns a structured CodeReview.
 *
 * This is designed for COUNCIL MODE ONLY — an opt-in deep review step.
 */
export async function runFreshEyes(
  agent: Agent,
  codeFiles: string[],
  idea: string,
): Promise<CodeReview> {
  const prompt = buildFreshEyesPrompt(codeFiles, idea);

  const streamResult = await agent.stream(prompt, {
    structuredOutput: { schema: RawCodeReviewSchema },
  });

  const raw = await consumeStructuredStream(streamResult, `Fresh Eyes (${agent.name})`);

  return normalizeCodeReview(raw as Record<string, unknown>);
}
