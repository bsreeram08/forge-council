import { Hono } from 'hono';
import type { SessionManager } from '../session.ts';
import { logBuffer } from '../session.ts';
import { getStore } from '../store.ts';
import { AGENT_DEFS } from '../../council/agent-registry.ts';
import { loadConfig } from '../../config/loader.ts';
import { eventBus } from './ws.ts';
import { getCurrentDisplay } from '../../core/workflow.ts';

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

  // Fetch logs from in-memory buffer (recent) or specify sessionId for persisted logs
  api.get('/api/logs', (c) => {
    const afterId = Number(c.req.query('after') ?? '0');
    const entries = logBuffer.getAfter(afterId);
    return c.json(entries);
  });

  // Persisted logs per session
  api.get('/api/logs/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId');
    const afterId = Number(c.req.query('after') ?? '0');
    const limit = Number(c.req.query('limit') ?? '200');
    try {
      const entries = getStore().getLogs(sessionId, afterId, limit);
      return c.json(entries);
    } catch (e) {
      return c.json({ error: 'failed to read logs' }, 500);
    }
  });

  api.post('/api/steer', async (c) => {
    const body = await c.req.json<{ guidance: string }>();
    sessionManager.addGuidance(body.guidance);
    return c.json({ ok: true });
  });

  // Per-agent steering
  api.post('/api/steer/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    const body = await c.req.json<{ guidance: string }>();
    if (!body.guidance) {
      return c.json({ error: 'guidance is required' }, 400);
    }
    sessionManager.addGuidance(body.guidance, agentId);
    return c.json({ ok: true, agentId });
  });

  // Live agent status — returns what AgentDisplay knows
  api.get('/api/agents/status', (c) => {
    const display = getCurrentDisplay();
    if (!display) {
      return c.json({ active: false, agents: [] });
    }
    return c.json({ active: true, agents: display.getStatus() });
  });

  // Agent tool call history
  api.get('/api/agents/:agentId/history', (c) => {
    const agentId = c.req.param('agentId');
    const display = getCurrentDisplay();
    if (!display) {
      return c.json({ agentId, history: [] });
    }
    return c.json({ agentId, history: display.getAgentHistory(agentId) });
  });

  // Expose resolved config (read-only) and allow updates to mutable fields
  api.get('/api/config', async (c) => {
    try {
      const config = await loadConfig();
      // Redact provider apiKeys
      for (const provider of Object.values(config.models.providers)) {
        if (provider.apiKey && !provider.apiKey.startsWith('env:')) {
          (provider as any).apiKey = 'REDACTED';
        }
      }
      return c.json(config);
    } catch (e) {
      return c.json({ error: 'failed to load config' }, 500);
    }
  });

  api.post('/api/config', async (c) => {
    try {
      const body = await c.req.json();
      const projectPath = './.forgecouncil/config.json';
      const file = Bun.file(projectPath);
      const exists = await file.exists();
      let current = {};
      if (exists) {
        current = await file.json() as any;
      }
      const merged = { ...current, ...body };
      await Bun.write(projectPath, JSON.stringify(merged, null, 2));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: 'failed to update config' }, 500);
    }
  });

  api.get('/api/health', (c) => {
    return c.json({ status: 'ok' });
  });

  // --- Task Board (parallel coding) ---

  api.get('/api/task-board', (c) => {
    const snapshot = sessionManager.getTaskBoardSnapshot();
    if (!snapshot) {
      return c.json({ active: false, board: null });
    }
    return c.json({ active: true, board: snapshot });
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

  // --- User action endpoints (for web UI parity) ---

  api.post('/api/pause', (_c) => {
    sessionManager.addGuidance('[pause]');
    try { eventBus.publish('pending-action', { type: 'confirm', message: 'Paused by user' }); } catch (_) {}
    return _c.json({ ok: true, action: 'pause' });
  });

  api.post('/api/ship-now', (_c) => {
    sessionManager.addGuidance('[ship-now]');
    try { eventBus.publish('pending-action', { type: 'confirm', message: 'Ship now requested' }); } catch (_) {}
    return _c.json({ ok: true, action: 'ship-now' });
  });

  api.post('/api/pick-items', async (c) => {
    const body = await c.req.json<{ selectedIds: string[] }>();
    if (!body.selectedIds || !Array.isArray(body.selectedIds)) {
      return c.json({ error: 'selectedIds must be an array of string IDs' }, 400);
    }
    sessionManager.resolvePendingAction({ type: 'pick-items', selectedIds: body.selectedIds });
    return c.json({ ok: true, selectedCount: body.selectedIds.length });
  });

  api.post('/api/pick-action', async (c) => {
    const body = await c.req.json<{ action: string }>();
    if (!body.action) {
      return c.json({ error: 'action is required' }, 400);
    }
    sessionManager.resolvePendingAction({ type: 'pick-action', action: body.action });
    return c.json({ ok: true, action: body.action });
  });

  api.post('/api/fix/select', async (c) => {
    const body = await c.req.json<{ issueIds: string[] }>();
    if (!body.issueIds || !Array.isArray(body.issueIds)) {
      return c.json({ error: 'issueIds must be an array of string IDs' }, 400);
    }
    sessionManager.resolvePendingAction({ type: 'fix-select', issueIds: body.issueIds });
    return c.json({ ok: true, selectedCount: body.issueIds.length });
  });

  api.post('/api/fix/action', async (c) => {
    const body = await c.req.json<{ action: string }>();
    if (!body.action) {
      return c.json({ error: 'action is required' }, 400);
    }
    sessionManager.resolvePendingAction({ type: 'fix-action', action: body.action });
    return c.json({ ok: true, action: body.action });
  });

  // --- Notifications ---

  api.get('/api/notifications', (c) => {
    const notifications = sessionManager.getNotifications();
    return c.json(notifications);
  });

  api.post('/api/notifications/:id/dismiss', (c) => {
    const id = c.req.param('id');
    const ok = sessionManager.dismissNotification(id);
    return ok ? c.json({ ok: true }) : c.json({ error: 'notification not found' }, 404);
  });

  api.post('/api/notifications/:id/respond', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ response: string }>();
    if (!body.response) {
      return c.json({ error: 'response is required' }, 400);
    }
    const ok = sessionManager.respondToNotification(id, body.response);
    return ok ? c.json({ ok: true }) : c.json({ error: 'notification not found or not actionable' }, 404);
  });

  // --- Git history ---

  api.get('/api/git-history', async (c) => {
    const count = Number(c.req.query('count') ?? '20');

    try {
      const proc = Bun.spawn(
        ['git', 'log', `--max-count=${count}`, '--format=%h %s (%cr)', '--no-color'],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return c.json({ error: 'Not in a git repository or git is not available.' }, 400);
      }

      const lines = output.trim().split('\n').filter(Boolean);

      // Format commits with icons based on conventional commit type
      const commitTypePattern = /^[a-f0-9]+ (?:\[[\w-]+\] )?(\w+):/;
      const formatted = lines.map(line => {
        const match = line.match(commitTypePattern);
        const type = match?.[1];
        const icon = type === 'feat' ? '✨'
          : type === 'fix' ? '🔧'
          : type === 'test' ? '🧪'
          : type === 'doc' || type === 'docs' ? '📚'
          : type === 'refactor' ? '♻️'
          : line.includes('[coder]') ? '💻'
          : line.includes('[executor]') ? '🏗️'
          : '•';
        return `${icon} ${line}`;
      });

      return c.json(formatted);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to read git history: ${msg}` }, 500);
    }
  });

  // --- UI Testing endpoints (mock pending actions for e2e testing) ---

  api.post('/api/test/pending-action', async (c) => {
    const body = await c.req.json<{ action: any }>();
    if (!body.action) {
      return c.json({ error: 'action object is required' }, 400);
    }
    sessionManager.setPendingAction(body.action);
    return c.json({ ok: true });
  });

  api.post('/api/test/clear-pending', (_c) => {
    sessionManager.resolvePendingAction({ type: 'cleared' });
    return _c.json({ ok: true });
  });

  api.post('/api/test/mock-session', async (c) => {
    const body = await c.req.json<{ idea?: string; phase?: string }>();
    const session = sessionManager.get();
    if (session) {
      if (body.phase) sessionManager.setPhase(body.phase);
      return c.json({ ok: true, sessionId: session.id });
    }
    const mockSession = sessionManager.create(
      body.idea ?? 'UI Test Session — mock data for e2e testing',
      0,
    );
    if (body.phase) sessionManager.setPhase(body.phase);
    return c.json({ ok: true, sessionId: mockSession.id });
  });

  api.post('/api/test/mock-plan', async (c) => {
    const body = await c.req.json<{ plan?: any }>();
    const plan = body.plan ?? {
      summary: 'Test plan for UI e2e testing',
      categories: [
        {
          name: 'Core Features',
          items: [
            { id: 'test-1', title: 'Implement auth', description: 'JWT-based authentication', priority: 'must', phase: 1, source: 'architect', selected: true },
            { id: 'test-2', title: 'Database setup', description: 'PostgreSQL with migrations', priority: 'must', phase: 1, source: 'architect', selected: true },
            { id: 'test-3', title: 'API routes', description: 'RESTful API endpoints', priority: 'should', phase: 1, source: 'planner', selected: true },
          ],
        },
        {
          name: 'UI',
          items: [
            { id: 'test-4', title: 'Dashboard', description: 'Main dashboard view', priority: 'should', phase: 2, source: 'researcher', selected: true },
            { id: 'test-5', title: 'Settings page', description: 'User settings and preferences', priority: 'could', phase: 3, source: 'planner', selected: false },
          ],
        },
      ],
      techStack: { Runtime: 'Bun', Framework: 'Hono', Database: 'PostgreSQL' },
    };
    sessionManager.setPendingAction({ type: 'pick-items', plan });
    return c.json({ ok: true });
  });

  api.post('/api/test/mock-reviews', async (c) => {
    const issues = [
      { id: 'issue-1', severity: 'critical', what: 'SQL injection in query builder', file: 'src/db/query.ts', line: 42, fix: 'Use parameterized queries' },
      { id: 'issue-2', severity: 'warning', what: 'Missing error boundary', file: 'src/ui/App.tsx', line: 15, fix: 'Wrap in ErrorBoundary component' },
      { id: 'issue-3', severity: 'suggestion', what: 'Consider caching', file: 'src/api/users.ts', line: 8, fix: 'Add Redis cache layer' },
    ];
    sessionManager.setPendingAction({ type: 'fix-select', issues });
    return c.json({ ok: true });
  });

  api.post('/api/test/mock-notification', async (c) => {
    const body = await c.req.json<{ notification?: any }>();
    const notification = body.notification ?? {
      agentId: 'carmack',
      severity: 'warning' as const,
      title: 'Need clarification on database schema',
      detail: 'The user model has conflicting field definitions between the auth module and the profile module. Should I use UUID or auto-increment for the primary key? The auth module expects UUID but the migration script uses auto-increment.',
      actionRequired: true,
    };
    sessionManager.addNotification(notification);
    return c.json({ ok: true });
  });

  /**
   * Mock task board for UI testing — seeds a TaskBoard with sample tasks.
   */
  api.post('/api/test/mock-task-board', async (c) => {
    const { TaskBoard } = await import('../../core/task-board.ts');
    const board = new TaskBoard();

    // Create sample tasks simulating parallel coding
    board.addTask('system', { id: 'ws-events', title: 'Normalize WebSocket events', description: 'Ensure all runtime events are emitted with consistent envelope', category: 'API & Server', phase: 1, priority: 'must' });
    board.addTask('system', { id: 'http-logs', title: 'Expose persisted logs via HTTP', description: 'Add /api/logs/:sessionId endpoint for historical logs', category: 'API & Server', phase: 1, priority: 'should' });
    board.addTask('system', { id: 'log-buffer', title: 'LogBuffer API + DB seeding', description: 'Provide LogBuffer API and seed from DB on create/restore', category: 'API & Server', phase: 1, priority: 'should' });
    board.addTask('system', { id: 'git-tab', title: 'Git History tab endpoint', description: 'Add /api/git-history for recent commits', category: 'API & Server', phase: 1, priority: 'could' });
    board.addTask('system', { id: 'seed-ui', title: 'Seed desktop UI from APIs', description: 'Fetch session, plan, scores before opening WS', category: 'Desktop UI', phase: 2, priority: 'should', dependsOn: ['ws-events'] });
    board.addTask('system', { id: 'pause-ship', title: 'Pause & Ship Now buttons', description: 'Add session control buttons to desktop panel', category: 'Desktop UI', phase: 2, priority: 'could' });
    board.addTask('system', { id: 'unit-tests', title: 'API unit tests + E2E smoke', description: 'Test logs, WS events, and parity with CLI', category: 'Testing', phase: 3, priority: 'should', dependsOn: ['ws-events', 'http-logs'] });

    // Simulate some progress
    board.claim('ws-events', 'coder-1');
    board.claim('http-logs', 'coder-2');
    board.claim('log-buffer', 'coder-3');
    board.complete('ws-events', 'coder-1', { files: ['src/server/routes/ws.ts', 'src/server/index.ts'], commitMessage: 'feat: normalize WebSocket event envelope', summary: 'All events now use consistent {type, data} envelope' });
    board.postMessage('coder-1', 'Finished WS events normalization, seed-ui is now unblocked');
    board.postMessage('coder-2', 'Working on HTTP logs endpoint, reading store.ts');
    board.postMessage('coder-3', 'LogBuffer seeding in progress, touching session.ts');

    sessionManager.setTaskBoard(board);
    // Also publish initial state to WS
    eventBus.publish('task-board', { type: 'snapshot', ...board.snapshot() });
    return c.json({ ok: true, board: board.snapshot() });
  });

  api.post('/api/test/clear-task-board', (_c) => {
    sessionManager.setTaskBoard(null);
    return _c.json({ ok: true });
  });

  return api;
}
