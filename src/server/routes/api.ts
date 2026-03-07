import { Hono } from 'hono';
import type { SessionManager } from '../session.ts';
import { logBuffer } from '../session.ts';
import { getStore } from '../store.ts';
import { AGENT_DEFS } from '../../council/agent-registry.ts';

export function createApiRoutes(sessionManager: SessionManager): Hono {
  const api = new Hono();

  function getReviewsForRound(sessionId: string, round: number) {
    const reviews = getStore().getReviews(sessionId, round);
    return { round, reviews };
  }

  api.get('/api/session', (c) => {
    const session = sessionManager.get();
    return c.json(session);
  });

  api.get('/api/reviews/:round', (c) => {
    const round = Number(c.req.param('round'));
    const session = sessionManager.get();
    if (!session) return c.json({ round, reviews: [] });
    return c.json(getReviewsForRound(session.id, round));
  });

  api.get('/api/reviews', (c) => {
    const session = sessionManager.get();
    if (!session) return c.json({ round: 0, reviews: [] });
    return c.json(getReviewsForRound(session.id, session.currentRound));
  });

  api.get('/api/plan/:round', (c) => {
    const round = Number(c.req.param('round'));
    const session = sessionManager.get();
    if (!session) return c.json(null, 404);
    const plan = getStore().getPlan(session.id, round);
    return c.json(plan);
  });

  api.get('/api/plan', (c) => {
    const session = sessionManager.get();
    if (!session) return c.json(null, 404);
    const latest = getStore().getLatestPlan(session.id);
    return c.json(latest);
  });

  api.get('/api/logs', (c) => {
    const afterId = Number(c.req.query('after') ?? '0');
    const entries = logBuffer.getAfter(afterId);
    return c.json(entries);
  });

  api.post('/api/steer', async (c) => {
    const body = await c.req.json<{ guidance: string }>();
    sessionManager.addGuidance(body.guidance);
    return c.json({ ok: true });
  });

  api.get('/api/health', (c) => {
    return c.json({ status: 'ok' });
  });

  // --- Council agents ---

  api.get('/api/agents', (c) => {
    const agents = AGENT_DEFS.map((def) => ({
      id: def.id,
      name: def.name,
      role: def.role,
      description: def.description,
      required: def.required,
      defaultModel: def.defaultModel,
      dimensions: def.dimensions,
    }));
    return c.json(agents);
  });

  // --- Session history ---

  api.get('/api/sessions', (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const sessions = getStore().listSessions(limit);
    return c.json(sessions);
  });

  api.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id');
    const session = getStore().getSession(id);
    if (!session) return c.json(null, 404);
    const scores = getStore().getScores(id);
    const latestPlan = getStore().getLatestPlan(id);
    return c.json({ ...session, scores, latestPlan });
  });

  return api;
}
