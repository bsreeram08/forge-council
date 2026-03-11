/**
 * Plugin Loader — Discovery, validation, and initialization of plugins.
 *
 * Sources (loaded in order, later can override earlier):
 *   1. Built-in plugins (registered programmatically)
 *   2. Global plugins (~/.forgecouncil/plugins/<name>/)
 *   3. Project plugins (.forgecouncil/plugins/<name>/)
 *
 * Each plugin directory can contain:
 *   - plugin.ts / plugin.js — TypeScript/JavaScript plugin (default export)
 *   - manifest.json — Declarative JSON plugin (hooks-only, simpler)
 *
 * JSON manifest format:
 * {
 *   "name": "my-plugin",
 *   "version": "1.0.0",
 *   "description": "What it does",
 *   "hooks": {
 *     "tool:post": {
 *       "matcher": "writeFile|editFile",
 *       "command": "bun run tsc --noEmit"
 *     }
 *   },
 *   "skills": [{ ...skill config }]
 * }
 */

import * as path from 'path';
import * as fs from 'fs';
import { z } from 'zod';
import {
  type ForgeCouncilPlugin,
  type HookEvent,
  type HookData,
  type HookResult,
  type PluginHookConfig,
  getPluginRegistry,
  PluginRegistry,
} from './plugin.ts';
import { getSkillRegistry } from './skill.ts';
import { registerPhaseHandler } from './pipeline.ts';
import { CustomSkillSchema } from './skill-loader.ts';
import type { ForgeCouncilConfig } from '../config/schema.ts';

// ---------------------------------------------------------------------------
// JSON manifest schema — for declarative plugins
// ---------------------------------------------------------------------------

const CommandHookSchema = z.object({
  matcher: z.string().optional(),
  /** Shell command to run. Receives hook data on stdin as JSON. */
  command: z.string(),
  /** Timeout in ms (default 30s) */
  timeout: z.number().default(30_000),
  /** If true, non-zero exit = block action (for pre hooks) */
  blockOnFailure: z.boolean().default(false),
  /** If true, capture stdout as feedback to inject into agent context */
  captureFeedback: z.boolean().default(true),
});

export type CommandHookConfig = z.infer<typeof CommandHookSchema>;

const ManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Plugin name must be lowercase alphanumeric with hyphens'),
  version: z.string().default('0.0.0'),
  description: z.string().optional(),
  meta: z.object({
    author: z.string().optional(),
    domains: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
  /** Whether this plugin is enabled (default true) */
  enabled: z.boolean().default(true),
  /** Hook definitions — event name → command config */
  hooks: z.record(z.string(), CommandHookSchema).optional(),
  /** Skills provided by this plugin */
  skills: z.array(CustomSkillSchema).optional(),
});

export type PluginManifest = z.infer<typeof ManifestSchema>;

// ---------------------------------------------------------------------------
// Config directories
// ---------------------------------------------------------------------------

const GLOBAL_PLUGINS_DIR = path.join(process.env.HOME ?? '~', '.forgecouncil', 'plugins');
const PROJECT_PLUGINS_DIR = path.join(process.cwd(), '.forgecouncil', 'plugins');

// ---------------------------------------------------------------------------
// Plugin discovery
// ---------------------------------------------------------------------------

interface DiscoveredPlugin {
  /** Absolute path to plugin directory or file */
  path: string;
  /** 'ts' for .ts/.js files, 'json' for manifest.json */
  type: 'ts' | 'json';
  /** Source: built-in, global, or project */
  source: 'builtin' | 'global' | 'project';
}

function discoverPluginsInDir(dir: string, source: 'global' | 'project'): DiscoveredPlugin[] {
  const discovered: DiscoveredPlugin[] = [];

  if (!fs.existsSync(dir)) return discovered;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Look for plugin.ts, plugin.js, or manifest.json inside the directory
      const tsPath = path.join(fullPath, 'plugin.ts');
      const jsPath = path.join(fullPath, 'plugin.js');
      const manifestPath = path.join(fullPath, 'manifest.json');

      if (fs.existsSync(tsPath)) {
        discovered.push({ path: tsPath, type: 'ts', source });
      } else if (fs.existsSync(jsPath)) {
        discovered.push({ path: jsPath, type: 'ts', source });
      } else if (fs.existsSync(manifestPath)) {
        discovered.push({ path: manifestPath, type: 'json', source });
      }
    } else if (entry.name === 'manifest.json' || entry.name.endsWith('.json')) {
      // Top-level JSON manifests
      discovered.push({ path: fullPath, type: 'json', source });
    }
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Manifest → Plugin conversion
// ---------------------------------------------------------------------------

function createCommandHookHandler(hookConfig: CommandHookConfig, pluginName: string): PluginHookConfig {
  const handler = async (data: HookData): Promise<HookResult> => {
    try {
      const input = JSON.stringify(data);
      const proc = Bun.spawn(['sh', '-c', hookConfig.command], {
        cwd: process.cwd(),
        stdin: new Blob([input]),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      });

      const timeoutId = setTimeout(() => proc.kill(), hookConfig.timeout);

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timeoutId);

      const output = stdout.trim();
      const errOutput = stderr.trim();

      // Non-zero exit
      if (exitCode !== 0) {
        const errorMsg = errOutput || output || `Command exited with code ${exitCode}`;
        if (hookConfig.blockOnFailure) {
          return { action: 'block', reason: errorMsg };
        }
        return {
          action: 'continue',
          feedback: hookConfig.captureFeedback ? errorMsg : undefined,
        };
      }

      // Success — capture stdout as feedback if configured
      return {
        action: 'continue',
        feedback: hookConfig.captureFeedback && output ? output : undefined,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[plugin:${pluginName}] Command hook failed: ${msg}`);
      return { action: 'continue', metadata: { error: msg } };
    }
  };

  return {
    matcher: hookConfig.matcher ? new RegExp(hookConfig.matcher) : undefined,
    handler,
  };
}

function manifestToPlugin(manifest: PluginManifest): ForgeCouncilPlugin {
  const hooks: ForgeCouncilPlugin['hooks'] = {};

  if (manifest.hooks) {
    for (const [event, hookConfig] of Object.entries(manifest.hooks)) {
      hooks[event as HookEvent] = createCommandHookHandler(hookConfig, manifest.name);
    }
  }

  const skills = manifest.skills?.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    domains: s.domains,
    tools: s.tools,
    promptTemplate: s.promptTemplate,
    knowledgeBase: s.knowledgeBase,
    priority: s.priority,
  }));

  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    meta: manifest.meta,
    hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
    skills,
  };
}

// ---------------------------------------------------------------------------
// Load a single plugin
// ---------------------------------------------------------------------------

async function loadPlugin(discovered: DiscoveredPlugin): Promise<ForgeCouncilPlugin | null> {
  try {
    if (discovered.type === 'json') {
      const content = fs.readFileSync(discovered.path, 'utf-8');
      const parsed = JSON.parse(content);
      const manifest = ManifestSchema.parse(parsed);
      if (!manifest.enabled) return null;
      return manifestToPlugin(manifest);
    } else {
      // TypeScript/JavaScript — dynamic import
      const module = await import(discovered.path);
      const plugin = module.default ?? module;
      if (!plugin.name || !plugin.version) {
        console.warn(`Plugin at ${discovered.path} missing name/version, skipping.`);
        return null;
      }
      return plugin as ForgeCouncilPlugin;
    }
  } catch (error) {
    console.warn(
      `Failed to load plugin from ${discovered.path}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Initialize the plugin system
// ---------------------------------------------------------------------------

export interface PluginInitOptions {
  /** ForgeCouncil config (for plugin-specific settings) */
  config?: ForgeCouncilConfig;
  /** Built-in plugins to register first */
  builtins?: ForgeCouncilPlugin[];
  /** Extra plugin directories to scan */
  extraDirs?: string[];
  /** Project root path */
  projectRoot?: string;
  /** Plugin-specific configs keyed by plugin name */
  pluginConfigs?: Record<string, Record<string, unknown>>;
}

export async function initializePlugins(options: PluginInitOptions = {}): Promise<PluginRegistry> {
  const registry = getPluginRegistry();
  const { builtins = [], extraDirs = [], projectRoot = process.cwd(), pluginConfigs = {} } = options;

  registry.setProjectRoot(projectRoot);

  // 1. Register built-in plugins
  for (const plugin of builtins) {
    await registry.register(plugin, pluginConfigs[plugin.name]);
  }

  // 2. Discover and load global plugins
  const globalPlugins = discoverPluginsInDir(GLOBAL_PLUGINS_DIR, 'global');

  // 3. Discover and load project plugins
  const projectPlugins = discoverPluginsInDir(PROJECT_PLUGINS_DIR, 'project');

  // 4. Discover from extra dirs
  const extraPlugins = extraDirs.flatMap(dir => discoverPluginsInDir(dir, 'project'));

  // 5. Load all discovered plugins
  const allDiscovered = [...globalPlugins, ...projectPlugins, ...extraPlugins];

  for (const discovered of allDiscovered) {
    const plugin = await loadPlugin(discovered);
    if (plugin) {
      // Register skills into the skill registry
      if (plugin.skills) {
        const skillRegistry = getSkillRegistry();
        for (const skill of plugin.skills) {
          skillRegistry.register(skill);
        }
      }

      // Register phase handlers
      if (plugin.phases) {
        for (const [phaseId, handler] of Object.entries(plugin.phases)) {
          registerPhaseHandler(phaseId, handler);
        }
      }

      await registry.register(plugin, pluginConfigs[plugin.name]);
    }
  }

  return registry;
}

// ---------------------------------------------------------------------------
// List available plugins (for CLI display)
// ---------------------------------------------------------------------------

export interface PluginInfo {
  name: string;
  version: string;
  description?: string;
  source: 'builtin' | 'global' | 'project';
  enabled: boolean;
  hookCount: number;
  skillCount: number;
}

export function listAvailablePlugins(): PluginInfo[] {
  const registry = getPluginRegistry();
  return registry.getAll().map(plugin => ({
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    source: 'builtin' as const, // TODO: track source in registry
    enabled: true,
    hookCount: Object.keys(plugin.hooks ?? {}).length,
    skillCount: plugin.skills?.length ?? 0,
  }));
}
