/**
 * Skill System — First-class executable skill definitions.
 *
 * A Skill is a reusable unit of capability that agents reference.
 * Unlike the old string[] approach, skills carry:
 *   - Tool bundles (which tools this skill grants)
 *   - Prompt templates (injected into Layer 1 when active)
 *   - Domain knowledge (reference material for the agent)
 *   - Activation conditions (auto-activate based on intent)
 *
 * Skills are standalone objects. Agents reference them by ID.
 * This enables sharing, composition, and dynamic activation.
 */

import type { IntentClassification } from './schemas.ts';

// ---------------------------------------------------------------------------
// Skill interface
// ---------------------------------------------------------------------------

export interface Skill {
  /** Unique identifier (e.g. 'system-design', 'security-audit') */
  id: string;
  /** Display name */
  name: string;
  /** Short description of what this skill enables */
  description: string;
  /** Domains this skill is relevant to (maps to IntentClassification.domains) */
  domains: string[];
  /** Tool IDs from tool-registry that this skill bundles */
  tools: string[];
  /** Prompt fragment injected into Layer 1 when the skill is active */
  promptTemplate: string;
  /** Domain knowledge text (e.g. OWASP top 10 for security, design patterns for architecture) */
  knowledgeBase?: string;
  /** Auto-activate based on intent classification */
  activationCondition?: (classification: IntentClassification) => boolean;
  /** Priority for prompt budget allocation (higher = more tokens allocated) */
  priority: number;
}

// ---------------------------------------------------------------------------
// Composed skill — merged from multiple skills
// ---------------------------------------------------------------------------

export interface ComposedSkill {
  skillIds: string[];
  tools: string[];
  promptFragment: string;
  knowledgeFragment: string;
}

// ---------------------------------------------------------------------------
// Skill Registry
// ---------------------------------------------------------------------------

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  registerAll(skills: Skill[]): void {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  getAll(): Skill[] {
    return [...this.skills.values()];
  }

  has(id: string): boolean {
    return this.skills.has(id);
  }

  /** Find skills relevant to the detected domains from intent classification */
  getForDomains(domains: string[]): Skill[] {
    const domainSet = new Set(domains);
    return [...this.skills.values()].filter(
      skill => skill.domains.some(d => domainSet.has(d)),
    );
  }

  /** Get skills assigned to an agent by skill IDs */
  getForAgent(skillIds: string[]): Skill[] {
    return skillIds
      .map(id => this.skills.get(id))
      .filter((s): s is Skill => s !== undefined);
  }

  /** Get skills that should auto-activate for a given intent */
  getAutoActivated(classification: IntentClassification): Skill[] {
    return [...this.skills.values()].filter(
      skill => skill.activationCondition?.(classification) === true,
    );
  }

  /** Compose multiple skills into a merged bundle */
  compose(skillIds: string[]): ComposedSkill {
    const resolved = this.getForAgent(skillIds);
    const toolSet = new Set<string>();
    const prompts: string[] = [];
    const knowledge: string[] = [];

    // Sort by priority (higher first)
    resolved.sort((a, b) => b.priority - a.priority);

    for (const skill of resolved) {
      for (const t of skill.tools) toolSet.add(t);
      if (skill.promptTemplate) prompts.push(skill.promptTemplate);
      if (skill.knowledgeBase) knowledge.push(skill.knowledgeBase);
    }

    return {
      skillIds: resolved.map(s => s.id),
      tools: [...toolSet],
      promptFragment: prompts.join('\n\n'),
      knowledgeFragment: knowledge.join('\n\n'),
    };
  }

  /** Resolve skills for an agent: explicit skills + auto-activated by intent */
  resolveForAgent(
    skillIds: string[],
    classification?: IntentClassification,
  ): Skill[] {
    const explicit = this.getForAgent(skillIds);
    const explicitIds = new Set(skillIds);

    if (!classification) return explicit;

    const auto = this.getAutoActivated(classification)
      .filter(s => !explicitIds.has(s.id));

    return [...explicit, ...auto];
  }
}

// ---------------------------------------------------------------------------
// Global registry singleton
// ---------------------------------------------------------------------------

let globalRegistry: SkillRegistry | undefined;

export function getSkillRegistry(): SkillRegistry {
  if (!globalRegistry) {
    globalRegistry = new SkillRegistry();
  }
  return globalRegistry;
}

/** Reset the global registry (for testing) */
export function resetSkillRegistry(): void {
  globalRegistry = undefined;
}
