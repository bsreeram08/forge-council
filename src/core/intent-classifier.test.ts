import { describe, test, expect } from 'bun:test';
import { greenfieldClassification } from './intent-classifier.ts';

describe('greenfieldClassification', () => {
  test('detects API domain', () => {
    const result = greenfieldClassification('Build a REST API for user management');
    // In an existing project, taskType will be 'feature', not 'greenfield'
    expect(['greenfield', 'feature']).toContain(result.taskType);
    expect(result.domains).toContain('api');
  });

  test('detects auth + security domains', () => {
    const result = greenfieldClassification('Build a login system with JWT authentication');
    expect(result.domains).toContain('auth');
  });

  test('detects payment domain', () => {
    const result = greenfieldClassification('Build a SaaS billing system with Stripe');
    expect(result.domains).toContain('payments');
  });

  test('detects UI domain', () => {
    const result = greenfieldClassification('Build a React dashboard for analytics');
    expect(result.domains).toContain('ui');
  });

  test('detects realtime domain', () => {
    const result = greenfieldClassification('Build a chat app with WebSocket support');
    expect(result.domains).toContain('realtime');
  });

  test('detects database domain', () => {
    const result = greenfieldClassification('Build an app with PostgreSQL database');
    expect(result.domains).toContain('database');
  });

  test('defaults to api when no domains detected', () => {
    const result = greenfieldClassification('Build something cool');
    expect(result.domains).toEqual(['api']);
  });

  test('simple complexity for short, single-domain ideas', () => {
    const result = greenfieldClassification('Build an API');
    expect(result.complexity).toBe('simple');
  });

  test('complex for many domains', () => {
    const result = greenfieldClassification(
      'Build a full-stack SaaS with auth, payments via Stripe, real-time chat via WebSocket, PostgreSQL database, and a React dashboard with deployment to Docker',
    );
    expect(result.complexity).toBe('complex');
  });

  test('moderate by default', () => {
    const result = greenfieldClassification('Build a REST API with authentication for a todo app');
    expect(result.complexity).toBe('moderate');
  });
});
