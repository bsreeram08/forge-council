import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3 } from '@ai-sdk/provider-v6';
import type { ForgeCouncilConfig, ProviderConfig } from './schema';
import { getCopilotAccessToken, createCopilotFetch } from './copilot';

/**
 * A resolved model instance — compatible with both AI SDK's generateText()
 * and Mastra's Agent constructor. All AI SDK providers return LanguageModelV3
 * which satisfies both MastraModelConfig and LanguageModel.
 */
export type ResolvedModel = LanguageModelV3;

/**
 * Splits a model reference like "anthropic/claude-opus-4-6" into its
 * provider and model ID components.
 */
export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const slashIndex = ref.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(`Invalid model reference "${ref}": expected "provider/modelId" format`);
  }
  return {
    provider: ref.slice(0, slashIndex),
    modelId: ref.slice(slashIndex + 1),
  };
}

/**
 * Resolve a "$VAR" style api key to its environment variable value.
 */
function resolveApiKey(apiKey: string): string {
  if (apiKey.startsWith('$')) {
    const envKey = apiKey.slice(1);
    const value = process.env[envKey];
    if (!value) {
      throw new Error(`Environment variable "${envKey}" is not set (referenced as "${apiKey}")`);
    }
    return value;
  }
  return apiKey;
}

/**
 * Creates the Copilot provider using OAuth token + custom fetch.
 * Falls back to $GITHUB_TOKEN env var if no OAuth token is stored.
 */
function createCopilotModel(
  providerConfig: ProviderConfig,
  modelId: string,
): ResolvedModel {
  // Prefer stored OAuth token from device flow
  const oauthToken = getCopilotAccessToken();

  if (oauthToken) {
    const copilotFetch = createCopilotFetch(oauthToken);
    const compatible = createOpenAICompatible({
      name: 'copilot',
      baseURL: providerConfig.baseUrl || 'https://api.githubcopilot.com',
      // The token is injected via the custom fetch, but the provider still
      // needs a non-empty apiKey to avoid validation errors
      apiKey: 'copilot-oauth',
      fetch: copilotFetch,
      supportsStructuredOutputs: true,
    });
    return compatible.chatModel(modelId);
  }

  // Fallback: use $GITHUB_TOKEN from env/config
  const apiKey = resolveApiKey(providerConfig.apiKey);
  const compatible = createOpenAICompatible({
    name: 'copilot',
    baseURL: providerConfig.baseUrl || 'https://api.githubcopilot.com',
    apiKey,
    fetch: createCopilotFetch(apiKey),
    supportsStructuredOutputs: true,
  });
  return compatible.chatModel(modelId);
}

/**
 * Creates an AI SDK language model instance for the given provider config
 * and model ID. Returns a MastraModelConfig-compatible model.
 */
function createModelInstance(
  providerName: string,
  providerConfig: ProviderConfig,
  modelId: string,
): ResolvedModel {
  // Copilot has its own auth flow
  if (providerName === 'copilot') {
    return createCopilotModel(providerConfig, modelId);
  }

  const apiKey = resolveApiKey(providerConfig.apiKey);

  // OpenRouter needs the compatible adapter with custom headers
  if (providerName === 'openrouter') {
    const compatible = createOpenAICompatible({
      name: 'openrouter',
      baseURL: providerConfig.baseUrl,
      apiKey,
      headers: {
        'HTTP-Referer': 'https://forgecouncil.dev',
        'X-Title': 'ForgeCouncil',
      },
    });
    return compatible.chatModel(modelId);
  }

  switch (providerConfig.api) {
    case 'anthropic-messages': {
      const anthropic = createAnthropic({
        baseURL: providerConfig.baseUrl,
        apiKey,
      });
      return anthropic(modelId);
    }

    case 'openai-chat':
    case 'openai-completions': {
      const openai = createOpenAI({
        baseURL: providerConfig.baseUrl,
        apiKey,
      });
      return openai(modelId);
    }

    default: {
      const compatible = createOpenAICompatible({
        name: providerName,
        baseURL: providerConfig.baseUrl,
        apiKey,
      });
      return compatible.chatModel(modelId);
    }
  }
}

/**
 * Resolves a model reference string (e.g. "anthropic/claude-opus-4-6") to
 * a model instance compatible with Mastra's Agent constructor.
 */
export function resolveModel(
  ref: string,
  config: ForgeCouncilConfig,
): ResolvedModel {
  const { provider, modelId } = parseModelRef(ref);
  const providerConfig = config.models.providers[provider];

  if (!providerConfig) {
    throw new Error(
      `Provider "${provider}" not found in config. Available: ${Object.keys(config.models.providers).join(', ')}`,
    );
  }

  return createModelInstance(provider, providerConfig, modelId);
}

/**
 * Resolves the primary model and fallback models for a given agent.
 * Looks up agent-specific overrides first, then falls back to defaults.
 *
 * Returns the primary model and an array of fallback models.
 */
export function resolveModelWithFallbacks(
  agentId: string,
  config: ForgeCouncilConfig,
): { primary: ResolvedModel; fallbacks: ResolvedModel[] } {
  const agentOverride = config.agents.overrides?.[agentId];
  const defaults = config.agents.defaults;

  // Determine the model ref to use: agent override takes precedence
  const primaryRef = agentOverride?.model?.primary ?? defaults.model.primary;
  const fallbackRefs = agentOverride?.model?.fallbacks ?? defaults.model.fallbacks ?? [];

  const primary = resolveModel(primaryRef, config);
  const fallbacks = fallbackRefs.map((ref) => resolveModel(ref, config));

  return { primary, fallbacks };
}
