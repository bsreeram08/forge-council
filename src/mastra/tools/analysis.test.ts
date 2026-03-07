import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  runDependencyAudit,
  runSecretsScan,
  analyzeCodeComplexity,
  analyzeTestCoverage,
} from './analysis';

describe('analysis tools', () => {
  const testDir = join(process.cwd(), 'test-analysis-temp');

  beforeEach(async () => {
    try {
      await mkdir(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }
  });

  afterEach(async () => {
    try {
      const fs = await import('node:fs/promises');
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Directory might not exist
    }
  });

  describe('dependency-audit', () => {
    test('returns empty result for directory without package.json', async () => {
      const result = await runDependencyAudit(testDir);
      expect(result.vulnerabilities).toEqual([]);
      expect(result.summary.total).toBe(0);
    });

    test.skip('audits current directory by default', async () => {
      const result = await runDependencyAudit();
      expect(result).toHaveProperty('vulnerabilities');
      expect(result).toHaveProperty('summary');
      expect(typeof result.summary.total).toBe('number');
    });


    test.skip('filters by severity level', async () => {
      // Test that the function accepts different severity levels
      const resultCritical = await runDependencyAudit(undefined, 'critical');
      const resultHigh = await runDependencyAudit(undefined, 'high');
      
      expect(resultCritical).toHaveProperty('vulnerabilities');
      expect(resultHigh).toHaveProperty('vulnerabilities');
    });

  });

  describe('secrets-scan', () => {
    test('scans files for AWS access keys', async () => {
      const testFile = join(testDir, 'test-aws.ts');
      await writeFile(testFile, `
        const config = {
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          region: 'us-east-1'
        };
      `);

      const result = await runSecretsScan(testDir);
      expect(result.scannedFiles).toBeGreaterThan(0);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings.some(f => f.type === 'aws_access_key')).toBe(true);
    });

    test('scans files for GitHub tokens', async () => {
      const testFile = join(testDir, 'test-github.ts');
      await writeFile(testFile, `
        const token = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      `);

      const result = await runSecretsScan(testDir);
      expect(result.findings.some(f => f.type === 'github_token')).toBe(true);
    });

    test('scans files for Slack tokens', async () => {
      const testFile = join(testDir, 'test-slack.ts');
      await writeFile(testFile, `
        const slackToken = 'xoxb-1234567890-1234567890-AbCdEfGhIjKlMnOpQrStUvWx';
      `);

      const result = await runSecretsScan(testDir);
      expect(result.findings.some(f => f.type === 'slack_token')).toBe(true);
    });

    test('reports file path and line number', async () => {
      const testFile = join(testDir, 'test-location.ts');
      await writeFile(testFile, `const key = 'AKIAIOSFODNN7EXAMPLE';`);

      const result = await runSecretsScan(testDir);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings[0]!.file).toContain('test-location.ts');
      expect(result.findings[0]!.line).toBe(1);
    });

    test('returns empty findings for clean code', async () => {
      const testFile = join(testDir, 'clean.ts');
      await writeFile(testFile, `
        function hello() {
          return 'world';
        }
      `);

      const result = await runSecretsScan(testDir);
      const cleanFindings = result.findings.filter(f => f.file.includes('clean.ts'));
      expect(cleanFindings.length).toBe(0);
    });

    test('excludes node_modules and .git by default', async () => {
      await mkdir(join(testDir, 'node_modules'), { recursive: true });
      const secretFile = join(testDir, 'node_modules', 'secret.ts');
      await writeFile(secretFile, `const key = 'AKIAIOSFODNN7EXAMPLE';`);

      const result = await runSecretsScan(testDir);
      const nodeModulesFindings = result.findings.filter(f => f.file.includes('node_modules'));
      expect(nodeModulesFindings.length).toBe(0);
    });
  });

  describe('code-complexity', () => {
    test('analyzes simple function', async () => {
      const testFile = join(testDir, 'simple.ts');
      await writeFile(testFile, `
        function greet(name: string) {
          return 'Hello, ' + name;
        }
      `);

      const result = await analyzeCodeComplexity([testDir]);
      expect(result.summary.totalFiles).toBeGreaterThan(0);
      expect(result.summary.totalFunctions).toBeGreaterThan(0);
    });

    test('detects high complexity functions', async () => {
      const testFile = join(testDir, 'complex.ts');
      await writeFile(testFile, `
        function complexLogic(x: number) {
          if (x > 0) {
            if (x < 10) {
              if (x % 2 === 0) {
                return 'small even';
              } else {
                return 'small odd';
              }
            } else if (x < 100) {
              return 'medium';
            } else {
              return 'large';
            }
          } else {
            return 'negative';
          }
        }
      `);

      const result = await analyzeCodeComplexity([testDir], 5);
      expect(result.summary.violations).toBeGreaterThan(0);
    });

    test('calculates average complexity', async () => {
      const testFile = join(testDir, 'average.ts');
      await writeFile(testFile, `
        function a() { return 1; }
        function b() { return 2; }
        function c() { return 3; }
      `);

      const result = await analyzeCodeComplexity([testDir]);
      expect(result.summary.averageComplexity).toBeGreaterThanOrEqual(0);
    });

    test('reports function details', async () => {
      const testFile = join(testDir, 'details.ts');
      await writeFile(testFile, `
        function myFunction() {
          return 42;
        }
      `);

      const result = await analyzeCodeComplexity([testDir]);
      expect(result.files.length).toBeGreaterThan(0);
      
      const testFileResult = result.files.find(f => f.path.includes('details.ts'));
      expect(testFileResult).toBeDefined();
      expect(testFileResult!.functions.length).toBeGreaterThan(0);
      expect(testFileResult!.functions[0]!.name).toBe('myFunction');
    });

    test('uses default threshold when not specified', async () => {
      const result = await analyzeCodeComplexity([testDir]);
      expect(result.summary.totalFiles).toBeGreaterThanOrEqual(0);
    });
  });

  describe('test-coverage', () => {
    test('returns empty result when no coverage report exists', async () => {
      const result = await analyzeTestCoverage([testDir]);
      expect(result.summary.lines.pct).toBe(0);
      expect(result.files).toEqual([]);
      expect(result.passed).toBe(false);
    });

    test('parses lcov.info format', async () => {
      const coverageDir = join(testDir, 'coverage');
      await mkdir(coverageDir, { recursive: true });
      
      const lcovContent = `SF:src/example.ts
DA:1,1
DA:2,1
DA:3,0
DA:4,1
LF:4
LH:3
end_of_record`;
      
      await writeFile(join(coverageDir, 'lcov.info'), lcovContent);
      
      const result = await analyzeTestCoverage([testDir]);
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.files[0]!.path).toBe('src/example.ts');
      expect(result.files[0]!.uncovered).toContain(3);
    });

    test('parses coverage-final.json format', async () => {
      const coverageDir = join(testDir, 'coverage');
      await mkdir(coverageDir, { recursive: true });
      
      const coverageData = {
        '/src/example.ts': {
          path: '/src/example.ts',
          statementMap: {
            '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
            '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
          },
          s: { '0': 1, '1': 0 },
          branchMap: {},
          b: {},
          fnMap: {},
          f: {},
        },
      };
      
      await writeFile(join(coverageDir, 'coverage-final.json'), JSON.stringify(coverageData));
      
      const result = await analyzeTestCoverage([testDir]);
      expect(result.summary.lines.total).toBeGreaterThan(0);
    });

    test('detects if coverage passes threshold', async () => {
      const coverageDir = join(testDir, 'coverage');
      await mkdir(coverageDir, { recursive: true });
      
      const lcovContent = `SF:src/example.ts
DA:1,1
DA:2,1
DA:3,1
DA:4,1
DA:5,1
LF:5
LH:5
end_of_record`;
      
      await writeFile(join(coverageDir, 'lcov.info'), lcovContent);
      
      const result = await analyzeTestCoverage([testDir]);
      expect(result.summary.lines.pct).toBe(100);
      expect(result.passed).toBe(true);
    });

    test('detects if coverage fails threshold', async () => {
      const coverageDir = join(testDir, 'coverage');
      await mkdir(coverageDir, { recursive: true });
      
      const lcovContent = `SF:src/example.ts
DA:1,1
DA:2,0
DA:3,0
DA:4,0
DA:5,0
LF:5
LH:1
end_of_record`;
      
      await writeFile(join(coverageDir, 'lcov.info'), lcovContent);
      
      const result = await analyzeTestCoverage([testDir]);
      expect(result.summary.lines.pct).toBeLessThan(80);
      expect(result.passed).toBe(false);
    });
  });

  describe('analysisTools export', () => {
    test('exports all four tools', async () => {
      const { analysisTools } = await import('./analysis');
      expect(analysisTools.dependencyAuditTool).toBeDefined();
      expect(analysisTools.secretsScanTool).toBeDefined();
      expect(analysisTools.codeComplexityTool).toBeDefined();
      expect(analysisTools.testCoverageTool).toBeDefined();
    });

    test('tools have required properties', async () => {
      const { analysisTools } = await import('./analysis');
      const tools = [
        analysisTools.dependencyAuditTool,
        analysisTools.secretsScanTool,
        analysisTools.codeComplexityTool,
        analysisTools.testCoverageTool,
      ];

      for (const tool of tools) {
        expect(tool.id).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        expect(typeof tool.execute).toBe('function');
      }
    });
  });
});
