import { describe, it, expect, beforeEach } from 'bun:test';
import {
  PluginRegistry,
  resetPluginRegistry,
  getPluginRegistry,
  type ForgeCouncilPlugin,
} from './plugin.ts';

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    resetPluginRegistry();
    registry = new PluginRegistry();
  });

  describe('registration', () => {
    it('registers and retrieves a plugin', async () => {
      const plugin: ForgeCouncilPlugin = {
        name: 'test-plugin',
        version: '1.0.0',
      };

      await registry.register(plugin);
      expect(registry.has('test-plugin')).toBe(true);
      expect(registry.get('test-plugin')).toBe(plugin);
    });

    it('lists all registered plugins', async () => {
      await registry.register({ name: 'a', version: '1.0.0' });
      await registry.register({ name: 'b', version: '1.0.0' });
      expect(registry.getAll()).toHaveLength(2);
    });

    it('replaces plugin with same name', async () => {
      await registry.register({ name: 'test', version: '1.0.0', description: 'v1' });
      await registry.register({ name: 'test', version: '2.0.0', description: 'v2' });
      expect(registry.get('test')?.version).toBe('2.0.0');
    });

    it('calls setup() with context', async () => {
      let setupCalled = false;
      const plugin: ForgeCouncilPlugin = {
        name: 'setup-test',
        version: '1.0.0',
        setup(ctx) {
          setupCalled = true;
          expect(ctx.projectRoot).toBeDefined();
          expect(typeof ctx.on).toBe('function');
          expect(typeof ctx.onToolPre).toBe('function');
          expect(typeof ctx.onToolPost).toBe('function');
          expect(typeof ctx.log).toBe('function');
        },
      };

      await registry.register(plugin);
      expect(setupCalled).toBe(true);
    });

    it('calls teardown() on unregister', async () => {
      let tornDown = false;
      const plugin: ForgeCouncilPlugin = {
        name: 'teardown-test',
        version: '1.0.0',
        teardown() {
          tornDown = true;
        },
      };

      await registry.register(plugin);
      await registry.unregister('teardown-test');
      expect(tornDown).toBe(true);
      expect(registry.has('teardown-test')).toBe(false);
    });
  });

  describe('declarative hooks', () => {
    it('registers hooks from plugin.hooks', async () => {
      const plugin: ForgeCouncilPlugin = {
        name: 'hook-test',
        version: '1.0.0',
        hooks: {
          'session:start': () => ({ action: 'continue' as const }),
          'phase:start': () => ({ action: 'continue' as const }),
        },
      };

      await registry.register(plugin);
      expect(registry.hookCount('session:start')).toBe(1);
      expect(registry.hookCount('phase:start')).toBe(1);
    });

    it('registers hooks with matcher config', async () => {
      const plugin: ForgeCouncilPlugin = {
        name: 'matcher-test',
        version: '1.0.0',
        hooks: {
          'tool:post': {
            matcher: /^(writeFile|editFile)$/,
            handler: () => ({ action: 'continue' as const }),
          },
        },
      };

      await registry.register(plugin);
      expect(registry.hookCount('tool:post')).toBe(1);
    });
  });

  describe('imperative hooks (via setup)', () => {
    it('registers hooks via context.on()', async () => {
      const plugin: ForgeCouncilPlugin = {
        name: 'imperative-test',
        version: '1.0.0',
        setup(ctx) {
          ctx.on('code:before', () => ({ action: 'continue' }));
          ctx.on('code:after', () => ({ action: 'continue' }));
        },
      };

      await registry.register(plugin);
      expect(registry.hookCount('code:before')).toBe(1);
      expect(registry.hookCount('code:after')).toBe(1);
    });

    it('registers tool hooks via convenience methods', async () => {
      const plugin: ForgeCouncilPlugin = {
        name: 'tool-hook-test',
        version: '1.0.0',
        setup(ctx) {
          ctx.onToolPre(/writeFile/, () => ({ action: 'continue' }));
          ctx.onToolPost(/editFile/, () => ({ action: 'continue' }));
        },
      };

      await registry.register(plugin);
      expect(registry.hookCount('tool:pre')).toBe(1);
      expect(registry.hookCount('tool:post')).toBe(1);
    });
  });

  describe('hook dispatch', () => {
    it('emits to all matching handlers', async () => {
      const calls: string[] = [];

      await registry.register({
        name: 'p1',
        version: '1.0.0',
        hooks: {
          'session:start': () => {
            calls.push('p1');
            return { action: 'continue' };
          },
        },
      });

      await registry.register({
        name: 'p2',
        version: '1.0.0',
        hooks: {
          'session:start': () => {
            calls.push('p2');
            return { action: 'continue' };
          },
        },
      });

      await registry.emit('session:start', { sessionId: 'test', idea: 'test', projectRoot: '.' });
      expect(calls).toEqual(['p1', 'p2']);
    });

    it('blocks on pre hooks returning action: block', async () => {
      const calls: string[] = [];

      await registry.register({
        name: 'blocker',
        version: '1.0.0',
        hooks: {
          'tool:pre': () => {
            calls.push('blocker');
            return { action: 'block', reason: 'blocked by test' };
          },
        },
      });

      await registry.register({
        name: 'after-blocker',
        version: '1.0.0',
        hooks: {
          'tool:pre': () => {
            calls.push('after-blocker');
            return { action: 'continue' };
          },
        },
      });

      const results = await registry.emit('tool:pre', {
        toolName: 'writeFile',
        input: {},
        agentId: 'coder',
      });

      expect(calls).toEqual(['blocker']); // second handler not called
      expect(results).toHaveLength(1);
      expect(results[0]!.action).toBe('block');
    });

    it('filters tool hooks by matcher', async () => {
      const calls: string[] = [];

      await registry.register({
        name: 'filtered',
        version: '1.0.0',
        hooks: {
          'tool:post': {
            matcher: /^writeFile$/,
            handler: () => {
              calls.push('writeFile-handler');
              return { action: 'continue' };
            },
          },
        },
      });

      // Should fire for writeFile
      await registry.emit('tool:post', { toolName: 'writeFile', input: {}, agentId: 'coder' });
      expect(calls).toEqual(['writeFile-handler']);

      // Should NOT fire for readFile
      calls.length = 0;
      await registry.emit('tool:post', { toolName: 'readFile', input: {}, agentId: 'coder' });
      expect(calls).toEqual([]);
    });

    it('collects feedback from handlers', async () => {
      await registry.register({
        name: 'feedback-1',
        version: '1.0.0',
        hooks: {
          'tool:post': () => ({
            action: 'continue',
            feedback: 'Error: type mismatch on line 5',
          }),
        },
      });

      await registry.register({
        name: 'feedback-2',
        version: '1.0.0',
        hooks: {
          'tool:post': () => ({
            action: 'continue',
            feedback: 'Warning: unused variable',
          }),
        },
      });

      const feedback = await registry.emitAndCollectFeedback('tool:post', {
        toolName: 'editFile',
        input: {},
        agentId: 'coder',
      });

      expect(feedback).toContain('type mismatch');
      expect(feedback).toContain('unused variable');
    });

    it('returns undefined feedback when no handlers have feedback', async () => {
      await registry.register({
        name: 'no-feedback',
        version: '1.0.0',
        hooks: {
          'tool:post': () => ({ action: 'continue' }),
        },
      });

      const feedback = await registry.emitAndCollectFeedback('tool:post', {
        toolName: 'editFile',
        input: {},
        agentId: 'coder',
      });
      expect(feedback).toBeUndefined();
    });

    it('emitPreHook returns blocked status', async () => {
      await registry.register({
        name: 'gate',
        version: '1.0.0',
        hooks: {
          'tool:pre': () => ({
            action: 'block',
            reason: 'not allowed',
          }),
        },
      });

      const result = await registry.emitPreHook('tool:pre', {
        toolName: 'writeFile',
        input: {},
        agentId: 'coder',
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('not allowed');
    });

    it('handles errors in hook handlers gracefully', async () => {
      await registry.register({
        name: 'error-plugin',
        version: '1.0.0',
        hooks: {
          'session:start': () => {
            throw new Error('plugin crashed');
          },
        },
      });

      // Should not throw
      const results = await registry.emit('session:start', {
        sessionId: 'test',
        idea: 'test',
        projectRoot: '.',
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.metadata?.error).toBe('plugin crashed');
    });

    it('returns empty results for events with no handlers', async () => {
      const results = await registry.emit('ship:before', {});
      expect(results).toEqual([]);
    });
  });

  describe('hook transforms', () => {
    it('passes transformed data to subsequent handlers', async () => {
      let secondHandlerData: any = null;

      await registry.register({
        name: 'transformer',
        version: '1.0.0',
        hooks: {
          'classify:after': (data) => ({
            action: 'continue',
            transformed: { ...(data as any), extra: 'injected' },
          }),
        },
      });

      await registry.register({
        name: 'receiver',
        version: '1.0.0',
        hooks: {
          'classify:after': (data) => {
            secondHandlerData = data;
            return { action: 'continue' };
          },
        },
      });

      await registry.emit('classify:after', {
        idea: 'test',
        classification: { taskType: 'feature', domains: [], complexity: 'medium' } as any,
      });

      expect(secondHandlerData?.extra).toBe('injected');
    });
  });

  describe('unregister', () => {
    it('removes all hooks from unregistered plugin', async () => {
      await registry.register({
        name: 'removable',
        version: '1.0.0',
        hooks: {
          'session:start': () => ({ action: 'continue' }),
          'tool:pre': () => ({ action: 'continue' }),
        },
      });

      expect(registry.hookCount('session:start')).toBe(1);
      expect(registry.hookCount('tool:pre')).toBe(1);

      await registry.unregister('removable');

      expect(registry.hookCount('session:start')).toBe(0);
      expect(registry.hookCount('tool:pre')).toBe(0);
    });
  });

  describe('global singleton', () => {
    it('returns the same registry', () => {
      const a = getPluginRegistry();
      const b = getPluginRegistry();
      expect(a).toBe(b);
    });

    it('resets on resetPluginRegistry()', () => {
      const a = getPluginRegistry();
      resetPluginRegistry();
      const b = getPluginRegistry();
      expect(a).not.toBe(b);
    });
  });
});
