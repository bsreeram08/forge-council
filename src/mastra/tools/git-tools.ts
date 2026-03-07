import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

async function runCommand(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: cwd ?? process.cwd(),
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Command failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  return output.trim();
}

async function runCommandSilent(cmd: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: cwd ?? process.cwd(),
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function isGitRepository(cwd?: string): Promise<boolean> {
  return runCommandSilent(['git', 'rev-parse', '--git-dir'], cwd)
    .then((result) => result.exitCode === 0)
    .catch(() => false);
}

async function hasCommits(cwd?: string): Promise<boolean> {
  const result = await runCommandSilent(['git', 'rev-parse', 'HEAD'], cwd);
  return result.exitCode === 0;
}

export interface GitCommitResult {
  hash: string;
  message: string;
  files: string[];
  timestamp: string;
}

export async function gitCommit(
  agentId: string,
  type: string,
  message: string,
  messageFormat: string,
  files: string[],
  cwd?: string,
): Promise<string> {
  const formatted = messageFormat
    .replace('{agentId}', agentId)
    .replace('{type}', type)
    .replace('{message}', message);

  if (files.length === 0) {
    throw new Error('No files specified for commit');
  }

  await runCommand(['git', 'add', '--', ...files], cwd);
  const output = await runCommand(['git', 'commit', '-m', formatted], cwd);

  const hashMatch = output.match(/([a-f0-9]{7,40})\b/);
  if (!hashMatch || !hashMatch[1]) {
    throw new Error(`Failed to extract commit hash from git output: ${output}`);
  }
  return hashMatch[1];
}

export async function gitCommitStructured(
  message: string,
  files: string[],
  agentId?: string,
  type?: string,
  amend?: boolean,
  noVerify?: boolean,
  cwd?: string,
): Promise<GitCommitResult> {
  if (!(await isGitRepository(cwd))) {
    throw new Error('Not a git repository');
  }

  if (files.length === 0) {
    throw new Error('No files specified for commit');
  }

  let formattedMessage = message;
  if (agentId && type) {
    formattedMessage = `[${agentId}] ${type}: ${message}`;
  } else if (agentId) {
    formattedMessage = `[${agentId}] ${message}`;
  } else if (type) {
    formattedMessage = `${type}: ${message}`;
  }

  await runCommand(['git', 'add', '--', ...files], cwd);

  const commitArgs = ['git', 'commit', '-m', formattedMessage];
  if (amend) {
    commitArgs.push('--amend');
  }
  if (noVerify) {
    commitArgs.push('--no-verify');
  }

  const output = await runCommand(commitArgs, cwd);

  const hashMatch = output.match(/([a-f0-9]{7,40})\b/);
  if (!hashMatch || !hashMatch[1]) {
    throw new Error(`Failed to extract commit hash from git output: ${output}`);
  }

  const hash = hashMatch[1];
  const timestamp = await runCommand(['git', 'log', '-1', '--format=%cI', hash], cwd);

  return {
    hash,
    message: formattedMessage,
    files,
    timestamp,
  };
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  timestamp: string;
  files?: string[];
}

export interface GitLogResult {
  commits: GitLogEntry[];
}

export async function gitLog(count: number, cwd?: string): Promise<string> {
  return runCommand(['git', 'log', '--oneline', '-n', String(count)], cwd);
}

export async function gitLogStructured(
  limit = 20,
  path?: string,
  author?: string,
  since?: string,
  until?: string,
  format: 'short' | 'full' | 'oneline' = 'short',
  cwd?: string,
): Promise<GitLogResult> {
  if (!(await isGitRepository(cwd))) {
    throw new Error('Not a git repository');
  }

  if (!(await hasCommits(cwd))) {
    return { commits: [] };
  }

  const args = ['git', 'log', `--max-count=${limit}`];
  const SEP = '<GIT_LOG_SEP>';
  const END = '<GIT_LOG_END>';
  args.push(`--format=%H${SEP}%an${SEP}%cI${SEP}%s${END}`);

  if (author) args.push('--author', author);
  if (since) args.push('--since', since);
  if (until) args.push('--until', until);
  if (path) args.push('--', path);

  const result = await runCommandSilent(args, cwd);
  const output = result.stdout;

  if (!output || result.exitCode !== 0) {
    return { commits: [] };
  }

  const commits: GitLogEntry[] = [];
  const entries = output.split(END).filter((e) => e.trim());

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(SEP);
    if (parts.length >= 4) {
      const hash = parts[0];
      const commitAuthor = parts[1];
      const timestamp = parts[2];
      const msg = parts.slice(3).join(SEP);

      if (!hash || !commitAuthor || !timestamp) continue;

      const commit: GitLogEntry = {
        hash: hash.slice(0, 7),
        message: msg.trim(),
        author: commitAuthor,
        timestamp,
      };

      if (format !== 'oneline') {
        try {
          const filesResult = await runCommandSilent(
            ['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', hash],
            cwd,
          );
          commit.files = filesResult.exitCode === 0 
            ? filesResult.stdout.split('\n').filter((f) => f.trim())
            : [];
        } catch {
          commit.files = [];
        }
      }

      commits.push(commit);
    }
  }

  return { commits };
}

export async function gitLogFiltered(agentId: string, count: number, cwd?: string): Promise<string> {
  return runCommand([
    'git', 'log', '--oneline', '-n', String(count),
    '--grep', `\\[${agentId}\\]`,
  ], cwd);
}

export interface GitDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GitDiffResult {
  files: GitDiffFile[];
}

export async function gitDiff(cwd?: string): Promise<string> {
  if (!(await hasCommits(cwd))) {
    return '';
  }
  return runCommand(['git', 'diff', 'HEAD'], cwd);
}

export async function gitDiffFiles(files: string[], cwd?: string): Promise<string> {
  if (files.length === 0) {
    return '';
  }
  if (!(await isGitRepository(cwd))) {
    throw new Error('Not a git repository');
  }
  return runCommand(['git', 'diff', '--', ...files], cwd);
}

export async function gitDiffStructured(
  from?: string,
  to?: string,
  path?: string,
  staged = false,
  cwd?: string,
): Promise<GitDiffResult> {
  if (!(await isGitRepository(cwd))) {
    throw new Error('Not a git repository');
  }

  const files: GitDiffFile[] = [];

  const statArgs = ['git', 'diff', '--numstat'];
  if (staged) statArgs.push('--staged');
  if (from) statArgs.push(from);
  if (to) statArgs.push(to);
  if (path) {
    statArgs.push('--', path);
  } else if (!from && !staged) {
    statArgs.push('HEAD');
  }

  const statResult = await runCommandSilent(statArgs, cwd);

  if (statResult.exitCode !== 0) {
    return { files: [] };
  }

  const fileStats = new Map<string, { additions: number; deletions: number }>();
  const statLines = statResult.stdout.split('\n').filter((l) => l.trim());

  for (const line of statLines) {
    const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match) {
      const adds = match[1];
      const dels = match[2];
      const filePath = match[3];
      if (adds && dels && filePath) {
        fileStats.set(filePath, {
          additions: parseInt(adds, 10) || 0,
          deletions: parseInt(dels, 10) || 0,
        });
      }
    }
  }

  const statusArgs = ['git', 'diff', '--name-status'];
  if (staged) statusArgs.push('--staged');
  if (from) statusArgs.push(from);
  if (to) statusArgs.push(to);
  if (path) {
    statusArgs.push('--', path);
  } else if (!from && !staged) {
    statusArgs.push('HEAD');
  }

  const statusResult = await runCommandSilent(statusArgs, cwd);

  if (statusResult.exitCode === 0 && statusResult.stdout) {
    const statusLines = statusResult.stdout.split('\n').filter((l) => l.trim());

    for (const line of statusLines) {
      const parts = line.split('\t');
      const statusCodePart = parts[0];
      let filePath = parts[1];

      if (!statusCodePart || !filePath) continue;

      const statusCode = statusCodePart[0];
      let status: GitDiffFile['status'] = 'modified';

      switch (statusCode) {
        case 'A': status = 'added'; break;
        case 'M': status = 'modified'; break;
        case 'D': status = 'deleted'; break;
        case 'R':
          status = 'renamed';
          filePath = parts[2] || filePath;
          break;
      }

      const stats = fileStats.get(filePath) || { additions: 0, deletions: 0 };

      const patchArgs = ['git', 'diff'];
      if (staged) patchArgs.push('--staged');
      if (from) patchArgs.push(from);
      if (to) patchArgs.push(to);
      patchArgs.push('--', filePath);

      const patchResult = await runCommandSilent(patchArgs, cwd);
      const patch = patchResult.exitCode === 0 ? patchResult.stdout : undefined;

      files.push({
        path: filePath,
        status,
        additions: stats.additions,
        deletions: stats.deletions,
        patch,
      });
    }
  }

  return { files };
}

export async function gitStatus(cwd?: string): Promise<string> {
  return runCommand(['git', 'status', '--porcelain'], cwd);
}

export interface GitStatusEntry {
  path: string;
  status: string;
}

export async function gitStatusStructured(cwd?: string): Promise<{ status: GitStatusEntry[] }> {
  if (!(await isGitRepository(cwd))) {
    throw new Error('Not a git repository');
  }

  const output = await runCommand(['git', 'status', '--porcelain'], cwd);

  if (!output) {
    return { status: [] };
  }

  const status: GitStatusEntry[] = [];
  const lines = output.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const statusCode = line.slice(0, 2);
    const pathPart = line.slice(3);
    const filePath = pathPart.split(' -> ')[0];

    status.push({
      path: filePath!,
      status: statusCode,
    });
  }

  return { status };
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  commit?: string;
}

export interface GitBranchResult {
  branches: GitBranchInfo[];
  success: boolean;
}

export async function gitBranch(
  action: 'list' | 'create' | 'delete' | 'checkout' | 'merge',
  branch?: string,
  from?: string,
  cwd?: string,
): Promise<GitBranchResult> {
  if (!(await isGitRepository(cwd))) {
    throw new Error('Not a git repository');
  }

  switch (action) {
    case 'create': {
      if (!branch) throw new Error('Branch name required for create action');
      const args = ['git', 'branch'];
      if (from) {
        args.push(branch, from);
      } else {
        args.push(branch);
      }
      await runCommand(args, cwd);
      break;
    }
    case 'delete': {
      if (!branch) throw new Error('Branch name required for delete action');
      await runCommand(['git', 'branch', '-D', branch], cwd);
      break;
    }
    case 'checkout': {
      if (!branch) throw new Error('Branch name required for checkout action');
      await runCommand(['git', 'checkout', branch], cwd);
      break;
    }
    case 'merge': {
      if (!branch) throw new Error('Branch name required for merge action');
      await runCommand(['git', 'merge', branch], cwd);
      break;
    }
    case 'list':
      break;
  }

  const output = await runCommand(['git', 'branch', '-a'], cwd);
  const branches: GitBranchInfo[] = [];
  const lines = output.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    // Handle both "* master" (current) and "feature-branch" (non-current, no prefix)
    let currentMarker: string;
    let name: string;
    
    if (line.startsWith('* ')) {
      currentMarker = '*';
      name = line.slice(2).trim();
    } else {
      currentMarker = ' ';
      name = line.trim();
    }
    
    if (!name) continue;

    const isRemote = name.startsWith('remotes/');
    const cleanName = isRemote ? name.replace('remotes/', '') : name;

    branches.push({
      name: cleanName,
      current: currentMarker === '*',
      remote: isRemote,
    });
  }

  return { branches, success: true };
}

export interface GitStashEntry {
  index: number;
  message: string;
  timestamp: string;
}

export interface GitStashResult {
  stashes: GitStashEntry[];
  success: boolean;
}

export async function gitStash(
  action: 'push' | 'pop' | 'apply' | 'drop' | 'list' | 'clear',
  message?: string,
  stash?: string,
  keepIndex = false,
  cwd?: string,
): Promise<GitStashResult> {
  if (!(await isGitRepository(cwd))) {
    throw new Error('Not a git repository');
  }

  switch (action) {
    case 'push': {
      const args = ['git', 'stash', 'push'];
      if (message) args.push('-m', message);
      if (keepIndex) args.push('--keep-index');
      await runCommand(args, cwd);
      break;
    }
    case 'pop': {
      const args = ['git', 'stash', 'pop'];
      if (stash) args.push(stash);
      await runCommand(args, cwd);
      break;
    }
    case 'apply': {
      const args = ['git', 'stash', 'apply'];
      if (stash) args.push(stash);
      await runCommand(args, cwd);
      break;
    }
    case 'drop': {
      const args = ['git', 'stash', 'drop'];
      if (stash) args.push(stash);
      await runCommand(args, cwd);
      break;
    }
    case 'clear':
      await runCommand(['git', 'stash', 'clear'], cwd);
      break;
    case 'list':
      break;
  }

  const output = await runCommandSilent(['git', 'stash', 'list'], cwd);
  const stashes: GitStashEntry[] = [];

  if (output.exitCode === 0 && output.stdout) {
    const lines = output.stdout.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      const match = line.match(/stash@\{(\d+)\}:\s+(.+)$/);
      if (match) {
        const index = match[1];
        const msg = match[2];
        if (!index || !msg) continue;

        let timestamp = new Date().toISOString();
        try {
          const timestampOutput = await runCommand(
            ['git', 'log', '-1', '--format=%cI', `stash@{${index}}`],
            cwd,
          );
          if (timestampOutput) timestamp = timestampOutput;
        } catch {
          // Use default timestamp
        }

        stashes.push({
          index: parseInt(index, 10),
          message: msg.trim(),
          timestamp,
        });
      }
    }
  }

  return { stashes, success: true };
}

export const gitCommitTool = createTool({
  id: 'git-commit',
  description: 'Commits changes with a semantic message tagged by agent role',
  inputSchema: z.object({
    agentId: z.string(),
    type: z.enum(['feat', 'fix', 'doc', 'test', 'refactor', 'config', 'plan']),
    message: z.string(),
    files: z.array(z.string()),
    amend: z.boolean().optional().default(false),
    noVerify: z.boolean().optional().default(false),
  }),
  execute: async (input) => {
    const format = '[{agentId}] {type}: {message}';
    const hash = await gitCommit(
      input.agentId,
      input.type,
      input.message,
      format,
      input.files,
    );
    return { committed: true, hash };
  },
});

export const gitCommitStructuredTool = createTool({
  id: 'git-commit-full',
  description: 'Stage and commit with full structured output matching tool-registry schema',
  inputSchema: z.object({
    message: z.string(),
    files: z.array(z.string()).optional(),
    agentId: z.string().optional(),
    type: z.enum(['feat', 'fix', 'doc', 'test', 'refactor', 'config', 'plan']).optional(),
    amend: z.boolean().optional().default(false),
    noVerify: z.boolean().optional().default(false),
  }),
  execute: async (input) => {
    return await gitCommitStructured(
      input.message,
      input.files ?? [],
      input.agentId,
      input.type,
      input.amend,
      input.noVerify,
    );
  },
});

export const gitLogTool = createTool({
  id: 'git-log',
  description: 'Read recent git history for project context',
  inputSchema: z.object({
    count: z.number().default(20),
    filter: z.string().optional(),
  }),
  execute: async (input) => {
    const count = input.count ?? 20;
    const log = input.filter
      ? await gitLogFiltered(input.filter, count)
      : await gitLog(count);
    return { log };
  },
});

export const gitLogStructuredTool = createTool({
  id: 'git-log-full',
  description: 'View commit history with structured output matching tool-registry schema',
  inputSchema: z.object({
    limit: z.number().optional().default(20),
    path: z.string().optional(),
    author: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    format: z.enum(['short', 'full', 'oneline']).optional().default('short'),
  }),
  execute: async (input) => {
    return await gitLogStructured(
      input.limit,
      input.path,
      input.author,
      input.since,
      input.until,
      input.format,
    );
  },
});

export const gitStatusTool = createTool({
  id: 'git-status',
  description: 'Check current git status for modified files',
  inputSchema: z.object({}),
  execute: async () => {
    const status = await gitStatus();
    return { status };
  },
});

export const gitStatusStructuredTool = createTool({
  id: 'git-status-full',
  description: 'Check git status with structured output',
  inputSchema: z.object({}),
  execute: async () => {
    return await gitStatusStructured();
  },
});

export const gitDiffTool = createTool({
  id: 'git-diff',
  description: 'Get diff for specific files or all changes',
  inputSchema: z.object({
    files: z.array(z.string()).optional(),
  }),
  execute: async (input) => {
    const diff = input.files
      ? await gitDiffFiles(input.files)
      : await gitDiff();
    return { diff };
  },
});

export const gitDiffStructuredTool = createTool({
  id: 'git-diff-full',
  description: 'Show differences with structured output matching tool-registry schema',
  inputSchema: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    path: z.string().optional(),
    staged: z.boolean().optional().default(false),
  }),
  execute: async (input) => {
    return await gitDiffStructured(
      input.from,
      input.to,
      input.path,
      input.staged,
    );
  },
});

export const gitBranchTool = createTool({
  id: 'git-branch',
  description: 'Manage git branches with structured output',
  inputSchema: z.object({
    action: z.enum(['list', 'create', 'delete', 'checkout', 'merge']),
    branch: z.string().optional(),
    from: z.string().optional(),
  }),
  execute: async (input) => {
    return await gitBranch(
      input.action,
      input.branch,
      input.from,
    );
  },
});

export const gitStashTool = createTool({
  id: 'git-stash',
  description: 'Stash changes for later with structured output',
  inputSchema: z.object({
    action: z.enum(['push', 'pop', 'apply', 'drop', 'list', 'clear']),
    message: z.string().optional(),
    stash: z.string().optional(),
    keepIndex: z.boolean().optional().default(false),
  }),
  execute: async (input) => {
    return await gitStash(
      input.action,
      input.message,
      input.stash,
      input.keepIndex,
    );
  },
});

export const allGitTools = [
  gitCommitTool,
  gitCommitStructuredTool,
  gitLogTool,
  gitLogStructuredTool,
  gitStatusTool,
  gitStatusStructuredTool,
  gitDiffTool,
  gitDiffStructuredTool,
  gitBranchTool,
  gitStashTool,
];
