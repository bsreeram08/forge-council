import { join } from 'path';
import { mkdir, chmod } from 'fs/promises';
import { z } from 'zod';
import { SessionSchema } from '../council/schemas.ts';
import type { Session } from '../council/schemas.ts';
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

  append(level: LogEntry['level'], source: string, message: string): void {
    const entry: LogEntry = {
      id: this.entries.length + 1,
      sessionId: this.sessionId ?? '',
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
    };
    this.entries.push(entry);

    // Persist to SQLite
    if (this.sessionId) {
      try { getStore().appendLog(this.sessionId, level, source, message); } catch (e) { logError('session.log-persist', e, { sessionId: this.sessionId }); }
    }

    // Notify listeners (WebSocket, etc.)
    for (const listener of this.listeners) {
      listener(entry);
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
    logBuffer.append('system', 'session', `Session ${sessionId.slice(0, 8)} resumed from round ${stored.current_round}`);

    return this.session;
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
