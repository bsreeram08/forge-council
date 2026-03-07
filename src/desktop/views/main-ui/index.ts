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
          case 'plan':
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
