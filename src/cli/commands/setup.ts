import * as p from '@clack/prompts';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, chmod } from 'fs/promises';
import { DEFAULT_CONFIG } from '../../config/defaults.ts';
import { loadConfig } from '../../config/loader.ts';
import type { ForgeCouncilConfig } from '../../config/schema.ts';
import { resolveModel } from '../../config/resolver.ts';
import { AGENT_DEFS, AgentRegistry } from '../../council/agent-registry.ts';
import type { AgentDef } from '../../council/agent-registry.ts';
import {
  hasCopilotToken,
  runCopilotDeviceFlow,
  validateCopilotToken,
  getCopilotAccessToken,
  clearCopilotToken,
} from '../../config/copilot.ts';
import { logError } from '../../errors/logger.ts';

// ---------------------------------------------------------------------------
// Provider meta
// ---------------------------------------------------------------------------

interface ProviderMeta {
  envVar: string;
  label: string;
  hint: string;
  description: string;
}

const PROVIDER_META: Record<string, ProviderMeta> = {
  anthropic: {
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Anthropic',
    hint: 'Claude Opus 4.6, Sonnet 4.6, Haiku 4.5',
    description: 'Direct access to Claude models via the Anthropic API',
  },
  openai: {
    envVar: 'OPENAI_API_KEY',
    label: 'OpenAI',
    hint: 'GPT-5.4, GPT-5.2, o3, o4-mini',
    description: 'Direct access to OpenAI models',
  },
  openrouter: {
    envVar: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    hint: 'Claude, GPT, Gemini, DeepSeek & 200+ models',
    description: 'Access 200+ models through a single API gateway',
  },
  copilot: {
    envVar: 'GITHUB_TOKEN',
    label: 'GitHub Copilot',
    hint: 'Claude, GPT-5.x, Gemini — included with subscription',
    description: 'Use models through GitHub Copilot (OAuth login or $GITHUB_TOKEN)',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProviderStatus(
  providerName: string,
  config: ForgeCouncilConfig,
): 'configured' | 'env-found' | 'not-configured' {
  const provider = config.models.providers[providerName];
  if (!provider) return 'not-configured';

  // Copilot: check for OAuth token first, then fall back to env var
  if (providerName === 'copilot') {
    if (hasCopilotToken()) return 'configured';
    if (process.env.GITHUB_TOKEN) return 'env-found';
    return 'not-configured';
  }

  const meta = PROVIDER_META[providerName];
  if (!meta) return 'configured';

  const apiKey = provider.apiKey;
  if (apiKey.startsWith('$')) {
    const envKey = apiKey.slice(1);
    return process.env[envKey] ? 'env-found' : 'not-configured';
  }
  return apiKey.length > 0 ? 'configured' : 'not-configured';
}

function copilotStatusLabel(): string {
  if (hasCopilotToken()) return '[logged in]';
  if (process.env.GITHUB_TOKEN) return '[env token]';
  return '[not logged in]';
}

function statusBadge(status: 'configured' | 'env-found' | 'not-configured'): string {
  switch (status) {
    case 'configured': return '[ready]';
    case 'env-found': return '[ready]';
    case 'not-configured': return '[needs key]';
  }
}

interface ModelOption {
  value: string;
  label: string;
  hint: string;
}

function getGroupedModelOptions(config: ForgeCouncilConfig): ModelOption[] {
  const options: ModelOption[] = [];

  for (const [providerName, provider] of Object.entries(config.models.providers)) {
    const meta = PROVIDER_META[providerName];
    const providerLabel = meta?.label ?? providerName;
    const status = getProviderStatus(providerName, config);
    const ready = status !== 'not-configured';

    for (const model of provider.models) {
      const ref = `${providerName}/${model.id}`;
      const parts: string[] = [];

      // Context window
      const ctxK = model.contextWindow >= 1_000_000
        ? `${(model.contextWindow / 1_000_000).toFixed(0)}M`
        : `${(model.contextWindow / 1000).toFixed(0)}k`;
      parts.push(`${ctxK} ctx`);

      // Cost
      if (model.cost.input === 0 && model.cost.output === 0) {
        parts.push('included');
      } else {
        parts.push(`$${model.cost.input}/$${model.cost.output}`);
      }

      // Reasoning
      if (model.reasoning) parts.push('reasoning');

      // Status
      if (!ready) parts.push('needs key');

      options.push({
        value: ref,
        label: `${providerLabel} > ${model.name}`,
        hint: parts.join(' | '),
      });
    }
  }

  return options;
}

function buildConfigSummary(config: ForgeCouncilConfig): string {
  const lines: string[] = [];

  const providerNames = Object.keys(config.models.providers);
  const readyProviders = providerNames.filter(
    (name) => getProviderStatus(name, config) !== 'not-configured',
  );
  lines.push(`Providers:  ${readyProviders.length}/${providerNames.length} ready (${providerNames.join(', ')})`);

  let modelCount = 0;
  for (const provider of Object.values(config.models.providers)) {
    modelCount += provider.models.length;
  }
  lines.push(`Models:     ${modelCount} available`);

  const registry = new AgentRegistry(config);
  const enabled = registry.listEnabled();
  lines.push(`Agents:     ${enabled.length}/${AGENT_DEFS.length} active`);
  for (const def of AGENT_DEFS) {
    const isActive = enabled.some((e) => e.id === def.id);
    const model = registry.getModelFor(def.id);
    const bullet = isActive ? '+' : '-';
    lines.push(`  ${bullet} ${def.name.padEnd(14)} ${model}`);
  }

  lines.push('');
  lines.push(`Council:    threshold ${config.council.scoreThreshold}/10, ${config.council.maxRounds} rounds`);
  lines.push(`            fresh eyes: ${config.council.freshEyes ? 'on' : 'off'}, anonymized: ${config.council.anonymizeReviews ? 'on' : 'off'}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Provider test
// ---------------------------------------------------------------------------

async function testProvider(providerName: string, config: ForgeCouncilConfig): Promise<boolean> {
  const provider = config.models.providers[providerName];
  if (!provider || provider.models.length === 0) return false;

  const firstModel = provider.models[0]!;
  const modelRef = `${providerName}/${firstModel.id}`;

  const s = p.spinner();
  s.start(`Testing ${modelRef}...`);

  try {
    const model = resolveModel(modelRef, config);
    // Send a minimal request to verify the connection works
    const { generateText } = await import('ai');
    await generateText({
      model,
      prompt: 'Say "ok".',
      maxOutputTokens: 5,
    });
    s.stop(`${providerName} is working.`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Truncate long error messages
    const short = msg.length > 120 ? msg.slice(0, 120) + '...' : msg;
    s.stop(`${providerName} failed: ${short}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Provider manager
// ---------------------------------------------------------------------------

async function addCopilotModel(config: ForgeCouncilConfig): Promise<void> {
  const copilot = config.models.providers.copilot;
  if (!copilot) return;

  const existingIds = new Set(copilot.models.map((m) => m.id));

  const modelId = await p.text({
    message: 'Model ID (e.g. gpt-5.5, claude-opus-5):',
    validate: (v) => {
      if (!v || v.trim().length === 0) return 'Model ID is required';
      if (existingIds.has(v.trim())) return `Model "${v.trim()}" already exists`;
    },
  });
  if (p.isCancel(modelId)) return;

  const displayName = await p.text({
    message: 'Display name:',
    initialValue: `${modelId} (via Copilot)`,
  });
  if (p.isCancel(displayName)) return;

  const reasoning = await p.confirm({
    message: 'Is this a reasoning model?',
    initialValue: false,
  });
  if (p.isCancel(reasoning)) return;

  copilot.models.push({
    id: modelId.trim(),
    name: typeof displayName === 'string' ? displayName : modelId.trim(),
    reasoning: !!reasoning,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  });

  p.log.success(`Added "${modelId.trim()}" to Copilot models.`);

  const shouldTest = await p.confirm({ message: 'Test this model?', initialValue: true });
  if (!p.isCancel(shouldTest) && shouldTest) {
    await testProvider('copilot', config);
  }
}

async function configureCopilotProvider(config: ForgeCouncilConfig): Promise<void> {
  const hasToken = hasCopilotToken();
  const hasEnvToken = !!process.env.GITHUB_TOKEN;

  if (hasToken) {
    p.log.success('Copilot: logged in via OAuth.');

    const modelCount = config.models.providers.copilot?.models.length ?? 0;
    const action = await p.select({
      message: 'Copilot is already configured',
      options: [
        { value: 'test', label: 'Test connection' },
        { value: 'add-model', label: 'Add a model', hint: `${modelCount} models configured` },
        { value: 'reauth', label: 'Re-authenticate', hint: 'Login again with GitHub' },
        { value: 'logout', label: 'Logout', hint: 'Remove stored token' },
        { value: 'back', label: 'Back' },
      ],
    });

    if (p.isCancel(action) || action === 'back') return;

    if (action === 'test') {
      const token = getCopilotAccessToken();
      if (token) {
        const s = p.spinner();
        s.start('Validating Copilot token...');
        const valid = await validateCopilotToken(token);
        s.stop(valid ? 'Copilot token is valid.' : 'Copilot token is invalid. Try re-authenticating.');
      }
      return;
    }

    if (action === 'logout') {
      clearCopilotToken();
      p.log.info('Copilot token removed.');
      return;
    }

    if (action === 'add-model') {
      await addCopilotModel(config);
      return;
    }

    // Fall through to reauth
  }

  const method = await p.select({
    message: 'How would you like to authenticate with GitHub Copilot?',
    options: [
      { value: 'oauth', label: 'Login with GitHub', hint: 'recommended — OAuth device flow' },
      { value: 'token', label: 'Use $GITHUB_TOKEN', hint: hasEnvToken ? 'found in environment' : 'set env var manually' },
      { value: 'back', label: 'Back' },
    ],
  });

  if (p.isCancel(method) || method === 'back') return;

  if (method === 'oauth') {
    const s = p.spinner();
    s.start('Starting GitHub device authorization...');

    try {
      const success = await runCopilotDeviceFlow((verificationUri, userCode) => {
        s.stop('Device code ready.');
        p.note(
          `1. Open: ${verificationUri}\n2. Enter code: ${userCode}\n\nWaiting for authorization...`,
          'GitHub Login',
        );
      });

      if (success) {
        p.log.success('Copilot authentication successful!');

        // Validate the token works
        const token = getCopilotAccessToken();
        if (token) {
          const vs = p.spinner();
          vs.start('Verifying Copilot API access...');
          const valid = await validateCopilotToken(token);
          vs.stop(valid ? 'Copilot API access confirmed.' : 'Token obtained but API validation failed. You may need a Copilot subscription.');
        }
      } else {
        p.log.error('Authorization timed out. Try again.');
      }
    } catch (err) {
      s.stop('Device authorization failed.');
      const msg = err instanceof Error ? err.message : String(err);
      p.log.error(`OAuth error: ${msg}`);
    }
    return;
  }

  // Token method — same as other providers
  if (hasEnvToken) {
    p.log.success('Found $GITHUB_TOKEN in environment.');
    if (config.models.providers.copilot) {
      config.models.providers.copilot.apiKey = '$GITHUB_TOKEN';
    }
  } else {
    const token = await p.password({
      message: 'GitHub token:',
    });
    if (p.isCancel(token)) return;
    if (config.models.providers.copilot) {
      config.models.providers.copilot.apiKey = token;
    }
  }

  // Test
  const shouldTest = await p.confirm({ message: 'Test the connection?', initialValue: true });
  if (!p.isCancel(shouldTest) && shouldTest) {
    await testProvider('copilot', config);
  }

  // Offer to add custom models
  const addMore = await p.confirm({ message: 'Add a custom Copilot model?', initialValue: false });
  if (!p.isCancel(addMore) && addMore) {
    await addCopilotModel(config);
  }
}

async function configureProviderKey(providerName: string, config: ForgeCouncilConfig): Promise<void> {
  // Copilot has its own auth flow
  if (providerName === 'copilot') {
    await configureCopilotProvider(config);
    return;
  }

  const meta = PROVIDER_META[providerName];
  if (!meta) return;

  const existing = process.env[meta.envVar];
  if (existing) {
    p.log.success(`Found $${meta.envVar} in environment.`);
    if (config.models.providers[providerName]) {
      config.models.providers[providerName]!.apiKey = `$${meta.envVar}`;
    }
  } else {
    p.log.info(meta.description);

    const apiKey = await p.password({
      message: `${meta.label} API key:`,
    });

    if (p.isCancel(apiKey)) return;

    if (config.models.providers[providerName]) {
      config.models.providers[providerName]!.apiKey = apiKey;
    }
  }

  // Test the connection
  const shouldTest = await p.confirm({
    message: 'Test the connection?',
    initialValue: true,
  });

  if (!p.isCancel(shouldTest) && shouldTest) {
    await testProvider(providerName, config);
  }
}

async function providerManager(config: ForgeCouncilConfig): Promise<void> {
  while (true) {
    // Include custom providers that aren't in PROVIDER_META
    const allProviders = Object.keys(config.models.providers);
    const customProviders = allProviders.filter((name) => !PROVIDER_META[name]);

    const providerOptions = Object.entries(PROVIDER_META).map(([name, meta]) => {
      const status = getProviderStatus(name, config);
      const modelCount = config.models.providers[name]?.models.length ?? 0;
      const badge = name === 'copilot' ? copilotStatusLabel() : statusBadge(status);
      return {
        value: name,
        label: `${meta.label}  ${badge}`,
        hint: `${meta.hint} | ${modelCount} models`,
      };
    });

    const customOptions = customProviders.map((name) => {
      const provider = config.models.providers[name]!;
      const status = getProviderStatus(name, config);
      return {
        value: name,
        label: `${name}  ${statusBadge(status)}`,
        hint: `${provider.baseUrl} | ${provider.models.length} models`,
      };
    });

    const choice = await p.select({
      message: 'Configure a provider',
      options: [
        ...providerOptions,
        ...customOptions,
        { value: 'custom', label: 'Add custom provider', hint: 'OpenAI or Anthropic compatible' },
        { value: '__back__', label: 'Back' },
      ],
    });

    if (p.isCancel(choice) || choice === '__back__') break;

    if (choice === 'custom') {
      const details = await p.group({
        name: () => p.text({ message: 'Provider name:', placeholder: 'e.g. ollama, together, groq' }),
        api: () => p.select({
          message: 'API type:',
          options: [
            { value: 'openai-chat', label: 'OpenAI Chat', hint: 'Most providers (OpenAI-compatible)' },
            { value: 'anthropic-messages', label: 'Anthropic Messages', hint: 'Anthropic API or compatible proxies' },
            { value: 'openai-completions', label: 'OpenAI Completions', hint: 'Legacy completions API' },
          ],
        }),
        baseUrl: () => p.text({ message: 'Base URL:', placeholder: 'e.g. http://localhost:11434/v1' }),
        apiKey: () => p.password({ message: 'API key (or env var like $MY_KEY):' }),
        modelId: () => p.text({ message: 'Model ID:', placeholder: 'e.g. llama-3.3-70b' }),
      });

      if (p.isCancel(details) || !details.name || !details.baseUrl || !details.apiKey || !details.modelId) continue;
      // p.group can return symbols for individual cancelled fields
      if (typeof details.name !== 'string' || typeof details.baseUrl !== 'string' || typeof details.apiKey !== 'string' || typeof details.modelId !== 'string') continue;

      config.models.providers[details.name] = {
        baseUrl: details.baseUrl,
        apiKey: details.apiKey,
        api: details.api as 'openai-chat' | 'anthropic-messages' | 'openai-completions',
        models: [{
          id: details.modelId,
          name: details.modelId,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4096,
        }],
      };

      // Auto-test custom providers
      const ok = await testProvider(details.name, config);
      if (ok) {
        p.log.success(`Added "${details.name}" with model ${details.modelId}.`);
      } else {
        const keep = await p.confirm({
          message: 'Connection failed. Keep this provider anyway?',
          initialValue: false,
        });
        if (p.isCancel(keep) || !keep) {
          delete config.models.providers[details.name];
          p.log.info(`Removed "${details.name}".`);
        }
      }
      continue;
    }

    // Built-in or existing custom provider
    if (PROVIDER_META[choice]) {
      await configureProviderKey(choice, config);
    } else {
      // Custom provider — offer test or remove
      const action = await p.select({
        message: `${choice}`,
        options: [
          { value: 'test', label: 'Test connection' },
          { value: 'remove', label: 'Remove provider' },
          { value: 'back', label: 'Back' },
        ],
      });
      if (!p.isCancel(action) && action === 'test') {
        await testProvider(choice, config);
      }
      if (!p.isCancel(action) && action === 'remove') {
        delete config.models.providers[choice];
        p.log.success(`Removed "${choice}".`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Agent manager
// ---------------------------------------------------------------------------

function formatAgentCard(def: AgentDef, config: ForgeCouncilConfig): string {
  const override = config.agents.overrides?.[def.id];
  const modelRef = override?.model?.primary ?? config.agents.defaults.model.primary;
  const enabled = def.required || override?.enabled !== false;

  // Find model display name
  const [provName, ...modelParts] = modelRef.split('/');
  const modelId = modelParts.join('/');
  const provider = config.models.providers[provName ?? ''];
  const modelDef = provider?.models.find((m) => m.id === modelId);
  const modelDisplay = modelDef ? `${modelDef.name} (${modelRef})` : modelRef;

  const lines = [
    `Role:        ${def.role}`,
    `Description: ${def.description}`,
    `Model:       ${modelDisplay}`,
    `Status:      ${enabled ? 'Active' : 'Disabled'}${def.required ? ' (required)' : ''}`,
  ];

  if (def.dimensions.length > 0) {
    lines.push('', 'Scoring Dimensions:');
    for (const dim of def.dimensions) {
      const bar = '#'.repeat(Math.round(dim.weight * 20)).padEnd(20, '.');
      lines.push(`  ${dim.name.padEnd(18)} [${bar}] ${(dim.weight * 100).toFixed(0)}%`);
    }
  }

  return lines.join('\n');
}

async function selectModel(
  message: string,
  config: ForgeCouncilConfig,
  currentValue?: string,
): Promise<string | symbol> {
  const options = getGroupedModelOptions(config);
  if (options.length === 0) {
    p.log.warn('No models configured. Configure a provider first.');
    return Symbol.for('clack:cancel');
  }

  return p.select({
    message,
    options: options.map((m) => ({
      ...m,
      hint: m.value === currentValue ? `${m.hint} (current)` : m.hint,
    })),
    initialValue: currentValue,
  });
}

async function selectFallbacks(
  message: string,
  config: ForgeCouncilConfig,
  currentValues: string[],
  primaryModel?: string,
): Promise<string[] | symbol> {
  const options = getGroupedModelOptions(config).filter((model) => model.value !== primaryModel);
  if (options.length === 0) {
    p.log.warn('No fallback models available. Configure providers first.');
    return Symbol.for('clack:cancel');
  }

  const selected = await p.multiselect({
    message,
    options: options.map((model) => ({
      value: model.value,
      label: model.label,
      hint: model.value === primaryModel ? `${model.hint} (primary)` : model.hint,
    })),
    initialValues: currentValues,
    required: false,
  });

  return selected;
}

async function manageAgent(def: AgentDef, config: ForgeCouncilConfig): Promise<void> {
  p.note(formatAgentCard(def, config), def.name);

  const currentModel = config.agents.overrides?.[def.id]?.model?.primary
    ?? config.agents.defaults.model.primary;
  const currentFallbacks = config.agents.overrides?.[def.id]?.model?.fallbacks
    ?? config.agents.defaults.model.fallbacks
    ?? [];
  const isEnabled = def.required || config.agents.overrides?.[def.id]?.enabled !== false;

  const actions: { value: string; label: string; hint?: string }[] = [
    { value: 'model', label: 'Change model', hint: currentModel },
    {
      value: 'fallbacks',
      label: 'Edit fallbacks',
      hint: currentFallbacks.length > 0 ? currentFallbacks.join(' -> ') : '(none)',
    },
  ];
  if (!def.required) {
    actions.push({
      value: 'toggle',
      label: isEnabled ? 'Disable agent' : 'Enable agent',
    });
  }
  actions.push({ value: 'back', label: 'Back' });

  const action = await p.select({ message: `Configure ${def.name}`, options: actions });
  if (p.isCancel(action) || action === 'back') return;

  if (!config.agents.overrides) {
    config.agents.overrides = {};
  }

  if (action === 'model') {
    const model = await selectModel(`Model for ${def.name}:`, config, currentModel);
    if (!p.isCancel(model)) {
      config.agents.overrides[def.id] = {
        ...config.agents.overrides[def.id],
        model: { primary: model },
      };
      p.log.success(`${def.name} -> ${model}`);
    }
  }

  if (action === 'fallbacks') {
    const selected = await selectFallbacks(
      `Fallback models for ${def.name}:`,
      config,
      currentFallbacks,
      currentModel,
    );
    if (!p.isCancel(selected)) {
      config.agents.overrides[def.id] = {
        ...config.agents.overrides[def.id],
        model: {
          primary: config.agents.overrides[def.id]?.model?.primary ?? currentModel,
          fallbacks: selected,
        },
      };
      p.log.success(`${def.name} fallbacks updated (${selected.length}).`);
    }
  }

  if (action === 'toggle') {
    config.agents.overrides[def.id] = {
      ...config.agents.overrides[def.id],
      enabled: !isEnabled,
    };
    p.log.success(`${def.name} ${!isEnabled ? 'enabled' : 'disabled'}.`);
  }
}

async function agentManager(config: ForgeCouncilConfig): Promise<void> {
  while (true) {
    const registry = new AgentRegistry(config);
    const enabled = registry.listEnabled();
    const disabled = registry.listDisabled();

    const agentOptions = AGENT_DEFS.map((def) => {
      const isActive = enabled.some((e) => e.id === def.id);
      const modelRef = registry.getModelFor(def.id);
      const statusIcon = isActive ? '+' : '-';
      return {
        value: def.id,
        label: `${statusIcon} ${def.name} — ${def.role}`,
        hint: modelRef,
      };
    });

    const choice = await p.select({
      message: `Agents (${enabled.length} active, ${disabled.length} disabled)`,
      options: [
        ...agentOptions,
        { value: '__defaults__', label: 'Change default model', hint: config.agents.defaults.model.primary },
        {
          value: '__default_fallbacks__',
          label: 'Edit default fallbacks',
          hint: (config.agents.defaults.model.fallbacks ?? []).length > 0
            ? (config.agents.defaults.model.fallbacks ?? []).join(' -> ')
            : '(none)',
        },
        { value: '__back__', label: 'Back' },
      ],
    });

    if (p.isCancel(choice) || choice === '__back__') break;

    if (choice === '__defaults__') {
      const model = await selectModel(
        'Default model for all agents:',
        config,
        config.agents.defaults.model.primary,
      );
      if (!p.isCancel(model)) {
        config.agents.defaults.model.primary = model;
        p.log.success(`Default model -> ${model}`);
      }
      continue;
    }

    if (choice === '__default_fallbacks__') {
      const selected = await selectFallbacks(
        'Default fallback models:',
        config,
        config.agents.defaults.model.fallbacks ?? [],
        config.agents.defaults.model.primary,
      );
      if (!p.isCancel(selected)) {
        config.agents.defaults.model.fallbacks = selected;
        p.log.success(`Default fallbacks updated (${selected.length}).`);
      }
      continue;
    }

    const def = AGENT_DEFS.find((d) => d.id === choice);
    if (def) {
      await manageAgent(def, config);
    }
  }
}

// ---------------------------------------------------------------------------
// Council settings
// ---------------------------------------------------------------------------

async function setupCouncil(config: ForgeCouncilConfig): Promise<void> {
  const currentSummary = [
    `Score threshold: ${config.council.scoreThreshold}/10`,
    `Max rounds:      ${config.council.maxRounds}`,
    `Stagnation:      delta < ${config.council.stagnationDelta}`,
    `Fresh Eyes:      ${config.council.freshEyes ? 'on' : 'off'}`,
    `Anonymize:       ${config.council.anonymizeReviews ? 'on' : 'off'}`,
  ].join('\n');
  p.note(currentSummary, 'Current Council Settings');

  const settings = await p.group({
    scoreThreshold: () => p.text({
      message: 'Score threshold (1-10):',
      initialValue: String(config.council.scoreThreshold),
      validate: (v) => {
        const n = parseFloat(v ?? '');
        if (isNaN(n) || n < 1 || n > 10) return 'Must be a number between 1 and 10';
      },
    }),
    maxRounds: () => p.text({
      message: 'Max review rounds:',
      initialValue: String(config.council.maxRounds),
      validate: (v) => {
        const n = parseInt(v ?? '');
        if (isNaN(n) || n < 1 || n > 10) return 'Must be 1-10';
      },
    }),
    stagnationDelta: () => p.text({
      message: 'Stagnation delta (stop if improvement < this):',
      initialValue: String(config.council.stagnationDelta),
      validate: (v) => {
        const n = parseFloat(v ?? '');
        if (isNaN(n) || n < 0 || n > 5) return 'Must be 0-5';
      },
    }),
    freshEyes: () => p.confirm({
      message: 'Enable Fresh Eyes validation? (independent review with zero context)',
      initialValue: config.council.freshEyes,
    }),
    anonymize: () => p.confirm({
      message: 'Anonymize reviews between agents? (reduces groupthink)',
      initialValue: config.council.anonymizeReviews,
    }),
  });

  if (p.isCancel(settings)) return;

  if (typeof settings.scoreThreshold === 'string') {
    config.council.scoreThreshold = parseFloat(settings.scoreThreshold);
  }
  if (typeof settings.maxRounds === 'string') {
    config.council.maxRounds = parseInt(settings.maxRounds);
  }
  if (typeof settings.stagnationDelta === 'string') {
    config.council.stagnationDelta = parseFloat(settings.stagnationDelta);
  }
  if (typeof settings.freshEyes === 'boolean') {
    config.council.freshEyes = settings.freshEyes;
  }
  if (typeof settings.anonymize === 'boolean') {
    config.council.anonymizeReviews = settings.anonymize;
  }

  p.log.success('Council settings updated.');
}

// ---------------------------------------------------------------------------
// Save config
// ---------------------------------------------------------------------------

async function saveConfig(config: ForgeCouncilConfig): Promise<void> {
  p.note(buildConfigSummary(config), 'Configuration Summary');

  const saveLocation = await p.select({
    message: 'Where to save?',
    options: [
      { value: 'global', label: 'Global config', hint: '~/.forgecouncil/config.json (recommended)' },
      { value: 'project', label: 'Project config', hint: './.forgecouncil/config.json' },
      { value: 'both', label: 'Both' },
      { value: 'cancel', label: 'Cancel' },
    ],
  });

  if (p.isCancel(saveLocation) || saveLocation === 'cancel') {
    p.log.warn('No changes saved.');
    return;
  }

  const configJson = JSON.stringify(config, null, 2);

  if (saveLocation === 'global' || saveLocation === 'both') {
    const dir = join(homedir(), '.forgecouncil');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = join(dir, 'config.json');
    await Bun.write(filePath, configJson);
    await chmod(filePath, 0o600);
    p.log.success('Saved ~/.forgecouncil/config.json');
  }

  if (saveLocation === 'project' || saveLocation === 'both') {
    const dir = join(process.cwd(), '.forgecouncil');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'config.json');
    await Bun.write(filePath, configJson);
    await chmod(filePath, 0o600);
    p.log.success('Saved ./.forgecouncil/config.json');
  }
}

// ---------------------------------------------------------------------------
// Main setup flow
// ---------------------------------------------------------------------------

export async function setupCommand(): Promise<void> {
  p.intro('ForgeCouncil Setup');

  let config: ForgeCouncilConfig;
  try {
    config = await loadConfig();
    p.log.info('Loaded existing configuration.');
  } catch (e) {
    logError('setup.load-config', e);
    config = structuredClone(DEFAULT_CONFIG);
    p.log.info('Starting with default configuration.');
  }

  p.note(buildConfigSummary(config), 'Current Configuration');

  while (true) {
    const registry = new AgentRegistry(config);
    const enabledCount = registry.listEnabled().length;

    const readyProviders = Object.keys(config.models.providers).filter(
      (name) => getProviderStatus(name, config) !== 'not-configured',
    );

    const section = await p.select({
      message: 'What would you like to configure?',
      options: [
        {
          value: 'providers',
          label: 'Providers',
          hint: `${readyProviders.length}/${Object.keys(config.models.providers).length} ready`,
        },
        {
          value: 'agents',
          label: 'Agents',
          hint: `${enabledCount}/${AGENT_DEFS.length} active | default: ${config.agents.defaults.model.primary}`,
        },
        {
          value: 'council',
          label: 'Council Settings',
          hint: `threshold ${config.council.scoreThreshold}/10, ${config.council.maxRounds} rounds`,
        },
        { value: 'save', label: 'Save & Exit' },
        { value: 'exit', label: 'Exit without saving' },
      ],
    });

    if (p.isCancel(section) || section === 'exit') {
      p.cancel('No changes saved.');
      return;
    }

    switch (section) {
      case 'providers':
        await providerManager(config);
        break;
      case 'agents':
        await agentManager(config);
        break;
      case 'council':
        await setupCouncil(config);
        break;
      case 'save':
        await saveConfig(config);
        p.outro('Setup complete!');
        return;
    }
  }
}
