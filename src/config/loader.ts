import { homedir } from 'os';
import { join } from 'path';
import { ForgeCouncilConfigSchema, type ForgeCouncilConfig } from './schema';
import { DEFAULT_CONFIG } from './defaults';
import { logError } from '../errors/logger.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Recursively walks an object and replaces string values starting with "$"
 * with the corresponding process.env value. Returns a new object.
 */
export function resolveEnvVars<T>(obj: T): T {
  if (typeof obj === 'string') {
    if (obj.startsWith('$')) {
      const envKey = obj.slice(1);
      return (process.env[envKey] ?? obj) as T;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvVars(item)) as T;
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result as T;
  }

  return obj;
}

/**
 * Deep merge `source` into `target`. Arrays are replaced, not concatenated.
 * Returns a new object without mutating inputs.
 */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (
      sourceVal !== undefined &&
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== undefined &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal as T[keyof T];
    }
  }

  return result;
}

/**
 * Safely read and parse a JSON config file. Returns undefined if the file
 * does not exist or cannot be parsed.
 */
async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) return undefined;
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    logError('config.read-file', e, { file: filePath });
    return undefined;
  }
}

/**
 * Loads and merges ForgeCouncil configuration from:
 *   1. Built-in defaults
 *   2. Global config: ~/.forgecouncil/config.json
 *   3. Project config: ./.forgecouncil/config.json
 *
 * Provider merge strategy is controlled by `models.mode`:
 *   - 'override': project providers replace global providers entirely
 *   - 'merge': project providers are deep-merged into global providers
 *
 * Agent overrides are always deep-merged.
 * Environment variable references ("$VAR") in apiKey fields are resolved.
 * The final config is validated against the Zod schema.
 */
export async function loadConfig(): Promise<ForgeCouncilConfig> {
  const globalPath = join(homedir(), '.forgecouncil', 'config.json');
  const projectPath = join(process.cwd(), '.forgecouncil', 'config.json');

  const globalRaw = await readJsonFile(globalPath);
  const projectRaw = await readJsonFile(projectPath);

  // Start with defaults
  // Work with the config as a generic record for merging, then validate with Zod
  let config: Record<string, unknown> = structuredClone(DEFAULT_CONFIG) satisfies ForgeCouncilConfig;

  // Merge global config
  if (globalRaw) {
    config = deepMerge(config, globalRaw);
  }

  // Merge project config with mode-aware provider handling
  if (projectRaw) {
    const projectModels = isRecord(projectRaw.models) ? projectRaw.models : undefined;
    const modelsMode = typeof projectModels?.mode === 'string' ? projectModels.mode : undefined;

    if (modelsMode === 'override' && projectModels?.providers) {
      // Replace providers entirely
      const merged = deepMerge(config, projectRaw);
      const mergedModels = isRecord(merged.models) ? merged.models : {};
      mergedModels.providers = projectModels.providers;
      merged.models = mergedModels;
      config = merged;
    } else {
      // Default: deep merge everything including providers
      config = deepMerge(config, projectRaw);
    }
  }

  // Resolve environment variable references
  config = resolveEnvVars(config);

  // Validate schema
  const parsed = ForgeCouncilConfigSchema.parse(config);

  // Validate that agent model refs point to configured providers
  const availableProviders = new Set(Object.keys(parsed.models.providers));

  function validateModelRef(ref: string, context: string): void {
    const slashIndex = ref.indexOf('/');
    if (slashIndex === -1) return;
    const provider = ref.slice(0, slashIndex);
    if (!availableProviders.has(provider)) {
      console.warn(
        `[config] ${context} references provider "${provider}" (from "${ref}") which is not configured. Falling back to defaults.`,
      );
    }
  }

  validateModelRef(parsed.agents.defaults.model.primary, 'agents.defaults.model.primary');
  if (parsed.agents.overrides) {
    for (const [agentId, override] of Object.entries(parsed.agents.overrides)) {
      if (override.model?.primary) {
        validateModelRef(override.model.primary, `agents.overrides.${agentId}.model.primary`);
      }
    }
  }

  return parsed;
}
