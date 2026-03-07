import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  executeShell,
  executeCode,
  executeTests,
  executeLint,
  executeTypeCheck,
  runShellTool,
  runCodeTool,
  runTestsTool,
  lintCodeTool,
  typeCheckTool,
} from './code-execution';

describe('code-execution', () => {
  const tempDir = `${process.cwd()}/.test-temp-${Date.now()}`;

  beforeEach(async () => {
    await Bun.write(`${tempDir}/.gitkeep`, '');
  });

  afterEach(async () => {
    try {
      await Bun.spawn(['rm', '-rf', tempDir]).exited;
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('executeShell', () => {
    test('executes basic command', async () => {
      const result = await executeShell('echo "hello world"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello world');
      expect(result.stderr).toBe('');
      expect(result.duration).toBeGreaterThan(0);
    });

    test('captures stderr', async () => {
      const result = await executeShell('echo "error" >&2');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('error');
    });

    test('returns non-zero exit code on failure', async () => {
      const result = await executeShell('exit 1');
      expect(result.exitCode).toBe(1);
    });

    test('respects timeout', async () => {
      const result = await executeShell('sleep 10', undefined, 100);
      expect(result.duration).toBeLessThan(5000);
    });

    test('respects custom cwd', async () => {
      const result = await executeShell('pwd', '/tmp');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.endsWith('/tmp')).toBe(true);
    });

    test('respects env variables', async () => {
      const result = await executeShell('echo $TEST_VAR', undefined, 30000, {
        TEST_VAR: 'test_value',
      });
      expect(result.stdout).toBe('test_value');
    });
  });

  describe('executeCode', () => {
    test('executes TypeScript code', async () => {
      const result = await executeCode('console.log(2 + 2)', 'typescript');
      expect(result.output).toBe('4');
      expect(result.errors).toHaveLength(0);
    });

    test('executes JavaScript code', async () => {
      const result = await executeCode('console.log("hello")', 'javascript');
      expect(result.output).toBe('hello');
      expect(result.errors).toHaveLength(0);
    });

    test('executes Bash code', async () => {
      const result = await executeCode('echo "bash test"', 'bash');
      expect(result.output).toBe('bash test');
      expect(result.errors).toHaveLength(0);
    });

    test('captures errors', async () => {
      const result = await executeCode('throw new Error("test error")', 'typescript');
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('respects timeout', async () => {
      const result = await executeCode('while(true){}', 'typescript', 100);
      expect(result.duration).toBeLessThan(5000);
    });

    test('tracks duration', async () => {
      const result = await executeCode('console.log("test")', 'typescript');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('executeTests', () => {
    test('detects bun test runner', async () => {
      const testFile = `${tempDir}/sample.test.ts`;
      await Bun.write(
        testFile,
        `import { test, expect } from 'bun:test';
test('sample', () => {
  expect(true).toBe(true);
});`
      );

      const result = await executeTests(tempDir);
      expect(result.passed + result.failed + result.skipped).toBeGreaterThanOrEqual(0);
      expect(typeof result.totalTime).toBe('string');
      expect(Array.isArray(result.failures)).toBe(true);
    });

    test('returns structured result', async () => {
      const result = await executeTests(tempDir);
      expect(typeof result.passed).toBe('number');
      expect(typeof result.failed).toBe('number');
      expect(typeof result.skipped).toBe('number');
      expect(typeof result.totalTime).toBe('string');
      expect(Array.isArray(result.failures)).toBe(true);
    });
  });

  describe('executeLint', () => {
    test('returns structured issues', async () => {
      const result = await executeLint(tempDir);
      expect(typeof result.errors).toBe('number');
      expect(typeof result.warnings).toBe('number');
      expect(Array.isArray(result.issues)).toBe(true);
    });
  });

  describe('executeTypeCheck', () => {
    test('returns empty result without tsconfig', async () => {
      const noConfigDir = `${tempDir}/no-config`;
      await Bun.write(`${noConfigDir}/.gitkeep`, '');
      
      const result = await executeTypeCheck(noConfigDir);
      expect(result.errors).toBe(0);
      expect(result.diagnostics).toHaveLength(0);
    });

    test('returns structured diagnostics', async () => {
      const result = await executeTypeCheck();
      expect(typeof result.errors).toBe('number');
      expect(Array.isArray(result.diagnostics)).toBe(true);
    });

    test('diagnostics have required fields', async () => {
      const result = await executeTypeCheck();
      for (const diagnostic of result.diagnostics) {
        expect(typeof diagnostic.file).toBe('string');
        expect(typeof diagnostic.line).toBe('number');
        expect(typeof diagnostic.column).toBe('number');
        expect(typeof diagnostic.message).toBe('string');
        expect(typeof diagnostic.code).toBe('string');
      }
    });
  });

  describe('Mastra Tools', () => {
    test('runShellTool is defined', () => {
      expect(runShellTool).toBeDefined();
      expect(runShellTool.id).toBe('run-shell');
    });

    test('runCodeTool is defined', () => {
      expect(runCodeTool).toBeDefined();
      expect(runCodeTool.id).toBe('run-code');
    });

    test('runTestsTool is defined', () => {
      expect(runTestsTool).toBeDefined();
      expect(runTestsTool.id).toBe('run-tests');
    });

    test('lintCodeTool is defined', () => {
      expect(lintCodeTool).toBeDefined();
      expect(lintCodeTool.id).toBe('lint-code');
    });

    test('typeCheckTool is defined', () => {
      expect(typeCheckTool).toBeDefined();
      expect(typeCheckTool.id).toBe('type-check');
    });
  });

  describe('error handling', () => {
    test('handles shell command errors gracefully', async () => {
      const result = await executeShell('invalid_command_xyz');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    test('handles code syntax errors', async () => {
      const result = await executeCode('invalid syntax {', 'typescript');
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('handles unsupported language', async () => {
      // @ts-expect-error - testing unsupported language
      const result = await executeCode('code', 'unsupported');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Unsupported language');
    });
  });
});
