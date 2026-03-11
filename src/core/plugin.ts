/**
 * Plugin System — Extensible hook-based plugin architecture.
 *
 * Inspired by Rollup (named hooks), Webpack (apply pattern), and Claude Code
 * (event matching). Plugins can:
 *   - Hook into lifecycle events (phase start/end, tool pre/post, etc.)
 *   - Provide custom skills, tools, and phase handlers
 *   - Transform data flowing through the pipeline
 *
 * Plugin discovery:
 *   - Global: ~/.forgecouncil/plugins/<name>/plugin.ts or manifest.json
 *   - Project: .forgecouncil/plugins/<name>/plugin.ts or manifest.json
 *   - Built-in: registered programmatically
 *
 * Hook execution order:
 *   - Hooks run in registration order (built-in → global → project)
 *   - 'pre' hooks run before the action, can block or transform input
 *   - 'post' hooks run after the action, can transform output
 *   - Async hooks are awaited sequentially by default
 */

import type { IntentClassification, CodeReview, MergedPlan, CodingOutput } from './schemas.ts';
import type { Skill } from './skill.ts';
import type { PhaseConfig, PipelineState, PhaseHandler } from './pipeline.ts';

// ---------------------------------------------------------------------------
// Hook event types — what plugins can react to
// ---------------------------------------------------------------------------

/** Events emitted during the ForgeCouncil lifecycle. */
export type HookEvent =
  // Session lifecycle
  | 'session:start'
  | 'session:end'

  // Pipeline lifecycle
  | 'pipeline:start'
  | 'pipeline:end'

  // Phase lifecycle
  | 'phase:start'
  | 'phase:end'

  // Intent classification
  | 'classify:before'
  | 'classify:after'

  // Plan lifecycle
  | 'plan:before'
  | 'plan:after'
  | 'plan:merge'
  | 'plan:pick'

  // Coding lifecycle
  | 'code:before'
  | 'code:after'
  | 'code:task-start'
  | 'code:task-end'

  // Tool lifecycle (the key hook for validation gates)
  | 'tool:pre'
  | 'tool:post'

  // Review lifecycle
  | 'review:before'
  | 'review:after'
  | 'review:score'

  // Fix lifecycle
  | 'fix:before'
  | 'fix:after'

  // Ship
  | 'ship:before'
  | 'ship:after';

// ---------------------------------------------------------------------------
// Hook data payloads — what each hook receives
// ---------------------------------------------------------------------------

export interface SessionStartData {
  sessionId: string;
  idea: string;
  guidance?: string;
  projectRoot: string;
}

export interface PhaseHookData {
  phase: PhaseConfig;
  state: PipelineState;
  agentIds: string[];
}

export interface ClassifyData {
  idea: string;
  classification: IntentClassification;
}

export interface PlanHookData {
  plan: MergedPlan;
}

export interface ToolHookData {
  /** Which tool is being called */
  toolName: string;
  /** Tool input arguments */
  input: unknown;
  /** Which agent is calling the tool */
  agentId: string;
  /** Tool output (only in tool:post) */
  output?: unknown;
}

export interface CodeTaskHookData {
  taskId: string;
  title: string;
  agentId: string;
  /** Files produced (only in code:task-end) */
  files?: string[];
}

export interface ReviewHookData {
  reviews: CodeReview[];
  codingOutputs: CodingOutput[];
}

export interface ShipHookData {
  state: PipelineState;
}

/** Union of all hook data types */
export type HookData =
  | SessionStartData
  | PhaseHookData
  | ClassifyData
  | PlanHookData
  | ToolHookData
  | CodeTaskHookData
  | ReviewHookData
  | ShipHookData
  | PipelineState
  | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Hook handler — what plugins register
// ---------------------------------------------------------------------------

export interface HookHandler<T = HookData> {
  /** Plugin that registered this hook */
  pluginName: string;
  /** Optional matcher — only fire for matching tool names (regex, for tool:pre/post) */
  matcher?: string | RegExp;
  /** The handler function. Return value semantics depend on hook type. */
  handler: (data: T) => HookResult | Promise<HookResult>;
}

/**
 * Hook result — what a hook handler returns.
 *
 * - For 'pre' hooks: can block the action or transform input
 * - For 'post' hooks: can transform output or inject feedback
 * - For lifecycle hooks: return value is informational
 */
export interface HookResult {
  /** If 'block', the action is prevented. Only for 'pre' hooks. */
  action?: 'continue' | 'block';
  /** Reason for blocking (shown to user/agent) */
  reason?: string;
  /** Transformed data to pass forward (replaces original) */
  transformed?: unknown;
  /** Feedback to inject into the agent's context (e.g. typecheck errors) */
  feedback?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plugin interface — what a plugin provides
// ---------------------------------------------------------------------------

export interface ForgeCouncilPlugin {
  /** Unique plugin identifier */
  name: string;
  /** Semver version */
  version: string;
  /** Human-readable description */
  description?: string;

  /** Plugin metadata */
  meta?: {
    author?: string;
    /** Domains this plugin is relevant to (e.g. ['security', 'testing']) */
    domains?: string[];
    /** Tags for discovery */
    tags?: string[];
  };

  /**
   * Called once when the plugin is loaded. Use to register hooks, skills, etc.
   * This is the Webpack-style apply() pattern.
   */
  setup?: (context: PluginContext) => void | Promise<void>;

  /**
   * Declarative hooks — alternative to imperative setup().
   * Hooks declared here are auto-registered during plugin initialization.
   * For simple plugins that just need hooks, this avoids boilerplate.
   */
  hooks?: Partial<Record<HookEvent, PluginHookFn | PluginHookConfig>>;

  /** Skills this plugin provides */
  skills?: Skill[];

  /** Phase handlers this plugin registers */
  phases?: Record<string, PhaseHandler>;

  /** Called when plugin is unloaded */
  teardown?: () => void | Promise<void>;
}

/** Simple hook function (shorthand) */
export type PluginHookFn = (data: HookData) => HookResult | Promise<HookResult>;

/** Hook with matcher and options */
export interface PluginHookConfig {
  /** Only fire for matching values (e.g. tool names for tool:pre/post) */
  matcher?: string | RegExp;
  /** The handler */
  handler: PluginHookFn;
}

// ---------------------------------------------------------------------------
// Plugin context — what plugins receive during setup()
// ---------------------------------------------------------------------------

export interface PluginContext {
  /** Register a hook handler */
  on(event: HookEvent, handler: PluginHookFn, options?: { matcher?: string | RegExp }): void;
  /** Register a tool:pre hook with a matcher (convenience) */
  onToolPre(matcher: string | RegExp, handler: (data: ToolHookData) => HookResult | Promise<HookResult>): void;
  /** Register a tool:post hook with a matcher (convenience) */
  onToolPost(matcher: string | RegExp, handler: (data: ToolHookData) => HookResult | Promise<HookResult>): void;
  /** Log a message */
  log(message: string, level?: 'info' | 'warn' | 'error'): void;
  /** Get project root path */
  projectRoot: string;
  /** Get plugin config (from forgecouncil config) */
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plugin Registry — singleton that manages all plugins and dispatches hooks
// ---------------------------------------------------------------------------

export class PluginRegistry {
  private plugins = new Map<string, ForgeCouncilPlugin>();
  private hooks = new Map<HookEvent, HookHandler[]>();
  private _projectRoot: string = process.cwd();

  /** Register and initialize a plugin */
  async register(plugin: ForgeCouncilPlugin, config?: Record<string, unknown>): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      console.warn(`Plugin "${plugin.name}" already registered, replacing.`);
      await this.unregister(plugin.name);
    }

    this.plugins.set(plugin.name, plugin);

    // Build context for setup()
    const context = this.createContext(plugin.name, config ?? {});

    // Register declarative hooks
    if (plugin.hooks) {
      for (const [event, hookDef] of Object.entries(plugin.hooks)) {
        const hookEvent = event as HookEvent;
        if (typeof hookDef === 'function') {
          this.addHook(hookEvent, {
            pluginName: plugin.name,
            handler: hookDef,
          });
        } else if (hookDef && typeof hookDef === 'object' && 'handler' in hookDef) {
          this.addHook(hookEvent, {
            pluginName: plugin.name,
            matcher: hookDef.matcher,
            handler: hookDef.handler,
          });
        }
      }
    }

    // Call setup()
    if (plugin.setup) {
      await plugin.setup(context);
    }
  }

  /** Unregister a plugin and call teardown */
  async unregister(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    // Remove all hooks from this plugin
    for (const [event, handlers] of this.hooks) {
      this.hooks.set(event, handlers.filter(h => h.pluginName !== name));
    }

    // Call teardown
    if (plugin.teardown) {
      await plugin.teardown();
    }

    this.plugins.delete(name);
  }

  /** Get a registered plugin by name */
  get(name: string): ForgeCouncilPlugin | undefined {
    return this.plugins.get(name);
  }

  /** Get all registered plugins */
  getAll(): ForgeCouncilPlugin[] {
    return [...this.plugins.values()];
  }

  /** Check if a plugin is registered */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /** Set the project root (used by plugin contexts) */
  setProjectRoot(root: string): void {
    this._projectRoot = root;
  }

  // -------------------------------------------------------------------------
  // Hook dispatch
  // -------------------------------------------------------------------------

  /**
   * Emit a hook event. Runs all matching handlers sequentially.
   *
   * For 'pre' hooks (tool:pre, *:before): if any handler returns { action: 'block' },
   * subsequent handlers are skipped and the block result is returned.
   *
   * For transform hooks (classify:after, review:score): each handler's transformed
   * output becomes the next handler's input.
   *
   * Returns aggregated results from all handlers.
   */
  async emit(event: HookEvent, data: HookData): Promise<HookResult[]> {
    const handlers = this.hooks.get(event) ?? [];
    const results: HookResult[] = [];

    for (const handler of handlers) {
      // Check matcher (for tool hooks)
      if (handler.matcher && 'toolName' in data) {
        const toolData = data as ToolHookData;
        const regex = handler.matcher instanceof RegExp
          ? handler.matcher
          : new RegExp(handler.matcher);
        if (!regex.test(toolData.toolName)) continue;
      }

      try {
        const result = await handler.handler(data);
        results.push(result);

        // Block semantics for pre hooks
        if (result.action === 'block') {
          return results;
        }

        // Transform semantics — pass transformed data to next handler
        if (result.transformed !== undefined) {
          Object.assign(data, result.transformed);
        }
      } catch (error) {
        console.warn(
          `Plugin "${handler.pluginName}" hook "${event}" threw:`,
          error instanceof Error ? error.message : String(error),
        );
        results.push({
          action: 'continue',
          metadata: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }

    return results;
  }

  /**
   * Emit and collect feedback from all handlers.
   * Returns concatenated feedback strings (useful for injecting into agent context).
   */
  async emitAndCollectFeedback(event: HookEvent, data: HookData): Promise<string | undefined> {
    const results = await this.emit(event, data);
    const feedback = results
      .map(r => r.feedback)
      .filter((f): f is string => !!f);
    return feedback.length > 0 ? feedback.join('\n\n') : undefined;
  }

  /**
   * Check if any pre-hook blocks the action.
   * Returns the block reason if blocked, undefined if allowed.
   */
  async emitPreHook(event: HookEvent, data: HookData): Promise<{ blocked: boolean; reason?: string; feedback?: string }> {
    const results = await this.emit(event, data);
    const blocked = results.find(r => r.action === 'block');
    const feedback = results.map(r => r.feedback).filter((f): f is string => !!f).join('\n\n');
    return {
      blocked: !!blocked,
      reason: blocked?.reason,
      feedback: feedback || undefined,
    };
  }

  /** Get count of hooks registered for an event */
  hookCount(event: HookEvent): number {
    return (this.hooks.get(event) ?? []).length;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private addHook(event: HookEvent, handler: HookHandler): void {
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }
    this.hooks.get(event)!.push(handler);
  }

  private createContext(pluginName: string, config: Record<string, unknown>): PluginContext {
    return {
      on: (event, handler, options) => {
        this.addHook(event, {
          pluginName,
          matcher: options?.matcher,
          handler,
        });
      },
      onToolPre: (matcher, handler) => {
        this.addHook('tool:pre', {
          pluginName,
          matcher,
          handler: handler as PluginHookFn,
        });
      },
      onToolPost: (matcher, handler) => {
        this.addHook('tool:post', {
          pluginName,
          matcher,
          handler: handler as PluginHookFn,
        });
      },
      log: (message, level = 'info') => {
        const prefix = `[plugin:${pluginName}]`;
        switch (level) {
          case 'warn': console.warn(prefix, message); break;
          case 'error': console.error(prefix, message); break;
          default: console.log(prefix, message); break;
        }
      },
      projectRoot: this._projectRoot,
      config,
    };
  }
}

// ---------------------------------------------------------------------------
// Global registry singleton
// ---------------------------------------------------------------------------

let globalPluginRegistry: PluginRegistry | undefined;

export function getPluginRegistry(): PluginRegistry {
  if (!globalPluginRegistry) {
    globalPluginRegistry = new PluginRegistry();
  }
  return globalPluginRegistry;
}

/** Reset the global registry (for testing) */
export function resetPluginRegistry(): void {
  globalPluginRegistry = undefined;
}
