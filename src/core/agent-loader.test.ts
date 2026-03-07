import { describe, test, expect } from 'bun:test';
import {
  CustomAgentSchema,
  resolveCustomAgent,
  resolveBuiltinAgent,
  getAgentsForPhase,
  type ResolvedAgent,
} from './agent-loader.ts';
import { PermissionLevel } from '../mastra/tools/tool-registry.ts';
import type { PersonaConfig } from './persona.ts';

// ---------------------------------------------------------------------------
// CustomAgentSchema validation
// ---------------------------------------------------------------------------

describe('CustomAgentSchema', () => {
  test('accepts valid custom agent', () => {
    const result = CustomAgentSchema.parse({
      id: 'my-reviewer',
      codename: 'Eagle',
      displayName: 'Eagle Eye Reviewer',
      systemPrompt: 'You are Eagle, a meticulous code reviewer focused on edge cases.',
      phases: ['review'],
      permission: 'READ_ONLY',
    });
    expect(result.id).toBe('my-reviewer');
    expect(result.phases).toEqual(['review']);
    expect(result.temperature).toBe(0.3);
    expect(result.skills).toEqual([]);
  });

  test('rejects invalid agent ID', () => {
    expect(() => CustomAgentSchema.parse({
      id: 'Invalid Agent',
      codename: 'Test',
      displayName: 'Test',
      systemPrompt: 'test',
    })).toThrow();
  });

  test('applies defaults', () => {
    const result = CustomAgentSchema.parse({
      id: 'test-agent',
      codename: 'Test',
      displayName: 'Test Agent',
      systemPrompt: 'You are a test agent.',
    });
    expect(result.model).toBe('anthropic/claude-sonnet-4-6');
    expect(result.temperature).toBe(0.3);
    expect(result.maxTokens).toBe(2000);
    expect(result.permission).toBe(PermissionLevel.READ_ONLY);
    expect(result.phases).toEqual([]);
    expect(result.tools).toEqual([]);
  });

  test('accepts all fields', () => {
    const result = CustomAgentSchema.parse({
      id: 'full-agent',
      codename: 'Full',
      displayName: 'Full Agent',
      archetype: 'The Perfectionist',
      inspiration: 'Ada Lovelace',
      systemPrompt: 'You are meticulous.',
      skills: ['Testing', 'Code review'],
      behavioralRules: ['Always test edge cases'],
      catchphrases: ['Did you test that?'],
      model: 'anthropic/claude-opus-4-6',
      temperature: 0.1,
      maxTokens: 4000,
      harshness: 0.9,
      phases: ['plan', 'review'],
      permission: 'READ_WRITE',
      scoringDimensions: [
        { name: 'Edge Cases', weight: 0.5, description: 'Covers edge cases' },
        { name: 'Clarity', weight: 0.5, description: 'Code is clear' },
      ],
      tools: ['read-file', 'run-tests'],
    });
    expect(result.skills).toHaveLength(2);
    expect(result.scoringDimensions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// resolveCustomAgent
// ---------------------------------------------------------------------------

describe('resolveCustomAgent', () => {
  test('produces a ResolvedAgent from config', () => {
    const config = CustomAgentSchema.parse({
      id: 'perf-reviewer',
      codename: 'Flame',
      displayName: 'Performance Reviewer',
      systemPrompt: 'You review code for performance issues.',
      phases: ['review'],
      permission: 'READ_ONLY',
      scoringDimensions: [
        { name: 'Performance', weight: 1.0, description: 'Is the code fast?' },
      ],
    });
    const resolved = resolveCustomAgent(config);

    expect(resolved.id).toBe('perf-reviewer');
    expect(resolved.isBuiltin).toBe(false);
    expect(resolved.phases).toEqual(['review']);
    expect(resolved.scoringDimensions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolveBuiltinAgent
// ---------------------------------------------------------------------------

describe('resolveBuiltinAgent', () => {
  test('wraps a PersonaConfig with defaults', () => {
    const persona: PersonaConfig = {
      id: 'reviewer',
      codename: 'Guido',
      displayName: 'Code Reviewer',
      archetype: 'The Readability Guardian',
      inspiration: 'Guido van Rossum',
      systemPrompt: 'You review code.',
      skills: ['Code review'],
      behavioralRules: ['Be honest'],
      catchphrases: ['Readability counts.'],
      model: 'anthropic/claude-sonnet-4-6',
      temperature: 0.2,
      maxTokens: 1000,
      harshness: 0.7,
    };

    const resolved = resolveBuiltinAgent(
      persona,
      ['review'],
      PermissionLevel.READ_ONLY,
      [{ name: 'Readability', weight: 0.5, description: 'Is the code readable?' }],
    );

    expect(resolved.isBuiltin).toBe(true);
    expect(resolved.phases).toEqual(['review']);
    expect(resolved.permission).toBe(PermissionLevel.READ_ONLY);
    expect(resolved.scoringDimensions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getAgentsForPhase
// ---------------------------------------------------------------------------

describe('getAgentsForPhase', () => {
  test('returns agents assigned to a phase', () => {
    const agents = new Map<string, ResolvedAgent>();

    const makeAgent = (id: string, phases: string[]): ResolvedAgent => ({
      id,
      codename: id,
      displayName: id,
      archetype: '',
      inspiration: '',
      systemPrompt: '',
      skills: [],
      behavioralRules: [],
      catchphrases: [],
      model: 'anthropic/claude-sonnet-4-6',
      temperature: 0.3,
      maxTokens: 1000,
      harshness: 0.5,
      phases,
      permission: PermissionLevel.READ_ONLY,
      scoringDimensions: [],
      tools: [],
      isBuiltin: true,
    });

    agents.set('a', makeAgent('a', ['plan', 'review']));
    agents.set('b', makeAgent('b', ['plan']));
    agents.set('c', makeAgent('c', ['review']));
    agents.set('d', makeAgent('d', ['code']));

    const planAgents = getAgentsForPhase(agents, 'plan');
    expect(planAgents.map(a => a.id)).toEqual(['a', 'b']);

    const reviewAgents = getAgentsForPhase(agents, 'review');
    expect(reviewAgents.map(a => a.id)).toEqual(['a', 'c']);

    const codeAgents = getAgentsForPhase(agents, 'code');
    expect(codeAgents.map(a => a.id)).toEqual(['d']);
  });

  test('returns empty for unknown phase', () => {
    const agents = new Map<string, ResolvedAgent>();
    expect(getAgentsForPhase(agents, 'nonexistent')).toEqual([]);
  });
});
