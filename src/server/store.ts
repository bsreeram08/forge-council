import { Database } from 'bun:sqlite';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { z } from 'zod';
import type { Session } from '../council/schemas.ts';
import { AgentReviewSchema } from '../council/schemas.ts';
import type { PlanOutput, AgentReview, ScoreCard } from '../council/schemas.ts';

const STORE_DIR = join(process.cwd(), '.forgecouncil');
const DB_PATH = join(STORE_DIR, 'sessions.db');

export interface LogEntry {
  id: number;
  sessionId: string;
  timestamp: string;
  level: 'info' | 'agent' | 'score' | 'error' | 'system';
  source: string;
  message: string;
}

export interface StoredSession {
  id: string;
  idea: string;
  port: number;
  pid: number;
  started_at: string;
  ended_at: string | null;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  current_round: number;
  max_rounds: number;
  score_threshold: number;
  config_snapshot: string;
  guidance: string;
}

interface PlanRow {
  round: number;
  executive_summary: string;
  architecture: string;
  phased_roadmap: string;
  skeleton_code: string;
  tech_stack: string;
}

interface ReviewRow {
  review_json: string;
}

interface ScoreRow {
  round: number;
  mean: number;
  agent_scores: string;
}

/** Subset of StoredSession fields that can be updated after creation. */
type SessionUpdateField = 'status' | 'current_round' | 'ended_at' | 'port' | 'pid';
export type SessionUpdate = Partial<Pick<StoredSession, SessionUpdateField>>;

class SessionStore {
  private db: Database;

  constructor() {
    mkdirSync(STORE_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        idea TEXT NOT NULL,
        port INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        current_round INTEGER NOT NULL DEFAULT 0,
        max_rounds INTEGER NOT NULL DEFAULT 3,
        score_threshold REAL NOT NULL DEFAULT 7.5,
        config_snapshot TEXT NOT NULL DEFAULT '{}',
        guidance TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        round INTEGER NOT NULL,
        executive_summary TEXT NOT NULL,
        architecture TEXT NOT NULL,
        phased_roadmap TEXT NOT NULL,
        skeleton_code TEXT NOT NULL,
        tech_stack TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, round)
      );

      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        round INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        review_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        round INTEGER NOT NULL,
        mean REAL NOT NULL,
        agent_scores TEXT NOT NULL,
        passed INTEGER NOT NULL DEFAULT 0,
        stagnated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, round)
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        level TEXT NOT NULL DEFAULT 'info',
        source TEXT NOT NULL DEFAULT 'system',
        message TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_session ON reviews(session_id, round);
      CREATE INDEX IF NOT EXISTS idx_scores_session ON scores(session_id);
    `);
  }

  // --- Sessions ---

  createSession(session: Session, maxRounds: number, scoreThreshold: number, configSnapshot: string): void {
    this.db.prepare(`
      INSERT INTO sessions (id, idea, port, pid, started_at, status, current_round, max_rounds, score_threshold, config_snapshot, guidance)
      VALUES ($id, $idea, $port, $pid, $startedAt, $status, $currentRound, $maxRounds, $scoreThreshold, $configSnapshot, $guidance)
    `).run({
      $id: session.id,
      $idea: session.idea,
      $port: session.port,
      $pid: session.pid,
      $startedAt: session.startedAt,
      $status: session.status,
      $currentRound: session.currentRound,
      $maxRounds: maxRounds,
      $scoreThreshold: scoreThreshold,
      $configSnapshot: configSnapshot,
      $guidance: JSON.stringify(session.guidance ?? []),
    });
  }

  updateSession(id: string, updates: SessionUpdate): void {
    // Build SET clause from the provided fields
    const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;

    const setClauses = entries.map(([col]) => `${col} = $${col}`).join(', ');
    const params: Record<string, string | number | null> = { $id: id };
    for (const [col, value] of entries) {
      params[`$${col}`] = value ?? null;
    }

    this.db.prepare(`UPDATE sessions SET ${setClauses} WHERE id = $id`).run(params);
  }

  updateGuidance(id: string, guidance: string[]): void {
    this.db.prepare('UPDATE sessions SET guidance = $guidance WHERE id = $id').run({
      $guidance: JSON.stringify(guidance),
      $id: id,
    });
  }

  getSession(id: string): StoredSession | null {
    return this.db.query<StoredSession, { $id: string }>(
      'SELECT * FROM sessions WHERE id = $id'
    ).get({ $id: id }) ?? null;
  }

  listSessions(limit = 20): StoredSession[] {
    return this.db.query<StoredSession, { $limit: number }>(
      'SELECT * FROM sessions ORDER BY started_at DESC LIMIT $limit'
    ).all({ $limit: limit });
  }

  getResumableSessions(): StoredSession[] {
    return this.db.query<StoredSession, []>(
      `SELECT * FROM sessions WHERE status IN ('running', 'failed') ORDER BY started_at DESC LIMIT 10`
    ).all();
  }

  // --- Plans ---

  savePlan(sessionId: string, round: number, plan: PlanOutput): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO plans (session_id, round, executive_summary, architecture, phased_roadmap, skeleton_code, tech_stack)
      VALUES ($sessionId, $round, $summary, $arch, $roadmap, $code, $stack)
    `).run({
      $sessionId: sessionId,
      $round: round,
      $summary: plan.executiveSummary,
      $arch: plan.architecture,
      $roadmap: plan.phasedRoadmap,
      $code: plan.skeletonCode,
      $stack: plan.techStack,
    });
  }

  getPlan(sessionId: string, round: number): PlanOutput | null {
    const row = this.db.query<PlanRow, { $sid: string; $round: number }>(
      'SELECT round, executive_summary, architecture, phased_roadmap, skeleton_code, tech_stack FROM plans WHERE session_id = $sid AND round = $round'
    ).get({ $sid: sessionId, $round: round });
    if (!row) return null;
    return planRowToOutput(row);
  }

  getLatestPlan(sessionId: string): { round: number; plan: PlanOutput } | null {
    const row = this.db.query<PlanRow, { $sid: string }>(
      'SELECT round, executive_summary, architecture, phased_roadmap, skeleton_code, tech_stack FROM plans WHERE session_id = $sid ORDER BY round DESC LIMIT 1'
    ).get({ $sid: sessionId });
    if (!row) return null;
    return { round: row.round, plan: planRowToOutput(row) };
  }

  // --- Reviews ---

  saveReview(sessionId: string, round: number, review: AgentReview): void {
    this.db.prepare(`
      INSERT INTO reviews (session_id, round, agent_id, review_json)
      VALUES ($sid, $round, $agentId, $json)
    `).run({
      $sid: sessionId,
      $round: round,
      $agentId: review.agentId,
      $json: JSON.stringify(review),
    });
  }

  getReviews(sessionId: string, round: number): AgentReview[] {
    const rows = this.db.query<ReviewRow, { $sid: string; $round: number }>(
      'SELECT review_json FROM reviews WHERE session_id = $sid AND round = $round'
    ).all({ $sid: sessionId, $round: round });
    return rows.map((r) => AgentReviewSchema.parse(JSON.parse(r.review_json)));
  }

  // --- Scores ---

  saveScore(sessionId: string, scoreCard: ScoreCard): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO scores (session_id, round, mean, agent_scores, passed, stagnated)
      VALUES ($sid, $round, $mean, $scores, $passed, $stagnated)
    `).run({
      $sid: sessionId,
      $round: scoreCard.round,
      $mean: scoreCard.mean,
      $scores: JSON.stringify(scoreCard.agentScores),
      $passed: scoreCard.passed ? 1 : 0,
      $stagnated: scoreCard.stagnated ? 1 : 0,
    });
  }

  getScores(sessionId: string): { round: number; mean: number; agents: Record<string, number> }[] {
    const rows = this.db.query<ScoreRow, { $sid: string }>(
      'SELECT round, mean, agent_scores FROM scores WHERE session_id = $sid ORDER BY round'
    ).all({ $sid: sessionId });
    const agentScoresSchema = z.record(z.string(), z.number());
    return rows.map((r) => ({
      round: r.round,
      mean: r.mean,
      agents: agentScoresSchema.parse(JSON.parse(r.agent_scores)),
    }));
  }

  // --- Logs ---

  /**
   * Append a log row to the logs table. Returns the inserted row id.
   */
  appendLog(sessionId: string, level: LogEntry['level'], source: string, message: string): number {
    const res = this.db.prepare(`
      INSERT INTO logs (session_id, level, source, message) VALUES ($sid, $level, $source, $msg)
    `).run({ $sid: sessionId, $level: level, $source: source, $msg: message });
    // @ts-ignore - Bun's sqlite returns lastInsertRowid
    return typeof res?.lastInsertRowid === 'number' ? res.lastInsertRowid as number : 0;
  }

  getLogs(sessionId: string, afterId = 0, limit = 200): LogEntry[] {
    return this.db.query<LogEntry, { $sid: string; $after: number; $limit: number }>(
      'SELECT id, session_id as sessionId, timestamp, level, source, message FROM logs WHERE session_id = $sid AND id > $after ORDER BY id ASC LIMIT $limit'
    ).all({ $sid: sessionId, $after: afterId, $limit: limit });
  }

  getRecentLogs(sessionId: string, limit = 50): LogEntry[] {
    return this.db.query<LogEntry, { $sid: string; $limit: number }>(
      'SELECT id, session_id as sessionId, timestamp, level, source, message FROM logs WHERE session_id = $sid ORDER BY id DESC LIMIT $limit'
    ).all({ $sid: sessionId, $limit: limit }).reverse();
  }

  close(): void {
    this.db.close();
  }
}

function planRowToOutput(row: PlanRow): PlanOutput {
  return {
    executiveSummary: row.executive_summary,
    architecture: row.architecture,
    phasedRoadmap: row.phased_roadmap,
    skeletonCode: row.skeleton_code,
    techStack: row.tech_stack,
  };
}

// Singleton
let _store: SessionStore | null = null;

export function getStore(): SessionStore {
  if (!_store) {
    _store = new SessionStore();
  }
  return _store;
}
