import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { SessionManager } from './session.ts';
import { createApiRoutes } from './routes/api.ts';
import { logBuffer } from './session.ts';
import { logError } from '../errors/logger.ts';
import { eventBus } from './routes/ws.ts';

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

  // Pipe eventBus events to WebSocket subscribers
  for (const topic of ['round', 'plan', 'score', 'freshEyes', 'agent-progress'] as const) {
    eventBus.subscribe(topic, (data) => {
      server.publish('events', JSON.stringify({ type: topic, data }));
    });
  }

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
      --bg: #0d1117; --surface: #161b22; --surface-hover: #1c2333; --border: #30363d;
      --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
      --green: #3fb950; --yellow: #d29922; --red: #f85149;
      --font: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    .container { max-width: 960px; margin: 0 auto; padding: 16px; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--border); margin-bottom: 0; }
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
    .nav-tabs { display: flex; gap: 2px; padding: 12px 0 0; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
    .nav-tab { font-size: 12px; padding: 8px 14px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--muted); cursor: pointer; }
    .nav-tab:hover { color: var(--text); }
    .nav-tab.active { border-bottom-color: var(--accent); color: var(--accent); }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }
    .hidden { display: none; }
    .guidance-row { display: flex; gap: 8px; margin-top: 8px; }
    .guidance-row input { flex: 1; padding: 6px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 13px; outline: none; }
    .guidance-row input:focus { border-color: var(--accent); }
    .guidance-row button { padding: 6px 14px; background: var(--accent); color: #fff; border: none; border-radius: 6px; font-size: 13px; cursor: pointer; }
    .guidance-row button:hover { opacity: 0.9; }
    .guidance-entry { font-size: 12px; padding: 3px 8px; margin-bottom: 3px; background: var(--bg); border-radius: 4px; border-left: 2px solid var(--accent); color: var(--muted); }
    .review-card { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 10px; }
    .review-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .review-name { font-size: 14px; font-weight: 600; }
    .review-verdict { font-family: var(--font); font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .review-verdict.approve { background: rgba(63,185,80,0.15); color: var(--green); }
    .review-verdict.request-changes { background: rgba(210,153,34,0.15); color: var(--yellow); }
    .review-verdict.reject { background: rgba(248,81,73,0.15); color: var(--red); }
    .review-dims { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
    .review-dim { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--surface); border: 1px solid var(--border); }
    .review-section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin: 6px 0 3px; }
    .review-item { font-size: 12px; padding: 1px 0 1px 12px; color: var(--muted); position: relative; }
    .review-item::before { content: '\\2022'; position: absolute; left: 0; color: var(--muted); }
    .council-card { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 6px; }
    .council-card.required { border-left: 3px solid var(--accent); }
    .council-header { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
    .council-header .c-name { font-size: 14px; font-weight: 600; }
    .council-header .c-role { font-size: 12px; color: var(--muted); }
    .council-header .c-model { margin-left: auto; font-family: var(--font); font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--surface); border: 1px solid var(--border); color: var(--muted); }
    .council-desc { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
    .council-dims { display: flex; flex-wrap: wrap; gap: 3px; }
    .council-dim { font-size: 10px; padding: 2px 5px; border-radius: 4px; background: var(--surface); color: var(--muted); }
    .hist-row { display: grid; grid-template-columns: 70px 80px 55px 90px 1fr; gap: 10px; padding: 6px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; margin-bottom: 3px; cursor: pointer; }
    .hist-row:hover { border-color: var(--accent); }
    .hist-id { font-family: var(--font); color: var(--accent); }
    .hist-status.running { color: var(--accent); }
    .hist-status.completed { color: var(--green); }
    .hist-status.failed { color: var(--red); }
    .hist-status.stopped { color: var(--muted); }
    .hist-round { font-family: var(--font); color: var(--muted); }
    .hist-date { color: var(--muted); }
    .hist-idea { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hist-header { display: grid; grid-template-columns: 70px 80px 55px 90px 1fr; gap: 10px; padding: 3px 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); border-bottom: 1px solid var(--border); margin-bottom: 4px; }
    .plan-section { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 8px; }
    .plan-section-header { padding: 8px 12px; font-size: 13px; font-weight: 600; color: var(--accent); cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px; }
    .plan-section-header:hover { background: var(--surface-hover); }
    .plan-section-body { padding: 10px 12px; font-family: var(--font); font-size: 12px; line-height: 1.6; color: var(--muted); white-space: pre-wrap; max-height: 350px; overflow-y: auto; border-top: 1px solid var(--border); }
    .plan-section-body.collapsed { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>&#9878; ForgeCouncil</h1>
      <span id="badge" class="badge badge-stopped">Loading...</span>
    </header>

    <div class="nav-tabs">
      <button class="nav-tab active" data-tab="pane-session">Session</button>
      <button class="nav-tab" data-tab="pane-plan">Plan</button>
      <button class="nav-tab" data-tab="pane-reviews">Reviews</button>
      <button class="nav-tab" data-tab="pane-council">Council</button>
      <button class="nav-tab" data-tab="pane-history">History</button>
    </div>

    <!-- Session pane -->
    <div id="pane-session" class="tab-pane active">
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

      <div class="panel">
        <h2>Guidance</h2>
        <div id="guidance-list"></div>
        <div class="guidance-row">
          <input type="text" id="guidance-input" placeholder="Inject guidance for the session..." />
          <button id="guidance-btn">Send</button>
        </div>
      </div>

      <div id="scores-panel" class="panel">
        <h2>Scores</h2>
        <div id="scores-area"><span class="empty">No scores yet</span></div>
      </div>

      <div class="panel">
        <h2>Live Output</h2>
        <div id="log-area" class="log-area"><span class="empty">Waiting for output...</span></div>
      </div>
    </div>

    <!-- Plan pane -->
    <div id="pane-plan" class="tab-pane">
      <div class="panel">
        <h2>Current Plan</h2>
        <div id="plan-round" style="font-size:12px;color:var(--muted);margin-bottom:8px;"></div>
        <div id="plan-area"></div>
      </div>
    </div>

    <!-- Reviews pane -->
    <div id="pane-reviews" class="tab-pane">
      <div class="panel">
        <h2>Agent Reviews</h2>
        <div id="reviews-round" style="font-size:12px;color:var(--muted);margin-bottom:8px;"></div>
        <div id="reviews-area"><span class="empty">No reviews yet</span></div>
      </div>
    </div>

    <!-- Council pane -->
    <div id="pane-council" class="tab-pane">
      <div class="panel">
        <h2>Council Roster</h2>
        <div id="council-area"><span class="empty">Loading...</span></div>
      </div>
    </div>

    <!-- History pane -->
    <div id="pane-history" class="tab-pane">
      <div class="panel">
        <h2>Session History</h2>
        <div id="history-area"><span class="empty">Loading...</span></div>
      </div>
      <div id="history-detail" class="panel hidden">
        <h2>Session Detail</h2>
        <div id="history-detail-content"></div>
      </div>
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
    const planRound = document.getElementById('plan-round');
    const reviewsArea = document.getElementById('reviews-area');
    const reviewsRound = document.getElementById('reviews-round');
    const councilArea = document.getElementById('council-area');
    const historyArea = document.getElementById('history-area');
    const historyDetail = document.getElementById('history-detail');
    const historyDetailContent = document.getElementById('history-detail-content');
    const guidanceList = document.getElementById('guidance-list');
    const guidanceInput = document.getElementById('guidance-input');
    const guidanceBtn = document.getElementById('guidance-btn');
    let lastLogId = 0;
    let logStarted = false;

    // Tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        document.getElementById(tab.dataset.tab).classList.add('active');
        if (tab.dataset.tab === 'pane-plan') loadPlan();
        if (tab.dataset.tab === 'pane-reviews') loadReviews();
        if (tab.dataset.tab === 'pane-council') loadCouncil();
        if (tab.dataset.tab === 'pane-history') loadHistory();
      });
    });

    function scoreColor(s) { return s >= 7.5 ? 'var(--green)' : s >= 5 ? 'var(--yellow)' : 'var(--red)'; }
    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    function updateSession(session) {
      if (!session) { badge.textContent = 'No Session'; badge.className = 'badge badge-stopped'; return; }
      badge.textContent = session.status.charAt(0).toUpperCase() + session.status.slice(1);
      badge.className = 'badge badge-' + session.status;
      sStatus.textContent = session.status;
      sRound.textContent = session.currentRound;
      sId.textContent = session.id.slice(0, 8);
      sIdea.textContent = session.idea;

      agentsBar.innerHTML = '';
      const active = session.activeAgents || [];
      if (active.length === 0) {
        agentsBar.innerHTML = '<span style="color:var(--muted);font-size:12px">No active agents</span>';
      } else {
        for (const id of active) {
          const chip = document.createElement('span');
          chip.className = 'agent-chip active';
          chip.textContent = id;
          agentsBar.appendChild(chip);
        }
      }

      if (session.scores && session.scores.length > 0) {
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

      // Guidance
      guidanceList.innerHTML = '';
      if (session.guidance && session.guidance.length > 0) {
        for (const g of session.guidance) {
          const div = document.createElement('div');
          div.className = 'guidance-entry';
          div.textContent = g;
          guidanceList.appendChild(div);
        }
      }
    }

    // Guidance submission
    async function submitGuidance() {
      const text = guidanceInput.value.trim();
      if (!text) return;
      guidanceBtn.disabled = true;
      try {
        const res = await fetch('/api/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guidance: text }) });
        if (res.ok) { guidanceInput.value = ''; poll(); }
      } catch {}
      guidanceBtn.disabled = false;
    }
    guidanceBtn.addEventListener('click', submitGuidance);
    guidanceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGuidance(); });

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

    // Plan viewer
    async function loadPlan() {
      try {
        const res = await fetch('/api/plan');
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.plan) { planArea.innerHTML = '<span class="empty">No plan yet</span>'; planRound.textContent = ''; return; }
        planRound.textContent = 'Round ' + data.round;
        const sections = [
          { title: 'Executive Summary', content: data.plan.executiveSummary },
          { title: 'Architecture', content: data.plan.architecture },
          { title: 'Phased Roadmap', content: data.plan.phasedRoadmap },
          { title: 'Tech Stack', content: data.plan.techStack },
          { title: 'Skeleton Code', content: data.plan.skeletonCode },
        ];
        planArea.innerHTML = '';
        for (const s of sections) {
          if (!s.content) continue;
          const sec = document.createElement('div');
          sec.className = 'plan-section';
          const hdr = document.createElement('div');
          hdr.className = 'plan-section-header';
          hdr.innerHTML = '<span>&#9662;</span> ' + esc(s.title);
          const body = document.createElement('div');
          body.className = 'plan-section-body';
          body.textContent = s.content;
          hdr.addEventListener('click', () => {
            body.classList.toggle('collapsed');
            hdr.querySelector('span').textContent = body.classList.contains('collapsed') ? '\\u25B8' : '\\u25BE';
          });
          sec.appendChild(hdr);
          sec.appendChild(body);
          planArea.appendChild(sec);
        }
      } catch {}
    }

    // Reviews
    async function loadReviews() {
      try {
        const res = await fetch('/api/reviews');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.reviews || data.reviews.length === 0) { reviewsArea.innerHTML = '<span class="empty">No reviews yet</span>'; reviewsRound.textContent = ''; return; }
        reviewsRound.textContent = 'Round ' + data.round;
        reviewsArea.innerHTML = '';
        for (const r of data.reviews) {
          const card = document.createElement('div');
          card.className = 'review-card';
          let html = '<div class="review-header"><span class="review-name">' + esc(r.codename) + '</span><div><span class="review-verdict ' + r.verdict + '">' + esc(r.verdict) + '</span> <span style="font-family:var(--font);font-size:13px;font-weight:700;color:' + scoreColor(r.weightedScore) + '">' + r.weightedScore.toFixed(1) + '/10</span></div></div>';
          if (r.dimensions && r.dimensions.length > 0) {
            html += '<div class="review-dims">';
            for (const d of r.dimensions) html += '<span class="review-dim"><span style="color:var(--muted);margin-right:3px">' + esc(d.name) + '</span> <span style="font-weight:600;color:' + scoreColor(d.score) + '">' + d.score.toFixed(1) + '</span></span>';
            html += '</div>';
          }
          if (r.summary) html += '<div style="font-size:12px;color:var(--muted);margin-bottom:6px">' + esc(r.summary) + '</div>';
          if (r.concerns && r.concerns.length > 0) {
            html += '<div class="review-section-title">Concerns</div>';
            for (const c of r.concerns) html += '<div class="review-item">' + esc(c) + '</div>';
          }
          if (r.suggestions && r.suggestions.length > 0) {
            html += '<div class="review-section-title">Suggestions</div>';
            for (const s of r.suggestions) html += '<div class="review-item">' + esc(s) + '</div>';
          }
          card.innerHTML = html;
          reviewsArea.appendChild(card);
        }
      } catch {}
    }

    // Council
    async function loadCouncil() {
      try {
        const res = await fetch('/api/agents');
        if (!res.ok) return;
        const agents = await res.json();
        if (!agents || agents.length === 0) { councilArea.innerHTML = '<span class="empty">No agents</span>'; return; }
        councilArea.innerHTML = '';
        for (const a of agents) {
          const card = document.createElement('div');
          card.className = 'council-card' + (a.required ? ' required' : '');
          let html = '<div class="council-header"><span class="c-name">' + esc(a.name) + '</span><span class="c-role">— ' + esc(a.role) + '</span><span class="c-model">' + esc(a.defaultModel) + '</span></div>';
          html += '<div class="council-desc">' + esc(a.description) + '</div>';
          if (a.dimensions && a.dimensions.length > 0) {
            html += '<div class="council-dims">';
            for (const d of a.dimensions) html += '<span class="council-dim">' + esc(d.name) + ' (' + (d.weight * 100).toFixed(0) + '%)</span>';
            html += '</div>';
          }
          card.innerHTML = html;
          councilArea.appendChild(card);
        }
      } catch {}
    }

    // History
    async function loadHistory() {
      try {
        const res = await fetch('/api/sessions?limit=20');
        if (!res.ok) return;
        const sessions = await res.json();
        if (!sessions || sessions.length === 0) { historyArea.innerHTML = '<span class="empty">No past sessions</span>'; return; }
        historyArea.innerHTML = '<div class="hist-header"><span>ID</span><span>Status</span><span>Round</span><span>Date</span><span>Idea</span></div>';
        for (const s of sessions) {
          const row = document.createElement('div');
          row.className = 'hist-row';
          row.innerHTML = '<span class="hist-id">' + esc(s.id.slice(0, 8)) + '</span><span class="hist-status ' + s.status + '">' + esc(s.status) + '</span><span class="hist-round">R' + s.current_round + '/' + s.max_rounds + '</span><span class="hist-date">' + esc(s.started_at.slice(0, 10)) + '</span><span class="hist-idea">' + esc(s.idea.length > 60 ? s.idea.slice(0, 57) + '...' : s.idea) + '</span>';
          row.addEventListener('click', () => loadSessionDetail(s.id));
          historyArea.appendChild(row);
        }
      } catch {}
    }

    async function loadSessionDetail(id) {
      try {
        const res = await fetch('/api/sessions/' + id);
        if (!res.ok) return;
        const d = await res.json();
        if (!d) return;
        historyDetail.classList.remove('hidden');
        let html = '<div class="info-row" style="margin-bottom:10px"><div><span class="label">ID</span> <span style="font-family:var(--font);font-size:12px">' + esc(d.id) + '</span></div><div><span class="label">Status</span> ' + esc(d.status) + '</div><div><span class="label">Round</span> ' + d.current_round + '/' + d.max_rounds + '</div></div>';
        html += '<div style="font-size:14px;margin-bottom:10px"><span class="label">Idea</span> ' + esc(d.idea) + '</div>';
        if (d.scores && d.scores.length > 0) {
          for (const s of d.scores) {
            const pct = (s.mean / 10) * 100;
            html += '<div class="score-row"><span class="round-label">Round ' + s.round + '</span><div class="bar-bg"><div class="bar-fill" style="width:' + pct + '%;background:' + scoreColor(s.mean) + '"></div><div class="threshold" style="left:75%"></div><span class="bar-value">' + s.mean.toFixed(2) + '</span></div></div>';
          }
        }
        if (d.latestPlan && d.latestPlan.plan) {
          html += '<div style="font-size:12px;color:var(--muted);margin-top:10px;background:var(--bg);padding:8px 10px;border-radius:6px;white-space:pre-wrap;max-height:200px;overflow-y:auto">' + esc(d.latestPlan.plan.executiveSummary) + '</div>';
        }
        historyDetailContent.innerHTML = html;
      } catch {}
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
          if (msg.type === 'score' || msg.type === 'plan' || msg.type === 'round') poll();
        } catch {}
      };
      ws.onclose = () => setTimeout(connectWS, 2000);
    }
    connectWS();

    // Poll session every 2s
    async function poll() {
      try {
        const res = await fetch('/api/session');
        if (res.ok) updateSession(await res.json());
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
