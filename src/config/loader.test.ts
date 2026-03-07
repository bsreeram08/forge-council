import { describe, expect, test } from 'bun:test';
import { resolveEnvVars } from './loader.ts';

describe('resolveEnvVars', () => {
  test('resolves nested $ENV values when present', () => {
    process.env.FC_TEST_KEY = 'secret-value';

    const input = {
      models: {
        providers: {
          anthropic: {
            apiKey: '$FC_TEST_KEY',
          },
        },
      },
    };

    const resolved = resolveEnvVars(input);
    expect(resolved.models.providers.anthropic.apiKey).toBe('secret-value');
  });

  test('keeps unresolved references when env var is missing', () => {
    delete process.env.FC_MISSING_KEY;

    const input = {
      models: {
        providers: {
          openai: {
            apiKey: '$FC_MISSING_KEY',
          },
        },
      },
    };

    const resolved = resolveEnvVars(input);
    expect(resolved.models.providers.openai.apiKey).toBe('$FC_MISSING_KEY');
  });
});

