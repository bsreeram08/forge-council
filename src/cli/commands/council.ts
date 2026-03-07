import * as p from '@clack/prompts';
import { loadConfig } from '../../config/loader.ts';
import { AGENT_DEFS, AgentRegistry } from '../../council/agent-registry.ts';

export async function councilCommand(): Promise<void> {
  const config = await loadConfig();
  const registry = new AgentRegistry(config);

  const enabled = registry.listEnabled();
  const disabled = registry.listDisabled();

  const lines: string[] = [];

  for (const def of enabled) {
    const chain = registry.getModelChainFor(def.id);
    const dims = def.dimensions.length > 0
      ? def.dimensions.map((d) => `${d.name} (${(d.weight * 100).toFixed(0)}%)`).join(', ')
      : 'N/A (executor)';

    lines.push(`${def.name.padEnd(10)} ${def.role.padEnd(26)} ${chain.primary}`);
    lines.push(`           fallbacks: ${chain.fallbacks.length > 0 ? chain.fallbacks.join(' -> ') : '(none)'}`);
    lines.push(`           ${dims}`);
    lines.push(``);
  }

  if (disabled.length > 0) {
    lines.push(`Disabled: ${disabled.map((d) => d.name).join(', ')}`);
  }

  p.note(lines.join('\n'), `Council Agents (${enabled.length} active)`);
}
