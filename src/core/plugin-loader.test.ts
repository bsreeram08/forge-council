import { describe, it, expect, beforeEach } from 'bun:test';
import { resetPluginRegistry, getPluginRegistry } from './plugin.ts';
import { checkTaskScope } from './builtin-plugins.ts';

// We test the public parts of the plugin loader and built-in plugins here.
// The actual file discovery is tested indirectly via integration.

describe('builtin-plugins', () => {
  beforeEach(() => {
    resetPluginRegistry();
  });

  describe('task-scope-guard: checkTaskScope', () => {
    it('flags overly broad task titles', () => {
      const issues = checkTaskScope('Implement authentication system', 'Build the auth');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]).toContain('Too broad');
    });

    it('flags compound tasks', () => {
      const issues = checkTaskScope('Add login endpoint and create user model', '');
      expect(issues.some((i: string) => i.includes('Compound task'))).toBe(true);
    });

    it('flags very short titles', () => {
      const issues = checkTaskScope('Fix bug', '');
      expect(issues.some((i: string) => i.includes('too short'))).toBe(true);
    });

    it('accepts specific, narrow tasks', () => {
      const issues = checkTaskScope('Add POST /login endpoint to auth-router.ts', 'Handles username/password login');
      expect(issues).toHaveLength(0);
    });

    it('accepts reasonable task titles', () => {
      const issues = checkTaskScope('Write unit tests for TokenCounter class', 'Test edge cases');
      expect(issues).toHaveLength(0);
    });

    it('flags compound in description too', () => {
      const issues = checkTaskScope('Update the config loader', 'Load config and also set up the database');
      expect(issues.some((i: string) => i.includes('Compound task'))).toBe(true);
    });
  });

  describe('validation-gate plugin', () => {
    it('exports the plugin with correct shape', async () => {
      const { validationGatePlugin } = await import('./builtin-plugins.ts');

      expect(validationGatePlugin.name).toBe('validation-gate');
      expect(validationGatePlugin.version).toBe('1.0.0');
      expect(typeof validationGatePlugin.setup).toBe('function');
    });
  });

  describe('task-scope-guard plugin', () => {
    it('exports the plugin with correct shape', async () => {
      const { taskScopeGuardPlugin } = await import('./builtin-plugins.ts');

      expect(taskScopeGuardPlugin.name).toBe('task-scope-guard');
      expect(taskScopeGuardPlugin.version).toBe('1.0.0');
      expect(taskScopeGuardPlugin.hooks).toBeDefined();
      expect(taskScopeGuardPlugin.hooks!['plan:merge']).toBeDefined();
      expect(taskScopeGuardPlugin.hooks!['code:task-end']).toBeDefined();
    });
  });

  describe('BUILTIN_PLUGINS array', () => {
    it('includes both built-in plugins', async () => {
      const { BUILTIN_PLUGINS } = await import('./builtin-plugins.ts');
      expect(BUILTIN_PLUGINS).toHaveLength(2);
      expect(BUILTIN_PLUGINS.map(p => p.name)).toEqual([
        'validation-gate',
        'task-scope-guard',
      ]);
    });
  });
});

describe('PluginRegistry integration with built-in plugins', () => {
  beforeEach(() => {
    resetPluginRegistry();
  });

  it('registers validation-gate and creates tool:post hooks', async () => {
    const { validationGatePlugin } = await import('./builtin-plugins.ts');
    const registry = getPluginRegistry();

    await registry.register(validationGatePlugin);

    expect(registry.has('validation-gate')).toBe(true);
    expect(registry.hookCount('tool:post')).toBeGreaterThan(0);
    expect(registry.hookCount('code:task-end')).toBeGreaterThan(0);
  });

  it('registers task-scope-guard with declarative hooks', async () => {
    const { taskScopeGuardPlugin } = await import('./builtin-plugins.ts');
    const registry = getPluginRegistry();

    await registry.register(taskScopeGuardPlugin);

    expect(registry.has('task-scope-guard')).toBe(true);
    expect(registry.hookCount('plan:merge')).toBe(1);
    expect(registry.hookCount('code:task-end')).toBe(1);
  });
});
