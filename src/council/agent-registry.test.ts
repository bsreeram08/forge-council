import { describe, expect, test } from 'bun:test';
import { AgentRegistry } from './agent-registry.ts';
import { DEFAULT_CONFIG } from '../config/defaults.ts';
import type { ForgeCouncilConfig } from '../config/schema.ts';

function cloneConfig(): ForgeCouncilConfig {
  return structuredClone(DEFAULT_CONFIG);
}

describe('AgentRegistry model chain resolution', () => {
  test('returns default model chain when no per-agent override fallback exists', () => {
    const config = cloneConfig();
    const registry = new AgentRegistry(config);

    const chain = registry.getModelChainFor('reviewer');

    expect(chain.primary).toBe('anthropic/claude-sonnet-4-6');
    expect(chain.fallbacks).toEqual(config.agents.defaults.model.fallbacks ?? []);
  });

  test('returns per-agent override fallback chain when configured', () => {
    const config = cloneConfig();
    config.agents.overrides = {
      ...config.agents.overrides,
      reviewer: {
        ...config.agents.overrides?.reviewer,
        model: {
          primary: 'openai/gpt-5.2',
          fallbacks: ['openai/o4-mini', 'anthropic/claude-sonnet-4-6'],
        },
      },
    };

    const registry = new AgentRegistry(config);
    const chain = registry.getModelChainFor('reviewer');

    expect(chain.primary).toBe('openai/gpt-5.2');
    expect(chain.fallbacks).toEqual(['openai/o4-mini', 'anthropic/claude-sonnet-4-6']);
  });
});

