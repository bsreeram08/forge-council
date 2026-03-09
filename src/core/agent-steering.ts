/**
 * Agent Steering — Non-blocking CLI interaction during agent execution.
 *
 * Inspired by OpenCode's approach: while agents run, the user can:
 *   - Press [1-9] to "tap into" an agent (see its full tool call history)
 *   - Press [s] to send guidance to a specific agent
 *   - Press [g] to send global guidance to all agents
 *   - Press [c] to cancel an agent
 *   - Press [Esc] to return to the overview
 *
 * Agents have access to a `checkGuidance` tool that reads any queued
 * guidance from the user, allowing mid-execution steering without
 * blocking the LLM call.
 *
 * Uses raw stdin keypress handling alongside the async agent execution.
 */

import * as readline from 'readline';
import * as p from '@clack/prompts';
import type { AgentDisplay } from './agent-display.ts';
import { sessionManager, logBuffer } from '../server/session.ts';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const CLEAR_LINE = '\x1b[2K';
const CLEAR_SCREEN_DOWN = '\x1b[J';
const CURSOR_UP = (n: number) => `\x1b[${n}A`;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// ---------------------------------------------------------------------------
// Guidance Inbox — per-agent guidance queue that agents read via tool
// ---------------------------------------------------------------------------

const guidanceInbox = new Map<string, string[]>();

/** Queue guidance for a specific agent (or all agents if agentId is '*'). */
export function queueGuidance(agentId: string, text: string): void {
  if (agentId === '*') {
    // Broadcast: queue for all known agents
    for (const [id, _] of guidanceInbox) {
      guidanceInbox.get(id)!.push(text);
    }
    // Also store in session for persistence
    sessionManager.addGuidance(text);
  } else {
    if (!guidanceInbox.has(agentId)) {
      guidanceInbox.set(agentId, []);
    }
    guidanceInbox.get(agentId)!.push(text);
    sessionManager.addGuidance(text, agentId);
  }
}

/** Initialize inbox slots for agents. */
export function initInbox(agentIds: readonly string[]): void {
  for (const id of agentIds) {
    if (!guidanceInbox.has(id)) {
      guidanceInbox.set(id, []);
    }
  }
}

/** Drain all pending guidance for an agent (called by the checkGuidance tool). */
export function drainGuidance(agentId: string): string[] {
  const messages = guidanceInbox.get(agentId) ?? [];
  guidanceInbox.set(agentId, []);
  return messages;
}

/** Check if any guidance is pending for an agent (non-destructive peek). */
export function hasGuidance(agentId: string): boolean {
  return (guidanceInbox.get(agentId)?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// AbortController Registry — per-agent cancellation
// ---------------------------------------------------------------------------

const abortControllers = new Map<string, AbortController>();

export function createAbortSignal(agentId: string): AbortSignal {
  const controller = new AbortController();
  abortControllers.set(agentId, controller);
  return controller.signal;
}

export function cancelAgent(agentId: string): boolean {
  const controller = abortControllers.get(agentId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
    abortControllers.delete(agentId);
    return true;
  }
  return false;
}

export function cleanupAbort(agentId: string): void {
  abortControllers.delete(agentId);
}

// ---------------------------------------------------------------------------
// Steering Session — non-blocking keypress handler during agent execution
// ---------------------------------------------------------------------------

export interface SteeringSession {
  /** Stop listening for keypresses. Call when agents are done. */
  stop(): void;
  /** Whether the user is currently "tapped into" an agent. */
  readonly tappedAgent: string | null;
}

export function startSteering(display: AgentDisplay): SteeringSession {
  if (!process.stdin.isTTY) {
    return { stop() {}, get tappedAgent() { return null; } };
  }

  let tappedAgent: string | null = null;
  let active = true;
  let guidanceMode = false;
  let guidanceTarget: string | null = null;
  let guidanceBuffer = '';

  const status = display.getStatus();
  const agentIds = status.map(s => s.agentId);

  // Show the hint bar
  function renderHintBar(): void {
    if (!active) return;
    const hint = guidanceMode
      ? `${BOLD}${MAGENTA}Guidance for ${guidanceTarget === '*' ? 'ALL' : guidanceTarget}${RESET}: ${guidanceBuffer}█  ${DIM}[Enter] send  [Esc] cancel${RESET}`
      : tappedAgent
        ? `${DIM}Tapped into ${BOLD}${tappedAgent}${RESET}${DIM} — [s] steer  [c] cancel  [Esc] back${RESET}`
        : `${DIM}[1-${Math.min(agentIds.length, 9)}] tap agent  [g] global guidance  [s] steer agent  [Esc] overview${RESET}`;
    process.stdout.write(`${CLEAR_LINE}\r${hint}`);
  }

  // Show full history for a tapped agent
  function renderTappedView(): void {
    if (!tappedAgent) return;
    const history = display.getAgentHistory(tappedAgent);
    const agentStatus = display.getStatus().find(s => s.agentId === tappedAgent);
    if (!agentStatus) return;

    process.stdout.write(CLEAR_SCREEN_DOWN);
    process.stdout.write(`\n${BOLD}${CYAN}${agentStatus.codename}${RESET} ${DIM}(${tappedAgent})${RESET}\n`);

    const statusColor = agentStatus.status === 'done' ? GREEN : agentStatus.status === 'failed' ? RED : YELLOW;
    process.stdout.write(`  Status: ${statusColor}${agentStatus.status}${RESET}  Tool calls: ${agentStatus.toolCalls}\n\n`);

    // Show last 15 tool calls
    const recent = history.slice(-15);
    for (const entry of recent) {
      const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
      process.stdout.write(`  ${DIM}${time}${RESET}  ${entry.action}\n`);
    }
    process.stdout.write('\n');

    // Show pending guidance
    const pending = guidanceInbox.get(tappedAgent) ?? [];
    if (pending.length > 0) {
      process.stdout.write(`  ${YELLOW}Pending guidance (${pending.length}):${RESET}\n`);
      for (const g of pending) {
        process.stdout.write(`    ${DIM}> ${g}${RESET}\n`);
      }
      process.stdout.write('\n');
    }
  }

  // Enter raw mode for keypress detection
  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw ?? false;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  function handleKeypress(_str: string | undefined, key: readline.Key): void {
    if (!active) return;

    // Guidance input mode — capture text
    if (guidanceMode) {
      if (key.name === 'escape') {
        guidanceMode = false;
        guidanceBuffer = '';
        guidanceTarget = null;
        renderHintBar();
        return;
      }
      if (key.name === 'return') {
        const text = guidanceBuffer.trim();
        if (text && guidanceTarget) {
          queueGuidance(guidanceTarget, text);
          logBuffer.append('info', 'user', `[steer → ${guidanceTarget}] ${text}`);
          process.stdout.write(`\n  ${GREEN}✓${RESET} Guidance queued for ${guidanceTarget}\n`);
        }
        guidanceMode = false;
        guidanceBuffer = '';
        guidanceTarget = null;
        renderHintBar();
        return;
      }
      if (key.name === 'backspace') {
        guidanceBuffer = guidanceBuffer.slice(0, -1);
        renderHintBar();
        return;
      }
      if (_str && !key.ctrl && !key.meta) {
        guidanceBuffer += _str;
        renderHintBar();
        return;
      }
      return;
    }

    // Normal mode keypresses
    if (key.name === 'escape') {
      tappedAgent = null;
      renderHintBar();
      return;
    }

    // Number keys to tap into agents
    const num = parseInt(key.name ?? '', 10);
    if (num >= 1 && num <= agentIds.length) {
      tappedAgent = agentIds[num - 1]!;
      renderTappedView();
      renderHintBar();
      return;
    }

    // [g] global guidance
    if (key.name === 'g') {
      guidanceMode = true;
      guidanceTarget = '*';
      guidanceBuffer = '';
      renderHintBar();
      return;
    }

    // [s] steer — sends guidance to tapped agent, or prompts for agent number
    if (key.name === 's') {
      if (tappedAgent) {
        guidanceMode = true;
        guidanceTarget = tappedAgent;
        guidanceBuffer = '';
      } else {
        // Ask which agent
        process.stdout.write(`\n  ${YELLOW}Which agent? [1-${agentIds.length}]:${RESET} `);
        // Next keypress will be the agent number — set a flag
        const onceHandler = (_s: string | undefined, k: readline.Key) => {
          process.stdin.removeListener('keypress', onceHandler);
          const n = parseInt(k.name ?? '', 10);
          if (n >= 1 && n <= agentIds.length) {
            tappedAgent = agentIds[n - 1]!;
            guidanceMode = true;
            guidanceTarget = tappedAgent;
            guidanceBuffer = '';
            renderHintBar();
          } else {
            renderHintBar();
          }
        };
        process.stdin.on('keypress', onceHandler);
        return;
      }
      renderHintBar();
      return;
    }

    // [c] cancel tapped agent
    if (key.name === 'c' && tappedAgent) {
      const cancelled = cancelAgent(tappedAgent);
      if (cancelled) {
        process.stdout.write(`\n  ${RED}✕${RESET} Cancelled ${tappedAgent}\n`);
        logBuffer.append('info', 'user', `Agent ${tappedAgent} cancelled by user`);
      }
      renderHintBar();
      return;
    }

    // Ctrl+C — bail out entirely
    if (key.ctrl && key.name === 'c') {
      stop();
      process.exit(0);
    }
  }

  process.stdin.on('keypress', handleKeypress);

  // Initial hint
  setTimeout(() => renderHintBar(), 100);

  function stop(): void {
    if (!active) return;
    active = false;
    process.stdin.removeListener('keypress', handleKeypress);
    try {
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    } catch { /* stdin may already be closed */ }
    process.stdout.write(`${CLEAR_LINE}\r${SHOW_CURSOR}`);

    // Clean up abort controllers
    for (const id of agentIds) {
      cleanupAbort(id);
    }
    guidanceInbox.clear();
  }

  return {
    stop,
    get tappedAgent() { return tappedAgent; },
  };
}
