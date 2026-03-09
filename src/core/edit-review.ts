/**
 * Edit Review — Accept/reject individual AI-generated file changes.
 *
 * When the coder produces file changes, this module presents them
 * as diffs for the user to approve, reject, or modify before applying.
 */

import * as p from '@clack/prompts';
import * as path from 'path';
import * as fs from 'fs';
import type { CodingOutput } from './schemas.ts';
import type { EditReviewConfig } from '../config/schema.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EditDecision = 'accept' | 'reject' | 'edit';

export interface FileChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  content: string;
  originalContent?: string;
}

export interface ReviewedChange {
  file: FileChange;
  decision: EditDecision;
  /** Modified content if user chose to edit */
  finalContent?: string;
}

export interface EditReviewResult {
  accepted: FileChange[];
  rejected: FileChange[];
  totalFiles: number;
}

// ---------------------------------------------------------------------------
// Diff display
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LCS-based unified diff
// ---------------------------------------------------------------------------

/**
 * Compute LCS table for two arrays of lines.
 * Returns a 2D table where dp[i][j] = length of LCS of a[0..i-1] and b[0..j-1].
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp;
}

interface DiffLine {
  type: ' ' | '-' | '+';
  content: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * Backtrack through LCS table to produce diff lines.
 */
function diffLines(a: string[], b: string[], dp: number[][]): DiffLine[] {
  const result: DiffLine[] = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: ' ', content: a[i - 1]!, oldLine: i, newLine: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({ type: '+', content: b[j - 1]!, newLine: j });
      j--;
    } else {
      result.push({ type: '-', content: a[i - 1]!, oldLine: i });
      i--;
    }
  }

  return result.reverse();
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

/**
 * Group diff lines into hunks with context lines.
 */
function buildHunks(diffs: DiffLine[], contextLines: number): Hunk[] {
  // Find change indices
  const changeIndices: number[] = [];
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i]!.type !== ' ') changeIndices.push(i);
  }

  if (changeIndices.length === 0) return [];

  // Group changes into hunks, merging those within 2*contextLines of each other
  const groups: Array<[number, number]> = [];
  let start = changeIndices[0]!;
  let end = changeIndices[0]!;

  for (let i = 1; i < changeIndices.length; i++) {
    if (changeIndices[i]! - end <= contextLines * 2) {
      end = changeIndices[i]!;
    } else {
      groups.push([start, end]);
      start = changeIndices[i]!;
      end = changeIndices[i]!;
    }
  }
  groups.push([start, end]);

  // Build hunks with context
  const hunks: Hunk[] = [];
  for (const [gs, ge] of groups) {
    const hunkStart = Math.max(0, gs - contextLines);
    const hunkEnd = Math.min(diffs.length - 1, ge + contextLines);
    const hunkLines = diffs.slice(hunkStart, hunkEnd + 1);

    const oldLines = hunkLines.filter(l => l.type !== '+');
    const newLines = hunkLines.filter(l => l.type !== '-');
    const firstOld = hunkLines.find(l => l.oldLine !== undefined);
    const firstNew = hunkLines.find(l => l.newLine !== undefined);

    hunks.push({
      oldStart: firstOld?.oldLine ?? 1,
      oldCount: oldLines.length,
      newStart: firstNew?.newLine ?? 1,
      newCount: newLines.length,
      lines: hunkLines,
    });
  }

  return hunks;
}

/**
 * Compute a unified diff between two strings.
 * Exported for testing and for use in the review display.
 */
export function computeUnifiedDiff(
  original: string,
  modified: string,
  filePath: string,
  contextLines = 3,
): string {
  if (original === modified) return '  (no changes)';

  const origLines = original.split('\n');
  const modLines = modified.split('\n');

  // For very large files, fall back to a simple summary
  if (origLines.length > 1000 || modLines.length > 1000) {
    const added = modLines.length - origLines.length;
    return `  (large file: ${origLines.length} → ${modLines.length} lines, ${added >= 0 ? '+' : ''}${added})`;
  }

  const dp = lcsTable(origLines, modLines);
  const diffs = diffLines(origLines, modLines, dp);
  const hunks = buildHunks(diffs, contextLines);

  if (hunks.length === 0) return '  (no changes)';

  const output: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  for (const hunk of hunks) {
    output.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      output.push(`${line.type}${line.content}`);
    }
  }

  const result = output.join('\n');
  if (result.split('\n').length > 80) {
    return result.split('\n').slice(0, 80).join('\n') + `\n  ... (truncated)`;
  }
  return result;
}

function formatFileHeader(change: FileChange): string {
  const icon = change.action === 'create' ? '+' : change.action === 'delete' ? '-' : '~';
  return `${icon} ${change.path} (${change.action})`;
}

// ---------------------------------------------------------------------------
// Load original file content for diff
// ---------------------------------------------------------------------------

function loadOriginal(filePath: string, projectRoot: string): string | undefined {
  const full = path.resolve(projectRoot, filePath);
  try {
    return fs.readFileSync(full, 'utf-8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Resolve file changes from coding output
// ---------------------------------------------------------------------------

export function extractFileChanges(
  output: CodingOutput,
  projectRoot: string,
): FileChange[] {
  return output.files.map(f => ({
    path: f.path,
    action: f.action,
    content: f.content,
    originalContent: f.action === 'modify' ? loadOriginal(f.path, projectRoot) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Interactive review
// ---------------------------------------------------------------------------

export async function reviewChanges(
  changes: FileChange[],
  config?: EditReviewConfig,
): Promise<EditReviewResult> {
  const reviewEnabled = config?.enabled ?? true;
  const autoAcceptThreshold = config?.autoAcceptThreshold ?? 0;
  const groupBy = config?.groupBy ?? 'file';

  // If review disabled, accept everything
  if (!reviewEnabled) {
    return {
      accepted: changes,
      rejected: [],
      totalFiles: changes.length,
    };
  }

  const accepted: FileChange[] = [];
  const rejected: FileChange[] = [];

  // Show summary first
  p.log.info(`${changes.length} file(s) changed by AI:`);
  for (const change of changes) {
    const lines = change.content.split('\n').length;
    p.log.message(`  ${formatFileHeader(change)} — ${lines} lines`);
  }

  // Auto-accept small changes if configured
  if (autoAcceptThreshold > 0) {
    const small = changes.filter(c => c.content.split('\n').length <= autoAcceptThreshold);
    const large = changes.filter(c => c.content.split('\n').length > autoAcceptThreshold);

    if (small.length > 0) {
      p.log.info(`Auto-accepting ${small.length} file(s) under ${autoAcceptThreshold} lines.`);
      accepted.push(...small);
    }
    changes = large;
  }

  if (changes.length === 0) {
    return { accepted, rejected, totalFiles: accepted.length + rejected.length };
  }

  // Ask for bulk or per-file review
  if (groupBy === 'file' && changes.length > 1) {
    const bulkAction = await p.select({
      message: 'How do you want to review changes?',
      options: [
        { value: 'accept-all', label: 'Accept all', hint: 'Apply all changes' },
        { value: 'reject-all', label: 'Reject all', hint: 'Discard all changes' },
        { value: 'per-file', label: 'Review per file', hint: 'Decide for each file' },
      ],
    });

    if (p.isCancel(bulkAction)) {
      return { accepted: [], rejected: changes, totalFiles: changes.length };
    }

    if (bulkAction === 'accept-all') {
      accepted.push(...changes);
      return { accepted, rejected, totalFiles: accepted.length };
    }

    if (bulkAction === 'reject-all') {
      rejected.push(...changes);
      return { accepted, rejected, totalFiles: rejected.length };
    }
  }

  // Per-file review
  for (const change of changes) {
    // Show diff
    if (change.originalContent) {
      const diff = computeUnifiedDiff(change.originalContent, change.content, change.path);
      p.note(diff, formatFileHeader(change));
    } else if (change.action === 'create') {
      const preview = change.content.split('\n').slice(0, 30).join('\n');
      const suffix = change.content.split('\n').length > 30
        ? `\n... (${change.content.split('\n').length - 30} more lines)`
        : '';
      p.note(preview + suffix, formatFileHeader(change));
    } else if (change.action === 'delete') {
      p.note(`File will be deleted: ${change.path}`, formatFileHeader(change));
    }

    const decision = await p.select({
      message: `${change.path}:`,
      options: [
        { value: 'accept', label: 'Accept', hint: 'Apply this change' },
        { value: 'reject', label: 'Reject', hint: 'Skip this change' },
      ],
    });

    if (p.isCancel(decision) || decision === 'reject') {
      rejected.push(change);
    } else {
      accepted.push(change);
    }
  }

  return {
    accepted,
    rejected,
    totalFiles: accepted.length + rejected.length,
  };
}

// ---------------------------------------------------------------------------
// Apply accepted changes to disk
// ---------------------------------------------------------------------------

export async function applyChanges(
  changes: FileChange[],
  projectRoot: string,
): Promise<{ applied: number; errors: string[] }> {
  let applied = 0;
  const errors: string[] = [];

  for (const change of changes) {
    const fullPath = path.resolve(projectRoot, change.path);

    try {
      if (change.action === 'delete') {
        fs.unlinkSync(fullPath);
      } else {
        // Ensure directory exists
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, change.content, 'utf-8');
      }
      applied++;
    } catch (e) {
      errors.push(`${change.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { applied, errors };
}

// ---------------------------------------------------------------------------
// Review and apply — convenience wrapper
// ---------------------------------------------------------------------------

export async function reviewAndApply(
  outputs: CodingOutput[],
  projectRoot: string,
  config?: EditReviewConfig,
): Promise<EditReviewResult> {
  const allChanges = outputs.flatMap(o => extractFileChanges(o, projectRoot));

  if (allChanges.length === 0) {
    return { accepted: [], rejected: [], totalFiles: 0 };
  }

  const result = await reviewChanges(allChanges, config);

  if (result.accepted.length > 0) {
    const { applied, errors } = await applyChanges(result.accepted, projectRoot);
    if (errors.length > 0) {
      p.log.warn(`${errors.length} file(s) failed to apply:`);
      for (const err of errors) {
        p.log.error(`  ${err}`);
      }
    }
    p.log.info(`Applied ${applied} of ${result.accepted.length} changes. Rejected ${result.rejected.length}.`);
  } else {
    p.log.info(`All ${result.rejected.length} changes rejected.`);
  }

  return result;
}
