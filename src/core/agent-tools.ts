/**
 * AI SDK Tool Adapters
 *
 * Wraps the existing tool implementations into AI SDK `tool()` format
 * so agents can call them during generateText.
 */

import { tool } from 'ai';
import { z } from 'zod';
import * as path from 'path';
import { AGENT_TOOL_ACCESS, type ToolDefinition } from '../mastra/tools/tool-registry.ts';

// ---------------------------------------------------------------------------
// Path security
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();

function safePath(inputPath: string): string {
  const resolved = path.resolve(PROJECT_ROOT, path.normalize(inputPath));
  if (!resolved.startsWith(PROJECT_ROOT)) {
    throw new Error(`Path traversal: "${inputPath}" escapes project root`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Core tools that agents actually need
// ---------------------------------------------------------------------------

const readFileTool = tool({
  description: 'Read a file. Returns its content. Use this to examine existing code before planning or coding.',
  inputSchema: z.object({
    path: z.string().describe('Relative path from project root'),
    offset: z.number().describe('Start line (0-based)').default(0),
    limit: z.number().describe('Max lines to read (0 = all)').default(0),
  }),
  execute: async ({ path: filePath, offset, limit }) => {
    const full = safePath(filePath);
    const content = await Bun.file(full).text();
    if (offset > 0 || limit > 0) {
      const lines = content.split('\n');
      const sliced = limit > 0 ? lines.slice(offset, offset + limit) : lines.slice(offset);
      return { path: filePath, content: sliced.join('\n'), lines: sliced.length };
    }
    return { path: filePath, content, lines: content.split('\n').length };
  },
});

const listDirTool = tool({
  description: 'List directory contents. Use to discover project structure and find relevant files.',
  inputSchema: z.object({
    path: z.string().describe('Directory path relative to project root').default('.'),
    recursive: z.boolean().describe('List recursively').default(false),
  }),
  execute: async ({ path: dirPath, recursive }) => {
    const full = safePath(dirPath);
    const entries: { name: string; type: 'file' | 'directory' }[] = [];

    if (recursive) {
      const { Glob } = await import('bun');
      const glob = new Glob('**/*');
      for await (const file of glob.scan({ cwd: full, absolute: false })) {
        if (file.includes('node_modules') || file.includes('.git/')) continue;
        entries.push({ name: file, type: 'file' });
      }
    } else {
      const { readdirSync, statSync } = await import('fs');
      for (const name of readdirSync(full)) {
        if (name === 'node_modules' || name === '.git') continue;
        try {
          const stat = statSync(path.join(full, name));
          entries.push({ name, type: stat.isDirectory() ? 'directory' : 'file' });
        } catch {
          entries.push({ name, type: 'file' });
        }
      }
    }
    return { path: dirPath, entries, count: entries.length };
  },
});

const searchFilesTool = tool({
  description: 'Search file contents with regex. Returns matching lines with context. Use to find specific code patterns.',
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().describe('Directory to search in').default('.'),
    include: z.string().describe('Glob pattern for files to include, e.g. "*.ts"').default('*'),
  }),
  execute: async ({ pattern, path: searchPath, include }) => {
    const full = safePath(searchPath);
    const matches: { file: string; line: number; content: string }[] = [];
    const regex = new RegExp(pattern, 'i');
    const { Glob } = await import('bun');
    const glob = new Glob(include.includes('*') ? `**/${include}` : `**/${include}`);

    let fileCount = 0;
    for await (const file of glob.scan({ cwd: full, absolute: false })) {
      if (file.includes('node_modules') || file.includes('.git/')) continue;
      if (/\.(png|jpg|gif|ico|woff|ttf|eot|svg|zip|tar|gz|lock)$/i.test(file)) continue;
      fileCount++;
      try {
        const content = await Bun.file(path.join(full, file)).text();
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            matches.push({ file, line: i + 1, content: lines[i]!.trim() });
            if (matches.length >= 50) break; // Cap results
          }
        }
      } catch { /* skip unreadable */ }
      if (matches.length >= 50) break;
    }
    return { matches, filesSearched: fileCount, totalMatches: matches.length };
  },
});

const gitLogTool = tool({
  description: 'View recent git commit history.',
  inputSchema: z.object({
    limit: z.number().describe('Number of commits').default(10),
    path: z.string().describe('Filter by file path').default(''),
  }),
  execute: async ({ limit, path: filePath }) => {
    const args = ['git', 'log', `--max-count=${limit}`, '--oneline', '--no-decorate'];
    if (filePath) args.push('--', filePath);
    const proc = Bun.spawn(args, { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(proc.stdout).text();
    return { commits: output.trim().split('\n').filter(Boolean) };
  },
});

const gitDiffTool = tool({
  description: 'Show git diff for uncommitted changes or between commits.',
  inputSchema: z.object({
    staged: z.boolean().describe('Show staged changes').default(false),
    path: z.string().describe('Filter by file path').default(''),
  }),
  execute: async ({ staged, path: filePath }) => {
    const args = ['git', 'diff'];
    if (staged) args.push('--staged');
    if (filePath) args.push('--', filePath);
    const proc = Bun.spawn(args, { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(proc.stdout).text();
    return { diff: output, linesChanged: output.split('\n').length };
  },
});

const writeFileTool = tool({
  description: 'Write content to a file. Creates parent directories if needed.',
  inputSchema: z.object({
    path: z.string().describe('File path relative to project root'),
    content: z.string().describe('Full file content to write'),
  }),
  execute: async ({ path: filePath, content }) => {
    const full = safePath(filePath);
    const dir = path.dirname(full);
    await Bun.spawn(['mkdir', '-p', dir], { stdout: 'pipe' }).exited;
    await Bun.write(full, content);
    return { path: filePath, bytesWritten: content.length, success: true };
  },
});

const editFileTool = tool({
  description: 'Apply search-and-replace edits to a file. Reads the file, replaces matching text, writes it back.',
  inputSchema: z.object({
    path: z.string().describe('File path relative to project root'),
    edits: z.array(z.object({
      search: z.string().describe('Exact text to find'),
      replace: z.string().describe('Text to replace with'),
    })),
  }),
  execute: async ({ path: filePath, edits }) => {
    const full = safePath(filePath);
    let content = await Bun.file(full).text();
    let applied = 0;
    for (const edit of edits) {
      if (content.includes(edit.search)) {
        content = content.replace(edit.search, edit.replace);
        applied++;
      }
    }
    await Bun.write(full, content);
    return { path: filePath, editsApplied: applied, success: applied > 0 };
  },
});

const runTestsTool = tool({
  description: 'Run tests. Returns pass/fail summary.',
  inputSchema: z.object({
    pattern: z.string().describe('Test file pattern, e.g. "src/core/"').default(''),
  }),
  execute: async ({ pattern }) => {
    const args = ['bun', 'test'];
    if (pattern) args.push(pattern);
    const proc = Bun.spawn(args, {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { output: stdout + stderr, passed: exitCode === 0 };
  },
});

const typeCheckTool = tool({
  description: 'Run TypeScript type checking. Returns errors if any.',
  inputSchema: z.object({}),
  execute: async () => {
    const proc = Bun.spawn(['bun', 'run', 'tsc', '--noEmit'], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { output: stdout + stderr, passed: exitCode === 0 };
  },
});

const gitCommitTool = tool({
  description: 'Stage files and create a git commit.',
  inputSchema: z.object({
    message: z.string().describe('Commit message'),
    files: z.array(z.string()).describe('Files to stage'),
  }),
  execute: async ({ message, files }) => {
    try {
      await Bun.spawn(['git', 'add', ...files], { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' }).exited;
      await Bun.spawn(['git', 'commit', '-m', message], { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' }).exited;
      return { success: true, message };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// ---------------------------------------------------------------------------
// Tool sets by permission level
// ---------------------------------------------------------------------------

/** Read-only tools — for planners, reviewers, researchers */
export const READ_ONLY_TOOLS = {
  readFile: readFileTool,
  listDir: listDirTool,
  searchFiles: searchFilesTool,
  gitLog: gitLogTool,
  gitDiff: gitDiffTool,
};

/** Read-write tools — for coder, executor */
export const READ_WRITE_TOOLS = {
  ...READ_ONLY_TOOLS,
  writeFile: writeFileTool,
  editFile: editFileTool,
  runTests: runTestsTool,
  typeCheck: typeCheckTool,
  gitCommit: gitCommitTool,
};

/**
 * Get the AI SDK tools for a given agent based on their permission level.
 */
export function getAgentTools(agentId: string): Record<string, any> {
  const access = AGENT_TOOL_ACCESS[agentId];
  if (!access) return READ_ONLY_TOOLS;

  switch (access.permission) {
    case 'ADMIN':
    case 'READ_WRITE':
      return READ_WRITE_TOOLS;
    case 'READ_ONLY':
    default:
      return READ_ONLY_TOOLS;
  }
}
