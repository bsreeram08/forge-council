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

// All 13 council agents
const AGENTS: Record<string, { name: string; role: string }> = {
  executor:    { name: 'Ford',      role: 'Executor' },
  architect:   { name: 'Torvalds',  role: 'System Architect' },
  coder:       { name: 'Carmack',   role: 'Implementation' },
  reviewer:    { name: 'Guido',     role: 'Readability' },
  'spec-agent':{ name: 'Fowler',    role: 'Requirements' },
  planner:     { name: 'Doshi',     role: 'Project Manager' },
  designer:    { name: 'Jobs',      role: 'UX/UI Design' },
  researcher:  { name: 'Scott',     role: 'Research' },
  qa:          { name: 'Whittaker', role: 'QA Engineer' },
  security:    { name: 'Schneier',  role: 'Security' },
  integrator:  { name: 'Tesla',     role: 'Infrastructure' },
  docs:        { name: 'Knuth',     role: 'Documentation' },
  scout:       { name: 'Scout',     role: 'Clarifier' },
};

let apiBase = '';
let ws: WebSocket | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let connectedPort: number | null = null;

// DOM refs
const statusBadge = document.getElementById('status-badge')!;
const sessionStatus = document.getElementById('session-status')!;
const sessionRound = document.getElementById('session-round')!;
const sessionIdea = document.getElementById('session-idea')!;
const agentCards = document.getElementById('agent-cards')!;
const scoresChart = document.getElementById('scores-chart')!;
const liveOutput = document.getElementById('live-output')!;
const connectDialog = document.getElementById('connect-dialog')!;
const portInput = document.getElementById('port-input') as HTMLInputElement;
const connectBtn = document.getElementById('connect-btn')!;
const disconnectBtn = document.getElementById('disconnect-btn');

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

function renderAgentCards(session: Session) {
  agentCards.innerHTML = '';
  for (const [id, meta] of Object.entries(AGENTS)) {
    const isActive = session.activeAgents?.includes(id);
    const lastScores = session.scores?.[session.scores.length - 1];
    const score = lastScores?.agents?.[id];

    const card = document.createElement('div');
    card.className = `agent-card${isActive ? ' active' : ''}`;
    card.innerHTML = `
      <div class="name">${escapeHtml(meta.name)}</div>
      <div class="role">${escapeHtml(meta.role)}</div>
      ${score !== undefined ? `
        <div class="score" style="color: ${scoreColor(score)}">${score.toFixed(1)}</div>
        <div class="score-bar">
          <div class="score-bar-fill" style="width: ${(score / 10) * 100}%; background: ${scoreColor(score)}"></div>
        </div>
      ` : `<div class="score" style="color: var(--text-muted)">—</div>`}
    `;
    agentCards.appendChild(card);
  }
}

function renderDefaultAgentCards() {
  agentCards.innerHTML = '';
  for (const [, meta] of Object.entries(AGENTS)) {
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.innerHTML = `
      <div class="name">${escapeHtml(meta.name)}</div>
      <div class="role">${escapeHtml(meta.role)}</div>
      <div class="score" style="color: var(--text-muted)">—</div>
    `;
    agentCards.appendChild(card);
  }
}

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

function updateUI(session: Session) {
  statusBadge.className = `badge badge-${session.status === 'running' ? 'running' : 'connected'}`;
  statusBadge.textContent = session.status.charAt(0).toUpperCase() + session.status.slice(1);

  sessionStatus.textContent = session.status;
  sessionRound.textContent = `${session.currentRound}`;
  sessionIdea.textContent = session.idea || '—';

  renderAgentCards(session);
  renderScores(session);
}

function appendLog(entry: LogEntry) {
  const line = document.createElement('div');
  line.className = `log-line ${logLevelClass(entry.level)}`;

  const time = new Date(entry.timestamp).toLocaleTimeString();
  line.innerHTML = `<span class="log-time">${time}</span> <span class="log-source">[${escapeHtml(entry.source)}]</span> ${escapeHtml(entry.message)}`;

  liveOutput.appendChild(line);
  liveOutput.scrollTop = liveOutput.scrollHeight;

  // Keep log panel from growing unbounded
  while (liveOutput.childNodes.length > 500) {
    liveOutput.removeChild(liveOutput.firstChild!);
  }
}

function appendOutputText(text: string, cls = 'log-system') {
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  line.textContent = text;
  liveOutput.appendChild(line);
  liveOutput.scrollTop = liveOutput.scrollHeight;
}

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
  if (ws) {
    ws.close();
    ws = null;
  }

  try {
    ws = new WebSocket(`ws://localhost:${port}/ws`);

    ws.onopen = () => {
      appendOutputText('Connected to session WebSocket', 'log-system');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'log' && msg.data) {
          appendLog(msg.data as LogEntry);

          // Refresh session on score or important events
          const entry = msg.data as LogEntry;
          if (entry.level === 'score' || entry.source === 'session') {
            fetchSession().then((s) => s && updateUI(s));
          }
        } else if (msg.type === 'event' && msg.data) {
          fetchSession().then((s) => s && updateUI(s));
        }
      } catch {
        appendOutputText(event.data, 'log-info');
      }
    };

    ws.onerror = () => {
      appendOutputText('WebSocket error', 'log-error');
    };

    ws.onclose = () => {
      appendOutputText('WebSocket disconnected', 'log-system');
    };
  } catch {
    appendOutputText('Failed to connect WebSocket', 'log-error');
  }
}

function disconnect() {
  if (ws) {
    ws.close();
    ws = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  connectedPort = null;
  apiBase = '';

  statusBadge.className = 'badge badge-disconnected';
  statusBadge.textContent = 'Disconnected';
  sessionStatus.textContent = '—';
  sessionRound.textContent = '—';
  sessionIdea.textContent = '—';
  scoresChart.innerHTML = '<div style="color: var(--text-muted)">No scores yet</div>';
  liveOutput.innerHTML = '';

  renderDefaultAgentCards();
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
    appendOutputText(`No session found on port ${port}. Is a forge session running?`, 'log-error');
    statusBadge.className = 'badge badge-disconnected';
    statusBadge.textContent = 'Disconnected';
    connectDialog.classList.remove('hidden');
    return;
  }

  connectedPort = port;
  updateUI(session);
  connectWebSocket(port);

  if (disconnectBtn) disconnectBtn.classList.remove('hidden');

  // Poll session state every 3s
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    const s = await fetchSession();
    if (s) updateUI(s);
  }, 3000);
}

// --- Auto-connect strategies ---

async function probePort(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function tryAutoConnect() {
  // Strategy 1: Port injected from bun process via executeJavascript
  const injectedPort = (window as any).__forgecouncilPort as number | undefined;
  if (injectedPort && injectedPort > 0) {
    if (await probePort(injectedPort)) {
      await connect(injectedPort);
      return;
    }
  }

  // Strategy 2: Show connect dialog (user enters port manually)
  connectDialog.classList.remove('hidden');
}

// Listen for late port injection from bun process
window.addEventListener('forge-port', async (e: Event) => {
  const port = (e as CustomEvent).detail as number;
  if (port > 0 && !connectedPort) {
    if (await probePort(port)) {
      await connect(port);
    }
  }
});

// --- Event handlers ---
connectBtn.addEventListener('click', () => {
  const port = parseInt(portInput.value);
  if (port > 0 && port <= 65535) {
    connect(port);
  }
});

portInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectBtn.click();
});

if (disconnectBtn) {
  disconnectBtn.addEventListener('click', disconnect);
}

// --- Boot ---
renderDefaultAgentCards();
scoresChart.innerHTML = '<div style="color: var(--text-muted)">No scores yet</div>';
tryAutoConnect();
