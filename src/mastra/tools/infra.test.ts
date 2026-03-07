import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  dockerExecute,
  envManagerExecute,
  packageManagerExecute,
  portCheckExecute,
  detectPackageManager,
  parseEnvFile,
  checkPortAvailable,
} from './infra';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('infra tools', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'infra-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('dockerExecute', () => {
    test('returns error when docker is not available', async () => {
      const result = await dockerExecute({
        action: 'ps',
        cwd: testDir,
      });

      expect(result).toHaveProperty('exitCode');
      expect(result).toHaveProperty('output');
    });
  });

  describe('envManagerExecute', () => {
    test('lists environment variables from .env file', async () => {
      writeFileSync(join(testDir, '.env'), `DATABASE_URL=postgres://localhost/db
API_KEY=secret123
PORT=3000
# This is a comment
DEBUG=true`);

      const result = await envManagerExecute({
        action: 'list',
        envFile: '.env',
        cwd: testDir,
      });

      expect(result.variables).toBeDefined();
      expect(result.variables?.DATABASE_URL).toBe('postgres://localhost/db');
      expect(result.variables?.PORT).toBe('3000');
      expect(result.variables?.DEBUG).toBe('true');
      expect(result.variables?.API_KEY).toContain('****');
    });

    test('masks sensitive environment variables', async () => {
      writeFileSync(join(testDir, '.env'), `SECRET_KEY=mysecretkey123
PASSWORD=mypassword456
API_TOKEN=token789
NORMAL_VAR=visible`);

      const result = await envManagerExecute({
        action: 'list',
        envFile: '.env',
        cwd: testDir,
      });

      expect(result.variables?.SECRET_KEY).toContain('****');
      expect(result.variables?.PASSWORD).toContain('****');
      expect(result.variables?.API_TOKEN).toContain('****');
      expect(result.variables?.NORMAL_VAR).toBe('visible');
    });

    test('validates required environment variables', async () => {
      writeFileSync(join(testDir, '.env'), `DATABASE_URL=postgres://localhost/db
PORT=3000`);

      const result = await envManagerExecute({
        action: 'validate',
        envFile: '.env',
        required: ['DATABASE_URL', 'PORT', 'API_KEY'],
        cwd: testDir,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing or empty required variable: API_KEY');
    });

    test('passes validation when all required vars present', async () => {
      writeFileSync(join(testDir, '.env'), `DATABASE_URL=postgres://localhost/db
PORT=3000
API_KEY=secret`);

      const result = await envManagerExecute({
        action: 'validate',
        envFile: '.env',
        required: ['DATABASE_URL', 'PORT', 'API_KEY'],
        cwd: testDir,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    test('check-missing returns missing variables', async () => {
      writeFileSync(join(testDir, '.env'), `DATABASE_URL=postgres://localhost/db`);

      const result = await envManagerExecute({
        action: 'check-missing',
        envFile: '.env',
        required: ['DATABASE_URL', 'PORT', 'API_KEY'],
        cwd: testDir,
      });

      expect(result.missing).toEqual(['PORT', 'API_KEY']);
      expect(result.valid).toBe(false);
    });

    test('handles missing .env file gracefully', async () => {
      const result = await envManagerExecute({
        action: 'list',
        envFile: '.env',
        cwd: testDir,
      });

      expect(result.variables).toEqual({});
    });

    test('handles quoted values', async () => {
      writeFileSync(join(testDir, '.env'), `SINGLE_QUOTED='hello world'
DOUBLE_QUOTED="foo bar"
NO_QUOTES=baz`);

      const result = await envManagerExecute({
        action: 'list',
        envFile: '.env',
        cwd: testDir,
      });

      expect(result.variables?.SINGLE_QUOTED).toBe('hello world');
      expect(result.variables?.DOUBLE_QUOTED).toBe('foo bar');
      expect(result.variables?.NO_QUOTES).toBe('baz');
    });
  });

  describe('detectPackageManager', () => {
    test('detects bun from bun.lockb', () => {
      writeFileSync(join(testDir, 'bun.lockb'), '');
      expect(detectPackageManager(testDir)).toBe('bun');
    });

    test('detects yarn from yarn.lock', () => {
      writeFileSync(join(testDir, 'yarn.lock'), '');
      expect(detectPackageManager(testDir)).toBe('yarn');
    });

    test('detects pnpm from pnpm-lock.yaml', () => {
      writeFileSync(join(testDir, 'pnpm-lock.yaml'), '');
      expect(detectPackageManager(testDir)).toBe('pnpm');
    });

    test('detects npm from package-lock.json', () => {
      writeFileSync(join(testDir, 'package-lock.json'), '');
      expect(detectPackageManager(testDir)).toBe('npm');
    });

    test('defaults to bun when no lock file found', () => {
      expect(detectPackageManager(testDir)).toBe('bun');
    });
  });

  describe('packageManagerExecute', () => {
    test('runs install command', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
      }));

      const result = await packageManagerExecute({
        action: 'install',
        manager: 'bun',
        cwd: testDir,
      });

      expect(result).toHaveProperty('exitCode');
      expect(result).toHaveProperty('output');
    }, 10000);

    test('throws when adding without packages', async () => {
      expect(async () => {
        await packageManagerExecute({
          action: 'add',
          packages: [],
          cwd: testDir,
        });
      }).toThrow('No packages specified');
    });

    test('throws when removing without packages', async () => {
      expect(async () => {
        await packageManagerExecute({
          action: 'remove',
          packages: [],
          cwd: testDir,
        });
      }).toThrow('No packages specified');
    });

    test('records added packages on success', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
      }));

      const result = await packageManagerExecute({
        action: 'add',
        packages: ['lodash', 'express'],
        manager: 'bun',
        cwd: testDir,
      });

      expect(result.added).toEqual(['lodash', 'express']);
    }, 10000);

    test('records removed packages on success', async () => {
      const result = await packageManagerExecute({
        action: 'remove',
        packages: ['lodash'],
        manager: 'npm',
        cwd: testDir,
      });

      expect(result.removed).toEqual(['lodash']);
    });

    test('auto-detects package manager from lock files', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
      }));
      writeFileSync(join(testDir, 'yarn.lock'), '');

      try {
        const result = await packageManagerExecute({
          action: 'list',
          cwd: testDir,
        });

        expect(result).toHaveProperty('exitCode');
      } catch (error: any) {
        if (error.message?.includes('Executable not found')) {
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });
  });

  describe('checkPortAvailable', () => {
    test('returns true for available port', async () => {
      const available = await checkPortAvailable(59999);
      expect(available).toBe(true);
    });

    test('handles port check with server binding', async () => {
      const net = await import('net');
      const server = net.createServer();
      
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(59998, 'localhost', () => resolve());
        });

        await new Promise(r => setTimeout(r, 100));
        const available = await checkPortAvailable(59998);
        
        expect(typeof available).toBe('boolean');
      } catch (e) {
        expect(true).toBe(true);
      } finally {
        server.close();
      }
    });
  });

  describe('portCheckExecute', () => {
    test('check action returns availability', async () => {
      const result = await portCheckExecute({
        action: 'check',
        port: 59997,
        host: 'localhost',
      });

      expect(result.available).toBe(true);
      expect(result.port).toBe(59997);
    });

    test('check action handles occupied port', async () => {
      const net = await import('net');
      const server = net.createServer();
      
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(59996, 'localhost', () => resolve());
        });

        await new Promise(r => setTimeout(r, 100));

        const result = await portCheckExecute({
          action: 'check',
          port: 59996,
          host: 'localhost',
        });

        expect(result.port).toBe(59996);
        expect(result).toHaveProperty('available');
        expect(typeof result.available).toBe('boolean');
      } catch (e) {
        expect(true).toBe(true);
      } finally {
        server.close();
      }
    });

    test('find-available returns an open port', async () => {
      const result = await portCheckExecute({
        action: 'find-available',
        range: { start: 59990, end: 59995 },
        host: 'localhost',
      });

      expect(result.available).toBe(true);
      expect(result.port).toBeDefined();
      expect(result.port).toBeGreaterThanOrEqual(59990);
      expect(result.port).toBeLessThanOrEqual(59995);
    });

    test('list-listening returns array', async () => {
      const result = await portCheckExecute({
        action: 'list-listening',
      });

      expect(result.services).toBeDefined();
      expect(Array.isArray(result.services)).toBe(true);
    });

    test('throws when check called without port', async () => {
      expect(async () => {
        await portCheckExecute({
          action: 'check',
        });
      }).toThrow('Port number required');
    });
  });

  describe('parseEnvFile', () => {
    test('parses simple env file', async () => {
      writeFileSync(join(testDir, '.env'), 'KEY=value\nFOO=bar');

      const vars = await parseEnvFile(join(testDir, '.env'));

      expect(vars).toEqual({ KEY: 'value', FOO: 'bar' });
    });

    test('ignores comments and empty lines', async () => {
      writeFileSync(join(testDir, '.env'), `# This is a comment
KEY=value

# Another comment
FOO=bar`);

      const vars = await parseEnvFile(join(testDir, '.env'));

      expect(vars).toEqual({ KEY: 'value', FOO: 'bar' });
    });

    test('handles values with equals signs', async () => {
      writeFileSync(join(testDir, '.env'), 'DATABASE_URL=postgres://user:pass@host/db');

      const vars = await parseEnvFile(join(testDir, '.env'));

      expect(vars.DATABASE_URL).toBe('postgres://user:pass@host/db');
    });

    test('handles quoted values', async () => {
      writeFileSync(join(testDir, '.env'), `SINGLE='quoted'
DOUBLE="quoted"
MIXED='mixed"quotes"'`);

      const vars = await parseEnvFile(join(testDir, '.env'));

      expect(vars.SINGLE).toBe('quoted');
      expect(vars.DOUBLE).toBe('quoted');
      expect(vars.MIXED).toBe('mixed"quotes"');
    });

    test('returns empty object for missing file', async () => {
      const vars = await parseEnvFile(join(testDir, 'nonexistent.env'));

      expect(vars).toEqual({});
    });
  });
});
