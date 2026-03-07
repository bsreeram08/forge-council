import { z } from 'zod';

// ============================================================================
// Types & Interfaces
// ============================================================================

interface Vulnerability {
  package: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  cve?: string;
  description: string;
  fixAvailable: boolean;
  fixedIn?: string;
}

interface DependencyAuditResult {
  vulnerabilities: Vulnerability[];
  summary: {
    total: number;
    critical: number;
    high: number;
    moderate: number;
    low: number;
  };
}

interface SecretFinding {
  file: string;
  line: number;
  type: string;
  pattern: string;
  match: string;
  severity: 'low' | 'medium' | 'high';
}

interface SecretsScanResult {
  findings: SecretFinding[];
  scannedFiles: number;
}

interface FunctionComplexity {
  name: string;
  line: number;
  cyclomatic: number;
  cognitive?: number;
  lines: number;
}

interface FileComplexity {
  path: string;
  functions: FunctionComplexity[];
  averageComplexity: number;
  violations: number;
}

interface CodeComplexityResult {
  files: FileComplexity[];
  summary: {
    totalFiles: number;
    totalFunctions: number;
    averageComplexity: number;
    violations: number;
  };
}

interface CoverageMetrics {
  total: number;
  covered: number;
  pct: number;
}

interface FileCoverage {
  path: string;
  statements: number;
  branches: number;
  functions: number;
  lines: number;
  uncovered?: number[];
}

interface TestCoverageResult {
  summary: {
    statements: CoverageMetrics;
    branches: CoverageMetrics;
    functions: CoverageMetrics;
    lines: CoverageMetrics;
  };
  files: FileCoverage[];
  passed: boolean;
}

// ============================================================================
// Secret Detection Patterns
// ============================================================================

const SECRET_PATTERNS = [
  { type: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/, severity: 'high' as const },
  { type: 'github_token', pattern: /ghp_[0-9a-zA-Z]{36}/, severity: 'high' as const },
  { type: 'github_oauth', pattern: /gho_[0-9a-zA-Z]{36}/, severity: 'high' as const },
  { type: 'slack_token', pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}/, severity: 'high' as const },
  { type: 'openai_api_key', pattern: /sk-[a-zA-Z0-9]{48}/, severity: 'high' as const },
  { type: 'stripe_key', pattern: /sk_live_[0-9a-zA-Z]{24,}/, severity: 'high' as const },
  { type: 'jwt_token', pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/, severity: 'medium' as const },
  { type: 'private_key', pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, severity: 'high' as const },
];

// ============================================================================
// Helper Functions
// ============================================================================

async function runShellCommand(
  command: string,
  cwd?: string,
  timeout: number = 60000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['sh', '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: cwd ?? process.cwd(),
    env: process.env,
    timeout,
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

async function findFiles(
  cwd: string,
  extensions: string[],
  exclude: string[] = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'],
): Promise<string[]> {
  const files: string[] = [];

  const shouldExclude = (path: string): boolean => {
    return exclude.some((ex) => path.includes(ex));
  };

  const hasMatchingExtension = (path: string): boolean => {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    return extensions.some((e) => {
      const pattern = e.replace('*.', '');
      return ext === pattern;
    });
  };

  const scanDir = async (dir: string): Promise<void> => {
    try {
      const fs = await import('node:fs/promises');
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = `${dir}/${entry.name}`;
        if (shouldExclude(fullPath)) continue;

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile() && hasMatchingExtension(fullPath)) {
          files.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  };

  await scanDir(cwd);
  return files;
}

// ============================================================================
// Dependency Audit
// ============================================================================

export async function runDependencyAudit(
  path?: string,
  severity?: 'low' | 'moderate' | 'high' | 'critical',
): Promise<DependencyAuditResult> {
  const cwd = path ?? process.cwd();
  const minSeverity = severity ?? 'low';

  const severityLevels: Record<string, number> = {
    low: 0,
    moderate: 1,
    high: 2,
    critical: 3,
  };

  const minLevel = severityLevels[minSeverity] ?? 0;

  try {
    // Try npm audit first
    const { stdout } = await runShellCommand('npm audit --json 2>&1 || true', cwd);

    let auditData: unknown;
    try {
      auditData = JSON.parse(stdout);
    } catch {
      // If JSON parsing fails, try bun audit
      const bunResult = await runShellCommand('bun audit 2>&1 || true', cwd);
      return parseBunAuditOutput(bunResult.stdout);
    }

    if (!auditData || typeof auditData !== 'object') {
      return createEmptyAuditResult();
    }

    const vulnerabilities: Vulnerability[] = [];
    let critical = 0;
    let high = 0;
    let moderate = 0;
    let low = 0;

    // Handle npm audit v2 format (advisories)
    if ('advisories' in auditData && auditData.advisories) {
      const advisories = auditData.advisories as Record<string, unknown>;
      for (const advisory of Object.values(advisories)) {
        if (typeof advisory !== 'object' || !advisory) continue;

        const sev = (advisory as { severity?: string }).severity || 'low';
        const severityLevel = severityLevels[sev] ?? 0;

        if (severityLevel >= minLevel) {
          const vuln: Vulnerability = {
            package: (advisory as { module_name?: string }).module_name || 'unknown',
            severity: sev as 'low' | 'moderate' | 'high' | 'critical',
            cve: (advisory as { cves?: string[] }).cves?.[0],
            description: (advisory as { overview?: string }).overview || 'No description',
            fixAvailable: !!((advisory as { patched_versions?: string }).patched_versions),
            fixedIn: (advisory as { patched_versions?: string }).patched_versions,
          };
          vulnerabilities.push(vuln);

          switch (sev) {
            case 'critical':
              critical++;
              break;
            case 'high':
              high++;
              break;
            case 'moderate':
              moderate++;
              break;
            default:
              low++;
          }
        }
      }
    }

    // Handle npm audit v7+ format (vulnerabilities)
    if ('vulnerabilities' in auditData && auditData.vulnerabilities) {
      const vulns = auditData.vulnerabilities as Record<string, unknown>;
      for (const [pkgName, vulnData] of Object.entries(vulns)) {
        if (typeof vulnData !== 'object' || !vulnData) continue;

        const sev = (vulnData as { severity?: string }).severity || 'low';
        const severityLevel = severityLevels[sev] ?? 0;

        if (severityLevel >= minLevel) {
          const vuln: Vulnerability = {
            package: pkgName,
            severity: sev as 'low' | 'moderate' | 'high' | 'critical',
            description: `Vulnerability in ${pkgName}`,
            fixAvailable: (vulnData as { fixAvailable?: boolean }).fixAvailable ?? false,
          };
          vulnerabilities.push(vuln);

          switch (sev) {
            case 'critical':
              critical++;
              break;
            case 'high':
              high++;
              break;
            case 'moderate':
              moderate++;
              break;
            default:
              low++;
          }
        }
      }
    }

    return {
      vulnerabilities,
      summary: {
        total: vulnerabilities.length,
        critical,
        high,
        moderate,
        low,
      },
    };
  } catch {
    return createEmptyAuditResult();
  }
}

function parseBunAuditOutput(output: string): DependencyAuditResult {
  const vulnerabilities: Vulnerability[] = [];
  let critical = 0;
  let high = 0;
  let moderate = 0;
  let low = 0;

  // Parse bun audit output format
  const lines = output.split('\n');
  for (const line of lines) {
    const match = line.match(/(\S+)\s+(.+?)\s+(low|moderate|high|critical)/i);
    if (match && match[1] && match[2] && match[3]) {
      const sev = match[3].toLowerCase() as 'low' | 'moderate' | 'high' | 'critical';
      vulnerabilities.push({
        package: match[1],
        severity: sev,
        description: match[2],
        fixAvailable: line.includes('fix'),
      });

      switch (sev) {
        case 'critical':
          critical++;
          break;
        case 'high':
          high++;
          break;
        case 'moderate':
          moderate++;
          break;
        default:
          low++;
      }
    }
  }

  return {
    vulnerabilities,
    summary: {
      total: vulnerabilities.length,
      critical,
      high,
      moderate,
      low,
    },
  };
}

function createEmptyAuditResult(): DependencyAuditResult {
  return {
    vulnerabilities: [],
    summary: {
      total: 0,
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0,
    },
  };
}

// ============================================================================
// Secrets Scan
// ============================================================================

export async function runSecretsScan(
  path?: string,
  includeGitHistory?: boolean,
): Promise<SecretsScanResult> {
  const cwd = path ?? process.cwd();
  const findings: SecretFinding[] = [];
  let scannedFiles = 0;

  // Scan current files only (no git history by default)
  const extensions = ['ts', 'tsx', 'js', 'jsx', 'json', 'yaml', 'yml', 'env', 'md'];
  const files = await findFiles(cwd, extensions);

  for (const file of files) {
    try {
      const content = await Bun.file(file).text();
      const lines = content.split('\n');

      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        if (!line) continue;

        for (const { type, pattern, severity } of SECRET_PATTERNS) {
          const matches = line.match(pattern);
          if (matches && matches[0]) {
            findings.push({
              file: file.replace(cwd, '.'),
              line: lineNum + 1,
              type,
              pattern: pattern.source,
              match: matches[0].substring(0, 50),
              severity,
            });
          }
        }
      }

      scannedFiles++;
    } catch {
      // Skip files we can't read
    }
  }

  // Optionally scan git history
  if (includeGitHistory) {
    try {
      const { stdout } = await runShellCommand('git log -p --all -S "AKIA" --format="%H" 2>/dev/null | head -100', cwd);
      if (stdout) {
        const commits = stdout.split('\n').filter((line) => line.match(/^[a-f0-9]{40}$/));
        for (const commit of commits.slice(0, 10)) {
          const { stdout: diffOutput } = await runShellCommand(`git show ${commit} 2>/dev/null`, cwd);
          const diffLines = diffOutput.split('\n');

          for (let i = 0; i < diffLines.length; i++) {
            const line = diffLines[i];
            if (!line || !line.startsWith('+')) continue;

            for (const { type, pattern, severity } of SECRET_PATTERNS) {
              const matches = line.match(pattern);
              if (matches && matches[0]) {
                findings.push({
                  file: `git:${commit.slice(0, 7)}`,
                  line: i + 1,
                  type: `${type} (historical)`,
                  pattern: pattern.source,
                  match: matches[0].substring(0, 50),
                  severity,
                });
              }
            }
          }
        }
      }
    } catch {
      // Git history scan is optional
    }
  }

  return {
    findings,
    scannedFiles,
  };
}

// ============================================================================
// Code Complexity Analysis
// ============================================================================

function calculateCyclomaticComplexity(code: string): number {
  let complexity = 1;

  const decisionPatterns = [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bdo\s*\{/g,
    /\bswitch\s*\(/g,
    /\bcase\s+.+:/g,
    /\?\s*[^:]*:/g,
    /\|\||/g,
    /&&/g,
    /\bcatch\s*\(/g,
    /\bthrow\s+/g,
  ];

  for (const pattern of decisionPatterns) {
    const matches = code.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }

  return complexity;
}

function extractFunctions(code: string): Array<{ name: string; line: number; code: string }> {
  const functions: Array<{ name: string; line: number; code: string }> = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
    if (funcMatch && funcMatch[1]) {
      functions.push({ name: funcMatch[1], line: i + 1, code: line });
      continue;
    }
    const arrowMatch = line?.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    if (arrowMatch && arrowMatch[1]) {
      functions.push({ name: arrowMatch[1], line: i + 1, code: line });
      continue;
    }

    const methodMatch = line.match(/(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
    if (methodMatch && methodMatch[1] && line && !line.includes('if') && !line.includes('while') && !line.includes('for')) {
      functions.push({ name: methodMatch[1], line: i + 1, code: line });
    }
  }

  return functions;
}

export async function analyzeCodeComplexity(
  paths?: string[],
  threshold: number = 10,
): Promise<CodeComplexityResult> {
  const cwd = process.cwd();
  const searchPaths = paths && paths.length > 0 ? paths : [cwd];

  const fileResults: FileComplexity[] = [];
  let totalFunctions = 0;
  let totalComplexity = 0;
  let totalViolations = 0;

  for (const searchPath of searchPaths) {
    const fullPath = searchPath.startsWith('/') ? searchPath : `${cwd}/${searchPath}`;
    const files = await findFiles(fullPath, ['ts', 'tsx', 'js', 'jsx']);

    for (const file of files) {
      try {
        const content = await Bun.file(file).text();
        const lines = content.split('\n');
        const loc = lines.filter((line) => line.trim().length > 0).length;

        const funcs = extractFunctions(content);
        const functionComplexities: FunctionComplexity[] = [];
        let fileViolations = 0;

        for (const func of funcs) {
          const cyclomatic = calculateCyclomaticComplexity(func.code);
          const cognitive = Math.min(cyclomatic, Math.floor(loc / 10));

          functionComplexities.push({
            name: func.name,
            line: func.line,
            cyclomatic,
            cognitive,
            lines: loc,
          });

          if (cyclomatic > threshold) {
            fileViolations++;
          }
        }

        const avgComplexity = functionComplexities.length > 0
          ? functionComplexities.reduce((sum, f) => sum + f.cyclomatic, 0) / functionComplexities.length
          : 0;

        fileResults.push({
          path: file.replace(cwd, '.'),
          functions: functionComplexities,
          averageComplexity: Math.round(avgComplexity * 100) / 100,
          violations: fileViolations,
        });

        totalFunctions += functionComplexities.length;
        totalComplexity += avgComplexity;
        totalViolations += fileViolations;
      } catch {
        // Skip files we can't analyze
      }
    }
  }

  const avgComplexity = fileResults.length > 0
    ? Math.round((totalComplexity / fileResults.length) * 100) / 100
    : 0;

  return {
    files: fileResults,
    summary: {
      totalFiles: fileResults.length,
      totalFunctions,
      averageComplexity: avgComplexity,
      violations: totalViolations,
    },
  };
}

// ============================================================================
// Test Coverage Analysis
// ============================================================================

async function findCoverageReport(searchPath: string): Promise<string | null> {
  const coveragePaths = [
    `${searchPath}/coverage/coverage-final.json`,
    `${searchPath}/coverage/lcov-report/lcov.info`,
    `${searchPath}/coverage/lcov.info`,
    `${searchPath}/coverage/coverage.json`,
  ];

  for (const path of coveragePaths) {
    if (await Bun.file(path).exists()) {
      return path;
    }
  }

  return null;
}

function parseLcovInfo(content: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  const lines = content.split('\n');

  let currentFile: FileCoverage | null = null;
  let currentUncoveredLines: number[] = [];

  for (const line of lines) {
    if (line.startsWith('SF:')) {
      if (currentFile) {
        currentFile.uncovered = currentUncoveredLines;
        files.push(currentFile);
      }
      currentFile = {
        path: line.replace('SF:', ''),
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
        uncovered: [],
      };
      currentUncoveredLines = [];
    } else if (line.startsWith('DA:') && currentFile) {
      const [, lineNum] = line.split(':');
      if (!lineNum) continue;
      const lineNumParts = lineNum.split(',');
      if (lineNumParts.length < 2) continue;
      const [num, hits] = lineNumParts;
      if (!num || !hits) continue;
      const lineNumber = parseInt(num, 10);
      const hitCount = parseInt(hits, 10);

      if (hitCount === 0) {
        currentUncoveredLines.push(lineNumber);
      }
      currentFile.lines = Math.max(currentFile.lines, lineNumber);
    } else if (line.startsWith('FN:') && currentFile) {
      currentFile.functions++;
    } else if (line.startsWith('BRDA:') && currentFile) {
      currentFile.branches++;
    }
  }

  if (currentFile) {
    currentFile.uncovered = currentUncoveredLines;
    files.push(currentFile);
  }

  return files;
}

function parseCoverageJson(content: string): { files: FileCoverage[]; summary: TestCoverageResult['summary'] } | null {
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    const files: FileCoverage[] = [];

    for (const [path, fileData] of Object.entries(data)) {
      if (typeof fileData !== 'object' || !fileData) continue;

      const statementMap = (fileData as { statementMap?: Record<string, unknown> }).statementMap || {};
      const s = (fileData as { s?: Record<string, number> }).s || {};

      const uncoveredLines: number[] = [];
      Object.entries(statementMap).forEach(([key, stmt]) => {
        const hits = s[key] || 0;
        if (hits === 0 && stmt && typeof stmt === 'object' && 'start' in stmt) {
          const start = (stmt as { start?: { line?: number } }).start;
          if (start?.line) {
            uncoveredLines.push(start.line);
          }
        }
      });

      files.push({
        path,
        statements: Object.keys(statementMap).length,
        branches: Object.keys((fileData as { branchMap?: Record<string, unknown> }).branchMap || {}).length,
        functions: Object.keys((fileData as { fnMap?: Record<string, unknown> }).fnMap || {}).length,
        lines: Object.keys(statementMap).length,
        uncovered: Array.from(new Set(uncoveredLines)).sort((a, b) => a - b),
      });
    }

    let totalStatements = 0;
    let coveredStatements = 0;
    let totalBranches = 0;
    let coveredBranches = 0;
    let totalFunctions = 0;
    let coveredFunctions = 0;
    let totalLines = 0;
    let coveredLines = 0;

    for (const file of Object.values(data) as Array<Record<string, unknown>>) {
      const s = (file.s || {}) as Record<string, number>;
      const b = (file.b || {}) as Record<string, number[]>;
      const f = (file.f || {}) as Record<string, number>;
      const statementMap = (file.statementMap || {}) as Record<string, unknown>;

      totalStatements += Object.keys(s).length;
      coveredStatements += Object.values(s).filter((v) => v > 0).length;

      totalBranches += Object.values(b).reduce((sum, arr) => sum + (arr as number[]).length, 0);
      coveredBranches += Object.values(b).reduce(
        (sum, arr) => sum + (arr as number[]).filter((v) => v > 0).length,
        0,
      );

      totalFunctions += Object.keys(f).length;
      coveredFunctions += Object.values(f).filter((v) => v > 0).length;

      totalLines += Object.keys(statementMap).length;
      coveredLines += Object.values(s).filter((v) => v > 0).length;
    }

    return {
      files,
      summary: {
        statements: {
          total: totalStatements,
          covered: coveredStatements,
          pct: totalStatements > 0 ? Math.round((coveredStatements / totalStatements) * 10000) / 100 : 0,
        },
        branches: {
          total: totalBranches,
          covered: coveredBranches,
          pct: totalBranches > 0 ? Math.round((coveredBranches / totalBranches) * 10000) / 100 : 0,
        },
        functions: {
          total: totalFunctions,
          covered: coveredFunctions,
          pct: totalFunctions > 0 ? Math.round((coveredFunctions / totalFunctions) * 10000) / 100 : 0,
        },
        lines: {
          total: totalLines,
          covered: coveredLines,
          pct: totalLines > 0 ? Math.round((coveredLines / totalLines) * 10000) / 100 : 0,
        },
      },
    };
  } catch {
    return null;
  }
}

export async function analyzeTestCoverage(
  paths?: string[],
  reporter: 'text' | 'json' | 'html' | 'lcov' = 'json',
): Promise<TestCoverageResult> {
  const cwd = process.cwd();
  const searchPaths = paths && paths.length > 0 ? paths : [cwd];

  let coveragePath: string | null = null;
  for (const searchPath of searchPaths) {
    const fullPath = searchPath.startsWith('/') ? searchPath : `${cwd}/${searchPath}`;
    coveragePath = await findCoverageReport(fullPath);
    if (coveragePath) break;
  }

  if (!coveragePath) {
    // No coverage report found - return empty result
    return {
      summary: {
        statements: { total: 0, covered: 0, pct: 0 },
        branches: { total: 0, covered: 0, pct: 0 },
        functions: { total: 0, covered: 0, pct: 0 },
        lines: { total: 0, covered: 0, pct: 0 },
      },
      files: [],
      passed: false,
    };
  }


  const content = await Bun.file(coveragePath).text();

  if (coveragePath.endsWith('.json')) {
    const parsed = parseCoverageJson(content);
    if (parsed) {
      const overallPct = parsed.summary.lines.pct;
      return {
        summary: parsed.summary,
        files: parsed.files,
        passed: overallPct >= 80,
      };
    }
  } else if (coveragePath.endsWith('lcov.info')) {
    const files = parseLcovInfo(content);
    const totalLines = files.reduce((sum, f) => sum + f.lines, 0);
    const uncoveredLines = files.reduce((sum, f) => sum + (f.uncovered?.length || 0), 0);
    const coveredLines = totalLines - uncoveredLines;
    const pct = totalLines > 0 ? Math.round((coveredLines / totalLines) * 10000) / 100 : 0;

    return {
      summary: {
        statements: { total: totalLines, covered: coveredLines, pct },
        branches: { total: 0, covered: 0, pct: 0 },
        functions: { total: files.reduce((sum, f) => sum + f.functions, 0), covered: 0, pct: 0 },
        lines: { total: totalLines, covered: coveredLines, pct },
      },
      files,
      passed: pct >= 80,
    };
  }

  return {
    summary: {
      statements: { total: 0, covered: 0, pct: 0 },
      branches: { total: 0, covered: 0, pct: 0 },
      functions: { total: 0, covered: 0, pct: 0 },
      lines: { total: 0, covered: 0, pct: 0 },
    },
    files: [],
    passed: false,
  };
}

// ============================================================================
// Mastra Tools Export
// ============================================================================

export const dependencyAuditTool = {
  id: 'dependency-audit',
  description: 'Audit dependencies for known vulnerabilities using npm audit or bun audit',
  inputSchema: z.object({
    path: z.string().optional().describe('Path to project directory containing package.json'),
    severity: z.enum(['low', 'moderate', 'high', 'critical']).optional().default('low').describe('Minimum severity to report'),
  }),
  outputSchema: z.object({
    vulnerabilities: z.array(
      z.object({
        package: z.string(),
        severity: z.enum(['low', 'moderate', 'high', 'critical']),
        cve: z.string().optional(),
        description: z.string(),
        fixAvailable: z.boolean(),
        fixedIn: z.string().optional(),
      }),
    ),
    summary: z.object({
      total: z.number(),
      critical: z.number(),
      high: z.number(),
      moderate: z.number(),
      low: z.number(),
    }),
  }),
  execute: async (input: { path?: string; severity?: 'low' | 'moderate' | 'high' | 'critical' }) => {
    return runDependencyAudit(input.path, input.severity);
  },
};

export const secretsScanTool = {
  id: 'secrets-scan',
  description: 'Scan for exposed secrets, API keys, and sensitive data in code files',
  inputSchema: z.object({
    path: z.string().optional().describe('Path to scan for secrets'),
    includeGitHistory: z.boolean().optional().default(false).describe('Also scan git commit history (slower)'),
  }),
  outputSchema: z.object({
    findings: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        type: z.string(),
        pattern: z.string(),
        match: z.string(),
        severity: z.enum(['low', 'medium', 'high']),
      }),
    ),
    scannedFiles: z.number(),
  }),
  execute: async (input: { path?: string; includeGitHistory?: boolean }) => {
    return runSecretsScan(input.path, input.includeGitHistory);
  },
};

export const codeComplexityTool = {
  id: 'code-complexity',
  description: 'Analyze code complexity metrics including cyclomatic complexity',
  inputSchema: z.object({
    paths: z.array(z.string()).optional().describe('Paths to analyze (defaults to current directory)'),
    threshold: z.number().optional().default(10).describe('Complexity threshold for flagging violations'),
  }),
  outputSchema: z.object({
    files: z.array(
      z.object({
        path: z.string(),
        functions: z.array(
          z.object({
            name: z.string(),
            line: z.number(),
            cyclomatic: z.number(),
            cognitive: z.number().optional(),
            lines: z.number(),
          }),
        ),
        averageComplexity: z.number(),
        violations: z.number(),
      }),
    ),
    summary: z.object({
      totalFiles: z.number(),
      totalFunctions: z.number(),
      averageComplexity: z.number(),
      violations: z.number(),
    }),
  }),
  execute: async (input: { paths?: string[]; threshold?: number }) => {
    return analyzeCodeComplexity(input.paths, input.threshold);
  },
};

export const testCoverageTool = {
  id: 'test-coverage',
  description: 'Generate and analyze test coverage reports from bun test, jest, or vitest',
  inputSchema: z.object({
    paths: z.array(z.string()).optional().describe('Paths to search for coverage reports'),
    reporter: z.enum(['text', 'json', 'html', 'lcov']).optional().default('json').describe('Coverage report format'),
  }),
  outputSchema: z.object({
    summary: z.object({
      statements: z.object({
        total: z.number(),
        covered: z.number(),
        pct: z.number(),
      }),
      branches: z.object({
        total: z.number(),
        covered: z.number(),
        pct: z.number(),
      }),
      functions: z.object({
        total: z.number(),
        covered: z.number(),
        pct: z.number(),
      }),
      lines: z.object({
        total: z.number(),
        covered: z.number(),
        pct: z.number(),
      }),
    }),
    files: z.array(
      z.object({
        path: z.string(),
        statements: z.number(),
        branches: z.number(),
        functions: z.number(),
        lines: z.number(),
        uncovered: z.array(z.number()).optional(),
      }),
    ),
    passed: z.boolean(),
  }),
  execute: async (input: { paths?: string[]; reporter?: 'text' | 'json' | 'html' | 'lcov' }) => {
    return analyzeTestCoverage(input.paths, input.reporter);
  },
};

export const analysisTools = {
  dependencyAuditTool,
  secretsScanTool,
  codeComplexityTool,
  testCoverageTool,
};
