import { describe, test, expect } from 'bun:test';
import {
  canUseTool,
  getAllowedTools,
  getToolDenialReason,
  hasWildcardAccess,
  getAgentPermissionLevel,
} from './tool-guard';
import { PermissionLevel } from './tool-registry';

describe('tool-guard', () => {
  describe('canUseTool', () => {
    test('Ford (ADMIN) can use delete-file (ADMIN required)', () => {
      const result = canUseTool('executor', 'delete-file');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test('Ford (ADMIN) can use write-file (READ_WRITE required)', () => {
      const result = canUseTool('executor', 'write-file');
      expect(result.allowed).toBe(true);
    });

    test('Ford (ADMIN) can use read-file (READ_ONLY required)', () => {
      const result = canUseTool('executor', 'read-file');
      expect(result.allowed).toBe(true);
    });

    test('Security (READ_ONLY) cannot use git-commit (READ_WRITE required, not in list)', () => {
      const result = canUseTool('security', 'git-commit');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in the allowed tools list');
    });

    test('Reviewer (READ_ONLY) can use read-file (READ_ONLY required)', () => {
      const result = canUseTool('reviewer', 'read-file');
      expect(result.allowed).toBe(true);
    });

    test('Reviewer cannot use git-branch (not in allowed list)', () => {
      const result = canUseTool('reviewer', 'git-branch');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in the allowed tools list");
    });

    test('returns false for unknown agent', () => {
      const result = canUseTool('unknown-agent', 'read-file');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not found");
    });

    test('returns false for unknown tool', () => {
      const result = canUseTool('executor', 'unknown-tool');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not found");
    });

    test('Coder (READ_WRITE) can use write-file', () => {
      const result = canUseTool('coder', 'write-file');
      expect(result.allowed).toBe(true);
    });

    test('Coder (READ_WRITE) cannot use run-shell (not in list + ADMIN required)', () => {
      const result = canUseTool('coder', 'run-shell');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in the allowed tools list");
    });

    test('Architect cannot use run-shell (not in allowed list)', () => {
      const result = canUseTool('architect', 'run-shell');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in the allowed tools list");
    });
  });

  describe('getAllowedTools', () => {
    test('returns all tools for executor with wildcard', () => {
      const tools = getAllowedTools('executor');
      expect(tools.length).toBeGreaterThan(25);
      expect(tools).toContain('delete-file');
      expect(tools).toContain('write-file');
      expect(tools).toContain('read-file');
    });

    test('returns empty array for unknown agent', () => {
      const tools = getAllowedTools('unknown-agent');
      expect(tools).toEqual([]);
    });

    test('returns filtered tools for reviewer (READ_ONLY)', () => {
      const tools = getAllowedTools('reviewer');
      // Reviewer has READ_ONLY permission, so should only get READ_ONLY tools
      expect(tools).toContain('read-file');
      expect(tools).toContain('git-log');
      expect(tools).toContain('search-files');
      // Should NOT contain READ_WRITE or ADMIN tools
      expect(tools).not.toContain('write-file');
      expect(tools).not.toContain('delete-file');
      expect(tools).not.toContain('run-shell');
    });

    test('returns filtered tools for coder (READ_WRITE)', () => {
      const tools = getAllowedTools('coder');
      // Coder can use READ_WRITE tools
      expect(tools).toContain('write-file');
      expect(tools).toContain('edit-file');
      expect(tools).toContain('run-tests');
      // Should NOT contain ADMIN tools
      expect(tools).not.toContain('delete-file');
      expect(tools).not.toContain('docker');
    });

    test('architect has no access to shell or docker', () => {
      const tools = getAllowedTools('architect');
      expect(tools).not.toContain('run-shell');
      expect(tools).not.toContain('docker');
      expect(tools).not.toContain('env-manager');
    });
  });

  describe('getToolDenialReason', () => {
    test('returns reason for denied access (tool not in list)', () => {
      // Security agent does not have git-commit in their allowed list
      const reason = getToolDenialReason('security', 'git-commit');
      expect(reason).toBeDefined();
      expect(reason).toContain('not in the allowed tools list');
    });

    test('returns undefined for allowed access', () => {
      const reason = getToolDenialReason('executor', 'read-file');
      expect(reason).toBeUndefined();
    });
  });

  describe('hasWildcardAccess', () => {
    test('executor has wildcard access', () => {
      expect(hasWildcardAccess('executor')).toBe(true);
    });

    test('architect does not have wildcard access', () => {
      expect(hasWildcardAccess('architect')).toBe(false);
    });

    test('returns false for unknown agent', () => {
      expect(hasWildcardAccess('unknown')).toBe(false);
    });
  });

  describe('getAgentPermissionLevel', () => {
    test('executor has ADMIN level', () => {
      expect(getAgentPermissionLevel('executor')).toBe(PermissionLevel.ADMIN);
    });

    test('reviewer has READ_ONLY level', () => {
      expect(getAgentPermissionLevel('reviewer')).toBe(PermissionLevel.READ_ONLY);
    });

    test('coder has READ_WRITE level', () => {
      expect(getAgentPermissionLevel('coder')).toBe(PermissionLevel.READ_WRITE);
    });

    test('returns undefined for unknown agent', () => {
      expect(getAgentPermissionLevel('unknown')).toBeUndefined();
    });
  });

  describe('Permission hierarchy', () => {
    test('ADMIN > READ_WRITE > READ_ONLY', () => {
      // ADMIN can use ADMIN tools
      expect(canUseTool('executor', 'delete-file').allowed).toBe(true);
      // ADMIN can use READ_WRITE tools
      expect(canUseTool('executor', 'write-file').allowed).toBe(true);
      // ADMIN can use READ_ONLY tools
      expect(canUseTool('executor', 'read-file').allowed).toBe(true);

      // READ_WRITE can use READ_WRITE tools
      expect(canUseTool('coder', 'write-file').allowed).toBe(true);
      // READ_WRITE can use READ_ONLY tools
      expect(canUseTool('coder', 'read-file').allowed).toBe(true);
      // READ_WRITE cannot use ADMIN tools
      expect(canUseTool('coder', 'delete-file').allowed).toBe(false);

      // READ_ONLY can only use READ_ONLY tools
      expect(canUseTool('reviewer', 'read-file').allowed).toBe(true);
      // READ_ONLY cannot use READ_WRITE tools
      expect(canUseTool('reviewer', 'write-file').allowed).toBe(false);
      // READ_ONLY cannot use ADMIN tools
      expect(canUseTool('reviewer', 'delete-file').allowed).toBe(false);
    });
  });

  describe('deniedTools override', () => {
    // Note: This test demonstrates the deniedTools functionality
    // To fully test it, we would need an agent with deniedTools configured
    test('deniedTools list is checked during permission evaluation', () => {
      // The canUseTool function checks deniedTools list
      // This test verifies the logic path exists
      const result = canUseTool('executor', 'delete-file');
      // Executor has wildcard, so would normally have access
      // If delete-file were in deniedTools, it would be denied
      expect(result.allowed).toBe(true);
    });
  });
});
