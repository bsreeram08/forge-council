/**
 * RLM Module — Public API for Recursive Language Model integration.
 *
 * Provides the `shouldUseRlm` check and `getRlmTools` for the workflow.
 */

export { type ContextHandle, type ContextHandleMetadata, getHandleStore, resetHandleStore } from './context-handle.ts';
export { RLM_TOOLS, peekContextTool, searchContextTool, readChunkTool, decomposeContextTool } from './rlm-tools.ts';
export { spawnSubAgent, createSpawnSubAgentTool, createSubAgentTracker, clearSubAgentTracker, type SubAgentResult } from './sub-agent.ts';

import type { LanguageModel } from 'ai';
import type { AssembledContext } from '../context-assembler.ts';
import type { RlmConfig } from '../../config/schema.ts';
import type { ContextHandle } from './context-handle.ts';
import { getHandleStore } from './context-handle.ts';
import { RLM_TOOLS } from './rlm-tools.ts';
import { createSpawnSubAgentTool, createSubAgentTracker } from './sub-agent.ts';

// ---------------------------------------------------------------------------
// Decision: should we use RLM mode for this context?
// ---------------------------------------------------------------------------

export function shouldUseRlm(
  context: AssembledContext,
  config?: RlmConfig,
): boolean {
  if (config && !config.enabled) return false;
  const threshold = config?.contextThreshold ?? 50_000;
  return context.totalTokens > threshold;
}

// ---------------------------------------------------------------------------
// Create context handle + get RLM tools for an agent
// ---------------------------------------------------------------------------

export interface RlmSetupResult {
  contextHandle: ContextHandle;
  tools: Record<string, any>;
}

export function setupRlm(
  context: AssembledContext,
  sessionId: string,
  model: LanguageModel,
  config?: RlmConfig,
): RlmSetupResult {
  const store = getHandleStore();
  const contextHandle = store.createFromContext(context);

  // Create tracker for sub-agent call limits
  createSubAgentTracker(sessionId, config);

  // Build RLM tool set: exploration + sub-agent spawning
  const tools = {
    ...RLM_TOOLS,
    spawnSubAgent: createSpawnSubAgentTool(sessionId, model),
  };

  return { contextHandle, tools };
}
