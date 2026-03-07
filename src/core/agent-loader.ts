/**
 * Agent Loader — Unified agent/persona loading from all sources.
 *
 * Sources (merged in order, later overrides earlier):
 *   1. Built-in personas (src/core/persona.ts)
 *   2. Global custom agents (~/.forgecouncil/agents/*.json)
 *   3. Project custom agents (.forgecouncil/agents/*.json)
 *   4. Project agent.md (injected as extra instructions into all agents)
 *
 * Custom agents can:
 *   - Override built-in persona fields (systemPrompt, model, temperature, etc.)
 *   - Define entirely new agents with custom IDs
 *   - Declare which pipeline phases they participate in
 *   - Set their own scoring dimensions for review phases
 */

import * as path from 'path';
import * as fs from 'fs';
import { z } from 'zod';
import type { PersonaConfig } from './persona.ts';
import { PermissionLevel } from '../mastra/tools/tool-registry.ts';

// ---------------------------------------------------------------------------
// Custom agent schema — what users write in JSON config files
// ---------------------------------------------------------------------------

export const ScoringDimensionSchema = z.object({
  name: z.string(),
  weight: z.number().min(0).max(1),
  description: z.string(),
});

export const CustomAgentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Agent ID must be lowercase alphanumeric with hyphens'),
  codename: z.string(),
  displayName: z.string(),
  archetype: z.string().default('Custom Agent'),
  inspiration: z.string().default(''),
  systemPrompt: z.string(),
  skills: z.array(z.string()).default([]),
  behavioralRules: z.array(z.string()).default([]),
  catchphrases: z.array(z.string()).default([]),
  model: z.string().default('anthropic/claude-sonnet-4-6'),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().default(2000),
  harshness: z.number().min(0).max(1).default(0.5),

  // Phase assignment — which pipeline phases this agent participates in
  phases: z.array(z.string()).default([]),

  // Permission level for tool access
  permission: z.nativeEnum(PermissionLevel).default(PermissionLevel.READ_ONLY),

  // Scoring dimensions (for review phases)
  scoringDimensions: z.array(ScoringDimensionSchema).default([]),

  // Tool access — specific tools this agent can use (empty = use permission defaults)
  tools: z.array(z.string()).default([]),
});

export type CustomAgentConfig = z.infer<typeof CustomAgentSchema>;

// ---------------------------------------------------------------------------
// Agent config file schema — a file can contain one or many agents
// ---------------------------------------------------------------------------

export const AgentFileSchema = z.union([
  CustomAgentSchema,
  z.array(CustomAgentSchema),
]);

// ---------------------------------------------------------------------------
// Resolved agent — unified type after merging all sources
// ---------------------------------------------------------------------------

export interface ResolvedAgent extends PersonaConfig {
  /** Pipeline phases this agent participates in */
  phases: string[];
  /** Permission level */
  permission: PermissionLevel;
  /** Scoring dimensions (for review phases) */
  scoringDimensions: Array<{ name: string; weight: number; description: string }>;
  /** Specific tool IDs */
  tools: string[];
  /** Extra instructions from agent.md */
  projectInstructions?: string;
  /** Whether this is a built-in agent or custom */
  isBuiltin: boolean;
}

// ---------------------------------------------------------------------------
// Agent loader
// ---------------------------------------------------------------------------

const GLOBAL_AGENTS_DIR = path.join(process.env.HOME ?? '~', '.forgecouncil', 'agents');
const PROJECT_AGENTS_DIR = path.join(process.cwd(), '.forgecouncil', 'agents');
const PROJECT_AGENT_MD = path.join(process.cwd(), '.forgecouncil', 'agent.md');
const PROJECT_AGENT_MD_ROOT = path.join(process.cwd(), 'agent.md');

export function loadCustomAgentsFromDir(dir: string): CustomAgentConfig[] {
  const agents: CustomAgentConfig[] = [];

  if (!fs.existsSync(dir)) return agents;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const parsed = JSON.parse(content);
      const result = AgentFileSchema.parse(parsed);
      if (Array.isArray(result)) {
        agents.push(...result);
      } else {
        agents.push(result);
      }
    } catch (e) {
      console.warn(`Warning: Failed to load agent config ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return agents;
}

export function loadProjectInstructions(): string | undefined {
  // Check .forgecouncil/agent.md first, then root agent.md
  for (const filepath of [PROJECT_AGENT_MD, PROJECT_AGENT_MD_ROOT]) {
    if (fs.existsSync(filepath)) {
      try {
        return fs.readFileSync(filepath, 'utf-8');
      } catch {
        // Skip unreadable
      }
    }
  }
  return undefined;
}

/**
 * Convert a built-in PersonaConfig into a ResolvedAgent with defaults.
 */
export function resolveBuiltinAgent(
  persona: PersonaConfig,
  defaultPhases: string[],
  defaultPermission: PermissionLevel,
  defaultDimensions: Array<{ name: string; weight: number; description: string }> = [],
): ResolvedAgent {
  return {
    ...persona,
    phases: defaultPhases,
    permission: defaultPermission,
    scoringDimensions: defaultDimensions,
    tools: [],
    isBuiltin: true,
  };
}

/**
 * Convert a CustomAgentConfig into a ResolvedAgent.
 */
export function resolveCustomAgent(config: CustomAgentConfig): ResolvedAgent {
  return {
    id: config.id,
    codename: config.codename,
    displayName: config.displayName,
    archetype: config.archetype,
    inspiration: config.inspiration,
    systemPrompt: config.systemPrompt,
    skills: config.skills,
    behavioralRules: config.behavioralRules,
    catchphrases: config.catchphrases,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    harshness: config.harshness,
    phases: config.phases,
    permission: config.permission,
    scoringDimensions: config.scoringDimensions,
    tools: config.tools,
    isBuiltin: false,
  };
}

/**
 * Load all agents from all sources.
 * Returns a map of agentId -> ResolvedAgent.
 */
export function loadAllAgents(
  builtinAgents: Map<string, ResolvedAgent>,
): Map<string, ResolvedAgent> {
  const agents = new Map(builtinAgents);
  const projectInstructions = loadProjectInstructions();

  // Load global custom agents
  const globalCustom = loadCustomAgentsFromDir(GLOBAL_AGENTS_DIR);
  for (const config of globalCustom) {
    const existing = agents.get(config.id);
    if (existing) {
      // Override specific fields of built-in agent
      agents.set(config.id, mergeAgentOverride(existing, config));
    } else {
      agents.set(config.id, resolveCustomAgent(config));
    }
  }

  // Load project custom agents (override global)
  const projectCustom = loadCustomAgentsFromDir(PROJECT_AGENTS_DIR);
  for (const config of projectCustom) {
    const existing = agents.get(config.id);
    if (existing) {
      agents.set(config.id, mergeAgentOverride(existing, config));
    } else {
      agents.set(config.id, resolveCustomAgent(config));
    }
  }

  // Inject project instructions into all agents
  if (projectInstructions) {
    for (const [id, agent] of agents) {
      agents.set(id, { ...agent, projectInstructions });
    }
  }

  return agents;
}

/**
 * Merge a custom agent config on top of an existing resolved agent.
 * Only overrides fields that are explicitly set (non-default).
 */
function mergeAgentOverride(base: ResolvedAgent, override: CustomAgentConfig): ResolvedAgent {
  return {
    ...base,
    codename: override.codename || base.codename,
    displayName: override.displayName || base.displayName,
    archetype: override.archetype || base.archetype,
    systemPrompt: override.systemPrompt || base.systemPrompt,
    skills: override.skills.length > 0 ? override.skills : base.skills,
    behavioralRules: override.behavioralRules.length > 0 ? override.behavioralRules : base.behavioralRules,
    model: override.model || base.model,
    temperature: override.temperature,
    maxTokens: override.maxTokens,
    harshness: override.harshness,
    phases: override.phases.length > 0 ? override.phases : base.phases,
    permission: override.permission,
    scoringDimensions: override.scoringDimensions.length > 0
      ? override.scoringDimensions
      : base.scoringDimensions,
    tools: override.tools.length > 0 ? override.tools : base.tools,
  };
}

/**
 * Get agents assigned to a specific pipeline phase.
 */
export function getAgentsForPhase(
  agents: Map<string, ResolvedAgent>,
  phaseId: string,
): ResolvedAgent[] {
  return [...agents.values()].filter(a => a.phases.includes(phaseId));
}
