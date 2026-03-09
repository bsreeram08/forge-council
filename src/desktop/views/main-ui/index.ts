// ForgeCouncil Desktop UI — connects to a running session's Hono API server

interface AppNotification {
  id: string;
  agentId: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  timestamp: string;
  dismissed: boolean;
  actionRequired: boolean;
  response?: string;
}

interface PendingAction {
  type: 'pick-items' | 'pick-action' | 'fix-select' | 'confirm';
  plan?: any;
  options?: { value: string; label: string; hint?: string }[];
  issues?: any[];
  message?: string;
}

interface Session {
  id: string;
  idea: string;
  port: number;
  pid: number;
  startedAt: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  currentRound: number;
  currentPhase?: string;
  pendingAction?: PendingAction;
  scores: { round: number; mean: number; agents: Record<string, number> }[];
  activeAgents: string[];
  guidance: string[];
  notifications?: AppNotification[];
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

// --- Task Board (parallel coding) ---

interface TaskBoardSnapshot {
  total: number;
  pending: number;
  claimed: number;
  done: number;
  failed: number;
  tasks: Array<{
    id: string;
    title: string;
    status: 'pending' | 'claimed' | 'done' | 'failed';
    claimedBy: string | null;
    phase: number;
    priority: string;
    producedFiles: string[];
  }>;
  recentMessages: Array<{
    from: string;
    content: string;
    taskId: string | null;
  }>;
}

interface TaskBoardResponse {
  active: boolean;
  board: TaskBoardSnapshot | null;
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

// Task Board
const taskBoardPanel = document.getElementById('task-board-panel')!;
const taskBoardSummary = document.getElementById('task-board-summary')!;
const taskBoardTasks = document.getElementById('task-board-tasks')!;
const taskBoardMessages = document.getElementById('task-board-messages')!;

// Notifications
const notificationsPanel = document.getElementById('notifications-panel')!;
const notificationsList = document.getElementById('notifications-list')!;

// Guidance
const guidanceInput = document.getElementById('guidance-input') as HTMLInputElement;
const guidanceBtn = document.getElementById('guidance-btn')!;
const guidanceHistory = document.getElementById('guidance-history')!;

// Plan
const planViewer = document.getElementById('plan-viewer')!;
const planRoundLabel = document.getElementById('plan-round-label')!;
const planPickPanel = document.getElementById('plan-pick-panel')!;
const planItemsList = document.getElementById('plan-items-list')!;
const planSelectAll = document.getElementById('plan-select-all')!;
const planDeselectAll = document.getElementById('plan-deselect-all')!;
const planSelectedCount = document.getElementById('plan-selected-count')!;
const planApproveBtn = document.getElementById('plan-approve-btn')!;
const planRefineBtn = document.getElementById('plan-refine-btn')!;

// Session Actions
const actionPause = document.getElementById('action-pause')!;
const actionShip = document.getElementById('action-ship')!;
const pendingActionPanel = document.getElementById('pending-action-panel')!;
const pendingActionContent = document.getElementById('pending-action-content')!;

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
// Task Board Rendering
// ---------------------------------------------------------------------------

let lastBoardSnapshot: TaskBoardSnapshot | null = null;
/** Track previous task statuses for claim/complete animations */
let prevTaskStatuses = new Map<string, string>();

function taskStatusIcon(status: string): string {
  switch (status) {
    case 'done': return '<span class="task-status-icon done">&#10003;</span>';
    case 'claimed': return '<span class="task-status-icon claimed">&#9679;</span>';
    case 'failed': return '<span class="task-status-icon failed">&#10007;</span>';
    default: return '<span class="task-status-icon pending">&#9675;</span>';
  }
}

function taskPriorityClass(priority: string): string {
  if (priority === 'must') return 'priority-must';
  if (priority === 'should') return 'priority-should';
  return 'priority-could';
}

/** Agent color palette for visual differentiation */
const AGENT_COLORS = [
  { bg: 'rgba(88, 166, 255, 0.08)', border: '#58a6ff', text: '#58a6ff' },   // blue
  { bg: 'rgba(210, 153, 34, 0.08)', border: '#d29922', text: '#d29922' },    // amber
  { bg: 'rgba(163, 113, 247, 0.08)', border: '#a371f7', text: '#a371f7' },   // purple
  { bg: 'rgba(63, 185, 80, 0.08)', border: '#3fb950', text: '#3fb950' },     // green
  { bg: 'rgba(248, 81, 73, 0.08)', border: '#f85149', text: '#f85149' },     // red
];
const agentColorMap = new Map<string, typeof AGENT_COLORS[0]>();
let nextColorIndex = 0;

function getAgentColor(agentId: string) {
  let color = agentColorMap.get(agentId);
  if (!color) {
    color = AGENT_COLORS[nextColorIndex % AGENT_COLORS.length]!;
    agentColorMap.set(agentId, color);
    nextColorIndex++;
  }
  return color;
}

function renderTaskBoard(snapshot: TaskBoardSnapshot) {
  lastBoardSnapshot = snapshot;
  taskBoardPanel.classList.remove('hidden');

  // Summary bar with progress ring
  const pct = snapshot.total > 0 ? Math.round((snapshot.done / snapshot.total) * 100) : 0;
  const circumference = 2 * Math.PI * 18;
  const dashOffset = circumference - (pct / 100) * circumference;

  taskBoardSummary.innerHTML = `
    <div class="board-header-row">
      <div class="board-progress-ring">
        <svg width="48" height="48" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="18" fill="none" stroke="var(--border)" stroke-width="4" />
          <circle cx="24" cy="24" r="18" fill="none" stroke="var(--green)" stroke-width="4"
            stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
            stroke-linecap="round" transform="rotate(-90 24 24)"
            style="transition: stroke-dashoffset 0.6s ease" />
        </svg>
        <span class="ring-label">${pct}%</span>
      </div>
      <div class="board-header-stats">
        <div class="board-header-title">${snapshot.done}/${snapshot.total} tasks complete</div>
        <div class="board-stats">
          <span class="board-stat"><span class="board-stat-dot pending"></span>${snapshot.pending} queued</span>
          <span class="board-stat"><span class="board-stat-dot claimed"></span>${snapshot.claimed} active</span>
          <span class="board-stat"><span class="board-stat-dot done"></span>${snapshot.done} done</span>
          ${snapshot.failed > 0 ? `<span class="board-stat"><span class="board-stat-dot failed"></span>${snapshot.failed} failed</span>` : ''}
        </div>
      </div>
    </div>
  `;

  // --- Agent Lanes ---
  // Group tasks by agent (claimed/done), plus an "unassigned" pool for pending tasks
  const agentTasks = new Map<string, typeof snapshot.tasks>();
  const unassigned: typeof snapshot.tasks = [];

  for (const task of snapshot.tasks) {
    if (task.claimedBy) {
      const list = agentTasks.get(task.claimedBy) ?? [];
      list.push(task);
      agentTasks.set(task.claimedBy, list);
    } else {
      unassigned.push(task);
    }
  }

  taskBoardTasks.innerHTML = '';

  // Render each agent's lane
  for (const [agentId, tasks] of agentTasks) {
    const state = agentStates.get(agentId);
    const name = state?.name ?? agentId;
    const color = getAgentColor(agentId);
    const action = state?.actions.length ? state.actions[state.actions.length - 1]! : '';
    const activeTasks = tasks.filter(t => t.status === 'claimed');
    const doneTasks = tasks.filter(t => t.status === 'done');
    const failedTasks = tasks.filter(t => t.status === 'failed');
    const totalFiles = tasks.reduce((n, t) => n + t.producedFiles.length, 0);

    const lane = document.createElement('div');
    lane.className = 'agent-lane';
    lane.style.borderColor = color.border;

    let laneHtml = `
      <div class="agent-lane-header">
        <span class="status-dot ${state?.status === 'done' ? 'done' : state?.status === 'failed' ? 'failed' : 'pulse'}" style="background: ${color.border}"></span>
        <span class="agent-lane-name" style="color: ${color.text}">${escapeHtml(name)}</span>
        <span class="agent-lane-stats">
          ${activeTasks.length > 0 ? `<span class="lane-stat active">${activeTasks.length} active</span>` : ''}
          ${doneTasks.length > 0 ? `<span class="lane-stat done">${doneTasks.length} done</span>` : ''}
          ${failedTasks.length > 0 ? `<span class="lane-stat failed">${failedTasks.length} failed</span>` : ''}
          ${totalFiles > 0 ? `<span class="lane-stat files">${totalFiles} files</span>` : ''}
        </span>
      </div>
    `;

    // Current action
    if (action && state?.status === 'working') {
      laneHtml += `<div class="agent-lane-action">${escapeHtml(action)}</div>`;
    }

    // Task list within lane
    laneHtml += '<div class="agent-lane-tasks">';
    // Active (claimed) first, then done
    const ordered = [...activeTasks, ...doneTasks, ...failedTasks];
    for (const task of ordered) {
      const prevStatus = prevTaskStatuses.get(task.id);
      const justClaimed = prevStatus === 'pending' && task.status === 'claimed';
      const justDone = prevStatus === 'claimed' && task.status === 'done';
      const animClass = justClaimed ? ' task-claim-anim' : justDone ? ' task-done-anim' : '';

      laneHtml += `
        <div class="task-row task-${task.status}${animClass}" data-task-id="${escapeHtml(task.id)}">
          ${taskStatusIcon(task.status)}
          <span class="task-title">${escapeHtml(task.title)}</span>
          ${task.producedFiles.length > 0 ? `<span class="task-files">${task.producedFiles.length} file${task.producedFiles.length !== 1 ? 's' : ''}</span>` : ''}
        </div>
      `;
    }
    laneHtml += '</div>';

    lane.innerHTML = laneHtml;
    taskBoardTasks.appendChild(lane);
  }

  // Unassigned / pending pool
  if (unassigned.length > 0) {
    const pool = document.createElement('div');
    pool.className = 'task-pool';

    let poolHtml = `<div class="task-pool-header">
      <span class="task-pool-label">Queued</span>
      <span class="task-pool-count">${unassigned.length} task${unassigned.length !== 1 ? 's' : ''}</span>
    </div><div class="task-pool-list">`;

    for (const task of unassigned) {
      poolHtml += `
        <div class="task-row task-pending" data-task-id="${escapeHtml(task.id)}">
          ${taskStatusIcon('pending')}
          <span class="task-priority ${taskPriorityClass(task.priority)}">${escapeHtml(task.priority)}</span>
          <span class="task-title">${escapeHtml(task.title)}</span>
          <span class="task-phase">Phase ${task.phase}</span>
        </div>
      `;
    }
    poolHtml += '</div>';
    pool.innerHTML = poolHtml;
    taskBoardTasks.appendChild(pool);
  }

  // Recent messages
  if (snapshot.recentMessages.length > 0) {
    taskBoardMessages.innerHTML = '<div class="board-messages-header">Agent Comms</div>';
    for (const msg of snapshot.recentMessages.slice(-5)) {
      const fromColor = getAgentColor(msg.from);
      const msgEl = document.createElement('div');
      msgEl.className = 'board-message';
      msgEl.innerHTML = `<span class="board-msg-from" style="color:${fromColor.text}">${escapeHtml(msg.from)}</span> ${escapeHtml(msg.content)}`;
      taskBoardMessages.appendChild(msgEl);
    }
  } else {
    taskBoardMessages.innerHTML = '';
  }

  // Save current statuses for next render's animation detection
  prevTaskStatuses.clear();
  for (const task of snapshot.tasks) {
    prevTaskStatuses.set(task.id, task.status);
  }
}

function hideTaskBoard() {
  lastBoardSnapshot = null;
  prevTaskStatuses.clear();
  taskBoardPanel.classList.add('hidden');
}

async function fetchTaskBoard() {
  if (!apiBase) return;
  try {
    const res = await fetch(`${apiBase}/api/task-board`);
    if (!res.ok) return;
    const data: TaskBoardResponse = await res.json();
    if (data.active && data.board) {
      renderTaskBoard(data.board);
    } else {
      hideTaskBoard();
    }
  } catch {
    // silently fail
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
// Session Actions (Pause / Ship)
// ---------------------------------------------------------------------------

actionPause.addEventListener('click', async () => {
  if (!apiBase) return;
  try { await fetch(`${apiBase}/api/pause`, { method: 'POST' }); } catch {}
});

actionShip.addEventListener('click', async () => {
  if (!apiBase) return;
  try { await fetch(`${apiBase}/api/ship-now`, { method: 'POST' }); } catch {}
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

let toastTimeout: ReturnType<typeof setTimeout> | null = null;

function renderNotifications(notifications: AppNotification[]) {
  const active = notifications.filter(n => !n.dismissed);
  if (active.length === 0) {
    notificationsPanel.classList.add('hidden');
    return;
  }

  notificationsPanel.classList.remove('hidden');
  notificationsList.innerHTML = '';

  for (const n of active) {
    const card = document.createElement('div');
    card.className = `notification-card severity-${n.severity}${n.dismissed ? ' dismissed' : ''}`;
    card.dataset.notificationId = n.id;

    const time = new Date(n.timestamp).toLocaleTimeString();

    let html = `
      <div class="notification-header">
        <span class="notification-severity ${n.severity}">${n.severity}</span>
        <span class="notification-agent">${escapeHtml(n.agentId)}</span>
        <span class="notification-time">${time}</span>
      </div>
      <div class="notification-title">${escapeHtml(n.title)}</div>
      <div class="notification-detail">${escapeHtml(n.detail)}</div>
    `;

    if (n.actionRequired && !n.response) {
      html += `
        <div class="notification-actions">
          <input type="text" class="notification-response-input" placeholder="Type your response..." data-nid="${n.id}" />
          <button class="btn-primary notification-respond-btn" data-nid="${n.id}">Respond</button>
          <button class="btn-secondary notification-dismiss-btn" data-nid="${n.id}">Dismiss</button>
        </div>
      `;
    } else {
      html += `
        <div class="notification-actions">
          ${n.response ? `<span style="font-size:12px;color:var(--green)">Responded: ${escapeHtml(n.response)}</span>` : ''}
          <button class="btn-secondary notification-dismiss-btn" data-nid="${n.id}" style="margin-left:auto">Dismiss</button>
        </div>
      `;
    }

    card.innerHTML = html;
    notificationsList.appendChild(card);
  }

  // Wire dismiss buttons
  notificationsList.querySelectorAll('.notification-dismiss-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const nid = (btn as HTMLElement).dataset.nid;
      if (!nid || !apiBase) return;
      try {
        await fetch(`${apiBase}/api/notifications/${nid}/dismiss`, { method: 'POST' });
        const card = btn.closest('.notification-card') as HTMLElement;
        card?.remove();
        if (notificationsList.children.length === 0) notificationsPanel.classList.add('hidden');
      } catch {}
    });
  });

  // Wire respond buttons
  notificationsList.querySelectorAll('.notification-respond-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const nid = (btn as HTMLElement).dataset.nid;
      if (!nid || !apiBase) return;
      const input = notificationsList.querySelector(`input[data-nid="${nid}"]`) as HTMLInputElement;
      const response = input?.value?.trim();
      if (!response) return;
      try {
        await fetch(`${apiBase}/api/notifications/${nid}/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response }),
        });
        // Refresh
        const session = await fetchSession();
        if (session) renderNotifications(session.notifications ?? []);
      } catch {}
    });
  });

  // Enter to respond
  notificationsList.querySelectorAll('.notification-response-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        const nid = (input as HTMLElement).dataset.nid;
        const btn = notificationsList.querySelector(`.notification-respond-btn[data-nid="${nid}"]`) as HTMLElement;
        btn?.click();
      }
    });
  });
}

function showNotificationToast(notification: AppNotification) {
  // Remove existing toast
  const existing = document.querySelector('.notification-toast');
  if (existing) existing.remove();
  if (toastTimeout) clearTimeout(toastTimeout);

  const toast = document.createElement('div');
  toast.className = 'notification-toast';
  const sevColor = notification.severity === 'critical' ? 'var(--red)' : notification.severity === 'warning' ? 'var(--yellow)' : 'var(--accent)';
  toast.innerHTML = `
    <div class="notification-card severity-${notification.severity}">
      <div class="notification-header">
        <span class="notification-severity ${notification.severity}">${notification.severity}</span>
        <span class="notification-agent">${escapeHtml(notification.agentId)}</span>
      </div>
      <div class="notification-title">${escapeHtml(notification.title)}</div>
      <div class="notification-detail">${escapeHtml(notification.detail.length > 150 ? notification.detail.slice(0, 147) + '...' : notification.detail)}</div>
      <div class="notification-actions">
        <button class="btn-primary" onclick="this.closest('.notification-toast')?.remove()">View</button>
      </div>
    </div>
  `;

  document.body.appendChild(toast);

  // Auto-dismiss after 10s for info, keep for warning/critical
  const duration = notification.severity === 'info' ? 10000 : notification.severity === 'warning' ? 20000 : 0;
  if (duration > 0) {
    toastTimeout = setTimeout(() => toast.remove(), duration);
  }

  // Click "View" scrolls to notifications panel
  toast.querySelector('.btn-primary')?.addEventListener('click', () => {
    toast.remove();
    notificationsPanel.scrollIntoView({ behavior: 'smooth' });
  });
}

// ---------------------------------------------------------------------------
// Pending Action Handler
// ---------------------------------------------------------------------------

let currentPendingAction: PendingAction | undefined;

function handlePendingAction(action?: PendingAction) {
  if (!action || (currentPendingAction?.type === action.type && JSON.stringify(currentPendingAction) === JSON.stringify(action))) {
    return; // Same action, don't re-render
  }
  currentPendingAction = action;

  switch (action.type) {
    case 'pick-items':
      renderPlanPicker(action.plan);
      // Auto-switch to Plan tab
      switchToTab('tab-plan');
      // Show notification banner on session tab too
      pendingActionPanel.classList.remove('hidden');
      pendingActionContent.innerHTML = `
        <h3>Plan Ready — Your Input Needed</h3>
        <p>Switch to the <strong>Plan</strong> tab to select items and approve.</p>
        <div class="action-buttons">
          <button class="btn-primary" onclick="document.querySelector('[data-tab=\\'tab-plan\\']')?.click()">Go to Plan</button>
        </div>
      `;
      break;

    case 'pick-action':
      pendingActionPanel.classList.remove('hidden');
      const btns = (action.options ?? []).map(opt =>
        `<button class="btn-primary pending-action-btn" data-action="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</button>`
      ).join('');
      pendingActionContent.innerHTML = `
        <h3>Action Required</h3>
        <div class="action-buttons">${btns}</div>
      `;
      pendingActionContent.querySelectorAll('.pending-action-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const val = (btn as HTMLElement).dataset.action;
          try {
            await fetch(`${apiBase}/api/pick-action`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: val }),
            });
          } catch {}
          clearPendingAction();
        });
      });
      break;

    case 'fix-select':
      renderFixSelector(action.issues ?? []);
      break;

    case 'confirm':
      pendingActionPanel.classList.remove('hidden');
      pendingActionContent.innerHTML = `
        <h3>${escapeHtml(action.message ?? 'Confirm?')}</h3>
        <div class="action-buttons">
          <button class="btn-secondary" id="pending-confirm-no">No</button>
          <button class="btn-primary" id="pending-confirm-yes">Yes</button>
        </div>
      `;
      document.getElementById('pending-confirm-yes')?.addEventListener('click', async () => {
        try {
          await fetch(`${apiBase}/api/pick-action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'yes' }),
          });
        } catch {}
        clearPendingAction();
      });
      document.getElementById('pending-confirm-no')?.addEventListener('click', async () => {
        try {
          await fetch(`${apiBase}/api/pick-action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'no' }),
          });
        } catch {}
        clearPendingAction();
      });
      break;
  }
}

function clearPendingAction() {
  currentPendingAction = undefined;
  pendingActionPanel.classList.add('hidden');
  pendingActionContent.innerHTML = '';
  planPickPanel.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Plan Item Selection (Interactive Picker)
// ---------------------------------------------------------------------------

interface PlanItem {
  id: string;
  title: string;
  description: string;
  priority: string;
  phase: number;
  source: string;
  selected: boolean;
}

interface PlanCategory {
  name: string;
  items: PlanItem[];
}

let selectedItemIds = new Set<string>();

function renderPlanPicker(plan: any) {
  if (!plan || !plan.categories) return;

  planPickPanel.classList.remove('hidden');
  planItemsList.innerHTML = '';
  selectedItemIds.clear();

  const categories: PlanCategory[] = plan.categories;

  // Pre-select based on priority
  for (const cat of categories) {
    for (const item of cat.items) {
      if (item.selected !== false && (item.priority === 'must' || item.priority === 'should')) {
        selectedItemIds.add(item.id);
      }
      if (item.selected === true) {
        selectedItemIds.add(item.id);
      }
    }
  }

  for (const cat of categories) {
    const header = document.createElement('div');
    header.className = 'plan-category-header';
    header.innerHTML = `<span>📁</span> ${escapeHtml(cat.name)} <span style="color:var(--text-muted)">(${cat.items.length})</span>`;
    planItemsList.appendChild(header);

    for (const item of cat.items) {
      const row = document.createElement('div');
      row.className = `plan-item${selectedItemIds.has(item.id) ? ' selected' : ''}`;
      row.dataset.itemId = item.id;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedItemIds.has(item.id);

      const content = document.createElement('div');
      content.className = 'plan-item-content';
      content.innerHTML = `
        <div class="plan-item-title">${escapeHtml(item.title)}</div>
        <div class="plan-item-desc">${escapeHtml(item.description)}</div>
      `;

      const priority = document.createElement('span');
      priority.className = `plan-item-priority ${item.priority}`;
      priority.textContent = item.priority;

      row.appendChild(checkbox);
      row.appendChild(content);
      row.appendChild(priority);

      const toggleItem = () => {
        if (selectedItemIds.has(item.id)) {
          selectedItemIds.delete(item.id);
          checkbox.checked = false;
          row.classList.remove('selected');
        } else {
          selectedItemIds.add(item.id);
          checkbox.checked = true;
          row.classList.add('selected');
        }
        updateSelectedCount();
      };

      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).tagName !== 'INPUT') toggleItem();
      });
      checkbox.addEventListener('change', toggleItem);

      planItemsList.appendChild(row);
    }
  }

  updateSelectedCount();
}

function updateSelectedCount() {
  const total = planItemsList.querySelectorAll('.plan-item').length;
  planSelectedCount.textContent = `${selectedItemIds.size}/${total} selected`;
}

// Select/deselect all
planSelectAll.addEventListener('click', () => {
  planItemsList.querySelectorAll('.plan-item').forEach(row => {
    const id = (row as HTMLElement).dataset.itemId!;
    selectedItemIds.add(id);
    row.classList.add('selected');
    const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (cb) cb.checked = true;
  });
  updateSelectedCount();
});

planDeselectAll.addEventListener('click', () => {
  selectedItemIds.clear();
  planItemsList.querySelectorAll('.plan-item').forEach(row => {
    row.classList.remove('selected');
    const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (cb) cb.checked = false;
  });
  updateSelectedCount();
});

// Approve and Code
planApproveBtn.addEventListener('click', async () => {
  if (!apiBase) return;
  planApproveBtn.setAttribute('disabled', 'true');
  planRefineBtn.setAttribute('disabled', 'true');
  try {
    await fetch(`${apiBase}/api/pick-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedIds: Array.from(selectedItemIds) }),
    });
    // Then send approve action
    await fetch(`${apiBase}/api/pick-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
  } catch {}
  clearPendingAction();
  planApproveBtn.removeAttribute('disabled');
  planRefineBtn.removeAttribute('disabled');
});

// Refine (Pass 2)
planRefineBtn.addEventListener('click', async () => {
  if (!apiBase) return;
  planApproveBtn.setAttribute('disabled', 'true');
  planRefineBtn.setAttribute('disabled', 'true');
  try {
    await fetch(`${apiBase}/api/pick-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedIds: Array.from(selectedItemIds) }),
    });
    await fetch(`${apiBase}/api/pick-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refine' }),
    });
  } catch {}
  clearPendingAction();
  planApproveBtn.removeAttribute('disabled');
  planRefineBtn.removeAttribute('disabled');
});

// ---------------------------------------------------------------------------
// Fix Issue Selector
// ---------------------------------------------------------------------------

function renderFixSelector(issues: any[]) {
  if (!issues || issues.length === 0) return;

  pendingActionPanel.classList.remove('hidden');
  const selectedFixIds = new Set<string>();

  let html = `<h3>${issues.length} Issues Found — Select to Fix</h3>`;
  html += '<div class="fix-issue-list" style="max-height:300px;overflow-y:auto;margin-bottom:8px">';
  for (const issue of issues) {
    const id = issue.id ?? crypto.randomUUID();
    const sevClass = issue.severity === 'critical' ? 'color:var(--red)' : issue.severity === 'warning' ? 'color:var(--yellow)' : 'color:var(--text-muted)';
    html += `
      <div class="fix-issue-item">
        <input type="checkbox" data-issue-id="${escapeHtml(id)}" checked />
        <div>
          <span style="${sevClass};font-weight:600;font-size:11px">[${escapeHtml(issue.severity ?? 'issue')}]</span>
          <span style="font-size:12px">${escapeHtml(issue.what ?? issue.title ?? '')}</span>
          <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(issue.file ?? '')}${issue.line ? ':' + issue.line : ''} — ${escapeHtml(issue.fix ?? '')}</div>
        </div>
      </div>
    `;
    selectedFixIds.add(id);
  }
  html += '</div>';
  html += `<div class="fix-actions">
    <button class="btn-secondary" id="fix-ship-btn">Ship Anyway</button>
    <button class="btn-primary" id="fix-apply-btn">Fix Selected (${selectedFixIds.size})</button>
  </div>`;

  pendingActionContent.innerHTML = html;

  // Wire checkboxes
  pendingActionContent.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = (cb as HTMLElement).dataset.issueId!;
      if ((cb as HTMLInputElement).checked) {
        selectedFixIds.add(id);
      } else {
        selectedFixIds.delete(id);
      }
      const applyBtn = document.getElementById('fix-apply-btn');
      if (applyBtn) applyBtn.textContent = `Fix Selected (${selectedFixIds.size})`;
    });
  });

  document.getElementById('fix-apply-btn')?.addEventListener('click', async () => {
    try {
      await fetch(`${apiBase}/api/fix/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueIds: Array.from(selectedFixIds) }),
      });
      await fetch(`${apiBase}/api/fix/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fix' }),
      });
    } catch {}
    clearPendingAction();
  });

  document.getElementById('fix-ship-btn')?.addEventListener('click', async () => {
    try {
      await fetch(`${apiBase}/api/fix/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ship' }),
      });
    } catch {}
    clearPendingAction();
  });
}

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
  phaseLabel.textContent = session.currentPhase ?? currentPhase ?? '—';

  renderAgentCards(session);
  renderScores(session);
  renderGuidance(session.guidance ?? []);
  renderNotifications(session.notifications ?? []);

  // Handle pending actions from workflow
  if (session.pendingAction) {
    handlePendingAction(session.pendingAction);
  } else if (currentPendingAction) {
    clearPendingAction();
  }
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

  // Also refresh task board so agent lanes show live activity
  if (lastBoardSnapshot) {
    renderTaskBoard(lastBoardSnapshot);
  }
}

function switchToTab(tabId: string) {
  document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tabId}"]`)?.classList.add('active');
  document.querySelectorAll('.tab-content').forEach((tc) => tc.classList.remove('active'));
  document.getElementById(tabId)?.classList.add('active');
}

function handleRoundEvent(data: { round: number; phase: string }) {
  currentPhase = data.phase;
  // Reset agent states for new phase
  agentStates.clear();

  // Auto-switch tabs based on phase
  if (data.phase === 'code' || data.phase === 'fix') {
    switchToTab('tab-session'); // task board is on session tab
  } else if (data.phase === 'review') {
    switchToTab('tab-reviews');
    fetchReviews();
  }

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
            fetchReviews();
            break;

          case 'plan':
            fetchSession().then((s) => s && updateUI(s));
            fetchPlan();
            break;

          case 'freshEyes':
            fetchSession().then((s) => s && updateUI(s));
            break;

          case 'pending-action':
            if (msg.data) handlePendingAction(msg.data as PendingAction);
            fetchSession().then((s) => s && updateUI(s));
            break;

          case 'notification':
            if (msg.data) {
              showNotificationToast(msg.data as AppNotification);
              fetchSession().then((s) => s && updateUI(s));
            }
            break;

          case 'task-board':
            // Task board events come as BoardEvent — refresh the full snapshot
            fetchTaskBoard();
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
  clearPendingAction();
  hideTaskBoard();
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
    fetchTaskBoard();
  }, 3000);

  // Pre-load data for tabs the user might switch to
  fetchCouncil();
  fetchPlan();
  fetchTaskBoard();
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
