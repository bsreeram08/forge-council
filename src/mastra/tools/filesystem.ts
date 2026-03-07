/**
 * Filesystem Tools Implementation
 *
 * Mastra tool implementations for filesystem operations.
 * Uses Bun-native APIs for all file operations.
 */

import { z } from 'zod';
import * as path from 'path';

// ============================================================================
// Path Security
// ============================================================================

const PROJECT_ROOT = process.cwd();

/**
 * Resolve and validate a path is within the project directory.
 * Prevents directory traversal attacks.
 */
function resolvePath(inputPath: string): string {
  // Normalize the path
  const normalized = path.normalize(inputPath);
  const resolved = path.resolve(PROJECT_ROOT, normalized);

  // Security check: ensure resolved path is within project root
  if (!resolved.startsWith(PROJECT_ROOT)) {
    throw new Error(
      `Path traversal detected: "${inputPath}" resolves outside project directory`,
    );
  }

  return resolved;
}

// ============================================================================
// Input Schemas
// ============================================================================

const ReadFileInputSchema = z.object({
  path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
});

const WriteFileInputSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
});

const EditFileInputSchema = z.object({
  path: z.string(),
  edits: z.array(
    z.object({
      search: z.string(),
      replace: z.string(),
      occurrences: z.number().optional().default(1),
    }),
  ),
});

const ListDirInputSchema = z.object({
  path: z.string(),
  recursive: z.boolean().optional().default(false),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

const SearchFilesInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

const DeleteFileInputSchema = z.object({
  path: z.string(),
  recursive: z.boolean().optional().default(false),
  permanent: z.boolean().optional().default(false),
});

// ============================================================================
// Output Schemas
// ============================================================================

const ReadFileOutputSchema = z.object({
  content: z.string(),
  size: z.number(),
  modified: z.string(),
  encoding: z.string(),
});

const WriteFileOutputSchema = z.object({
  path: z.string(),
  bytesWritten: z.number(),
  success: z.boolean(),
});

const EditFileOutputSchema = z.object({
  path: z.string(),
  editsApplied: z.number(),
  success: z.boolean(),
});

const ListDirOutputSchema = z.object({
  path: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['file', 'directory', 'symlink']),
      size: z.number().optional(),
      modified: z.string().optional(),
    }),
  ),
});

const SearchFilesOutputSchema = z.object({
  matches: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      column: z.number(),
      content: z.string(),
      context: z.array(z.string()).optional(),
    }),
  ),
  totalFiles: z.number(),
  totalMatches: z.number(),
});

const DeleteFileOutputSchema = z.object({
  path: z.string(),
  deleted: z.boolean(),
  bytesFreed: z.number().optional(),
});

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Read file contents with optional line range.
 */
export async function readFile(
  input: z.infer<typeof ReadFileInputSchema>,
): Promise<z.infer<typeof ReadFileOutputSchema>> {
  const validated = ReadFileInputSchema.parse(input);
  const resolvedPath = resolvePath(validated.path);

  const file = Bun.file(resolvedPath);

  if (!(await file.exists())) {
    throw new Error(`File not found: ${validated.path}`);
  }

  const fileInfo = await file.stat();

  if (!fileInfo.isFile()) {
    throw new Error(`Path is not a file: ${validated.path}`);
  }

  let content: string;

  if (validated.encoding === 'base64') {
    const buffer = await file.arrayBuffer();
    content = Buffer.from(buffer).toString('base64');
  } else {
    content = await file.text();

    // Apply offset and limit if specified
    if (validated.offset !== undefined || validated.limit !== undefined) {
      const lines = content.split('\n');
      const start = validated.offset ?? 0;
      const end =
        validated.limit !== undefined ? start + validated.limit : lines.length;
      content = lines.slice(start, end).join('\n');
    }
  }

  return {
    content,
    size: fileInfo.size,
    modified: fileInfo.mtime.toISOString(),
    encoding: validated.encoding,
  };
}

/**
 * Write content to a file, creating parent directories if needed.
 */
export async function writeFile(
  input: z.infer<typeof WriteFileInputSchema>,
): Promise<z.infer<typeof WriteFileOutputSchema>> {
  const validated = WriteFileInputSchema.parse(input);
  const resolvedPath = resolvePath(validated.path);

  // Create parent directories if they don't exist
  const parentDir = path.dirname(resolvedPath);
  await mkdirRecursive(parentDir);

  let contentToWrite: string | Buffer;


  if (validated.encoding === 'base64') {
    contentToWrite = Buffer.from(validated.content, 'base64');
  } else {
    contentToWrite = validated.content;
  }

  await Bun.write(resolvedPath, contentToWrite);

  // Get file stats to confirm write
  const file = Bun.file(resolvedPath);
  const fileInfo = await file.stat();

  return {
    path: validated.path,
    bytesWritten: fileInfo.size,
    success: true,
  };
}

/**
 * Apply targeted edits to a file using string replacement.
 */
export async function editFile(
  input: z.infer<typeof EditFileInputSchema>,
): Promise<z.infer<typeof EditFileOutputSchema>> {
  const validated = EditFileInputSchema.parse(input);
  const resolvedPath = resolvePath(validated.path);

  const file = Bun.file(resolvedPath);

  if (!(await file.exists())) {
    throw new Error(`File not found: ${validated.path}`);
  }

  let content = await file.text();
  let editsApplied = 0;

  for (const edit of validated.edits) {
    const { search, replace, occurrences } = edit;

    if (occurrences === -1) {
      // Replace all occurrences
      const newContent = content.split(search).join(replace);
      if (newContent !== content) {
        const count = (content.match(new RegExp(escapeRegExp(search), 'g')) || [])
          .length;
        editsApplied += count;
        content = newContent;
      }
    } else {
      // Replace specific number of occurrences
      let remaining = occurrences;
      let index = content.indexOf(search);

      while (index !== -1 && remaining > 0) {
        content =
          content.substring(0, index) +
          replace +
          content.substring(index + search.length);
        remaining--;
        editsApplied++;
        index = content.indexOf(search, index + replace.length);
      }
    }
  }

  // Write the modified content back
  await Bun.write(resolvedPath, content);

  return {
    path: validated.path,
    editsApplied,
    success: editsApplied > 0,
  };
}

/**
 * List directory contents with optional recursion and filtering.
 */
export async function listDir(
  input: z.infer<typeof ListDirInputSchema>,
): Promise<z.infer<typeof ListDirOutputSchema>> {
  const validated = ListDirInputSchema.parse(input);
  const resolvedPath = resolvePath(validated.path);

  if (!(await pathExists(resolvedPath))) {
    throw new Error(`Directory not found: ${validated.path}`);
  }

  if (!(await isDirectory(resolvedPath))) {
    throw new Error(`Path is not a directory: ${validated.path}`);
  }

  const entries: Array<{
    name: string;
    type: 'file' | 'directory' | 'symlink';
    size?: number;
    modified?: string;
  }> = [];

  // Use glob to list directory contents
  const globPattern = validated.recursive ? '**/*' : '*';
  const glob = new Bun.Glob(globPattern);

  for await (const filePath of glob.scan({
    cwd: resolvedPath,
    dot: true,
    onlyFiles: false,
  })) {
    const fullPath = path.join(resolvedPath, filePath);
    const fileName = path.basename(filePath);

    // Skip the directory itself when using recursive glob
    if (filePath === '.' || filePath === '') continue;

    // Apply filters
    if (validated.exclude) {
      const shouldExclude = validated.exclude.some((pattern) =>
        matchesPattern(fileName, pattern),
      );
      if (shouldExclude) continue;
    }

    if (validated.include && validated.include.length > 0) {
      const shouldInclude = validated.include.some((pattern) =>
        matchesPattern(fileName, pattern),
      );
      if (!shouldInclude) continue;
    }

    try {
      const file = Bun.file(fullPath);
      const stat = await file.stat();

      let type: 'file' | 'directory' | 'symlink' = 'file';
      if (stat.isDirectory()) {
        type = 'directory';
      } else if (stat.isSymbolicLink && stat.isSymbolicLink()) {
        type = 'symlink';
      }

      const entry: {
        name: string;
        type: 'file' | 'directory' | 'symlink';
        size?: number;
        modified?: string;
      } = {
        name: fileName,
        type,
      };

      if (type === 'file') {
        entry.size = stat.size;
      }

      entry.modified = stat.mtime.toISOString();

      entries.push(entry);
    } catch {
      // Skip files we can't stat (permissions, etc.)
      continue;
    }
  }

  return {
    path: validated.path,
    entries,
  };
}

/**
 * Search for patterns in files across the codebase.
 */
export async function searchFiles(
  input: z.infer<typeof SearchFilesInputSchema>,
): Promise<z.infer<typeof SearchFilesOutputSchema>> {
  const validated = SearchFilesInputSchema.parse(input);
  const searchPath = validated.path
    ? resolvePath(validated.path)
    : PROJECT_ROOT;

  const matches: Array<{
    file: string;
    line: number;
    column: number;
    content: string;
    context?: string[];
  }> = [];

  // Compile regex pattern
  let regex: RegExp;
  try {
    regex = new RegExp(validated.pattern, 'g');
  } catch {
    // If invalid regex, treat as literal string
    regex = new RegExp(escapeRegExp(validated.pattern), 'g');
  }

  const scannedFiles = new Set<string>();

  async function scanFile(filePath: string): Promise<void> {
    // Skip if already scanned
    if (scannedFiles.has(filePath)) return;
    scannedFiles.add(filePath);

    const fileName = path.basename(filePath);

    // Apply include filters
    if (validated.include && validated.include.length > 0) {
      const shouldInclude = validated.include.some((pattern) =>
        matchesPattern(fileName, pattern),
      );
      if (!shouldInclude) return;
    }

    // Apply exclude filters
    if (validated.exclude) {
      const shouldExclude = validated.exclude.some((pattern) =>
        matchesPattern(fileName, pattern),
      );
      if (shouldExclude) return;
    }

    try {
      const file = Bun.file(filePath);
      const stat = await file.stat();

      if (!stat.isFile()) return;

      // Skip binary files (heuristic: check for null bytes in first 1KB)
      const sample = await file.arrayBuffer();
      const sampleBytes = new Uint8Array(sample.slice(0, 1024));
      if (sampleBytes.includes(0)) return; // Binary file

      const content = await file.text();
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        regex.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = regex.exec(line!)) !== null) {
          const contextLines: string[] = [];
          const contextStart = Math.max(0, i - 2);
          const contextEnd = Math.min(lines.length, i + 3);

          for (let j = contextStart; j < contextEnd; j++) {
            contextLines.push(lines[j]!);
          }

          matches.push({
            file: path.relative(PROJECT_ROOT, filePath),
            line: i + 1,
            column: match.index + 1,
            content: line!.trim(),
            context: contextLines,
          });
        }
      }
    } catch {
      // Skip files we can't read
    }
  }

  // If searchPath is a directory, scan all files recursively
  if (await isDirectory(searchPath)) {
    const glob = new Bun.Glob('**/*');
    for await (const filePath of glob.scan({
      cwd: searchPath,
      dot: true,
      onlyFiles: true,
    })) {
      const fullPath = path.join(searchPath, filePath);
      await scanFile(fullPath);
    }
  } else {
    // SearchPath is a file
    await scanFile(searchPath);
  }

  return {
    matches,
    totalFiles: scannedFiles.size,
    totalMatches: matches.length,
  };
}

/**
 * Delete files or directories.
 * Note: ADMIN permission check should be done by the guard layer.
 */
export async function deleteFile(
  input: z.infer<typeof DeleteFileInputSchema>,
): Promise<z.infer<typeof DeleteFileOutputSchema>> {
  const validated = DeleteFileInputSchema.parse(input);
  const resolvedPath = resolvePath(validated.path);

  if (!(await pathExists(resolvedPath))) {
    throw new Error(`File or directory not found: ${validated.path}`);
  }

  const isDir = await isDirectory(resolvedPath);
  let bytesFreed = 0;

  if (isDir) {
    if (!validated.recursive) {
      // Check if directory is empty
      const glob = new Bun.Glob('*');
      let hasEntries = false;
      for await (const _ of glob.scan({ cwd: resolvedPath, dot: true })) {
        hasEntries = true;
        break;
      }

      if (hasEntries) {
        throw new Error(
          `Cannot delete non-empty directory without recursive flag: ${validated.path}`,
        );
      }
    }

    // Calculate total size before deletion
    bytesFreed = await calculateDirSize(resolvedPath);

    // Delete directory recursively
    await deleteDirRecursive(resolvedPath);
  } else {
    const file = Bun.file(resolvedPath);
    const stat = await file.stat();
    bytesFreed = stat.size;
    await Bun.spawn(['rm', resolvedPath]).exited;
  }

  return {
    path: validated.path,
    deleted: true,
    bytesFreed,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a filename matches a glob pattern.
 * Simple implementation supporting * and ? wildcards.
 */
function matchesPattern(filename: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/{{GLOBSTAR}}/g, '.*');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filename);
}

/**
 * Calculate total size of a directory.
 */
async function calculateDirSize(dirPath: string): Promise<number> {
  let totalSize = 0;
  const glob = new Bun.Glob(path.join(dirPath, '**/*'));

  for await (const filePath of glob.scan()) {
    const fullPath = path.join(dirPath, filePath);
    try {
      const file = Bun.file(fullPath);
      const stat = await file.stat();
      if (stat.isFile()) {
        totalSize += stat.size;
      }
    } catch {
      // Skip files we can't stat
    }
  }

  return totalSize;
}

/**
 * Delete a directory recursively using shell command.
 */
async function deleteDirRecursive(dirPath: string): Promise<void> {
  const proc = Bun.spawn(['rm', '-rf', dirPath]);
  await proc.exited;
}

/**
 * Create directory recursively using shell command.
 */
async function mkdirRecursive(dirPath: string): Promise<void> {
  const proc = Bun.spawn(['mkdir', '-p', dirPath]);
  await proc.exited;
}

/**
 * Check if path is a directory.
 */
async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    const stat = await file.stat();
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if path exists.
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    await file.stat();
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Export Tool Map for Registry Integration
// ============================================================================

export const FILESYSTEM_TOOLS = {
  'read-file': readFile,
  'write-file': writeFile,
  'edit-file': editFile,
  'list-dir': listDir,
  'search-files': searchFiles,
  'delete-file': deleteFile,
};
