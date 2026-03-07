/**
 * Tool System Integration Tests
 *
 * Comprehensive integration tests for the tool guard system with all 13 agents
 * and end-to-end tool execution for safe operations.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import {
  canUseTool,
  getAllowedTools,
  getToolDenialReason,
  hasWildcardAccess,
  getAgentPermissionLevel,
} from './tool-guard';
import {
  PermissionLevel,
  BUILTIN_TOOLS,
  listToolIds,
  AGENT_TOOL_ACCESS,
} from './tool-registry';
import { readFile, listDir, writeFile, deleteFile } from './filesystem';
import { executeTypeCheck, executeLint } from './code-execution';
import { analyzeCodeComplexity } from './analysis';


// Test directory setup
const TEST_DIR = path.join(process.cwd(), 'tmp-test-tool-integration');

async function setupTestDir(): Promise<void> {
  try {
    await Bun.spawn(['mkdir', '-p', TEST_DIR]).exited;
  } catch {
    // Directory might already exist
  }
}

async function cleanupTestDir(): Promise<void> {
  try {
    await Bun.spawn(['rm', '-rf', TEST_DIR]).exited;
  } catch {
    // Directory might not exist
  }
}

async function createTestFile(filePath: string, content: string): Promise<string> {
  const fullPath = path.join(TEST_DIR, filePath);
  const parentDir = path.dirname(fullPath);
  await Bun.spawn(['mkdir', '-p', parentDir]).exited;
  await Bun.write(fullPath, content);
  return fullPath;
}

// ============================================================================
// All 13 Agent Definitions
// ============================================================================

const ALL_AGENTS = [
  'executor', // Ford
  'architect', // Torvalds
  'coder', // Carmack
  'reviewer', // Guido
  'spec-agent', // Fowler
  'planner', // Doshi
  'designer', // Jobs
  'researcher', // Scott
  'qa', // Whittaker
  'security', // Schneier
  'integrator', // Tesla
  'docs', // Knuth
  'scout', // Scout
] as const;

// ============================================================================
// Tool Guard Integration Tests - All 13 Agents
// ============================================================================

describe('Tool Guard Integration - All 13 Agents', () => {
  describe('canUseTool() - Permission Enforcement', () => {
    // Ford (executor) - ADMIN access
    test('Ford (executor) can use any tool including ADMIN tools', () => {
      expect(canUseTool('executor', 'delete-file').allowed).toBe(true);
      expect(canUseTool('executor', 'run-shell').allowed).toBe(true);
      expect(canUseTool('executor', 'docker').allowed).toBe(true);
      expect(canUseTool('executor', 'env-manager').allowed).toBe(true);
      expect(canUseTool('executor', 'write-file').allowed).toBe(true);
      expect(canUseTool('executor', 'read-file').allowed).toBe(true);
    });

    // Architect (Torvalds) - READ_WRITE, no delete/docker/shell
    test('Architect can use READ_WRITE tools but not ADMIN tools', () => {
      expect(canUseTool('architect', 'write-file').allowed).toBe(true);
      expect(canUseTool('architect', 'edit-file').allowed).toBe(true);
      expect(canUseTool('architect', 'git-commit').allowed).toBe(true);
      expect(canUseTool('architect', 'read-file').allowed).toBe(true);

      // Should be denied ADMIN tools
      expect(canUseTool('architect', 'delete-file').allowed).toBe(false);
      expect(canUseTool('architect', 'run-shell').allowed).toBe(false);
      expect(canUseTool('architect', 'docker').allowed).toBe(false);
      expect(canUseTool('architect', 'env-manager').allowed).toBe(false);
    });

    // Coder (Carmack) - READ_WRITE, no delete/docker/shell
    test('Coder can use code tools but not ADMIN tools', () => {
      expect(canUseTool('coder', 'run-code').allowed).toBe(true);
      expect(canUseTool('coder', 'run-tests').allowed).toBe(true);
      expect(canUseTool('coder', 'write-file').allowed).toBe(true);
      expect(canUseTool('coder', 'package-manager').allowed).toBe(true);

      // Should be denied ADMIN tools
      expect(canUseTool('coder', 'delete-file').allowed).toBe(false);
      expect(canUseTool('coder', 'run-shell').allowed).toBe(false);
      expect(canUseTool('coder', 'docker').allowed).toBe(false);
    });

    // Reviewer (Guido) - READ_ONLY
    test('Reviewer can only use READ_ONLY tools', () => {
      expect(canUseTool('reviewer', 'read-file').allowed).toBe(true);
      expect(canUseTool('reviewer', 'list-dir').allowed).toBe(true);
      expect(canUseTool('reviewer', 'search-files').allowed).toBe(true);
      expect(canUseTool('reviewer', 'lint-code').allowed).toBe(true);
      expect(canUseTool('reviewer', 'type-check').allowed).toBe(true);
      expect(canUseTool('reviewer', 'git-log').allowed).toBe(true);
      expect(canUseTool('reviewer', 'git-diff').allowed).toBe(true);

      // Should be denied WRITE and ADMIN tools
      expect(canUseTool('reviewer', 'write-file').allowed).toBe(false);
      expect(canUseTool('reviewer', 'git-commit').allowed).toBe(false);
      expect(canUseTool('reviewer', 'delete-file').allowed).toBe(false);
    });

    // Spec Agent (Fowler) - READ_WRITE for docs
    test('Spec Agent can write documentation but has limited tool access', () => {
      expect(canUseTool('spec-agent', 'read-file').allowed).toBe(true);
      expect(canUseTool('spec-agent', 'write-file').allowed).toBe(true);
      expect(canUseTool('spec-agent', 'edit-file').allowed).toBe(true);
      expect(canUseTool('spec-agent', 'web-search').allowed).toBe(true);

      // Should not have access to code execution
      expect(canUseTool('spec-agent', 'run-code').allowed).toBe(false);
      expect(canUseTool('spec-agent', 'run-tests').allowed).toBe(false);
      expect(canUseTool('spec-agent', 'lint-code').allowed).toBe(false);
    });

    // Planner (Doshi) - READ_ONLY
    test('Planner has READ_ONLY access to planning tools', () => {
      expect(canUseTool('planner', 'read-file').allowed).toBe(true);
      expect(canUseTool('planner', 'web-search').allowed).toBe(true);
      expect(canUseTool('planner', 'dependency-audit').allowed).toBe(true);
      expect(canUseTool('planner', 'git-log').allowed).toBe(true);

      // Should not have write access
      expect(canUseTool('planner', 'write-file').allowed).toBe(false);
      expect(canUseTool('planner', 'git-commit').allowed).toBe(false);
    });

    // Designer (Jobs) - READ_ONLY + web
    test('Designer has minimal READ_ONLY access', () => {
      expect(canUseTool('designer', 'read-file').allowed).toBe(true);
      expect(canUseTool('designer', 'web-fetch').allowed).toBe(true);
      expect(canUseTool('designer', 'web-search').allowed).toBe(true);

      // Should not have analysis tools
      expect(canUseTool('designer', 'dependency-audit').allowed).toBe(false);
      expect(canUseTool('designer', 'code-complexity').allowed).toBe(false);
      expect(canUseTool('designer', 'write-file').allowed).toBe(false);
    });

    // Researcher (Scott) - READ_ONLY + extensive web
    test('Researcher has web and analysis READ_ONLY access', () => {
      expect(canUseTool('researcher', 'read-file').allowed).toBe(true);
      expect(canUseTool('researcher', 'web-fetch').allowed).toBe(true);
      expect(canUseTool('researcher', 'web-search').allowed).toBe(true);
      expect(canUseTool('researcher', 'dependency-audit').allowed).toBe(true);
      expect(canUseTool('researcher', 'code-complexity').allowed).toBe(true);
      expect(canUseTool('researcher', 'find-symbol').allowed).toBe(true);

      // Should not have write access
      expect(canUseTool('researcher', 'write-file').allowed).toBe(false);
    });

    // QA (Whittaker) - READ_WRITE for tests
    test('QA has READ_WRITE access to testing tools', () => {
      expect(canUseTool('qa', 'read-file').allowed).toBe(true);
      expect(canUseTool('qa', 'write-file').allowed).toBe(true);
      expect(canUseTool('qa', 'run-tests').allowed).toBe(true);
      expect(canUseTool('qa', 'run-code').allowed).toBe(true);
      expect(canUseTool('qa', 'test-coverage').allowed).toBe(true);
      expect(canUseTool('qa', 'secrets-scan').allowed).toBe(true);

      // Should not have ADMIN tools
      expect(canUseTool('qa', 'docker').allowed).toBe(false);
      expect(canUseTool('qa', 'delete-file').allowed).toBe(false);
      expect(canUseTool('qa', 'run-shell').allowed).toBe(false);
    });

    // Security (Schneier) - READ_ONLY + security tools
    test('Security has security-focused READ_ONLY access', () => {
      expect(canUseTool('security', 'read-file').allowed).toBe(true);
      expect(canUseTool('security', 'search-files').allowed).toBe(true);
      expect(canUseTool('security', 'dependency-audit').allowed).toBe(true);
      expect(canUseTool('security', 'secrets-scan').allowed).toBe(true);
      expect(canUseTool('security', 'code-complexity').allowed).toBe(true);

      // Should not have write access
      expect(canUseTool('security', 'write-file').allowed).toBe(false);
      expect(canUseTool('security', 'git-commit').allowed).toBe(false);
    });
    // Integrator (Tesla) - READ_WRITE + infra (but docker requires ADMIN, so blocked by permission level)
    test('Integrator has infrastructure access but docker blocked by permission level', () => {
      expect(canUseTool('integrator', 'read-file').allowed).toBe(true);
      expect(canUseTool('integrator', 'write-file').allowed).toBe(true);
      // Docker requires ADMIN, integrator has READ_WRITE
      expect(canUseTool('integrator', 'docker').allowed).toBe(false);
      expect(canUseTool('integrator', 'env-manager').allowed).toBe(false);
      // run-shell also requires ADMIN
      expect(canUseTool('integrator', 'run-shell').allowed).toBe(false);
      expect(canUseTool('integrator', 'port-check').allowed).toBe(true);

      // Should not have delete-file (ADMIN)
      expect(canUseTool('integrator', 'delete-file').allowed).toBe(false);
    });

    // Docs (Knuth) - READ_WRITE for docs
    test('Docs has documentation-focused READ_WRITE access', () => {
      expect(canUseTool('docs', 'read-file').allowed).toBe(true);
      expect(canUseTool('docs', 'write-file').allowed).toBe(true);
      expect(canUseTool('docs', 'edit-file').allowed).toBe(true);
      expect(canUseTool('docs', 'git-commit').allowed).toBe(true);
      expect(canUseTool('docs', 'web-search').allowed).toBe(true);
      expect(canUseTool('docs', 'lint-code').allowed).toBe(true);

      // Should not have code execution
      expect(canUseTool('docs', 'run-code').allowed).toBe(false);
      expect(canUseTool('docs', 'run-tests').allowed).toBe(false);
    });

    // Scout - READ_ONLY (minimal access)
    test('Scout has minimal READ_ONLY access including git-log', () => {
      expect(canUseTool('scout', 'read-file').allowed).toBe(true);
      expect(canUseTool('scout', 'list-dir').allowed).toBe(true);
      expect(canUseTool('scout', 'search-files').allowed).toBe(true);
      expect(canUseTool('scout', 'web-fetch').allowed).toBe(true);
      expect(canUseTool('scout', 'git-log').allowed).toBe(true); // Scout has git-log in their list

      // Should not have write access
      expect(canUseTool('scout', 'write-file').allowed).toBe(false);
      expect(canUseTool('scout', 'dependency-audit').allowed).toBe(false);
    });

  describe('getAllowedTools() - Agent Tool Access', () => {
    test('Executor (Ford) has access to all 30 tools', () => {
      const tools = getAllowedTools('executor');
      const allToolIds = listToolIds();

      expect(tools.length).toBe(allToolIds.length);
      expect(tools.length).toBe(30);

      // Check some specific tools
      expect(tools).toContain('delete-file');
      expect(tools).toContain('run-shell');
      expect(tools).toContain('docker');
      expect(tools).toContain('write-file');
      expect(tools).toContain('read-file');
    });

    test('Architect has access to 26 tools (no ADMIN tools due to permission level)', () => {
      const tools = getAllowedTools('architect');

      expect(tools.length).toBe(26); // Has 26 READ_WRITE and READ_ONLY tools

      // Should have these
      expect(tools).toContain('read-file');
      expect(tools).toContain('write-file');
      expect(tools).toContain('run-tests');
      expect(tools).toContain('git-commit');

      // Should NOT have ADMIN tools (filtered by permission level)
      expect(tools).not.toContain('delete-file');
      expect(tools).not.toContain('run-shell');
      expect(tools).not.toContain('docker');
      expect(tools).not.toContain('env-manager');
    });

    test('Security has security-focused tools only', () => {
      const tools = getAllowedTools('security');

      // Should have security tools
      expect(tools).toContain('read-file');
      expect(tools).toContain('search-files');
      expect(tools).toContain('dependency-audit');
      expect(tools).toContain('secrets-scan');
      expect(tools).toContain('code-complexity');

      // Should NOT have write tools
      expect(tools).not.toContain('write-file');
      expect(tools).not.toContain('git-commit');
      expect(tools).not.toContain('run-tests');
    });

    test('Scout has minimal tool set (6 tools)', () => {
      const tools = getAllowedTools('scout');

      expect(tools.length).toBe(6); // READ_ONLY tools only

      expect(tools).toContain('read-file');
      expect(tools).toContain('list-dir');
      expect(tools).toContain('search-files');
      expect(tools).toContain('web-fetch');
      expect(tools).toContain('codebase-index');
    });

    test('Designer has 7 tools', () => {
      const tools = getAllowedTools('designer');

      expect(tools.length).toBe(7);

      expect(tools).toContain('read-file');
      expect(tools).toContain('web-fetch');
      expect(tools).toContain('web-search');
    });

    test('Integrator has infrastructure tools but ADMIN tools filtered by permission level', () => {
      const tools = getAllowedTools('integrator');

      // Docker, env-manager, run-shell require ADMIN, integrator has READ_WRITE
      expect(tools).not.toContain('docker');
      expect(tools).not.toContain('env-manager');
      expect(tools).not.toContain('run-shell');

      // But integrator has these infrastructure tools
      expect(tools).toContain('port-check');
      expect(tools).toContain('package-manager');
    });
  });

  describe('hasWildcardAccess() - Wildcard Detection', () => {
    test('Only executor has wildcard access', () => {
      expect(hasWildcardAccess('executor')).toBe(true);

      // All other agents should not have wildcard
      ALL_AGENTS.filter((a) => a !== 'executor').forEach((agent) => {
        expect(hasWildcardAccess(agent)).toBe(false);
      });
    });
  });

  describe('getAgentPermissionLevel() - Permission Levels', () => {
    test('Correct permission levels for all agents', () => {
      expect(getAgentPermissionLevel('executor')).toBe(PermissionLevel.ADMIN);
      expect(getAgentPermissionLevel('integrator')).toBe(PermissionLevel.READ_WRITE);
      expect(getAgentPermissionLevel('architect')).toBe(PermissionLevel.READ_WRITE);
      expect(getAgentPermissionLevel('coder')).toBe(PermissionLevel.READ_WRITE);
      expect(getAgentPermissionLevel('spec-agent')).toBe(PermissionLevel.READ_WRITE);
      expect(getAgentPermissionLevel('qa')).toBe(PermissionLevel.READ_WRITE);
      expect(getAgentPermissionLevel('docs')).toBe(PermissionLevel.READ_WRITE);

      expect(getAgentPermissionLevel('reviewer')).toBe(PermissionLevel.READ_ONLY);
      expect(getAgentPermissionLevel('planner')).toBe(PermissionLevel.READ_ONLY);
      expect(getAgentPermissionLevel('designer')).toBe(PermissionLevel.READ_ONLY);
      expect(getAgentPermissionLevel('researcher')).toBe(PermissionLevel.READ_ONLY);
      expect(getAgentPermissionLevel('security')).toBe(PermissionLevel.READ_ONLY);
      expect(getAgentPermissionLevel('scout')).toBe(PermissionLevel.READ_ONLY);
    });
  });

  describe('getToolDenialReason() - Detailed Denial Messages', () => {
    test('Returns specific reason when tool not in allowed list', () => {
      const reason = getToolDenialReason('reviewer', 'docker');
      expect(reason).toContain('not in the allowed tools list');
    });

    test('Returns specific reason when permission level insufficient', () => {
      const result = canUseTool('reviewer', 'write-file');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    test('Returns undefined for allowed access', () => {
      const reason = getToolDenialReason('executor', 'delete-file');
      expect(reason).toBeUndefined();
    });
  });
});

// ============================================================================
// End-to-End Tool Execution Tests (Safe Operations Only)
// ============================================================================

describe('End-to-End Tool Execution - Safe Operations', () => {
  beforeEach(async () => {
    await cleanupTestDir();
    await setupTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  describe('read-file execution', () => {
    test('successfully reads existing file', async () => {
      const content = 'Hello, Integration Test!';
      await createTestFile('test-read.txt', content);

      const result = await readFile({ path: path.join('tmp-test-tool-integration', 'test-read.txt'), encoding: 'utf8' });

      expect(result.content).toBe(content);
      expect(result.size).toBe(content.length);
      expect(result.encoding).toBe('utf8');
    });

    test('reads file with offset and limit', async () => {
      const lines = ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5'];
      await createTestFile('test-offset.txt', lines.join('\n'));

      const result = await readFile({
        path: path.join('tmp-test-tool-integration', 'test-offset.txt'),
        encoding: 'utf8',
        offset: 1,
        limit: 3,
      });

      expect(result.content).toBe('Line 2\nLine 3\nLine 4');
    });
  });

  describe('list-dir execution', () => {
    test('successfully lists project root', async () => {
      const result = await listDir({ path: '.', recursive: false });

      expect(result.path).toBe('.');
      expect(result.entries.length).toBeGreaterThan(0);

      const entryNames = result.entries.map((e) => e.name);
      expect(entryNames).toContain('src');
      expect(entryNames).toContain('package.json');
    });

    test('lists test directory with file types', async () => {
      await createTestFile('file1.txt', 'content1');
      await createTestFile('file2.txt', 'content2');
      await Bun.spawn(['mkdir', '-p', path.join(TEST_DIR, 'subdir')]).exited;

      const result = await listDir({ path: 'tmp-test-tool-integration', recursive: false });

      expect(result.entries.length).toBe(3);

      const fileEntry = result.entries.find((e) => e.name === 'file1.txt');
      const dirEntry = result.entries.find((e) => e.name === 'subdir');

      expect(fileEntry?.type).toBe('file');
      expect(dirEntry?.type).toBe('directory');
    });
  });

  describe('type-check execution', () => {
    test('runs type-check on project', async () => {
      const result = await executeTypeCheck();

      // Should pass for this project
      expect(result.diagnostics).toBeDefined();
      expect(Array.isArray(result.diagnostics)).toBe(true);
    });

    test('type-check with specific file pattern', async () => {
      const result = await executeTypeCheck('src/mastra/tools/tool-guard.ts');

      expect(result.diagnostics).toBeDefined();
    });
  });

  describe('code-complexity execution', () => {
    test('calculates complexity for project files', async () => {
      const result = await analyzeCodeComplexity(['src/mastra/tools/tool-guard.ts']);

      expect(result.files.length).toBeGreaterThan(0);
      expect(result.summary.totalFiles).toBeGreaterThan(0);
      expect(result.summary.totalFunctions).toBeGreaterThan(0);
    });

    test('detects high complexity violations', async () => {
      const result = await analyzeCodeComplexity(['src/mastra/tools'], 5);

      expect(result.summary).toBeDefined();
      expect(typeof result.summary.violations).toBe('number');
    });
    });
  });

  describe('lint-code execution', () => {
    test.skip('runs linting on project files (skipped - npx not available)', async () => {
      const result = await executeLint('src/mastra/tools/tool-guard.ts');

      expect(result.issues).toBeDefined();
      expect(Array.isArray(result.issues)).toBe(true);
    });
  });

// ============================================================================
// Permission Violation Tests
// ============================================================================

describe('Permission Violation Tests', () => {
  describe('READ_ONLY agents blocked from WRITE operations', () => {
    const readOnlyAgents = ['reviewer', 'planner', 'designer', 'researcher', 'security', 'scout'];

    readOnlyAgents.forEach((agent) => {
      test(`${agent} is blocked from write-file`, () => {
        const result = canUseTool(agent, 'write-file');
        expect(result.allowed).toBe(false);
      });

      test(`${agent} is blocked from edit-file`, () => {
        const result = canUseTool(agent, 'edit-file');
        expect(result.allowed).toBe(false);
      });

      test(`${agent} is blocked from git-commit`, () => {
        const result = canUseTool(agent, 'git-commit');
        expect(result.allowed).toBe(false);
      });
    });
  });

  describe('Non-ADMIN agents blocked from ADMIN operations', () => {
    const nonAdminAgents = ALL_AGENTS.filter((a) => a !== 'executor');

    nonAdminAgents.forEach((agent) => {
      test(`${agent} is blocked from delete-file`, () => {
        const result = canUseTool(agent, 'delete-file');
        expect(result.allowed).toBe(false);
      });
    });

    test('Integrator blocked from run-shell (ADMIN required)', () => {
      // run-shell requires ADMIN permission, integrator has READ_WRITE
      expect(canUseTool('integrator', 'run-shell').allowed).toBe(false);
    });

    test('Integrator blocked from docker (ADMIN required)', () => {
      // docker requires ADMIN permission, integrator has READ_WRITE
      expect(canUseTool('integrator', 'docker').allowed).toBe(false);
    });

  describe('Tool not in allowed list blocks access', () => {
    test('Coder blocked from web-search (not in list)', () => {
      // Coder doesn't have web-search in their tool list
      const result = canUseTool('coder', 'web-search');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in the allowed tools list');
    });
    test('Coder blocked from web-search (not in list)', () => {
      // Coder doesn't have web-search in their tool list
      const result = canUseTool('coder', 'web-search');
      expect(result.allowed).toBe(false);
    });

    test('QA blocked from docker (not in list + ADMIN required)', () => {
      const result = canUseTool('qa', 'docker');
      expect(result.allowed).toBe(false);
    });
  });
});

// ============================================================================
// Integration Tests - Tool Guard + Tool Execution
// ============================================================================

describe('Tool Guard + Execution Integration', () => {
  beforeEach(async () => {
    await cleanupTestDir();
    await setupTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  test('Ford can execute read-file after permission check', async () => {
    // Permission check
    const permission = canUseTool('executor', 'read-file');
    expect(permission.allowed).toBe(true);

    // Actual execution
    await createTestFile('ford-test.txt', 'Ford content');
    const result = await readFile({ path: path.join('tmp-test-tool-integration', 'ford-test.txt'), encoding: 'utf8' });

    expect(result.content).toBe('Ford content');
  });

  test('Reviewer blocked from write-file in permission check', async () => {
    // Permission check should block
    const permission = canUseTool('reviewer', 'write-file');
    expect(permission.allowed).toBe(false);
    expect(permission.reason).toBeDefined();
  });

  test('Coder can execute allowed tools (type-check)', async () => {
    const permission = canUseTool('coder', 'type-check');
    expect(permission.allowed).toBe(true);

    const result = await executeTypeCheck('src/mastra/tools/tool-guard.ts');
    expect(result.errors).toBeDefined();
  });

  test('Security can execute security tools (code-complexity)', async () => {
    const permission = canUseTool('security', 'code-complexity');
    expect(permission.allowed).toBe(true);

    const result = await analyzeCodeComplexity(['src/mastra/tools']);
    expect(result.files.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

describe('Edge Cases and Error Handling', () => {
  test('canUseTool returns correct error for unknown agent', () => {
    const result = canUseTool('unknown-agent', 'read-file');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not found in tool access registry');
  });

  test('canUseTool returns correct error for unknown tool', () => {
    const result = canUseTool('executor', 'unknown-tool');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not found in builtin tools registry');
  });

  test('getAllowedTools returns empty array for unknown agent', () => {
    const tools = getAllowedTools('nonexistent-agent');
    expect(tools).toEqual([]);
  });

  test('Permission level hierarchy is enforced correctly', () => {
    // READ_ONLY can use READ_ONLY
    expect(canUseTool('reviewer', 'read-file').allowed).toBe(true);

    // READ_ONLY cannot use READ_WRITE
    expect(canUseTool('reviewer', 'write-file').allowed).toBe(false);

    // READ_ONLY cannot use ADMIN
    expect(canUseTool('reviewer', 'delete-file').allowed).toBe(false);

    // READ_WRITE can use READ_WRITE
    expect(canUseTool('coder', 'write-file').allowed).toBe(true);

    // READ_WRITE can use READ_ONLY
    expect(canUseTool('coder', 'read-file').allowed).toBe(true);

    // READ_WRITE cannot use ADMIN
    expect(canUseTool('coder', 'delete-file').allowed).toBe(false);

    // ADMIN can use all levels
    expect(canUseTool('executor', 'delete-file').allowed).toBe(true);
    expect(canUseTool('executor', 'write-file').allowed).toBe(true);
    expect(canUseTool('executor', 'read-file').allowed).toBe(true);
  });

  test('All agents are registered in AGENT_TOOL_ACCESS', () => {
    ALL_AGENTS.forEach((agent) => {
      expect(AGENT_TOOL_ACCESS[agent]!).toBeDefined();
      expect(AGENT_TOOL_ACCESS[agent]!.permission).toBeDefined();
      expect(AGENT_TOOL_ACCESS[agent]!.tools).toBeDefined();
    });
  });

  test('All tools in agent lists exist in BUILTIN_TOOLS', () => {
    ALL_AGENTS.forEach((agent) => {
      const access = AGENT_TOOL_ACCESS[agent]!;
      if (access.tools !== '*') {
        access.tools.forEach((toolId) => {
          expect(BUILTIN_TOOLS[toolId]).toBeDefined();
        });
      }
    });
  });
});

// ============================================================================
// Tool Registry Validation
// ============================================================================

describe('Tool Registry Validation', () => {
  test('All 30 tools are registered', () => {
    const toolIds = listToolIds();
    expect(toolIds.length).toBe(30);
  });

  test('Each tool has required properties', () => {
    Object.values(BUILTIN_TOOLS).forEach((tool) => {
      expect(tool.id).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.category).toBeDefined();
      expect(tool.permissionRequired).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    });
  });

  test('Tool IDs match their keys in BUILTIN_TOOLS', () => {
    Object.entries(BUILTIN_TOOLS).forEach(([key, tool]) => {
      expect(tool.id).toBe(key);
    });
  });

  test('Tools are categorized correctly', () => {
    const categories = ['code', 'filesystem', 'git', 'web', 'analysis', 'infra', 'codebase'];

    Object.values(BUILTIN_TOOLS).forEach((tool) => {
      expect(categories).toContain(tool.category);
    });
  });
});

});
});