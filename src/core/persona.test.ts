import { describe, test, expect } from 'bun:test';
import {
  loadPersona,
  getAllPersonas,
  getPersonaIds,
  PLANNING_AGENT_IDS,
  REVIEW_AGENT_IDS,
  CORE_AGENT_IDS,
} from './persona.ts';

describe('loadPersona', () => {
  test('loads executor persona', () => {
    const persona = loadPersona('executor');
    expect(persona.codename).toBe('Ford');
    expect(persona.id).toBe('executor');
    expect(persona.model).toBe('anthropic/claude-opus-4-6');
  });

  test('loads all planning agents', () => {
    for (const id of PLANNING_AGENT_IDS) {
      const persona = loadPersona(id);
      expect(persona.id).toBe(id);
      expect(persona.systemPrompt.length).toBeGreaterThan(0);
      expect(persona.skills.length).toBeGreaterThan(0);
      expect(persona.behavioralRules.length).toBeGreaterThan(0);
    }
  });

  test('loads all review agents', () => {
    for (const id of REVIEW_AGENT_IDS) {
      const persona = loadPersona(id);
      expect(persona.id).toBe(id);
    }
  });

  test('loads coder persona with correct properties', () => {
    const persona = loadPersona('coder');
    expect(persona.codename).toBe('Carmack');
    expect(persona.archetype).toBe('The Craftsman');
    expect(persona.temperature).toBeLessThanOrEqual(0.3);
    expect(persona.maxTokens).toBeGreaterThan(2000);
  });

  test('throws for unknown agent', () => {
    expect(() => loadPersona('nonexistent')).toThrow('Unknown agent');
  });
});

describe('getAllPersonas', () => {
  test('returns all 12 personas', () => {
    const all = getAllPersonas();
    expect(all.length).toBe(12);
  });

  test('includes all expected roles', () => {
    const ids = getPersonaIds();
    expect(ids).toContain('executor');
    expect(ids).toContain('coder');
    expect(ids).toContain('architect');
    expect(ids).toContain('planner');
    expect(ids).toContain('researcher');
    expect(ids).toContain('reviewer');
    expect(ids).toContain('security');
    expect(ids).toContain('qa');
    expect(ids).toContain('integrator');
    expect(ids).toContain('designer');
    expect(ids).toContain('spec-agent');
    expect(ids).toContain('docs');
  });
});

describe('agent group constants', () => {
  test('planning agents are correct', () => {
    expect(PLANNING_AGENT_IDS).toEqual(['architect', 'planner', 'researcher']);
  });

  test('core agents are correct', () => {
    expect(CORE_AGENT_IDS).toEqual(['executor', 'coder']);
  });

  test('review agents are correct', () => {
    expect(REVIEW_AGENT_IDS).toEqual(['reviewer', 'security', 'qa', 'integrator', 'designer']);
  });
});
