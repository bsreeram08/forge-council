import { describe, test, expect } from 'bun:test';
import { estimateTokens, TokenCounter } from './token-counter.ts';

describe('estimateTokens', () => {
  test('estimates based on character count', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello')).toBe(2); // 5/4 = 1.25 → ceil → 2
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });
});

describe('TokenCounter', () => {
  test('tracks token usage', () => {
    const counter = new TokenCounter();
    counter.record({
      inputTokens: 1000,
      outputTokens: 500,
      modelId: 'claude-opus-4-6',
      phase: 'plan',
      agentId: 'architect',
    });
    expect(counter.totalInput).toBe(1000);
    expect(counter.totalOutput).toBe(500);
    expect(counter.totalTokens).toBe(1500);
  });

  test('calculates cost correctly', () => {
    const counter = new TokenCounter();
    // Opus: $15/1M in, $75/1M out
    counter.record({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      modelId: 'claude-opus-4-6',
      phase: 'plan',
      agentId: 'architect',
    });
    // Cost = 1M * 15/1M + 100K * 75/1M = 15 + 7.5 = 22.5
    expect(counter.estimatedCost).toBe(22.5);
  });

  test('tracks by phase', () => {
    const counter = new TokenCounter();
    counter.record({
      inputTokens: 1000,
      outputTokens: 500,
      modelId: 'claude-sonnet-4-6',
      phase: 'plan',
      agentId: 'architect',
    });
    counter.record({
      inputTokens: 2000,
      outputTokens: 1000,
      modelId: 'claude-sonnet-4-6',
      phase: 'code',
      agentId: 'coder',
    });
    const phases = counter.byPhase();
    expect(Object.keys(phases)).toHaveLength(2);
    expect(phases['plan']!.input).toBe(1000);
    expect(phases['code']!.input).toBe(2000);
  });

  test('produces summary string', () => {
    const counter = new TokenCounter();
    counter.record({
      inputTokens: 5000,
      outputTokens: 2000,
      modelId: 'claude-sonnet-4-6',
      phase: 'plan',
      agentId: 'architect',
    });
    const summary = counter.summary();
    expect(summary).toContain('5,000 in');
    expect(summary).toContain('2,000 out');
    expect(summary).toContain('7,000 tokens');
    expect(summary).toContain('$');
  });

  test('reset clears all entries', () => {
    const counter = new TokenCounter();
    counter.record({
      inputTokens: 1000,
      outputTokens: 500,
      modelId: 'unknown',
      phase: 'test',
      agentId: 'test',
    });
    expect(counter.totalTokens).toBe(1500);
    counter.reset();
    expect(counter.totalTokens).toBe(0);
  });

  test('falls back to sonnet pricing for unknown models', () => {
    const counter = new TokenCounter();
    counter.record({
      inputTokens: 1_000_000,
      outputTokens: 0,
      modelId: 'some-unknown-model',
      phase: 'test',
      agentId: 'test',
    });
    // Sonnet: $3/1M in
    expect(counter.estimatedCost).toBe(3);
  });
});
