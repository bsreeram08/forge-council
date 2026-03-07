import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  gitCommit,
  gitLog,
  gitStatus,
  gitDiff,
  gitLogFiltered,
  gitDiffFiles,
  gitCommitStructured,
  gitLogStructured,
  gitDiffStructured,
  gitStatusStructured,
  gitBranch,
  gitStash,
} from './git-tools';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('git-tools', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'git-tools-test-'));
    mkdirSync(join(testDir, 'subdir'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  async function runGit(cmd: string[]): Promise<string> {
    const proc = Bun.spawn(cmd, {
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim();
  }

  describe('gitCommit', () => {
    test('gitCommit creates a commit with formatted message', async () => {
      writeFileSync(join(testDir, 'test.txt'), 'Hello World');
      
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      const hash = await gitCommit(
        'coder',
        'feat',
        'add test file',
        '[{agentId}] {type}: {message}',
        ['test.txt'],
        testDir,
      );
      
      expect(hash).toMatch(/^[a-f0-9]{7,}$/);
      
      const log = await gitLog(1, testDir);
      expect(log).toContain('[coder] feat: add test file');
    });

    test('gitCommit throws on empty files', async () => {
      await runGit(['git', 'init']);
      
      expect(async () => {
        await gitCommit('coder', 'feat', 'message', '[{agentId}] {type}: {message}', [], testDir);
      }).toThrow();
    });
  });

  describe('gitCommitStructured', () => {
    test('creates commit with full structured output', async () => {
      writeFileSync(join(testDir, 'test.txt'), 'Hello World');
      
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      const result = await gitCommitStructured(
        'add test file',
        ['test.txt'],
        'coder',
        'feat',
        false,
        false,
        testDir,
      );
      
      expect(result.hash).toMatch(/^[a-f0-9]{7,}$/);
      expect(result.message).toBe('[coder] feat: add test file');
      expect(result.files).toEqual(['test.txt']);
      expect(result.timestamp).toBeDefined();
    });

    test('creates commit with only message', async () => {
      writeFileSync(join(testDir, 'test.txt'), 'Hello World');
      
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      const result = await gitCommitStructured(
        'simple commit',
        ['test.txt'],
        undefined,
        undefined,
        false,
        false,
        testDir,
      );
      
      expect(result.hash).toMatch(/^[a-f0-9]{7,}$/);
      expect(result.message).toBe('simple commit');
    });

    test('throws in non-git directory', async () => {
      const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-test-'));
      
      try {
        await gitCommitStructured('message', ['file.txt'], undefined, undefined, false, false, nonGitDir);
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Not a git repository');
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('gitLog', () => {
    test('gitLog returns formatted log', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'a.txt'), 'a');
      await gitCommit('executor', 'feat', 'first', '[{agentId}] {type}: {message}', ['a.txt'], testDir);
      
      writeFileSync(join(testDir, 'b.txt'), 'b');
      await gitCommit('architect', 'fix', 'second', '[{agentId}] {type}: {message}', ['b.txt'], testDir);
      
      const log = await gitLog(5, testDir);
      expect(log).toContain('[architect] fix: second');
      expect(log).toContain('[executor] feat: first');
    });
  });

  describe('gitLogStructured', () => {
    test('returns structured commits', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'a.txt'), 'a');
      await gitCommit('executor', 'feat', 'first', '[{agentId}] {type}: {message}', ['a.txt'], testDir);
      
      writeFileSync(join(testDir, 'b.txt'), 'b');
      await gitCommit('architect', 'fix', 'second', '[{agentId}] {type}: {message}', ['b.txt'], testDir);
      
      const result = await gitLogStructured(10, undefined, undefined, undefined, undefined, 'short', testDir);
      
      expect(result.commits).toHaveLength(2);
      expect(result.commits[0]!.message).toContain('[architect] fix: second');
      expect(result.commits[1]!.message).toContain('[executor] feat: first');
      expect(result.commits[0]!.hash).toMatch(/^[a-f0-9]{7}$/);
      expect(result.commits[0]!.author).toBe('Test');
      expect(result.commits[0]!.timestamp).toBeDefined();
    });

    test('respects limit parameter', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(testDir, `file${i}.txt`), `content${i}`);
        await gitCommit('executor', 'feat', `commit ${i}`, '[{agentId}] {type}: {message}', [`file${i}.txt`], testDir);
      }
      
      const result = await gitLogStructured(3, undefined, undefined, undefined, undefined, 'short', testDir);
      expect(result.commits).toHaveLength(3);
    });

    test('returns empty array for empty repo', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      const result = await gitLogStructured(10, undefined, undefined, undefined, undefined, 'short', testDir);
      expect(result.commits).toHaveLength(0);
    });

    test('throws in non-git directory', async () => {
      const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-test-'));
      
      try {
        await gitLogStructured(10, undefined, undefined, undefined, undefined, 'short', nonGitDir);
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Not a git repository');
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('gitStatus', () => {
    test('gitStatus returns modified files', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'new.txt'), 'new');
      
      const status = await gitStatus(testDir);
      expect(status).toContain('new.txt');
    });
  });

  describe('gitStatusStructured', () => {
    test('returns structured status', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'new.txt'), 'new');
      
      const result = await gitStatusStructured(testDir);
      expect(result.status).toHaveLength(1);
      expect(result.status[0]!.path).toBe('new.txt');
      expect(result.status[0]!.status).toBe('??');
    });

    test('returns empty array for clean repo', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      const result = await gitStatusStructured(testDir);
      expect(result.status).toHaveLength(0);
    });

    test('throws in non-git directory', async () => {
      const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-test-'));
      
      try {
        await gitStatusStructured(nonGitDir);
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Not a git repository');
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('gitDiff', () => {
    test('gitDiff returns empty for repo with no commits', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'content');
      
      const diff = await gitDiff(testDir);
      expect(diff).toBe('');
    });
  });

  describe('gitDiffStructured', () => {
    test('returns structured diff for working directory', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'original content');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['file.txt'], testDir);
      
      writeFileSync(join(testDir, 'file.txt'), 'modified content');
      
      const result = await gitDiffStructured(undefined, undefined, undefined, false, testDir);
      
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.path).toBe('file.txt');
      expect(result.files[0]!.status).toBe('modified');
    });

    test('returns empty array when no changes', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'content');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['file.txt'], testDir);
      
      const result = await gitDiffStructured(undefined, undefined, undefined, false, testDir);
      expect(result.files).toHaveLength(0);
    });

    test('supports staged option', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'original');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['file.txt'], testDir);
      
      writeFileSync(join(testDir, 'file.txt'), 'staged content');
      await runGit(['git', 'add', 'file.txt']);
      
      const result = await gitDiffStructured(undefined, undefined, undefined, true, testDir);
      
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.path).toBe('file.txt');
    });

    test('supports from/to commit range', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'a.txt'), 'a');
      await gitCommit('executor', 'feat', 'first', '[{agentId}] {type}: {message}', ['a.txt'], testDir);
      
      writeFileSync(join(testDir, 'b.txt'), 'b');
      await gitCommit('executor', 'feat', 'second', '[{agentId}] {type}: {message}', ['b.txt'], testDir);
      
      const result = await gitDiffStructured('HEAD~1', 'HEAD', undefined, false, testDir);
      
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.path).toBe('b.txt');
      expect(result.files[0]!.status).toBe('added');
    });

    test('throws in non-git directory', async () => {
      const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-test-'));
      
      try {
        await gitDiffStructured(undefined, undefined, undefined, false, nonGitDir);
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Not a git repository');
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('gitBranch', () => {
    test('lists branches', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'content');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['file.txt'], testDir);
      
      const result = await gitBranch('list', undefined, undefined, testDir);
      
      expect(result.success).toBe(true);
      expect(result.branches.length).toBeGreaterThan(0);
      expect(result.branches.some((b) => b.current)).toBe(true);
    });

    test('creates new branch', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'content');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['file.txt'], testDir);
      
      const beforeCreate = await gitBranch('list', undefined, undefined, testDir);
      const initialBranchCount = beforeCreate.branches.length;
      
      await gitBranch('create', 'feature-branch', undefined, testDir);
      
      const result = await gitBranch('list', undefined, undefined, testDir);
      expect(result.branches.length).toBeGreaterThan(initialBranchCount);
    });



    test('switches branches', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'content');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['file.txt'], testDir);
      
      await gitBranch('create', 'feature-branch', undefined, testDir);
      await gitBranch('checkout', 'feature-branch', undefined, testDir);
      
      const result = await gitBranch('list', undefined, undefined, testDir);
      const currentBranch = result.branches.find((b) => b.current);
      expect(currentBranch?.name).toBe('feature-branch');
    });

    test('deletes branch', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'content');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['file.txt'], testDir);
      
      await gitBranch('create', 'temp-branch', undefined, testDir);
      await gitBranch('delete', 'temp-branch', undefined, testDir);
      
      const result = await gitBranch('list', undefined, undefined, testDir);
      expect(result.branches.some((b) => b.name === 'temp-branch')).toBe(false);
    });

    test('throws when creating branch without name', async () => {
      await runGit(['git', 'init']);
      
      expect(async () => {
        await gitBranch('create', undefined, undefined, testDir);
      }).toThrow('Branch name required');
    });

    test('throws in non-git directory', async () => {
      const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-test-'));
      
      try {
        await gitBranch('list', undefined, undefined, nonGitDir);
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Not a git repository');
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('gitStash', () => {
    test('pushes and lists stashes', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'content');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['file.txt'], testDir);
      
      writeFileSync(join(testDir, 'file.txt'), 'modified');
      
      const result = await gitStash('push', 'my stash', undefined, false, testDir);
      
      expect(result.success).toBe(true);
      expect(result.stashes.length).toBeGreaterThan(0);
      expect(result.stashes[0]!.message).toContain('my stash');
      expect(result.stashes[0]!.index).toBe(0);
      expect(result.stashes[0]!.timestamp).toBeDefined();
    });

    test('pops stashes', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'content');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['file.txt'], testDir);
      
      writeFileSync(join(testDir, 'file.txt'), 'modified');
      await gitStash('push', 'temp stash', undefined, false, testDir);
      
      const beforePop = await gitStash('list', undefined, undefined, false, testDir);
      expect(beforePop.stashes).toHaveLength(1);
      
      await gitStash('pop', undefined, undefined, false, testDir);
      
      const afterPop = await gitStash('list', undefined, undefined, false, testDir);
      expect(afterPop.stashes).toHaveLength(0);
    });

    test('clears all stashes', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'content');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['file.txt'], testDir);
      
      writeFileSync(join(testDir, 'a.txt'), 'a');
      await gitStash('push', 'stash 1', undefined, false, testDir);
      
      writeFileSync(join(testDir, 'b.txt'), 'b');
      await gitStash('push', 'stash 2', undefined, false, testDir);
      
      const result = await gitStash('clear', undefined, undefined, false, testDir);
      expect(result.success).toBe(true);
      expect(result.stashes).toHaveLength(0);
    });

    test('returns empty array when no stashes', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'file.txt'), 'content');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['file.txt'], testDir);
      
      const result = await gitStash('list', undefined, undefined, false, testDir);
      expect(result.success).toBe(true);
      expect(result.stashes).toHaveLength(0);
    });

    test('throws in non-git directory', async () => {
      const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-test-'));
      
      try {
        await gitStash('list', undefined, undefined, false, nonGitDir);
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Not a git repository');
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('gitLogFiltered', () => {
    test('gitLogFiltered filters by agent', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'a.txt'), 'a');
      await gitCommit('coder', 'feat', 'from coder', '[{agentId}] {type}: {message}', ['a.txt'], testDir);
      
      writeFileSync(join(testDir, 'b.txt'), 'b');
      await gitCommit('architect', 'fix', 'from architect', '[{agentId}] {type}: {message}', ['b.txt'], testDir);
      
      const coderLog = await gitLogFiltered('coder', 10, testDir);
      expect(coderLog).toContain('from coder');
      expect(coderLog).not.toContain('from architect');
    });
  });

  describe('gitDiffFiles', () => {
    test('returns diff for specific files', async () => {
      await runGit(['git', 'init']);
      await runGit(['git', 'config', 'user.email', 'test@test.com']);
      await runGit(['git', 'config', 'user.name', 'Test']);
      
      writeFileSync(join(testDir, 'a.txt'), 'a');
      writeFileSync(join(testDir, 'b.txt'), 'b');
      await gitCommit('executor', 'feat', 'initial', '[{agentId}] {type}: {message}', ['a.txt', 'b.txt'], testDir);
      
      writeFileSync(join(testDir, 'a.txt'), 'modified a');
      writeFileSync(join(testDir, 'b.txt'), 'modified b');
      
      const diff = await gitDiffFiles(['a.txt'], testDir);
      expect(diff).toContain('modified a');
      expect(diff).not.toContain('modified b');
    });

    test('returns empty string for empty file list', async () => {
      const diff = await gitDiffFiles([], testDir);
      expect(diff).toBe('');
    });
  });
});
