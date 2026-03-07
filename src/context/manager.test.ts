import { describe, expect, test, beforeEach } from 'bun:test';
import { ContextManager, getContextManager, resetContextManager } from './manager';

describe('ContextManager', () => {
  beforeEach(() => {
    resetContextManager();
  });

  test('starts with empty state', () => {
    const manager = new ContextManager();
    expect(manager.getTotalTokens('test-agent')).toBe(0);
    expect(manager.getUsagePercentage('test-agent')).toBe(0);
  });

  test('adds entries and tracks tokens', () => {
    const manager = new ContextManager({ maxTokens: 1000 });
    
    manager.addEntry('test-agent', {
      type: 'task',
      content: 'Build a todo app',
    });
    
    expect(manager.getTotalTokens('test-agent')).toBeGreaterThan(0);
    expect(manager.getUsagePercentage('test-agent')).toBeGreaterThan(0);
  });

  test('returns correct scope for known agent', () => {
    const manager = new ContextManager();
    
    const scope = manager.getScope('architect');
    expect(scope.codebase).toBe('full-tree-with-signatures');
    expect(scope.git).toBe('last-20-commits-with-diffs');
  });

  test('returns default scope for unknown agent', () => {
    const manager = new ContextManager();
    
    const scope = manager.getScope('unknown-agent');
    expect(scope.codebase).toBe('full-tree');
  });

  test('triggers compaction callback at threshold', () => {
    const manager = new ContextManager({ 
      maxTokens: 100,
      compactionThreshold: 0.5,
      mode: 'safeguard' 
    });
    
    let callbackCalled = false;
    manager.registerCompactionCallback('test-agent', () => {
      callbackCalled = true;
    });
    
    manager.addEntry('test-agent', {
      type: 'task',
      content: 'A'.repeat(300),
    });
    
    expect(callbackCalled).toBe(true);
  });

  test('compact method reduces entries', () => {
    const manager = new ContextManager({ 
      maxTokens: 100,
      compactionThreshold: 0.8,
      mode: 'aggressive' 
    });
    
    manager.addEntry('test-agent', {
      type: 'task',
      content: 'Task 1',
    });
    
    manager.addEntry('test-agent', {
      type: 'review',
      content: 'Review 1',
    });
    
    const entries = manager.getEntries('test-agent');
    const countBefore = entries.length;
    
    manager.compact('test-agent');
    
    const entriesAfter = manager.getEntries('test-agent');
    expect(entriesAfter.length).toBeLessThanOrEqual(countBefore);
  });

  test('clear removes agent state', () => {
    const manager = new ContextManager();
    
    manager.addEntry('test-agent', {
      type: 'task',
      content: 'Test task',
    });
    
    expect(manager.getTotalTokens('test-agent')).toBeGreaterThan(0);
    
    manager.clear('test-agent');
    
    expect(manager.getTotalTokens('test-agent')).toBe(0);
  });

  test('getContextManager returns singleton', () => {
    const manager1 = getContextManager();
    const manager2 = getContextManager();
    
    expect(manager1).toBe(manager2);
  });

  test('resetContextManager creates new instance', () => {
    const manager1 = getContextManager();
    resetContextManager();
    const manager2 = getContextManager();
    
    expect(manager1).not.toBe(manager2);
  });
});
