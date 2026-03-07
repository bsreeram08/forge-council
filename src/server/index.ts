import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { SessionManager } from './session.ts';
import { createApiRoutes } from './routes/api.ts';
import { logBuffer } from './session.ts';
import { logError } from '../errors/logger.ts';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function createServer(sessionManager: SessionManager): Hono {
  const app = new Hono();

  // Allow cross-origin requests (desktop app webview uses views:// origin)
  app.use('*', cors({ origin: '*' }));

  // Mount API routes
  const apiRoutes = createApiRoutes(sessionManager);
  app.route('/', apiRoutes);

  // Live dashboard
  app.get('/', (c) => {
    return c.html(DASHBOARD_HTML);
  });

  return app;
}

export function startServer(app: Hono, port: number): { port: number; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({
    fetch(req, server) {
      // WebSocket upgrade
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (server.upgrade(req)) return;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        ws.subscribe('logs');
        ws.subscribe('events');
        // Send recent logs on connect
        const recent = logBuffer.getRecent(50);
        for (const entry of recent) {
          ws.send(JSON.stringify({ type: 'log', data: entry }));
        }
      },
      message() {},
      close() {},
    },
    port,
    hostname: '127.0.0.1',
  });

  // Pipe log buffer to WebSocket subscribers
  logBuffer.onEntry((entry) => {
    server.publish('logs', JSON.stringify({ type: 'log', data: entry }));
  });

  return { port: server.port ?? port, server };
}

// --- Dashboard HTML (self-contained, auto-refreshing) ---
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ForgeCouncil — Live Dashboard</title>
  <style>
    :root {
      --bg: #0d1117; --surface: #161b22; --border: #30363d;
      --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
      --green: #3fb950; --yellow: #d29922; --red: #f85149;
      --font: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    .container { max-width: 960px; margin: 0 auto; padding: 16px; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
    header h1 { font-size: 18px; color: var(--accent); }
    .badge { font-size: 12px; padding: 4px 10px; border-radius: 12px; font-weight: 500; }
    .badge-running { background: rgba(88,166,255,0.15); color: var(--accent); }
    .badge-completed { background: rgba(63,185,80,0.15); color: var(--green); }
    .badge-failed { background: rgba(248,81,73,0.15); color: var(--red); }
    .badge-stopped { background: rgba(139,148,158,0.15); color: var(--muted); }
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 10px; }
    .info-row { display: flex; gap: 24px; flex-wrap: wrap; font-size: 14px; }
    .info-row .label { color: var(--muted); min-width: 60px; }
    .agents-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .agent-chip { font-size: 12px; padding: 3px 8px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border); }
    .agent-chip.active { border-color: var(--accent); color: var(--accent); }
    .score-row { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; font-family: var(--font); font-size: 13px; }
    .score-row .round-label { width: 70px; color: var(--muted); }
    .bar-bg { flex: 1; height: 22px; background: var(--bg); border-radius: 4px; position: relative; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 4px; transition: width 0.4s; }
    .bar-value { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 600; }
    .threshold { border-left: 2px dashed var(--yellow); height: 100%; position: absolute; top: 0; }
    .plan-content { font-family: var(--font); font-size: 13px; line-height: 1.6; white-space: pre-wrap; max-height: 400px; overflow-y: auto; background: var(--bg); padding: 12px; border-radius: 6px; border: 1px solid var(--border); color: var(--muted); }
    .log-area { font-family: var(--font); font-size: 12px; line-height: 1.5; white-space: pre-wrap; max-height: 350px; overflow-y: auto; background: var(--bg); padding: 12px; border-radius: 6px; border: 1px solid var(--border); }
    .log-entry { margin-bottom: 2px; }
    .log-time { color: var(--muted); }
    .log-source { color: var(--accent); font-weight: 500; }
    .log-agent { color: var(--green); }
    .log-error { color: var(--red); }
    .log-score { color: var(--yellow); }
    .empty { color: var(--muted); font-style: italic; }
    .tabs { display: flex; gap: 4px; margin-bottom: 12px; }
    .tab { font-size: 12px; padding: 6px 12px; border-radius: 6px; background: var(--bg); border: 1px solid var(--border); cursor: pointer; color: var(--muted); }
    .tab.active { border-color: var(--accent); color: var(--accent); }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>&#9878; ForgeCouncil</h1>
      <span id="badge" class="badge badge-stopped">Loading...</span>
    </header>

    <div id="session-info" class="panel">
      <h2>Session</h2>
      <div class="info-row">
        <div><span class="label">Status</span> <span id="s-status">—</span></div>
        <div><span class="label">Round</span> <span id="s-round">—</span></div>
        <div><span class="label">ID</span> <span id="s-id" style="font-family:var(--font);font-size:12px">—</span></div>
      </div>
      <div style="margin-top:8px;font-size:14px"><span class="label">Idea</span> <span id="s-idea">—</span></div>
      <div class="agents-bar" id="agents-bar"></div>
    </div>

    <div id="scores-panel" class="panel">
      <h2>Scores</h2>
      <div id="scores-area"><span class="empty">No scores yet</span></div>
    </div>

    <div class="tabs">
      <div class="tab active" data-tab="logs">Live Logs</div>
      <div class="tab" data-tab="plan">Current Plan</div>
    </div>

    <div id="tab-logs" class="panel">
      <h2>Live Output</h2>
      <div id="log-area" class="log-area"><span class="empty">Waiting for output...</span></div>
    </div>

    <div id="tab-plan" class="panel hidden">
      <h2>Latest Plan</h2>
      <div id="plan-area" class="plan-content"><span class="empty">No plan yet</span></div>
    </div>
  </div>

  <script>
    const badge = document.getElementById('badge');
    const sStatus = document.getElementById('s-status');
    const sRound = document.getElementById('s-round');
    const sId = document.getElementById('s-id');
    const sIdea = document.getElementById('s-idea');
    const agentsBar = document.getElementById('agents-bar');
    const scoresArea = document.getElementById('scores-area');
    const logArea = document.getElementById('log-area');
    const planArea = document.getElementById('plan-area');
    let lastLogId = 0;
    let logStarted = false;

    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-logs').classList.toggle('hidden', tab.dataset.tab !== 'logs');
        document.getElementById('tab-plan').classList.toggle('hidden', tab.dataset.tab !== 'plan');
      });
    });

    function scoreColor(s) { return s >= 7.5 ? 'var(--green)' : s >= 5 ? 'var(--yellow)' : 'var(--red)'; }
    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    const AGENTS = { executor: 'Ford', architect: 'Torvalds', coder: 'Carmack', reviewer: 'Guido', 'spec-agent': 'Fowler', planner: 'Doshi', designer: 'Jobs', researcher: 'Scott', qa: 'Whittaker', security: 'Schneier', integrator: 'Tesla', docs: 'Knuth', scout: 'Scout' };

    function updateSession(session) {
      if (!session) { badge.textContent = 'No Session'; badge.className = 'badge badge-stopped'; return; }
      badge.textContent = session.status.charAt(0).toUpperCase() + session.status.slice(1);
      badge.className = 'badge badge-' + session.status;
      sStatus.textContent = session.status;
      sRound.textContent = session.currentRound;
      sId.textContent = session.id.slice(0, 8);
      sIdea.textContent = session.idea;

      agentsBar.innerHTML = '';
      for (const [id, name] of Object.entries(AGENTS)) {
        const chip = document.createElement('span');
        chip.className = 'agent-chip' + (session.activeAgents.includes(id) ? ' active' : '');
        chip.textContent = name;
        agentsBar.appendChild(chip);
      }

      if (session.scores.length > 0) {
        scoresArea.innerHTML = '';
        for (const s of session.scores) {
          const pct = (s.mean / 10) * 100;
          scoresArea.innerHTML += '<div class="score-row">' +
            '<span class="round-label">Round ' + s.round + '</span>' +
            '<div class="bar-bg"><div class="bar-fill" style="width:' + pct + '%;background:' + scoreColor(s.mean) + '"></div>' +
            '<div class="threshold" style="left:75%"></div>' +
            '<span class="bar-value">' + s.mean.toFixed(2) + '</span></div></div>';
        }
      }
    }

    function appendLog(entry) {
      if (!logStarted) { logArea.innerHTML = ''; logStarted = true; }
      const cls = entry.level === 'agent' ? 'log-agent' : entry.level === 'error' ? 'log-error' : entry.level === 'score' ? 'log-score' : '';
      const time = entry.timestamp ? entry.timestamp.slice(11, 19) : '';
      const line = document.createElement('div');
      line.className = 'log-entry';
      line.innerHTML = '<span class="log-time">' + time + '</span> <span class="log-source ' + cls + '">[' + esc(entry.source) + ']</span> ' + esc(entry.message);
      logArea.appendChild(line);
      logArea.scrollTop = logArea.scrollHeight;
      if (entry.id > lastLogId) lastLogId = entry.id;
    }

    // WebSocket for real-time logs
    let ws;
    function connectWS() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws');
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'log') appendLog(msg.data);
        } catch {}
      };
      ws.onclose = () => setTimeout(connectWS, 2000);
    }
    connectWS();

    // Poll session + plan every 2s
    async function poll() {
      try {
        const [sRes, pRes] = await Promise.all([
          fetch('/api/session'),
          fetch('/api/plan'),
        ]);
        if (sRes.ok) updateSession(await sRes.json());
        if (pRes.ok) {
          const data = await pRes.json();
          if (data && data.plan) {
            planArea.textContent = '# Executive Summary\\n' + data.plan.executiveSummary +
              '\\n\\n# Architecture\\n' + data.plan.architecture +
              '\\n\\n# Phased Roadmap\\n' + data.plan.phasedRoadmap +
              '\\n\\n# Tech Stack\\n' + data.plan.techStack +
              '\\n\\n# Skeleton Code\\n' + data.plan.skeletonCode;
          }
        }
      } catch {}
    }
    poll();
    setInterval(poll, 2000);

    // Also poll logs as fallback
    async function pollLogs() {
      try {
        const res = await fetch('/api/logs?after=' + lastLogId);
        if (res.ok) {
          const entries = await res.json();
          for (const e of entries) appendLog(e);
        }
      } catch {}
    }
    setInterval(pollLogs, 3000);
  </script>
</body>
</html>`;
