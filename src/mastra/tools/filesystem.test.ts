/**
 * Filesystem Tools Tests
 *
 * Comprehensive tests for all filesystem tool implementations.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import {
  readFile,
  writeFile,
  editFile,
  listDir,
  searchFiles,
  deleteFile,
} from './filesystem';

// Test directory setup
const TEST_DIR = path.join(process.cwd(), 'tmp-test-filesystem');

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

async function createTestFile(
  filePath: string,
  content: string,
): Promise<string> {
  const fullPath = path.join(TEST_DIR, filePath);
  const parentDir = path.dirname(fullPath);

  // Create parent directories
  await Bun.spawn(['mkdir', '-p', parentDir]).exited;

  // Write file
  await Bun.write(fullPath, content);

  return fullPath;
}

describe('filesystem tools', () => {
  beforeEach(async () => {
    await cleanupTestDir();
    await setupTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  // ==========================================================================
  // readFile tests
  // ==========================================================================
  describe('readFile', () => {
    test('should read a text file', async () => {
      const content = 'Hello, World!';
      const filePath = 'test-read.txt';
      await createTestFile(filePath, content);

      const result = await readFile({ path: path.join('tmp-test-filesystem', filePath), encoding: 'utf8' });

      expect(result.content).toBe(content);
      expect(result.size).toBe(content.length);
      expect(result.encoding).toBe('utf8');
      expect(result.modified).toBeDefined();
    });

    test('should read file with offset and limit', async () => {
      const lines = ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5'];
      const content = lines.join('\n');
      const filePath = 'test-read-lines.txt';
      await createTestFile(filePath, content);

      const result = await readFile({
        path: path.join('tmp-test-filesystem', filePath),
        encoding: 'utf8',
        offset: 1,
        limit: 2,
      });

      expect(result.content).toBe('Line 2\nLine 3');
    });

    test('should read file as base64', async () => {
      const content = 'Hello, World!';
      const filePath = 'test-read-base64.txt';
      await createTestFile(filePath, content);

      const result = await readFile({
        path: path.join('tmp-test-filesystem', filePath),
        encoding: 'base64',
      });

      expect(result.encoding).toBe('base64');
      expect(result.content).toBe(Buffer.from(content).toString('base64'));
    });

    test('should throw error for non-existent file', async () => {
      await expect(
        readFile({ path: 'tmp-test-filesystem/non-existent.txt', encoding: 'utf8' }),
      ).rejects.toThrow('File not found');
    });

    test('should throw error for path traversal', async () => {
      await expect(
        readFile({ path: '../../../etc/passwd', encoding: 'utf8' }),
      ).rejects.toThrow('Path traversal detected');
    });
  });

  // ==========================================================================
  // writeFile tests
  // ==========================================================================
  describe('writeFile', () => {
    test('should write a new file', async () => {
      const content = 'Test content';
      const filePath = 'test-write.txt';

      const result = await writeFile({
        path: path.join('tmp-test-filesystem', filePath),
        content,
        encoding: 'utf8',
      });

      expect(result.success).toBe(true);
      expect(result.path).toBe(path.join('tmp-test-filesystem', filePath));
      expect(result.bytesWritten).toBe(content.length);

      // Verify file was written
      const file = Bun.file(path.join(TEST_DIR, filePath));
      expect(await file.text()).toBe(content);
    });

    test('should overwrite existing file', async () => {
      const filePath = 'test-overwrite.txt';
      await createTestFile(filePath, 'Old content');

      const newContent = 'New content';
      const result = await writeFile({
        path: path.join('tmp-test-filesystem', filePath),
        content: newContent,
        encoding: 'utf8',
      });

      expect(result.success).toBe(true);

      const file = Bun.file(path.join(TEST_DIR, filePath));
      expect(await file.text()).toBe(newContent);
    });

    test('should create nested directories', async () => {
      const content = 'Nested file content';
      const filePath = 'tmp-test-filesystem/nested/deep/file.txt';

      const result = await writeFile({
        path: filePath,
        content,
        encoding: 'utf8',
      });

      expect(result.success).toBe(true);

      const file = Bun.file(path.join(process.cwd(), filePath));
      expect(await file.text()).toBe(content);
    });

    test('should write base64 encoded content', async () => {
      const originalContent = 'Binary content';
      const base64Content = Buffer.from(originalContent).toString('base64');
      const filePath = 'tmp-test-filesystem/test-base64.txt';

      await writeFile({
        path: filePath,
        content: base64Content,
        encoding: 'base64',
      });

      const file = Bun.file(path.join(process.cwd(), filePath));
      const readContent = await file.text();
      expect(readContent).toBe(originalContent);
    });

    test('should throw error for path traversal', async () => {
      await expect(
        writeFile({
          path: '../../../etc/passwd',
          content: 'malicious',
          encoding: 'utf8',
        }),
      ).rejects.toThrow('Path traversal detected');
    });
  });

  // ==========================================================================
  // editFile tests
  // ==========================================================================
  describe('editFile', () => {
    test('should apply single edit', async () => {
      const filePath = 'test-edit.txt';
      await createTestFile(filePath, 'Hello World');

      const result = await editFile({
        path: path.join('tmp-test-filesystem', filePath),
        edits: [{ search: 'World', replace: 'Universe', occurrences: 1 }],
      });

      expect(result.success).toBe(true);
      expect(result.editsApplied).toBe(1);

      const file = Bun.file(path.join(TEST_DIR, filePath));
      expect(await file.text()).toBe('Hello Universe');
    });

    test('should apply multiple edits', async () => {
      const filePath = 'test-multi-edit.txt';
      await createTestFile(filePath, 'Hello World and Hello Universe');

      const result = await editFile({
        path: path.join('tmp-test-filesystem', filePath),
        edits: [
          { search: 'Hello', replace: 'Hi', occurrences: 1 },
          { search: 'Universe', replace: 'Galaxy', occurrences: 1 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.editsApplied).toBe(2);

      const file = Bun.file(path.join(TEST_DIR, filePath));
      expect(await file.text()).toBe('Hi World and Hello Galaxy');
    });

    test('should replace all occurrences with occurrences: -1', async () => {
      const filePath = 'test-replace-all.txt';
      await createTestFile(filePath, 'foo bar foo baz foo');

      const result = await editFile({
        path: path.join('tmp-test-filesystem', filePath),
        edits: [{ search: 'foo', replace: 'qux', occurrences: -1 }],
      });

      expect(result.success).toBe(true);
      expect(result.editsApplied).toBe(3);

      const file = Bun.file(path.join(TEST_DIR, filePath));
      expect(await file.text()).toBe('qux bar qux baz qux');
    });

    test('should return success: false when no edits applied', async () => {
      const filePath = 'test-no-edit.txt';
      await createTestFile(filePath, 'Hello World');

      const result = await editFile({
        path: path.join('tmp-test-filesystem', filePath),
        edits: [{ search: 'NonExistent', replace: 'Replacement', occurrences: 1 }],
      });

      expect(result.success).toBe(false);
      expect(result.editsApplied).toBe(0);
    });

    test('should throw error for non-existent file', async () => {
      await expect(
        editFile({
          path: 'tmp-test-filesystem/non-existent.txt',
          edits: [{ search: 'old', replace: 'new', occurrences: 1 }],
        }),
      ).rejects.toThrow('File not found');
    });
  });

  // ==========================================================================
  // listDir tests
  // ==========================================================================
  describe('listDir', () => {
    test('should list directory contents', async () => {
      await createTestFile('file1.txt', 'content1');
      await createTestFile('file2.txt', 'content2');
      await Bun.spawn(['mkdir', '-p', path.join(TEST_DIR, 'subdir')]).exited;

      const result = await listDir({ path: 'tmp-test-filesystem', recursive: false });

      expect(result.path).toBe('tmp-test-filesystem');
      expect(result.entries.length).toBeGreaterThanOrEqual(2);

      const fileNames = result.entries.map((e) => e.name);
      expect(fileNames).toContain('file1.txt');
      expect(fileNames).toContain('file2.txt');
    });

    test('should identify file types correctly', async () => {
      await createTestFile('test-file.txt', 'content');
      await Bun.spawn(['mkdir', '-p', path.join(TEST_DIR, 'test-dir')]).exited;

      const result = await listDir({ path: 'tmp-test-filesystem', recursive: false });

      const fileEntry = result.entries.find((e) => e.name === 'test-file.txt');
      const dirEntry = result.entries.find((e) => e.name === 'test-dir');

      expect(fileEntry?.type).toBe('file');
      expect(dirEntry?.type).toBe('directory');
    });

    test('should include file metadata', async () => {
      const content = 'Test content for metadata';
      await createTestFile('meta-test.txt', content);

      const result = await listDir({ path: 'tmp-test-filesystem', recursive: false });

      const entry = result.entries.find((e) => e.name === 'meta-test.txt');
      expect(entry).toBeDefined();
      expect(entry?.size).toBe(content.length);
      expect(entry?.modified).toBeDefined();
    });

    test('should filter with include patterns', async () => {
      await createTestFile('test.txt', 'content');
      await createTestFile('test.js', 'content');
      await createTestFile('other.ts', 'content');

      const result = await listDir({
        path: 'tmp-test-filesystem',
        recursive: false,
        include: ['*.txt', '*.js'],
      });

      const fileNames = result.entries.map((e) => e.name);
      expect(fileNames).toContain('test.txt');
      expect(fileNames).toContain('test.js');
    });

    test('should filter with exclude patterns', async () => {
      await createTestFile('keep.txt', 'content');
      await createTestFile('ignore.log', 'content');

      const result = await listDir({
        path: 'tmp-test-filesystem',
        recursive: false,
        exclude: ['*.log'],
      });

      const fileNames = result.entries.map((e) => e.name);
      expect(fileNames).toContain('keep.txt');
      expect(fileNames).not.toContain('ignore.log');
    });

    test('should throw error for non-existent directory', async () => {
      await expect(
        listDir({ path: 'tmp-test-filesystem/non-existent-dir', recursive: false }),
      ).rejects.toThrow('Directory not found');
    });
  });

  // ==========================================================================
  // searchFiles tests
  // ==========================================================================
  describe('searchFiles', () => {
    test('should find pattern in files', async () => {
      await createTestFile('search1.txt', 'Hello World');
      await createTestFile('search2.txt', 'Hello Universe');
      await createTestFile('search3.txt', 'Goodbye World');

      const result = await searchFiles({
        pattern: 'Hello',
        path: 'tmp-test-filesystem',
      });

      expect(result.totalMatches).toBe(2);
      expect(result.matches.length).toBe(2);

      const files = result.matches.map((m) => m.file);
      expect(files.some((f) => f.includes('search1.txt'))).toBe(true);
      expect(files.some((f) => f.includes('search2.txt'))).toBe(true);
    });

    test('should return correct line and column numbers', async () => {
      await createTestFile('positions.txt', 'Line 1\nHello World\nLine 3');

      const result = await searchFiles({
        pattern: 'Hello',
        path: 'tmp-test-filesystem',
      });

      expect(result.matches.length).toBe(1);
      expect(result.matches[0]!.line).toBe(2);
      expect(result.matches[0]!.column).toBe(1);
      expect(result.matches[0]!.content).toBe('Hello World');
    });

    test('should provide context lines', async () => {
      await createTestFile('context.txt', 'Line 1\nLine 2\nHello World\nLine 4\nLine 5');

      const result = await searchFiles({
        pattern: 'Hello',
        path: 'tmp-test-filesystem',
      });

      expect(result.matches[0]!.context).toBeDefined();
      expect(result.matches[0]!.context?.length).toBeGreaterThanOrEqual(3);
    });

    test('should filter by include patterns', async () => {
      await createTestFile('include.txt', 'target content');
      await createTestFile('exclude.log', 'target content');

      const result = await searchFiles({
        pattern: 'target',
        path: 'tmp-test-filesystem',
        include: ['*.txt'],
      });

      expect(result.totalMatches).toBe(1);
      expect(result.matches[0]!.file).toContain('include.txt');
    });

    test('should filter by exclude patterns', async () => {
      await createTestFile('keep.txt', 'search content');
      await createTestFile('ignore.log', 'search content');

      const result = await searchFiles({
        pattern: 'search',
        path: 'tmp-test-filesystem',
        exclude: ['*.log'],
      });

      expect(result.totalMatches).toBe(1);
      expect(result.matches[0]!.file).toContain('keep.txt');
    });

    test('should handle regex patterns', async () => {
      await createTestFile('regex.txt', 'test123 test456 test789');

      const result = await searchFiles({
        pattern: 'test\\d+',
        path: 'tmp-test-filesystem',
      });

      expect(result.totalMatches).toBe(3);
    });

    test('should default to project root when no path specified', async () => {
      // This test searches in the actual project for a known pattern
      const result = await searchFiles({
        pattern: 'ForgeCouncil',
      });

      expect(result.totalMatches).toBeGreaterThan(0);
      expect(result.totalFiles).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // deleteFile tests
  // ==========================================================================
  describe('deleteFile', () => {
    test('should delete a file', async () => {
      const filePath = 'delete-me.txt';
      await createTestFile(filePath, 'delete this content');

      const result = await deleteFile({
        path: path.join('tmp-test-filesystem', filePath),
        recursive: false,
        permanent: false,
      });

      expect(result.deleted).toBe(true);
      expect(result.bytesFreed).toBeGreaterThan(0);

      const file = Bun.file(path.join(TEST_DIR, filePath));
      expect(await file.exists()).toBe(false);
    });

    test('should delete directory recursively', async () => {
      await createTestFile('nested/deep/file.txt', 'content');

      const result = await deleteFile({
        path: 'tmp-test-filesystem/nested',
        recursive: true,
        permanent: false,
      });

      expect(result.deleted).toBe(true);

      const dir = Bun.file(path.join(TEST_DIR, 'nested'));
      expect(await dir.exists()).toBe(false);
    });

    test('should throw error for non-existent file', async () => {
      await expect(
        deleteFile({ path: 'tmp-test-filesystem/non-existent.txt', recursive: false, permanent: false }),
      ).rejects.toThrow('File or directory not found');
    });

    test('should throw error for directory without recursive flag', async () => {
      await Bun.spawn(['mkdir', '-p', path.join(TEST_DIR, 'non-empty-dir')]).exited;
      await createTestFile('non-empty-dir/file.txt', 'content');

      await expect(
        deleteFile({ path: 'tmp-test-filesystem/non-empty-dir', recursive: false, permanent: false }),
      ).rejects.toThrow('Cannot delete non-empty directory without recursive flag');
    });

    test('should throw error for path traversal', async () => {
      await expect(
        deleteFile({ path: '../../../etc/passwd', recursive: false, permanent: false }),
      ).rejects.toThrow('Path traversal detected');
    });
  });

  // ==========================================================================
  // Integration tests
  // ==========================================================================
  describe('integration', () => {
    test('full workflow: write, read, edit, search, delete', async () => {
      const filePath = 'workflow-test.txt';

      // Write
      await writeFile({
        path: path.join('tmp-test-filesystem', filePath),
        content: 'Initial content',
        encoding: 'utf8',
      });

      // Read
      const readResult = await readFile({
        path: path.join('tmp-test-filesystem', filePath),
        encoding: 'utf8',
      });
      expect(readResult.content).toBe('Initial content');

      // Edit
      await editFile({
        path: path.join('tmp-test-filesystem', filePath),
        edits: [{ search: 'Initial', replace: 'Updated', occurrences: 1 }],
      });

      // Search
      const searchResult = await searchFiles({
        pattern: 'Updated',
        path: 'tmp-test-filesystem',
      });
      expect(searchResult.totalMatches).toBe(1);

      // List
      const listResult = await listDir({ path: 'tmp-test-filesystem', recursive: false });
      expect(listResult.entries.some((e) => e.name === filePath)).toBe(true);

      // Delete
      await deleteFile({
        path: path.join('tmp-test-filesystem', filePath),
        recursive: false,
        permanent: false,
      });

      const file = Bun.file(path.join(TEST_DIR, filePath));
      expect(await file.exists()).toBe(false);
    });

    test('path traversal protection across all tools', async () => {
      const traversalPath = '../../../etc/passwd';

      await expect(readFile({ path: traversalPath, encoding: 'utf8' })).rejects.toThrow(
        'Path traversal detected',
      );

      await expect(writeFile({ path: traversalPath, content: 'x', encoding: 'utf8' })).rejects.toThrow(
        'Path traversal detected',
      );

      await expect(editFile({ path: traversalPath, edits: [] })).rejects.toThrow(
        'Path traversal detected',
      );

      await expect(listDir({ path: traversalPath, recursive: false })).rejects.toThrow(
        'Path traversal detected',
      );

      await expect(deleteFile({ path: traversalPath, recursive: false, permanent: false })).rejects.toThrow(
        'Path traversal detected',
      );
    });
  });
});
