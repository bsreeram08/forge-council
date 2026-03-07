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

function computeSimpleDiff(original: string, modified: string): string {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  const lines: string[] = [];

  const maxLen = Math.max(origLines.length, modLines.length);
  for (let i = 0; i < maxLen; i++) {
    const orig = origLines[i];
    const mod = modLines[i];

    if (orig === undefined && mod !== undefined) {
      lines.push(`+ ${mod}`);
    } else if (orig !== undefined && mod === undefined) {
      lines.push(`- ${orig}`);
    } else if (orig !== mod) {
      lines.push(`- ${orig}`);
      lines.push(`+ ${mod}`);
    }
    // Skip unchanged lines for brevity (show context around changes)
  }

  if (lines.length === 0) return '  (no changes)';
  if (lines.length > 60) {
    return lines.slice(0, 60).join('\n') + `\n  ... (${lines.length - 60} more lines)`;
  }
  return lines.join('\n');
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
      const diff = computeSimpleDiff(change.originalContent, change.content);
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
