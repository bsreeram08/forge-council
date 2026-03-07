import * as p from '@clack/prompts';
import { logFatal, logError, formatReportForUser } from './logger.ts';

/**
 * Unified exit handler for ForgeCouncil CLI.
 *
 * All fatal errors should flow through this function instead of calling
 * process.exit(1) directly. This ensures:
 * - Error is logged to ~/.forgecouncil/logs/ with timestamp + system info
 * - User sees a consistent error message with instructions for reporting
 * - Single exit point for the entire CLI
 */
export function exitWithError(
  source: string,
  error: unknown,
  context: Record<string, unknown> = {},
): never {
  const report = logFatal(source, error, context);
  p.log.error(formatReportForUser(report));
  process.exit(1);
}

/**
 * Wraps an async CLI command so any unhandled error goes through the
 * unified exit flow. Use this at the top level of each command.
 */
export function withErrorHandling<T extends unknown[]>(
  source: string,
  fn: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (error) {
      exitWithError(source, error);
    }
  };
}

/**
 * Log a non-fatal error (persists to log file but doesn't exit).
 * Returns the error message for display purposes.
 */
export function handleError(
  source: string,
  error: unknown,
  context: Record<string, unknown> = {},
): string {
  const report = logError(source, error, context);
  return report.message;
}
