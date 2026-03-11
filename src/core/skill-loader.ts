/**
 * Skill Loader — Load custom skills from config directories.
 *
 * Sources (merged in order, later overrides earlier):
 *   1. Built-in skills (builtin-skills.ts)
 *   2. Global custom skills (~/.forgecouncil/skills/*.json)
 *   3. Project custom skills (.forgecouncil/skills/*.json)
 */

import * as path from 'path';
import * as fs from 'fs';
import { z } from 'zod';
import { SkillRegistry, getSkillRegistry, type Skill } from './skill.ts';
import { BUILTIN_SKILLS, AGENT_SKILL_MAP } from './builtin-skills.ts';

// ---------------------------------------------------------------------------
// Custom skill schema — what users write in JSON config files
// ---------------------------------------------------------------------------

export const CustomSkillSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Skill ID must be lowercase alphanumeric with hyphens'),
  name: z.string(),
  description: z.string(),
  domains: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  promptTemplate: z.string().default(''),
  knowledgeBase: z.string().optional(),
  priority: z.number().min(0).max(10).default(5),
});

export type CustomSkillConfig = z.infer<typeof CustomSkillSchema>;

export const SkillFileSchema = z.union([
  CustomSkillSchema,
  z.array(CustomSkillSchema),
]);

// ---------------------------------------------------------------------------
// Config directories
// ---------------------------------------------------------------------------

const GLOBAL_SKILLS_DIR = path.join(process.env.HOME ?? '~', '.forgecouncil', 'skills');
const PROJECT_SKILLS_DIR = path.join(process.cwd(), '.forgecouncil', 'skills');

// ---------------------------------------------------------------------------
// Loading functions
// ---------------------------------------------------------------------------

export function loadCustomSkillsFromDir(dir: string): CustomSkillConfig[] {
  const skills: CustomSkillConfig[] = [];

  if (!fs.existsSync(dir)) return skills;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const parsed = JSON.parse(content);
      const result = SkillFileSchema.parse(parsed);
      if (Array.isArray(result)) {
        skills.push(...result);
      } else {
        skills.push(result);
      }
    } catch (e) {
      console.warn(`Warning: Failed to load skill config ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return skills;
}

function customSkillToSkill(config: CustomSkillConfig): Skill {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    domains: config.domains,
    tools: config.tools,
    promptTemplate: config.promptTemplate,
    knowledgeBase: config.knowledgeBase,
    priority: config.priority,
  };
}

// ---------------------------------------------------------------------------
// Initialize the global skill registry with all sources
// ---------------------------------------------------------------------------

export function initializeSkillRegistry(): SkillRegistry {
  const registry = getSkillRegistry();

  // 1. Register built-in skills
  registry.registerAll(BUILTIN_SKILLS);

  // 2. Load and register global custom skills (override built-ins)
  const globalCustom = loadCustomSkillsFromDir(GLOBAL_SKILLS_DIR);
  for (const config of globalCustom) {
    registry.register(customSkillToSkill(config));
  }

  // 3. Load and register project custom skills (override global)
  const projectCustom = loadCustomSkillsFromDir(PROJECT_SKILLS_DIR);
  for (const config of projectCustom) {
    registry.register(customSkillToSkill(config));
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Resolve skill IDs for an agent
// ---------------------------------------------------------------------------

/**
 * Get skill IDs for an agent — explicit skillIds from agent config,
 * falling back to the default agent→skill mapping.
 */
export function resolveAgentSkillIds(
  agentId: string,
  explicitSkillIds?: string[],
): string[] {
  if (explicitSkillIds && explicitSkillIds.length > 0) {
    return explicitSkillIds;
  }

  // Strip numeric suffix for lookup (e.g. 'coder-1' → 'coder')
  const baseId = agentId.replace(/-\d+$/, '');
  return AGENT_SKILL_MAP[baseId] ?? ['context-search'];
}
