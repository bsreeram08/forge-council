import * as p from '@clack/prompts';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, chmod } from 'fs/promises';
import { DEFAULT_CONFIG } from '../../config/defaults.ts';
import { loadConfig } from '../../config/loader.ts';
import type { ForgeCouncilConfig } from '../../config/schema.ts';

interface ConfigPaths {
  globalDir: string;
  globalConfigPath: string;
  projectDir: string;
  projectConfigPath: string;
}

function getConfigPaths(): ConfigPaths {
  const globalDir = join(homedir(), '.forgecouncil');
  const globalConfigPath = join(globalDir, 'config.json');
  const projectDir = join(process.cwd(), '.forgecouncil');
  const projectConfigPath = join(projectDir, 'config.json');

  return {
    globalDir,
    globalConfigPath,
    projectDir,
    projectConfigPath,
  };
}

export async function configInitCommand(): Promise<void> {
  const { globalDir, globalConfigPath, projectDir, projectConfigPath } = getConfigPaths();

  const created: string[] = [];

  // Global config
  const globalFile = Bun.file(globalConfigPath);
  if (!(await globalFile.exists())) {
    await mkdir(globalDir, { recursive: true, mode: 0o700 });
    await Bun.write(globalConfigPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    await chmod(globalConfigPath, 0o600);
    created.push(globalConfigPath);
    p.log.success(`Created global config: ${globalConfigPath}`);
  } else {
    p.log.info(`Global config exists: ${globalConfigPath}`);
  }

  // Project config (minimal)
  const projectFile = Bun.file(projectConfigPath);
  if (!(await projectFile.exists())) {
    const minimalProjectConfig = {
      models: {
        mode: 'merge' as const,
        providers: {},
      },
      council: {
        scoreThreshold: 7.5,
        maxRounds: 3,
      },
    };
    await mkdir(projectDir, { recursive: true });
    await Bun.write(projectConfigPath, JSON.stringify(minimalProjectConfig, null, 2));
    await chmod(projectConfigPath, 0o600);
    created.push(projectConfigPath);
    p.log.success(`Created project config: ${projectConfigPath}`);
  } else {
    p.log.info(`Project config exists: ${projectConfigPath}`);
  }

  if (created.length === 0) {
    p.log.info('All config files already exist.');
  }
}

function redactApiKey(value: string): string {
  if (value.startsWith('$')) return value;
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-2)}`;
}

function toDisplayConfig(config: ForgeCouncilConfig): ForgeCouncilConfig {
  const clone = structuredClone(config);
  for (const provider of Object.values(clone.models.providers)) {
    provider.apiKey = redactApiKey(provider.apiKey);
  }
  return clone;
}

export async function configShowCommand(): Promise<void> {
  const config = await loadConfig();
  const providerEntries = Object.entries(config.models.providers);
  const modelCount = providerEntries.reduce((count, [, provider]) => count + provider.models.length, 0);

  const summary = [
    `Merge mode: ${config.models.mode}`,
    `Providers: ${providerEntries.length}`,
    `Models: ${modelCount}`,
    `Agent defaults: ${config.agents.defaults.model.primary}`,
    `Agent overrides: ${Object.keys(config.agents.overrides ?? {}).length}`,
  ];

  p.note(summary.join('\n'), 'Resolved Config Summary');
  console.log('\nResolved Config (redacted):');
  console.log(JSON.stringify(toDisplayConfig(config), null, 2));
}

export async function configWhereCommand(): Promise<void> {
  const { globalConfigPath, projectConfigPath } = getConfigPaths();
  const globalExists = await Bun.file(globalConfigPath).exists();
  const projectExists = await Bun.file(projectConfigPath).exists();

  const lines = [
    `Global:  ${globalConfigPath} ${globalExists ? '[exists]' : '[missing]'}`,
    `Project: ${projectConfigPath} ${projectExists ? '[exists]' : '[missing]'}`,
    '',
    'Resolution order:',
    '1) Built-in defaults',
    '2) Global config',
    '3) Project config',
  ];

  p.note(lines.join('\n'), 'Config Locations');
}

export async function configCommand(): Promise<void> {
  await configInitCommand();
}
