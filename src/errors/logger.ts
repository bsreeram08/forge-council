import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync } from 'fs';

const LOG_DIR = join(homedir(), '.forgecouncil', 'logs');
const MAX_LOG_FILES = 50;
const MAX_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface ErrorReport {
  timestamp: string;
  level: 'error' | 'fatal' | 'warn';
  source: string;
  message: string;
  stack?: string;
  context: Record<string, unknown>;
  system: {
    platform: string;
    arch: string;
    bunVersion: string;
    forgeVersion: string;
    nodeVersion: string;
    pid: number;
    cwd: string;
  };
}

function getSystemInfo(): ErrorReport['system'] {
  return {
    platform: process.platform,
    arch: process.arch,
    bunVersion: typeof Bun !== 'undefined' ? Bun.version : 'unknown',
    forgeVersion: '0.1.0',
    nodeVersion: process.version,
    pid: process.pid,
    cwd: process.cwd(),
  };
}

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
}

function pruneOldLogs(): void {
  try {
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ name: f, path: join(LOG_DIR, f) }));

    const now = Date.now();

    // Remove old files
    for (const file of files) {
      try {
        const stat = statSync(file.path);
        if (now - stat.mtimeMs > MAX_LOG_AGE_MS) {
          unlinkSync(file.path);
        }
      } catch {}
    }

    // If still too many, remove oldest
    const remaining = readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .sort();
    if (remaining.length > MAX_LOG_FILES) {
      const toRemove = remaining.slice(0, remaining.length - MAX_LOG_FILES);
      for (const f of toRemove) {
        try { unlinkSync(join(LOG_DIR, f)); } catch {}
      }
    }
  } catch {}
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function buildReport(
  level: ErrorReport['level'],
  source: string,
  error: unknown,
  context: Record<string, unknown> = {},
): ErrorReport {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  return {
    timestamp: formatTimestamp(),
    level,
    source,
    message,
    stack,
    context,
    system: getSystemInfo(),
  };
}

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOG_DIR, `forge-${date}.log`);
}

function writeReport(report: ErrorReport): void {
  ensureLogDir();

  const line = JSON.stringify(report) + '\n';
  appendFileSync(getLogFilePath(), line, { mode: 0o600 });
}

/**
 * Log an error to the persistent error log file.
 * Each entry is a single JSON line in ~/.forgecouncil/logs/forge-YYYY-MM-DD.log
 */
export function logError(
  source: string,
  error: unknown,
  context: Record<string, unknown> = {},
): ErrorReport {
  const report = buildReport('error', source, error, context);
  writeReport(report);
  return report;
}

/**
 * Log a fatal error and return the report.
 * Use this right before exiting the process.
 */
export function logFatal(
  source: string,
  error: unknown,
  context: Record<string, unknown> = {},
): ErrorReport {
  const report = buildReport('fatal', source, error, context);
  writeReport(report);
  return report;
}

/**
 * Log a warning to the persistent error log file.
 */
export function logWarn(
  source: string,
  error: unknown,
  context: Record<string, unknown> = {},
): ErrorReport {
  const report = buildReport('warn', source, error, context);
  writeReport(report);
  return report;
}

/**
 * Format an error report for display to the user.
 */
export function formatReportForUser(report: ErrorReport): string {
  const lines = [
    `Error: ${report.message}`,
    ``,
    `Timestamp: ${report.timestamp}`,
    `Source:    ${report.source}`,
    `Log file: ${getLogFilePath()}`,
    ``,
    `To report this issue:`,
    `  https://github.com/anthropics/forge-council/issues`,
    `  Include the log file above for faster debugging.`,
  ];
  return lines.join('\n');
}

/**
 * Initialize error logging: prune old logs, set up global handlers.
 */
export function initErrorLogging(): void {
  pruneOldLogs();

  // Catch unhandled rejections
  process.on('unhandledRejection', (reason) => {
    logFatal('unhandled-rejection', reason instanceof Error ? reason : new Error(String(reason)));
  });

  // Catch uncaught exceptions
  process.on('uncaughtException', (error) => {
    const report = logFatal('uncaught-exception', error);
    process.stderr.write(`\n${formatReportForUser(report)}\n`);
    process.exit(1);
  });
}
