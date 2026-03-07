import { join } from 'path';
import { mkdir, chmod } from 'fs/promises';
import { z } from 'zod';
import { SessionSchema } from '../council/schemas.ts';
import type { Session, PendingAction, Notification } from '../council/schemas.ts';
import type { PlanOutput, AgentReview, ScoreCard } from '../council/schemas.ts';
import { getStore } from './store.ts';
import type { LogEntry, SessionUpdate } from './store.ts';
import { logError } from '../errors/logger.ts';

const SESSION_DIR = join(process.cwd(), '.forgecouncil', 'sessions');
const SESSION_FILE = join(SESSION_DIR, 'current.json');

/**
 * In-memory log buffer for real-time streaming + SQLite persistence.
 */
class LogBuffer {
  private entries: LogEntry[] = [];
  private listeners: Set<(entry: LogEntry) => void> = new Set();
  private sessionId: string | null = null;

  setSession(id: string): void {
    this.sessionId = id;
    this.entries = [];
  }

  /** Load recent persisted logs for session into memory buffer */
  loadRecent(sessionId: string, limit = 200): void {
    try {
      const rows = getStore().getRecentLogs(sessionId, limit);
      this.sessionId = sessionId;
      this.entries = rows.slice();
    } catch (e) {
      logError('logbuffer.loadRecent', e, { sessionId });
    }
  }

  /** Clear in-memory buffer */
  clear(): void {
    this.entries = [];
  }

  append(level: LogEntry['level'], source: string, message: string): void {
    const entry: LogEntry = {
      id: 0,
      sessionId: this.sessionId ?? '',
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
    };

    // Persist to SQLite and capture assigned id
    if (this.sessionId) {
      try {
        const insertedId = getStore().appendLog(this.sessionId, level, source, message);
        if (typeof insertedId === 'number' && insertedId > 0) entry.id = insertedId;
      } catch (e) {
        logError('session.log-persist', e, { sessionId: this.sessionId });
      }
    }

    // If DB didn't provide an id (e.g., no session), fallback to sequential id
    if (entry.id === 0) {
      entry.id = this.entries.length > 0 ? this.entries[this.entries.length - 1]!.id + 1 : 1;
    }

    this.entries.push(entry);

    // Notify listeners (WebSocket, etc.)
    for (const listener of this.listeners) {
      try { listener(entry); } catch (e) { logError('logbuffer.listener', e); }
    }
  }

  onEntry(callback: (entry: LogEntry) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getRecent(limit = 50): LogEntry[] {
    return this.entries.slice(-limit);
  }

  getAfter(afterId: number): LogEntry[] {
    return this.entries.filter((e) => e.id > afterId);
  }
}

export const logBuffer = new LogBuffer();

export class SessionManager {
  private session: Session | null = null;
  private pendingResolver: ((response: unknown) => void) | null = null;

  create(idea: string, port: number, maxRounds = 3, scoreThreshold = 7.5, configSnapshot = '{}'): Session {
    this.session = {
      id: crypto.randomUUID(),
      idea,
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      status: 'running',
      currentRound: 0,
      scores: [],
      activeAgents: [],
      guidance: [],
    };

    // Persist to store
    try {
      getStore().createSession(this.session, maxRounds, scoreThreshold, configSnapshot);
    } catch (e) { logError('session.create-persist', e, { sessionId: this.session?.id }); }

    logBuffer.setSession(this.session.id);

    // Seed in-memory logs from DB for this session
    try { logBuffer.loadRecent(this.session.id, 200); } catch (e) { /* ignore */ }

    logBuffer.append('system', 'session', `Session ${this.session.id.slice(0, 8)} created for: ${idea}`);

    return this.session;
  }

  get(): Session | null {
    return this.session;
  }

  update(partial: Partial<Session>): void {
    if (!this.session) return;
    this.session = { ...this.session, ...partial };

    // Sync relevant fields to store
    const storeUpdates: SessionUpdate = {};
    if (partial.status !== undefined) storeUpdates.status = partial.status;
    if (partial.currentRound !== undefined) storeUpdates.current_round = partial.currentRound;
    if (partial.port !== undefined) storeUpdates.port = partial.port;

    if (partial.status === 'completed' || partial.status === 'failed' || partial.status === 'stopped') {
      storeUpdates.ended_at = new Date().toISOString();
    }

    if (Object.keys(storeUpdates).length > 0) {
      try { getStore().updateSession(this.session.id, storeUpdates); } catch (e) { logError('session.update-persist', e, { sessionId: this.session.id }); }
    }
  }

  addGuidance(text: string): void {
    if (!this.session) return;
    const guidance = this.session.guidance ?? [];
    guidance.push(text);
    this.session.guidance = guidance;
    try { getStore().updateGuidance(this.session.id, guidance); } catch (e) { logError('session.guidance-persist', e, { sessionId: this.session.id }); }
    logBuffer.append('info', 'user', `Guidance added: ${text}`);
  }

  savePlan(round: number, plan: PlanOutput): void {
    if (!this.session) return;
    try { getStore().savePlan(this.session.id, round, plan); } catch (e) { logError('session.plan-persist', e, { sessionId: this.session.id, round }); }
    logBuffer.append('system', 'ford', `Plan saved for round ${round}`);
  }

  saveReviews(round: number, reviews: AgentReview[]): void {
    if (!this.session) return;
    for (const review of reviews) {
      try { getStore().saveReview(this.session.id, round, review); } catch (e) { logError('session.review-persist', e, { sessionId: this.session.id, round, agentId: review.agentId }); }
    }
  }

  saveScore(scoreCard: ScoreCard): void {
    if (!this.session) return;
    try { getStore().saveScore(this.session.id, scoreCard); } catch (e) { logError('session.score-persist', e, { sessionId: this.session.id, round: scoreCard.round }); }
  }

  /**
   * Restore a session from the store for resumption.
   */
  restore(sessionId: string): Session | null {
    const stored = getStore().getSession(sessionId);
    if (!stored) return null;

    const scores = getStore().getScores(sessionId);

    this.session = {
      id: stored.id,
      idea: stored.idea,
      port: stored.port,
      pid: process.pid,
      startedAt: stored.started_at,
      status: 'running',
      currentRound: stored.current_round,
      scores,
      activeAgents: [],
      guidance: stored.guidance ? z.array(z.string()).parse(JSON.parse(stored.guidance)) : [],
    };

    getStore().updateSession(sessionId, { status: 'running', pid: process.pid });
    logBuffer.setSession(sessionId);

    // Seed in-memory logs from DB
    try { logBuffer.loadRecent(sessionId, 200); } catch (e) { /* ignore */ }

    logBuffer.append('system', 'session', `Session ${sessionId.slice(0, 8)} resumed from round ${stored.current_round}`);

    return this.session;
  }

  /**
   * Set a pending action — indicates the workflow is waiting for user input.
   * The desktop app will render the appropriate UI.
   */
  setPendingAction(action: PendingAction): void {
    if (!this.session) return;
    this.session.pendingAction = action;
    logBuffer.append('system', 'session', `Waiting for user: ${action.type}`);
  }

  /**
   * Clear the pending action and resolve the waiting promise.
   */
  resolvePendingAction(response: unknown): void {
    if (!this.session) return;
    this.session.pendingAction = undefined;
    if (this.pendingResolver) {
      this.pendingResolver(response);
      this.pendingResolver = null;
    }
  }

  /**
   * Wait for user to respond to a pending action.
   * Returns the response data from the API call.
   */
  waitForAction<T>(action: PendingAction): Promise<T> {
    this.setPendingAction(action);
    return new Promise<T>((resolve) => {
      this.pendingResolver = resolve as (response: unknown) => void;
    });
  }

  // --- Notifications ---

  private notificationListeners: Set<(notification: Notification) => void> = new Set();

  addNotification(partial: Omit<Notification, 'id' | 'timestamp' | 'dismissed'>): Notification {
    if (!this.session) throw new Error('No active session');
    const notification: Notification = {
      ...partial,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      dismissed: false,
    };
    const notifications = this.session.notifications ?? [];
    notifications.push(notification);
    this.session.notifications = notifications;
    logBuffer.append('system', 'notification', `[${notification.severity}] ${notification.agentId}: ${notification.title}`);

    // Notify listeners (for CLI bell, eventBus push, etc.)
    for (const listener of this.notificationListeners) {
      try { listener(notification); } catch (_) {}
    }
    return notification;
  }

  getNotifications(): Notification[] {
    return this.session?.notifications ?? [];
  }

  dismissNotification(id: string): boolean {
    if (!this.session?.notifications) return false;
    const n = this.session.notifications.find(n => n.id === id);
    if (!n) return false;
    n.dismissed = true;
    return true;
  }

  respondToNotification(id: string, response: string): boolean {
    if (!this.session?.notifications) return false;
    const n = this.session.notifications.find(n => n.id === id && n.actionRequired);
    if (!n) return false;
    n.response = response;
    n.dismissed = true;
    logBuffer.append('info', 'user', `Response to ${n.agentId}: ${response}`);
    return true;
  }

  onNotification(callback: (notification: Notification) => void): () => void {
    this.notificationListeners.add(callback);
    return () => this.notificationListeners.delete(callback);
  }

  setPhase(phase: string): void {
    if (!this.session) return;
    this.session.currentPhase = phase;
  }

  async save(): Promise<void> {
    if (!this.session) return;
    await mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
    await Bun.write(SESSION_FILE, JSON.stringify(this.session, null, 2));
    await chmod(SESSION_FILE, 0o600);
  }

  static async load(): Promise<Session | null> {
    try {
      const file = Bun.file(SESSION_FILE);
      const exists = await file.exists();
      if (!exists) return null;
      const text = await file.text();
      return SessionSchema.parse(JSON.parse(text));
    } catch (e) {
      logError('session.load', e, { file: SESSION_FILE });
      return null;
    }
  }
}

export const sessionManager = new SessionManager();
