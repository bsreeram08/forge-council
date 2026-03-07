import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { existsSync } from 'fs';
import { join } from 'path';
import net from 'net';

// ============================================================================
// Helper Functions
// ============================================================================

async function runCommand(
  cmd: string[],
  cwd?: string,
  timeout?: number
): Promise<{ stdout: string; stderr: string; exitCode: number; duration: number }> {
  const start = Date.now();
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: cwd ?? process.cwd(),
  });

  // Handle timeout if specified
  if (timeout) {
    setTimeout(() => {
      proc.kill();
    }, timeout);
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const duration = Date.now() - start;

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode, duration };
}

function detectPackageManager(cwd?: string): 'bun' | 'npm' | 'yarn' | 'pnpm' {
  const basePath = cwd ?? process.cwd();

  if (existsSync(join(basePath, 'bun.lockb'))) return 'bun';
  if (existsSync(join(basePath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(basePath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(basePath, 'package-lock.json'))) return 'npm';

  // Default to bun if no lock file found (Bun-first philosophy)
  return 'bun';
}

async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
  const envFile = Bun.file(filePath);
  if (!(await envFile.exists())) {
    return {};
  }

  const content = await envFile.text();
  const vars: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();

    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key) {
      vars[key] = value;
    }
  }

  return vars;
}

async function checkPortAvailable(port: number, host: string = 'localhost'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(true);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port, host);
  });
}

async function getProcessOnPort(port: number): Promise<{ pid: number; name: string; command: string } | undefined> {
  try {
    // Try lsof first (macOS/Linux)
    const { stdout, exitCode } = await runCommand(['lsof', '-i', `:${port}`, '-P', '-n']);
    if (exitCode === 0 && stdout) {
      const lines = stdout.split('\n').filter(l => l.trim());
      // Skip header line
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i]!.split(/\s+/);
        if (parts.length >= 9) {
          const name = parts[0]!;
          const pid = parseInt(parts[1]!, 10);
          const command = parts.slice(8).join(' ');
          return { pid, name, command };
        }
      }
    }
  } catch {
    // lsof not available, try ss (Linux)
    try {
      const { stdout, exitCode } = await runCommand(['ss', '-tlnp']);
      if (exitCode === 0 && stdout) {
        const lines = stdout.split('\n').filter(l => l.includes(`:${port}`));
        for (const line of lines) {
          const match = line.match(/pid=(\d+)/);
          if (match) {
            const pid = parseInt(match[1]!, 10);
            return { pid, name: 'unknown', command: 'unknown' };
          }
        }
      }
    } catch {
      // Neither available
    }
  }

  return undefined;
}

// ============================================================================
// Docker Tool
// ============================================================================

export interface DockerInput {
  action: 'build' | 'run' | 'ps' | 'logs' | 'stop' | 'compose-up' | 'compose-down';
  args?: string[];
  service?: string;
  image?: string;
  container?: string;
  command?: string;
  ports?: string[];
  env?: Record<string, string>;
  volumes?: string[];
  file?: string;
  cwd?: string;
}

export interface DockerResult {
  output: string;
  exitCode: number;
  containerId?: string;
}

export async function dockerExecute(input: DockerInput): Promise<DockerResult> {
  const { action, args = [], cwd } = input;

  let cmd: string[];

  switch (action) {
    case 'build': {
      cmd = ['docker', 'build', ...args];
      if (input.file) {
        cmd.push('-f', input.file);
      }
      if (input.image) {
        cmd.push('-t', input.image);
      }
      cmd.push('.');
      break;
    }

    case 'run': {
      cmd = ['docker', 'run', ...args];
      if (input.ports) {
        for (const port of input.ports) {
          cmd.push('-p', port);
        }
      }
      if (input.env) {
        for (const [key, value] of Object.entries(input.env)) {
          cmd.push('-e', `${key}=${value}`);
        }
      }
      if (input.volumes) {
        for (const volume of input.volumes) {
          cmd.push('-v', volume);
        }
      }
      if (input.image) {
        cmd.push(input.image);
      }
      if (input.command) {
        cmd.push(...input.command.split(' '));
      }
      break;
    }

    case 'ps': {
      cmd = ['docker', 'ps', ...args];
      break;
    }

    case 'logs': {
      cmd = ['docker', 'logs', ...args];
      if (input.container) {
        cmd.push(input.container);
      }
      break;
    }

    case 'stop': {
      cmd = ['docker', 'stop', ...args];
      if (input.container) {
        cmd.push(input.container);
      }
      break;
    }

    case 'compose-up': {
      cmd = ['docker', 'compose', 'up', '-d', ...args];
      if (input.service) {
        cmd.push(input.service);
      }
      if (input.file) {
        cmd.push('-f', input.file);
      }
      break;
    }

    case 'compose-down': {
      cmd = ['docker', 'compose', 'down', ...args];
      if (input.file) {
        cmd.push('-f', input.file);
      }
      break;
    }

    default:
      throw new Error(`Unknown docker action: ${action}`);
  }

  const result = await runCommand(cmd, cwd);

  // Extract container ID from docker run output (first 12 chars of container ID)
  let containerId: string | undefined;
  if (action === 'run' && result.exitCode === 0 && result.stdout) {
    const match = result.stdout.match(/^([a-f0-9]{12,64})/);
    if (match) {
      containerId = match[1]!.slice(0, 12);
    }
  }

  return {
    output: result.exitCode === 0 ? result.stdout : result.stderr,
    exitCode: result.exitCode,
    containerId,
  };
}

// ============================================================================
// Environment Manager Tool
// ============================================================================

export interface EnvManagerInput {
  action: 'list' | 'validate' | 'check-missing';
  envFile?: string;
  required?: string[];
  cwd?: string;
}

export interface EnvManagerResult {
  variables?: Record<string, string>;
  missing?: string[];
  valid?: boolean;
  errors?: string[];
}

export async function envManagerExecute(input: EnvManagerInput): Promise<EnvManagerResult> {
  const { action, envFile = '.env', required = [], cwd } = input;
  const filePath = cwd ? join(cwd, envFile) : envFile;

  const vars = await parseEnvFile(filePath);

  switch (action) {
    case 'list': {
      // Don't expose sensitive values in output, mask them
      const masked: Record<string, string> = {};
      for (const [key, value] of Object.entries(vars)) {
        // Mask potential secrets (keys containing PASSWORD, SECRET, TOKEN, KEY)
        if (/password|secret|token|key|api/i.test(key)) {
          masked[key] = value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : '****';
        } else {
          masked[key] = value;
        }
      }
      return { variables: masked };
    }

    case 'validate': {
      const errors: string[] = [];
      for (const key of required) {
        if (!vars[key] || vars[key].trim() === '') {
          errors.push(`Missing or empty required variable: ${key}`);
        }
      }
      return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
        variables: vars,
      };
    }

    case 'check-missing': {
      const missing: string[] = [];
      for (const key of required) {
        if (!vars[key]) {
          missing.push(key);
        }
      }
      return {
        missing,
        valid: missing.length === 0,
      };
    }

    default:
      throw new Error(`Unknown env-manager action: ${action}`);
  }
}

// ============================================================================
// Package Manager Tool
// ============================================================================

export interface PackageManagerInput {
  action: 'install' | 'add' | 'remove' | 'list' | 'outdated';
  packages?: string[];
  dev?: boolean;
  manager?: 'bun' | 'npm' | 'yarn' | 'pnpm';
  cwd?: string;
}

export interface PackageManagerResult {
  output: string;
  exitCode: number;
  added?: string[];
  removed?: string[];
  updated?: string[];
}

export async function packageManagerExecute(input: PackageManagerInput): Promise<PackageManagerResult> {
  const { action, packages = [], dev = false, manager, cwd } = input;

  const detectedManager = manager ?? detectPackageManager(cwd);
  let cmd: string[];

  switch (action) {
    case 'install': {
      if (detectedManager === 'bun') {
        cmd = ['bun', 'install'];
      } else if (detectedManager === 'yarn') {
        cmd = ['yarn', 'install'];
      } else if (detectedManager === 'pnpm') {
        cmd = ['pnpm', 'install'];
      } else {
        cmd = ['npm', 'install'];
      }
      break;
    }

    case 'add': {
      if (packages.length === 0) {
        throw new Error('No packages specified for add action');
      }

      if (detectedManager === 'bun') {
        cmd = ['bun', 'add', ...packages];
        if (dev) cmd.push('-d');
      } else if (detectedManager === 'yarn') {
        cmd = ['yarn', 'add', ...packages];
        if (dev) cmd.push('-D');
      } else if (detectedManager === 'pnpm') {
        cmd = ['pnpm', 'add', ...packages];
        if (dev) cmd.push('-D');
      } else {
        cmd = ['npm', 'install', ...packages];
        if (dev) cmd.push('--save-dev');
      }
      break;
    }

    case 'remove': {
      if (packages.length === 0) {
        throw new Error('No packages specified for remove action');
      }

      if (detectedManager === 'bun') {
        cmd = ['bun', 'remove', ...packages];
      } else if (detectedManager === 'yarn') {
        cmd = ['yarn', 'remove', ...packages];
      } else if (detectedManager === 'pnpm') {
        cmd = ['pnpm', 'remove', ...packages];
      } else {
        cmd = ['npm', 'uninstall', ...packages];
      }
      break;
    }

    case 'list': {
      if (detectedManager === 'bun') {
        cmd = ['bun', 'pm', 'ls'];
      } else if (detectedManager === 'yarn') {
        cmd = ['yarn', 'list'];
      } else if (detectedManager === 'pnpm') {
        cmd = ['pnpm', 'list'];
      } else {
        cmd = ['npm', 'list'];
      }
      break;
    }

    case 'outdated': {
      if (detectedManager === 'bun') {
        cmd = ['bun', 'outdated'];
      } else if (detectedManager === 'yarn') {
        cmd = ['yarn', 'outdated'];
      } else if (detectedManager === 'pnpm') {
        cmd = ['pnpm', 'outdated'];
      } else {
        cmd = ['npm', 'outdated'];
      }
      break;
    }

    default:
      throw new Error(`Unknown package-manager action: ${action}`);
  }

  const result = await runCommand(cmd, cwd);

  // Parse added/removed/updated packages from output (basic parsing)
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];

  if (action === 'add' && result.exitCode === 0) {
    added.push(...packages);
  } else if (action === 'remove' && result.exitCode === 0) {
    removed.push(...packages);
  }

  return {
    output: result.exitCode === 0 ? result.stdout : result.stderr,
    exitCode: result.exitCode,
    added: added.length > 0 ? added : undefined,
    removed: removed.length > 0 ? removed : undefined,
    updated: updated.length > 0 ? updated : undefined,
  };
}

// ============================================================================
// Port Check Tool
// ============================================================================

export interface PortCheckInput {
  action: 'check' | 'find-available' | 'list-listening';
  port?: number;
  range?: { start: number; end: number };
  host?: string;
}

export interface PortCheckResult {
  available?: boolean;
  port?: number;
  services?: Array<{ port: number; pid: number; name: string }>;
  process?: { pid: number; name: string; command: string };
}

export async function portCheckExecute(input: PortCheckInput): Promise<PortCheckResult> {
  const { action, port, range, host = 'localhost' } = input;

  switch (action) {
    case 'check': {
      if (port === undefined) {
        throw new Error('Port number required for check action');
      }

      const available = await checkPortAvailable(port, host);
      let process: { pid: number; name: string; command: string } | undefined;

      if (!available) {
        process = await getProcessOnPort(port);
      }

      return {
        available,
        port,
        process,
      };
    }

    case 'find-available': {
      const startPort = range?.start ?? 3000;
      const endPort = range?.end ?? 9000;

      for (let p = startPort; p <= endPort; p++) {
        const available = await checkPortAvailable(p, host);
        if (available) {
          return {
            available: true,
            port: p,
          };
        }
      }

      return {
        available: false,
        port: undefined,
      };
    }

    case 'list-listening': {
      const services: Array<{ port: number; pid: number; name: string }> = [];

      try {
        // Try to get listening ports using lsof
        const { stdout, exitCode } = await runCommand(['lsof', '-iTCP', '-sTCP:LISTEN', '-P', '-n']);
        if (exitCode === 0 && stdout) {
          const lines = stdout.split('\n').filter(l => l.trim());
          // Skip header
          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i]!.split(/\s+/);
            if (parts.length >= 9) {
              const name = parts[0]!;
              const pid = parseInt(parts[1]!, 10);
              const portMatch = parts[8]!.match(/:(\d+)$/);
              if (portMatch) {
                services.push({
                  port: parseInt(portMatch[1]!, 10),
                  pid,
                  name,
                });
              }
            }
          }
        }
      } catch {
        // lsof not available
      }

      return { services };
    }

    default:
      throw new Error(`Unknown port-check action: ${action}`);
  }
}

// ============================================================================
// Mastra Tools
// ============================================================================

export const dockerTool = createTool({
  id: 'docker',
  description: 'Execute Docker commands including build, run, ps, logs, compose operations',
  inputSchema: z.object({
    action: z.enum(['build', 'run', 'ps', 'logs', 'stop', 'compose-up', 'compose-down']),
    args: z.array(z.string()).optional(),
    service: z.string().optional(),
    image: z.string().optional(),
    container: z.string().optional(),
    command: z.string().optional(),
    ports: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    volumes: z.array(z.string()).optional(),
    file: z.string().optional().describe('Path to Dockerfile or compose.yml'),
    cwd: z.string().optional(),
  }),
  execute: async (input) => {
    const result = await dockerExecute(input);
    return result;
  },
});

export const envManagerTool = createTool({
  id: 'env-manager',
  description: 'Manage environment variables from .env files with validation and masking',
  inputSchema: z.object({
    action: z.enum(['list', 'validate', 'check-missing']),
    envFile: z.string().optional().default('.env'),
    required: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  }),
  execute: async (input) => {
    const result = await envManagerExecute(input);
    return result;
  },
});

export const packageManagerTool = createTool({
  id: 'package-manager',
  description: 'Auto-detect and run package manager commands (bun/npm/yarn/pnpm)',
  inputSchema: z.object({
    action: z.enum(['install', 'add', 'remove', 'list', 'outdated']),
    packages: z.array(z.string()).optional(),
    dev: z.boolean().optional().default(false),
    manager: z.enum(['bun', 'npm', 'yarn', 'pnpm']).optional(),
    cwd: z.string().optional(),
  }),
  execute: async (input) => {
    const result = await packageManagerExecute(input);
    return result;
  },
});

export const portCheckTool = createTool({
  id: 'port-check',
  description: 'Check port availability, find open ports, and list listening services',
  inputSchema: z.object({
    action: z.enum(['check', 'find-available', 'list-listening']),
    port: z.number().optional(),
    range: z.object({
      start: z.number(),
      end: z.number(),
    }).optional(),
    host: z.string().optional().default('localhost'),
  }),
  execute: async (input) => {
    const result = await portCheckExecute(input);
    return result;
  },
});

// Export all infrastructure tools
export const allInfraTools = [
  dockerTool,
  envManagerTool,
  packageManagerTool,
  portCheckTool,
];

// Export individual functions for testing
export {
  runCommand,
  detectPackageManager,
  parseEnvFile,
  checkPortAvailable,
};
