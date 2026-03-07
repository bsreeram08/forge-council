import { describe, it, expect, beforeAll } from 'bun:test';
import { registerBuiltinHandlers } from './pipeline-handlers.ts';
import { getPhaseHandler } from './pipeline.ts';

beforeAll(() => {
  registerBuiltinHandlers();
});

describe('pipeline-handlers registration', () => {
  const handlerNames = [
    'classify',
    'plan',
    'merge',
    'pick',
    'code',
    'review',
    'fix',
    'ship',
    'fresh-eyes',
  ];

  for (const name of handlerNames) {
    it(`registers "${name}" handler`, () => {
      const handler = getPhaseHandler(name);
      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });
  }

  it('is idempotent — calling registerBuiltinHandlers() twice does not throw', () => {
    expect(() => registerBuiltinHandlers()).not.toThrow();
  });

  it('unknown handler returns undefined', () => {
    expect(getPhaseHandler('nonexistent')).toBeUndefined();
  });
});
