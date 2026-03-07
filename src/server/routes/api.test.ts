import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { createApiRoutes } from './api.ts';
import { SessionManager, logBuffer } from '../session.ts';
import { AGENT_DEFS } from '../../council/agent-registry.ts';

// Use a real SessionManager to test routes
const sessionManager = new SessionManager();

function createTestApp() {
  const app = new Hono();
  const api = createApiRoutes(sessionManager);
  app.route('/', api);
  return app;
}

describe('API routes', () => {
  const app = createTestApp();

  test('GET /api/health returns ok', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  test('GET /api/session returns null when no session', async () => {
    const res = await app.request('/api/session');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });

  test('GET /api/agents returns agent definitions', async () => {
    const res = await app.request('/api/agents');
    expect(res.status).toBe(200);
    const agents = await res.json() as { id: string; name: string; role: string; description: string; required: boolean; defaultModel: string; dimensions: unknown[]; instructions?: string }[];

    // Should return an array of agents
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBe(AGENT_DEFS.length);

    // Each agent should have the expected fields (no instructions leaked)
    for (const agent of agents) {
      expect(agent).toHaveProperty('id');
      expect(agent).toHaveProperty('name');
      expect(agent).toHaveProperty('role');
      expect(agent).toHaveProperty('description');
      expect(agent).toHaveProperty('required');
      expect(agent).toHaveProperty('defaultModel');
      expect(agent).toHaveProperty('dimensions');
      // Should NOT include the full instructions
      expect(agent).not.toHaveProperty('instructions');
    }

    // Verify specific agents exist
    const ids = agents.map((a) => a.id);
    expect(ids).toContain('executor');
    expect(ids).toContain('architect');
    expect(ids).toContain('coder');
  });

  test('GET /api/agents returns dimension details', async () => {
    const res = await app.request('/api/agents');
    const agents = await res.json() as { id: string; dimensions: { name: string; weight: number; description: string }[] }[];

    const architect = agents.find((a) => a.id === 'architect');
    expect(architect).toBeDefined();
    expect(architect!.dimensions.length).toBeGreaterThan(0);

    for (const dim of architect!.dimensions) {
      expect(dim).toHaveProperty('name');
      expect(dim).toHaveProperty('weight');
      expect(dim).toHaveProperty('description');
    }
  });

  test('GET /api/reviews returns empty when no session', async () => {
    const res = await app.request('/api/reviews');
    expect(res.status).toBe(200);
    const body = await res.json() as { round: number; reviews: unknown[] };
    expect(body.round).toBe(0);
    expect(body.reviews).toEqual([]);
  });

  test('GET /api/sessions returns empty array when no sessions in store', async () => {
    const res = await app.request('/api/sessions');
    expect(res.status).toBe(200);
    const sessions = await res.json();
    expect(Array.isArray(sessions)).toBe(true);
  });

  test('GET /api/sessions/:id returns 404 for unknown id', async () => {
    const res = await app.request('/api/sessions/nonexistent');
    expect(res.status).toBe(404);
  });

  test('POST /api/steer accepts guidance', async () => {
    // Create a session first
    sessionManager.create('test idea', 0);
    const res = await app.request('/api/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guidance: 'Focus on tests' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify guidance was added to session
    const session = sessionManager.get();
    expect(session?.guidance).toContain('Focus on tests');
  });
});
