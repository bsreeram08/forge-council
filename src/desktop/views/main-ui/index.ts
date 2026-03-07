// ForgeCouncil Desktop UI — connects to a running session's Hono API server

interface Session {
  id: string;
  idea: string;
  port: number;
  pid: number;
  startedAt: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  currentRound: number;
  scores: { round: number; mean: number; agents: Record<string, number> }[];
  activeAgents: string[];
  guidance: string[];
}

interface LogEntry {
  id: number;
  sessionId: string;
  timestamp: string;
  level: 'info' | 'agent' | 'score' | 'error' | 'system';
  source: string;
  message: string;
}

interface AgentProgress {
  agentId: string;
  name: string;
  status: 'working' | 'done' | 'failed';
  action?: string;
  score?: number;
  verdict?: string;
  error?: string;
}

interface AgentState {
  id: string;
  name: string;
  status: 'idle' | 'working' | 'done' | 'failed';
  actions: string[];
  score?: number;
  verdict?: string;
  error?: string;
  expanded: boolean;
}

interface AgentDef {
  id: string;
  name: string;
  role: string;
  description: string;
  required: boolean;
  defaultModel: string;
  dimensions: { name: string; weight: number; description: string }[];
}

interface AgentReview {
  agentId: string;
  codename: string;
  dimensions: { name: string; score: number; weight: number; reasoning: string }[];
  weightedScore: number;
  verdict: 'approve' | 'request-changes' | 'reject';
  summary: string;
  concerns: string[];
  suggestions: string[];
}

interface StoredSession {
  id: string;
  idea: string;
  port: number;
  pid: number;
  started_at: string;
  ended_at: string | null;
  status: string;
  current_round: number;
  max_rounds: number;
  score_threshold: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let apiBase = '';
let ws: WebSocket | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let connectedPort: number | null = null;
let currentPhase = '';
let agentStates = new Map<string, AgentState>();

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const statusBadge = document.getElementById('status-badge')!;
const sessionStatus = document.getElementById('session-status')!;
const sessionRound = document.getElementById('session-round')!;
const sessionIdea = document.getElementById('session-idea')!;
const phaseLabel = document.getElementById('session-phase')!;
const agentCards = document.getElementById('agent-cards')!;
const scoresChart = document.getElementById('scores-chart')!;
const liveOutput = document.getElementById('live-output')!;
const connectDialog = document.getElementById('connect-dialog')!;
const portInput = document.getElementById('port-input') as HTMLInputElement;
const connectBtn = document.getElementById('connect-btn')!;
const disconnectBtn = document.getElementById('disconnect-btn');

// Guidance
const guidanceInput = document.getElementById('guidance-input') as HTMLInputElement;
const guidanceBtn = document.getElementById('guidance-btn')!;
const guidanceHistory = document.getElementById('guidance-history')!;

// Plan
const planViewer = document.getElementById('plan-viewer')!;
const planRoundLabel = document.getElementById('plan-round-label')!;

// Reviews
const reviewsList = document.getElementById('reviews-list')!;
const reviewsRoundLabel = document.getElementById('reviews-round-label')!;

// Council
const councilList = document.getElementById('council-list')!;

// History
const historyList = document.getElementById('history-list')!;
const historyDetail = document.getElementById('history-detail')!;
const historyDetailContent = document.getElementById('history-detail-content')!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function scoreColor(score: number): string {
  if (score >= 7.5) return 'var(--green)';
  if (score >= 5) return 'var(--yellow)';
  return 'var(--red)';
}

function logLevelClass(level: string): string {
  switch (level) {
    case 'error': return 'log-error';
    case 'agent': return 'log-agent';
    case 'score': return 'log-score';
    case 'system': return 'log-system';
    default: return 'log-info';
  }
}

function statusIcon(status: AgentState['status']): string {
  switch (status) {
    case 'working': return '<span class="status-dot pulse"></span>';
    case 'done': return '<span class="status-dot done"></span>';
    case 'failed': return '<span class="status-dot failed"></span>';
    default: return '<span class="status-dot idle"></span>';
  }
}

// ---------------------------------------------------------------------------
// Navigation Tabs
// ---------------------------------------------------------------------------

document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = (tab as HTMLElement).dataset.tab;
    if (!target) return;

    // Update tab buttons
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');

    // Show/hide tab content
    document.querySelectorAll('.tab-content').forEach((tc) => tc.classList.remove('active'));
    document.getElementById(target)?.classList.add('active');

    // Load data for the tab when switching to it
    if (target === 'tab-plan') fetchPlan();
    if (target === 'tab-reviews') fetchReviews();
    if (target === 'tab-council') fetchCouncil();
    if (target === 'tab-history') fetchHistory();
  });
});

// ---------------------------------------------------------------------------
// Agent card rendering — only active agents
// ---------------------------------------------------------------------------

function ensureAgentState(agentId: string, name: string): AgentState {
  let state = agentStates.get(agentId);
  if (!state) {
    state = { id: agentId, name, status: 'idle', actions: [], expanded: false };
    agentStates.set(agentId, state);
  }
  return state;
}

function renderAgentCards(session: Session) {
  // If no active agents, show empty state
  if (!session.activeAgents || session.activeAgents.length === 0) {
    agentCards.innerHTML = '<div class="empty-agents">No active agents</div>';
    return;
  }

  const lastScores = session.scores?.[session.scores.length - 1];

  // Reconcile — mark agents not in activeAgents as idle
  for (const [id, state] of agentStates) {
    if (!session.activeAgents.includes(id) && state.status === 'working') {
      state.status = 'idle';
    }
  }

  // Build cards only for active agents
  const fragment = document.createDocumentFragment();

  for (const agentId of session.activeAgents) {
    const state = agentStates.get(agentId);
    const name = state?.name ?? agentId;
    const agentScore = lastScores?.agents?.[agentId];

    const card = document.createElement('div');
    card.className = `agent-card ${state?.status ?? 'working'}`;
    card.dataset.agentId = agentId;

    // Header row
    const header = document.createElement('div');
    header.className = 'agent-header';
    header.innerHTML = `
      ${statusIcon(state?.status ?? 'working')}
      <span class="name">${escapeHtml(name)}</span>
      ${agentScore !== undefined
        ? `<span class="score" style="color: ${scoreColor(agentScore)}">${agentScore.toFixed(1)}</span>`
        : ''}
      <span class="expand-btn">${state?.expanded ? '▾' : '▸'}</span>
    `;
    card.appendChild(header);

    // Status line
    const statusLine = document.createElement('div');
    statusLine.className = 'agent-status-line';
    if (state?.status === 'done' && state.verdict) {
      statusLine.innerHTML = `<span class="verdict verdict-${state.verdict}">${escapeHtml(state.verdict)}</span>`;
      if (state.score !== undefined) {
        statusLine.innerHTML += ` <span class="agent-score" style="color:${scoreColor(state.score)}">${state.score.toFixed(1)}/10</span>`;
      }
    } else if (state?.status === 'failed') {
      statusLine.innerHTML = `<span class="verdict verdict-failed">${escapeHtml(state.error ?? 'failed')}</span>`;
    } else if (state?.actions.length) {
      statusLine.innerHTML = `<span class="current-action">${escapeHtml(state.actions[state.actions.length - 1]!)}</span>`;
    } else {
      statusLine.innerHTML = `<span class="current-action">starting...</span>`;
    }
    card.appendChild(statusLine);

    // Expandable action log
    if (state?.expanded && state.actions.length > 0) {
      const log = document.createElement('div');
      log.className = 'agent-log';
      // Show last 10 actions
      const visible = state.actions.slice(-10);
      for (const action of visible) {
        const line = document.createElement('div');
        line.className = 'agent-log-line';
        line.textContent = action;
        log.appendChild(line);
      }
      card.appendChild(log);
    }

    // Click to expand/collapse
    header.addEventListener('click', () => {
      if (state) {
        state.expanded = !state.expanded;
        renderAgentCards(lastSession!);
      }
    });

    fragment.appendChild(card);
  }

  agentCards.innerHTML = '';
  agentCards.appendChild(fragment);
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

function renderScores(session: Session) {
  scoresChart.innerHTML = '';
  if (!session.scores || session.scores.length === 0) {
    scoresChart.innerHTML = '<div style="color: var(--text-muted)">No scores yet</div>';
    return;
  }

  for (const entry of session.scores) {
    const pct = (entry.mean / 10) * 100;
    const row = document.createElement('div');
    row.className = 'score-row';
    row.innerHTML = `
      <span class="round-label">Round ${entry.round}</span>
      <div class="bar-container">
        <div class="bar-fill" style="width: ${pct}%; background: ${scoreColor(entry.mean)}"></div>
        <div class="threshold-line" style="left: 75%"></div>
        <span class="bar-value">${entry.mean.toFixed(2)}</span>
      </div>
    `;
    scoresChart.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Guidance
// ---------------------------------------------------------------------------

function renderGuidance(guidance: string[]) {
  guidanceHistory.innerHTML = '';
  if (!guidance || guidance.length === 0) return;
  for (const g of guidance) {
    const div = document.createElement('div');
    div.className = 'guidance-entry';
    div.textContent = g;
    guidanceHistory.appendChild(div);
  }
}

async function submitGuidance() {
  const text = guidanceInput.value.trim();
  if (!text || !apiBase) return;

  guidanceBtn.setAttribute('disabled', 'true');
  try {
    const res = await fetch(`${apiBase}/api/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guidance: text }),
    });
    if (res.ok) {
      guidanceInput.value = '';
      // Refresh session to show new guidance
      const session = await fetchSession();
      if (session) {
        updateUI(session);
      }
    }
  } catch {
    // silently fail
  }
  guidanceBtn.removeAttribute('disabled');
}

guidanceBtn.addEventListener('click', submitGuidance);
guidanceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitGuidance();
});

// ---------------------------------------------------------------------------
// Plan Viewer
// ---------------------------------------------------------------------------

async function fetchPlan() {
  if (!apiBase) return;
  try {
    const res = await fetch(`${apiBase}/api/plan`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.plan) {
      planViewer.innerHTML = '<div class="empty-state">No plan yet — start a session to see the plan.</div>';
      planRoundLabel.textContent = '';
      return;
    }

    planRoundLabel.textContent = `Round ${data.round}`;
    const plan = data.plan;
    const sections = [
      { title: 'Executive Summary', content: plan.executiveSummary },
      { title: 'Architecture', content: plan.architecture },
      { title: 'Phased Roadmap', content: plan.phasedRoadmap },
      { title: 'Tech Stack', content: plan.techStack },
      { title: 'Skeleton Code', content: plan.skeletonCode },
    ];

    planViewer.innerHTML = '';
    for (const section of sections) {
      if (!section.content) continue;
      const el = document.createElement('div');
      el.className = 'plan-section';

      const header = document.createElement('div');
      header.className = 'plan-section-header';
      header.innerHTML = `<span class="chevron">▾</span> ${escapeHtml(section.title)}`;

      const body = document.createElement('div');
      body.className = 'plan-section-body';
      body.textContent = section.content;

      header.addEventListener('click', () => {
        body.classList.toggle('collapsed');
        const chevron = header.querySelector('.chevron')!;
        chevron.textContent = body.classList.contains('collapsed') ? '▸' : '▾';
      });

      el.appendChild(header);
      el.appendChild(body);
      planViewer.appendChild(el);
    }
  } catch {
    // silently fail
  }
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

async function fetchReviews() {
  if (!apiBase) return;
  try {
    const res = await fetch(`${apiBase}/api/reviews`);
    if (!res.ok) return;
    const data: { round: number; reviews: AgentReview[] } = await res.json();

    if (!data.reviews || data.reviews.length === 0) {
      reviewsList.innerHTML = '<div class="empty-state">No reviews yet.</div>';
      reviewsRoundLabel.textContent = '';
      return;
    }

    reviewsRoundLabel.textContent = `Round ${data.round}`;
    reviewsList.innerHTML = '';

    for (const review of data.reviews) {
      const card = document.createElement('div');
      card.className = 'review-card';

      // Header with agent name, verdict, score
      const header = document.createElement('div');
      header.className = 'review-card-header';
      header.innerHTML = `
        <span class="review-agent-name">${escapeHtml(review.codename)}</span>
        <div>
          <span class="review-verdict ${review.verdict}">${escapeHtml(review.verdict)}</span>
          <span class="review-score" style="color: ${scoreColor(review.weightedScore)}">${review.weightedScore.toFixed(1)}/10</span>
        </div>
      `;
      card.appendChild(header);

      // Dimensions
      if (review.dimensions && review.dimensions.length > 0) {
        const dims = document.createElement('div');
        dims.className = 'review-dims';
        for (const dim of review.dimensions) {
          const chip = document.createElement('span');
          chip.className = 'review-dim';
          chip.innerHTML = `<span class="dim-name">${escapeHtml(dim.name)}</span> <span class="dim-score" style="color: ${scoreColor(dim.score)}">${dim.score.toFixed(1)}</span>`;
          dims.appendChild(chip);
        }
        card.appendChild(dims);
      }

      // Summary
      if (review.summary) {
        const summary = document.createElement('div');
        summary.className = 'review-item';
        summary.style.paddingLeft = '0';
        summary.textContent = review.summary;
        summary.style.marginBottom = '6px';
        card.appendChild(summary);
      }

      // Concerns
      if (review.concerns && review.concerns.length > 0) {
        const title = document.createElement('div');
        title.className = 'review-section-title';
        title.textContent = 'Concerns';
        card.appendChild(title);
        for (const concern of review.concerns) {
          const item = document.createElement('div');
          item.className = 'review-item';
          item.textContent = concern;
          card.appendChild(item);
        }
      }

      // Suggestions
      if (review.suggestions && review.suggestions.length > 0) {
        const title = document.createElement('div');
        title.className = 'review-section-title';
        title.textContent = 'Suggestions';
        card.appendChild(title);
        for (const suggestion of review.suggestions) {
          const item = document.createElement('div');
          item.className = 'review-item';
          item.textContent = suggestion;
          card.appendChild(item);
        }
      }

      reviewsList.appendChild(card);
    }
  } catch {
    // silently fail
  }
}

// ---------------------------------------------------------------------------
// Council Roster
// ---------------------------------------------------------------------------

async function fetchCouncil() {
  if (!apiBase) return;
  try {
    const res = await fetch(`${apiBase}/api/agents`);
    if (!res.ok) return;
    const agents: AgentDef[] = await res.json();

    if (!agents || agents.length === 0) {
      councilList.innerHTML = '<div class="empty-state">No agents configured.</div>';
      return;
    }

    councilList.innerHTML = '';

    for (const agent of agents) {
      const card = document.createElement('div');
      card.className = `council-card${agent.required ? ' required' : ''}`;

      const header = document.createElement('div');
      header.className = 'council-card-header';
      header.innerHTML = `
        <span class="agent-name">${escapeHtml(agent.name)}</span>
        <span class="agent-role">— ${escapeHtml(agent.role)}</span>
        <span class="agent-model">${escapeHtml(agent.defaultModel)}</span>
      `;
      card.appendChild(header);

      const desc = document.createElement('div');
      desc.className = 'council-card-desc';
      desc.textContent = agent.description;
      card.appendChild(desc);

      if (agent.dimensions && agent.dimensions.length > 0) {
        const dims = document.createElement('div');
        dims.className = 'council-card-dims';
        for (const dim of agent.dimensions) {
          const chip = document.createElement('span');
          chip.className = 'council-dim-chip';
          chip.textContent = `${dim.name} (${(dim.weight * 100).toFixed(0)}%)`;
          dims.appendChild(chip);
        }
        card.appendChild(dims);
      }

      councilList.appendChild(card);
    }
  } catch {
    // silently fail
  }
}

// ---------------------------------------------------------------------------
// Session History
// ---------------------------------------------------------------------------

async function fetchHistory() {
  if (!apiBase) return;
  try {
    const res = await fetch(`${apiBase}/api/sessions?limit=20`);
    if (!res.ok) return;
    const sessions: StoredSession[] = await res.json();

    if (!sessions || sessions.length === 0) {
      historyList.innerHTML = '<div class="empty-state">No past sessions found.</div>';
      return;
    }

    historyList.innerHTML = '';

    // Header row
    const headerRow = document.createElement('div');
    headerRow.className = 'history-header';
    headerRow.innerHTML = '<span>ID</span><span>Status</span><span>Round</span><span>Date</span><span>Idea</span>';
    historyList.appendChild(headerRow);

    for (const sess of sessions) {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.innerHTML = `
        <span class="hist-id">${escapeHtml(sess.id.slice(0, 8))}</span>
        <span class="hist-status ${sess.status}">${escapeHtml(sess.status)}</span>
        <span class="hist-round">R${sess.current_round}/${sess.max_rounds}</span>
        <span class="hist-date">${escapeHtml(sess.started_at.slice(0, 10))}</span>
        <span class="hist-idea">${escapeHtml(sess.idea.length > 60 ? sess.idea.slice(0, 57) + '...' : sess.idea)}</span>
      `;

      row.addEventListener('click', () => fetchSessionDetail(sess.id));
      historyList.appendChild(row);
    }
  } catch {
    // silently fail
  }
}

async function fetchSessionDetail(sessionId: string) {
  if (!apiBase) return;
  try {
    const res = await fetch(`${apiBase}/api/sessions/${sessionId}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data) return;

    historyDetail.classList.remove('hidden');

    let html = `
      <div class="info-grid">
        <span class="label">ID</span><span style="font-family: var(--font); font-size: 12px;">${escapeHtml(data.id)}</span>
        <span class="label">Idea</span><span>${escapeHtml(data.idea)}</span>
        <span class="label">Status</span><span>${escapeHtml(data.status)}</span>
        <span class="label">Round</span><span>${data.current_round}/${data.max_rounds}</span>
        <span class="label">Threshold</span><span>${data.score_threshold}</span>
        <span class="label">Started</span><span>${escapeHtml(data.started_at)}</span>
        ${data.ended_at ? `<span class="label">Ended</span><span>${escapeHtml(data.ended_at)}</span>` : ''}
      </div>
    `;

    // Scores
    if (data.scores && data.scores.length > 0) {
      html += '<h3 style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); margin: 12px 0 6px;">Scores</h3>';
      for (const score of data.scores) {
        const pct = (score.mean / 10) * 100;
        html += `
          <div class="score-row">
            <span class="round-label">Round ${score.round}</span>
            <div class="bar-container">
              <div class="bar-fill" style="width: ${pct}%; background: ${scoreColor(score.mean)}"></div>
              <div class="threshold-line" style="left: 75%"></div>
              <span class="bar-value">${score.mean.toFixed(2)}</span>
            </div>
          </div>
        `;
      }
    }

    // Plan summary
    if (data.latestPlan && data.latestPlan.plan) {
      html += '<h3 style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); margin: 12px 0 6px;">Plan Summary</h3>';
      html += `<div style="font-size: 12px; color: var(--text-muted); background: var(--bg); padding: 8px 12px; border-radius: 6px; white-space: pre-wrap; max-height: 200px; overflow-y: auto;">${escapeHtml(data.latestPlan.plan.executiveSummary)}</div>`;
    }

    historyDetailContent.innerHTML = html;
  } catch {
    // silently fail
  }
}

// ---------------------------------------------------------------------------
// Session update
// ---------------------------------------------------------------------------

let lastSession: Session | null = null;

function updateUI(session: Session) {
  lastSession = session;

  statusBadge.className = `badge badge-${session.status === 'running' ? 'running' : 'connected'}`;
  statusBadge.textContent = session.status.charAt(0).toUpperCase() + session.status.slice(1);

  sessionStatus.textContent = session.status;
  sessionRound.textContent = `${session.currentRound}`;
  sessionIdea.textContent = session.idea || '—';
  phaseLabel.textContent = currentPhase || '—';

  renderAgentCards(session);
  renderScores(session);
  renderGuidance(session.guidance ?? []);
}

// ---------------------------------------------------------------------------
// Log output
// ---------------------------------------------------------------------------

function appendLog(entry: LogEntry) {
  const line = document.createElement('div');
  line.className = `log-line ${logLevelClass(entry.level)}`;

  const time = new Date(entry.timestamp).toLocaleTimeString();
  line.innerHTML = `<span class="log-time">${time}</span> <span class="log-source">[${escapeHtml(entry.source)}]</span> ${escapeHtml(entry.message)}`;

  liveOutput.appendChild(line);
  liveOutput.scrollTop = liveOutput.scrollHeight;

  while (liveOutput.childNodes.length > 500) {
    liveOutput.removeChild(liveOutput.firstChild!);
  }
}

// ---------------------------------------------------------------------------
// Agent progress handling
// ---------------------------------------------------------------------------

function handleAgentProgress(data: AgentProgress) {
  const state = ensureAgentState(data.agentId, data.name);
  state.status = data.status;

  if (data.action) {
    state.actions.push(data.action);
  }
  if (data.score !== undefined) state.score = data.score;
  if (data.verdict) state.verdict = data.verdict;
  if (data.error) state.error = data.error;

  if (data.status === 'done') {
    state.actions.push(`completed — ${data.verdict ?? 'done'} (${data.score?.toFixed(1) ?? '?'}/10)`);
  } else if (data.status === 'failed') {
    state.actions.push(`failed: ${data.error ?? 'unknown error'}`);
  }

  // Re-render agent cards if we have a session
  if (lastSession) {
    renderAgentCards(lastSession);
  }
}

function handleRoundEvent(data: { round: number; phase: string }) {
  currentPhase = data.phase;
  // Reset agent states for new phase
  agentStates.clear();
  if (lastSession) {
    updateUI(lastSession);
  }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function fetchSession(): Promise<Session | null> {
  try {
    const res = await fetch(`${apiBase}/api/session`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function connectWebSocket(port: number) {
  if (ws) { ws.close(); ws = null; }

  try {
    ws = new WebSocket(`ws://localhost:${port}/ws`);

    ws.onopen = () => {
      appendLog({ id: 0, sessionId: '', timestamp: new Date().toISOString(), level: 'system', source: 'desktop', message: 'Connected to session' });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case 'log':
            if (msg.data) appendLog(msg.data as LogEntry);
            // Refresh session on score/system events
            if (msg.data?.level === 'score' || msg.data?.source === 'session') {
              fetchSession().then((s) => s && updateUI(s));
            }
            break;

          case 'agent-progress':
            if (msg.data) handleAgentProgress(msg.data as AgentProgress);
            break;

          case 'round':
            if (msg.data) handleRoundEvent(msg.data as { round: number; phase: string });
            fetchSession().then((s) => s && updateUI(s));
            break;

          case 'score':
            fetchSession().then((s) => s && updateUI(s));
            // Auto-refresh reviews when new scores arrive
            fetchReviews();
            break;

          case 'plan':
            fetchSession().then((s) => s && updateUI(s));
            // Auto-refresh plan when new plan arrives
            fetchPlan();
            break;

          case 'freshEyes':
            fetchSession().then((s) => s && updateUI(s));
            break;
        }
      } catch {
        // Non-JSON message, ignore
      }
    };

    ws.onerror = () => {
      appendLog({ id: 0, sessionId: '', timestamp: new Date().toISOString(), level: 'error', source: 'desktop', message: 'WebSocket error' });
    };

    ws.onclose = () => {
      appendLog({ id: 0, sessionId: '', timestamp: new Date().toISOString(), level: 'system', source: 'desktop', message: 'WebSocket disconnected' });
    };
  } catch {
    appendLog({ id: 0, sessionId: '', timestamp: new Date().toISOString(), level: 'error', source: 'desktop', message: 'Failed to connect WebSocket' });
  }
}

// ---------------------------------------------------------------------------
// Connect / Disconnect
// ---------------------------------------------------------------------------

function disconnect() {
  if (ws) { ws.close(); ws = null; }
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  connectedPort = null;
  apiBase = '';
  lastSession = null;
  currentPhase = '';
  agentStates.clear();

  statusBadge.className = 'badge badge-disconnected';
  statusBadge.textContent = 'Disconnected';
  sessionStatus.textContent = '—';
  sessionRound.textContent = '—';
  sessionIdea.textContent = '—';
  phaseLabel.textContent = '—';
  scoresChart.innerHTML = '<div style="color: var(--text-muted)">No scores yet</div>';
  liveOutput.innerHTML = '';
  agentCards.innerHTML = '<div class="empty-agents">Not connected</div>';
  guidanceHistory.innerHTML = '';
  planViewer.innerHTML = '<div class="empty-state">No plan yet — start a session to see the plan.</div>';
  planRoundLabel.textContent = '';
  reviewsList.innerHTML = '<div class="empty-state">No reviews yet.</div>';
  reviewsRoundLabel.textContent = '';
  councilList.innerHTML = '<div class="empty-state">Not connected.</div>';
  historyList.innerHTML = '<div class="empty-state">Not connected.</div>';
  historyDetail.classList.add('hidden');

  connectDialog.classList.remove('hidden');
  if (disconnectBtn) disconnectBtn.classList.add('hidden');
}

async function connect(port: number) {
  apiBase = `http://localhost:${port}`;
  connectDialog.classList.add('hidden');

  statusBadge.className = 'badge badge-connected';
  statusBadge.textContent = 'Connecting...';
  liveOutput.innerHTML = '';

  const session = await fetchSession();
  if (!session) {
    appendLog({ id: 0, sessionId: '', timestamp: new Date().toISOString(), level: 'error', source: 'desktop', message: `No session found on port ${port}` });
    statusBadge.className = 'badge badge-disconnected';
    statusBadge.textContent = 'Disconnected';
    connectDialog.classList.remove('hidden');
    return;
  }

  connectedPort = port;

  // Seed agent states from session's active agents
  for (const agentId of session.activeAgents) {
    ensureAgentState(agentId, agentId);
  }

  updateUI(session);
  connectWebSocket(port);

  if (disconnectBtn) disconnectBtn.classList.remove('hidden');

  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    const s = await fetchSession();
    if (s) updateUI(s);
  }, 3000);

  // Pre-load data for tabs the user might switch to
  fetchCouncil();
  fetchPlan();
}

// ---------------------------------------------------------------------------
// Auto-connect
// ---------------------------------------------------------------------------

async function probePort(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function tryAutoConnect() {
  const injectedPort = (window as any).__forgecouncilPort as number | undefined;
  if (injectedPort && injectedPort > 0) {
    if (await probePort(injectedPort)) {
      await connect(injectedPort);
      return;
    }
  }
  connectDialog.classList.remove('hidden');
}

window.addEventListener('forge-port', async (e: Event) => {
  const port = (e as CustomEvent).detail as number;
  if (port > 0 && !connectedPort) {
    if (await probePort(port)) {
      await connect(port);
    }
  }
});

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

connectBtn.addEventListener('click', () => {
  const port = parseInt(portInput.value);
  if (port > 0 && port <= 65535) connect(port);
});

portInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectBtn.click();
});

if (disconnectBtn) {
  disconnectBtn.addEventListener('click', disconnect);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

agentCards.innerHTML = '<div class="empty-agents">Not connected</div>';
scoresChart.innerHTML = '<div style="color: var(--text-muted)">No scores yet</div>';
tryAutoConnect();
