import { describe, it, expect, beforeEach } from 'bun:test';
import { SkillRegistry, resetSkillRegistry, getSkillRegistry, type Skill } from './skill.ts';
import type { IntentClassification } from './schemas.ts';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill',
    domains: [],
    tools: [],
    promptTemplate: '',
    priority: 5,
    ...overrides,
  };
}

function makeClassification(overrides: Partial<IntentClassification> = {}): IntentClassification {
  return {
    taskType: 'feature',
    domains: ['api'],
    contextNeeded: {
      filePatterns: [],
      gitLogCount: 0,
      gitLogFilter: null,
      includeProjectStructure: false,
      includeDependencies: false,
      externalDocs: [],
    },
    complexity: 'moderate',
    ...overrides,
  };
}

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it('registers and retrieves a skill', () => {
    const skill = makeSkill({ id: 'code-review' });
    registry.register(skill);
    expect(registry.get('code-review')).toEqual(skill);
    expect(registry.has('code-review')).toBe(true);
  });

  it('returns undefined for unknown skill', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('registerAll adds multiple skills', () => {
    const skills = [
      makeSkill({ id: 'a' }),
      makeSkill({ id: 'b' }),
    ];
    registry.registerAll(skills);
    expect(registry.getAll()).toHaveLength(2);
  });

  it('getForDomains returns skills matching any domain', () => {
    registry.register(makeSkill({ id: 'auth', domains: ['auth', 'security'] }));
    registry.register(makeSkill({ id: 'ui', domains: ['ui'] }));
    registry.register(makeSkill({ id: 'none', domains: [] }));

    const results = registry.getForDomains(['auth']);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('auth');
  });

  it('getForAgent resolves by skill IDs', () => {
    registry.register(makeSkill({ id: 'a' }));
    registry.register(makeSkill({ id: 'b' }));
    registry.register(makeSkill({ id: 'c' }));

    const results = registry.getForAgent(['a', 'c', 'nonexistent']);
    expect(results).toHaveLength(2);
    expect(results.map(s => s.id)).toEqual(['a', 'c']);
  });

  it('getAutoActivated calls activation conditions', () => {
    registry.register(makeSkill({
      id: 'security',
      activationCondition: (c) => c.domains.includes('auth'),
    }));
    registry.register(makeSkill({
      id: 'testing',
      activationCondition: (c) => c.taskType === 'bugfix',
    }));
    registry.register(makeSkill({ id: 'no-condition' }));

    const classification = makeClassification({ domains: ['auth'] });
    const results = registry.getAutoActivated(classification);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('security');
  });

  it('compose merges tools and prompts', () => {
    registry.register(makeSkill({
      id: 'a',
      tools: ['read-file', 'search-files'],
      promptTemplate: 'Skill A instructions',
      knowledgeBase: 'Knowledge A',
      priority: 8,
    }));
    registry.register(makeSkill({
      id: 'b',
      tools: ['search-files', 'run-tests'],
      promptTemplate: 'Skill B instructions',
      priority: 5,
    }));

    const composed = registry.compose(['a', 'b']);
    expect(composed.skillIds).toEqual(['a', 'b']);
    expect(composed.tools).toContain('read-file');
    expect(composed.tools).toContain('search-files');
    expect(composed.tools).toContain('run-tests');
    // Deduped
    expect(composed.tools.filter(t => t === 'search-files')).toHaveLength(1);
    expect(composed.promptFragment).toContain('Skill A instructions');
    expect(composed.promptFragment).toContain('Skill B instructions');
    expect(composed.knowledgeFragment).toContain('Knowledge A');
  });

  it('resolveForAgent includes auto-activated skills', () => {
    registry.register(makeSkill({ id: 'explicit' }));
    registry.register(makeSkill({
      id: 'auto-auth',
      activationCondition: (c) => c.domains.includes('security'),
    }));

    const classification = makeClassification({ domains: ['security'] });
    const results = registry.resolveForAgent(['explicit'], classification);
    expect(results).toHaveLength(2);
    expect(results.map(s => s.id)).toContain('explicit');
    expect(results.map(s => s.id)).toContain('auto-auth');
  });

  it('resolveForAgent does not duplicate explicit + auto', () => {
    registry.register(makeSkill({
      id: 'security',
      activationCondition: (c) => c.domains.includes('auth'),
    }));

    const classification = makeClassification({ domains: ['auth'] });
    const results = registry.resolveForAgent(['security'], classification);
    expect(results).toHaveLength(1);
  });
});

describe('getSkillRegistry / resetSkillRegistry', () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  it('returns a singleton', () => {
    const a = getSkillRegistry();
    const b = getSkillRegistry();
    expect(a).toBe(b);
  });

  it('reset creates a new instance', () => {
    const a = getSkillRegistry();
    a.register(makeSkill({ id: 'x' }));
    resetSkillRegistry();
    const b = getSkillRegistry();
    expect(b.has('x')).toBe(false);
  });
});
