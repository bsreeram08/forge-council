/**
 * Sub-Agent Spawning — Recursive agent calls for large context processing.
 *
 * Based on the RLM paper's `sub_RLM` concept: an agent can spawn a
 * sub-agent to independently process a chunk of context, then aggregate
 * the results.
 *
 * Safety guards:
 *   - Max recursion depth (configurable, default 3)
 *   - Max total sub-agent calls per top-level invocation (default 10)
 *   - Sub-agents get smaller token budgets
 *   - Depth counter travels with the context handle
 */

import { generateText, tool, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { ContextHandle } from './context-handle.ts';
import { getHandleStore } from './context-handle.ts';
import { RLM_TOOLS } from './rlm-tools.ts';
import { READ_ONLY_TOOLS } from '../agent-tools.ts';
import type { RlmConfig } from '../../config/schema.ts';

// ---------------------------------------------------------------------------
// Sub-agent call tracking
// ---------------------------------------------------------------------------

interface SubAgentTracker {
  totalCalls: number;
  maxCalls: number;
  maxDepth: number;
}

const trackers = new Map<string, SubAgentTracker>();

/** Create a new tracker for a top-level invocation */
export function createSubAgentTracker(
  sessionId: string,
  config?: RlmConfig,
): SubAgentTracker {
  const tracker: SubAgentTracker = {
    totalCalls: 0,
    maxCalls: config?.maxSubAgentCalls ?? 10,
    maxDepth: config?.maxDepth ?? 3,
  };
  trackers.set(sessionId, tracker);
  return tracker;
}

export function getSubAgentTracker(sessionId: string): SubAgentTracker | undefined {
  return trackers.get(sessionId);
}

export function clearSubAgentTracker(sessionId: string): void {
  trackers.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Sub-agent call
// ---------------------------------------------------------------------------

export interface SubAgentCallOptions {
  /** Session ID for tracking */
  sessionId: string;
  /** Model to use for the sub-agent */
  model: LanguageModel;
  /** Task description for the sub-agent */
  task: string;
  /** Context handle to process */
  contextHandle: ContextHandle;
  /** Expected output schema */
  outputSchema: z.ZodType<any>;
  /** Output name for the submit tool */
  outputName: string;
  /** Max tool call steps */
  maxSteps?: number;
  /** Max output tokens */
  maxOutputTokens?: number;
}

export interface SubAgentResult<T = any> {
  success: boolean;
  result?: T;
  error?: string;
  depth: number;
  handleId: string;
}

export async function spawnSubAgent<T>(
  options: SubAgentCallOptions,
): Promise<SubAgentResult<T>> {
  const {
    sessionId, model, task, contextHandle,
    outputSchema, outputName,
    maxSteps = 8, maxOutputTokens = 4000,
  } = options;

  const tracker = trackers.get(sessionId);
  if (!tracker) {
    return { success: false, error: 'No sub-agent tracker found', depth: contextHandle.depth, handleId: contextHandle.id };
  }

  // Safety checks
  if (tracker.totalCalls >= tracker.maxCalls) {
    return {
      success: false,
      error: `Sub-agent call limit reached (${tracker.maxCalls})`,
      depth: contextHandle.depth,
      handleId: contextHandle.id,
    };
  }

  if (contextHandle.depth >= tracker.maxDepth) {
    return {
      success: false,
      error: `Max recursion depth reached (${tracker.maxDepth})`,
      depth: contextHandle.depth,
      handleId: contextHandle.id,
    };
  }

  tracker.totalCalls++;

  try {
    // Build sub-agent prompt
    const systemPrompt = [
      'You are a sub-agent performing focused analysis on a context chunk.',
      'You have access to a context handle — use peekContext, searchContext, and readChunk to examine it.',
      'Work efficiently: search first, read only what you need, then submit your result.',
      `Your context handle ID is: ${contextHandle.id}`,
    ].join('\n');

    const userMessage = [
      '## Task',
      task,
      '',
      '## Context Handle',
      `ID: ${contextHandle.id}`,
      `Type: ${contextHandle.type}`,
      `Tokens: ${contextHandle.metadata.totalTokens.toLocaleString()}`,
      `Files: ${contextHandle.metadata.totalFiles ?? 'N/A'}`,
      `Summary: ${contextHandle.metadata.summary}`,
      contextHandle.metadata.structure ? `\nStructure:\n${contextHandle.metadata.structure}` : '',
    ].join('\n');

    // Sub-agents get RLM tools + basic read tools
    const submitTool = tool({
      description: `Submit your analysis result. Call this ONCE when done.`,
      inputSchema: outputSchema,
    });

    const allTools = {
      ...READ_ONLY_TOOLS,
      ...RLM_TOOLS,
      [outputName]: submitTool,
    };

    const response = await generateText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      tools: allTools,
      maxOutputTokens,
      stopWhen: stepCountIs(maxSteps),
      temperature: 0.2,
    });

    // Extract the submit tool call result
    for (const step of response.steps) {
      for (const tc of step.toolCalls) {
        if (tc.toolName === outputName) {
          return {
            success: true,
            result: tc.input as T,
            depth: contextHandle.depth,
            handleId: contextHandle.id,
          };
        }
      }
    }

    return {
      success: false,
      error: 'Sub-agent did not produce a result',
      depth: contextHandle.depth,
      handleId: contextHandle.id,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
      depth: contextHandle.depth,
      handleId: contextHandle.id,
    };
  }
}

// ---------------------------------------------------------------------------
// spawnSubAgent as an AI SDK tool (for agents to call during generateText)
// ---------------------------------------------------------------------------

export function createSpawnSubAgentTool(
  sessionId: string,
  model: LanguageModel,
) {
  return tool({
    description: [
      'Spawn a sub-agent to independently analyze a chunk of context.',
      'The sub-agent gets its own context window and can use RLM tools.',
      'Use after decomposeContext to process chunks in parallel.',
      'Returns the sub-agent\'s analysis result.',
    ].join(' '),
    inputSchema: z.object({
      handleId: z.string().describe('Context handle ID for the sub-agent to process'),
      task: z.string().describe('Task description — what should the sub-agent analyze?'),
    }),
    execute: async ({ handleId, task }) => {
      const store = getHandleStore();
      const handle = store.getHandle(handleId);
      if (!handle) {
        return { error: `Context handle not found: ${handleId}` };
      }

      // Sub-agents return a simple analysis result
      const result = await spawnSubAgent({
        sessionId,
        model,
        task,
        contextHandle: handle,
        outputSchema: z.object({
          summary: z.string().describe('Summary of findings'),
          relevantFiles: z.array(z.string()).describe('Paths of relevant files found'),
          issues: z.array(z.object({
            file: z.string(),
            description: z.string(),
            severity: z.enum(['critical', 'warning', 'info']),
          })).describe('Issues found'),
        }),
        outputName: 'submitAnalysis',
        maxSteps: 6,
      });

      if (result.success) {
        const data = result.result as Record<string, unknown> | undefined;
        return {
          success: true,
          depth: result.depth,
          ...(data ?? {}),
        };
      }

      return {
        success: false,
        error: result.error,
        depth: result.depth,
      };
    },
  });
}
