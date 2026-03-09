/**
 * Agent Display — Per-agent live terminal panels for parallel work.
 *
 * Each agent gets its own section that shows a rolling log of tool calls.
 * The display uses ANSI escape codes to update in-place without reprinting
 * the entire block. When agents complete, their panel freezes and shows
 * a summary.
 *
 * Layout during parallel execution:
 *
 *   ┌ Torvalds (architect) ───────────────────────────
 *   │ reading src/core/workflow.ts
 *   │ searching for "generateText" in src
 *   │ listing src/core (recursive)
 *   │ submitting result...
 *   └ Done — 5 items, 4 tool calls
 *
 *   ┌ Doshi (planner) ────────────────────────────────
 *   │ reading package.json
 *   │ listing src
 *   │ working...
 *
 *   ┌ Scott (researcher) ─────────────────────────────
 *   │ searching for "dependencies" in .
 *   │ working...
 */

import { loadPersona } from './persona.ts';

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
const CLEAR_LINE = '\x1b[2K';
const CURSOR_UP = (n: number) => `\x1b[${n}A`;
const CURSOR_DOWN = (n: number) => `\x1b[${n}B`;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProgressCallback = (agentId: string, event: string, detail?: string) => void;

interface AgentPanel {
  agentId: string;
  codename: string;
  role: string;
  status: 'working' | 'done' | 'failed';
  toolCalls: ToolCallEntry[];
  summary?: string;
}

interface ToolCallEntry {
  timestamp: number;
  action: string;
}

// How many recent tool calls to show per agent
const MAX_VISIBLE_CALLS = 4;
// Panel width
const PANEL_WIDTH = 60;

// ---------------------------------------------------------------------------
// AgentDisplay — manages the multi-panel terminal display
// ---------------------------------------------------------------------------

export class AgentDisplay {
  private panels: Map<string, AgentPanel> = new Map();
  private panelOrder: string[] = [];
  private totalLines = 0;
  private rendered = false;
  private isTTY: boolean;

  constructor(agentIds: readonly string[]) {
    this.isTTY = process.stdout.isTTY ?? false;
    this.panelOrder = [...agentIds];

    for (const id of agentIds) {
      let codename = id;
      let role = '';
      try {
        const persona = loadPersona(id);
        // For suffixed agents (coder-1, coder-2), append the number to the codename
        const suffixMatch = id.match(/-(\d+)$/);
        codename = suffixMatch ? `${persona.codename}-${suffixMatch[1]}` : persona.codename;
        role = persona.displayName;
      } catch { /* use id as codename */ }

      this.panels.set(id, {
        agentId: id,
        codename,
        role,
        status: 'working',
        toolCalls: [],
      });
    }
  }

  /**
   * Returns a ProgressCallback that feeds events into the display.
   */
  get callback(): ProgressCallback {
    return (agentId: string, event: string, detail?: string) => {
      this.handleEvent(agentId, event, detail);
    };
  }

  private handleEvent(agentId: string, event: string, detail?: string): void {
    const panel = this.panels.get(agentId);
    if (!panel) return;

    switch (event) {
      case 'start':
        panel.toolCalls.push({ timestamp: Date.now(), action: detail ?? 'starting...' });
        break;
      case 'tool':
        panel.toolCalls.push({ timestamp: Date.now(), action: detail ?? 'working...' });
        break;
      case 'submit':
        panel.toolCalls.push({ timestamp: Date.now(), action: 'submitting result...' });
        break;
      case 'done':
        panel.status = 'done';
        panel.summary = detail;
        break;
      case 'failed':
        panel.status = 'failed';
        panel.summary = detail;
        break;
    }

    this.render();
  }

  /**
   * Render all panels. Uses ANSI cursor movement to update in-place.
   */
  private render(): void {
    if (!this.isTTY) {
      this.renderPlain();
      return;
    }

    // Move cursor back to the start of our display region
    if (this.rendered && this.totalLines > 0) {
      process.stdout.write(CURSOR_UP(this.totalLines));
    }

    process.stdout.write(HIDE_CURSOR);

    let lines = 0;
    for (const id of this.panelOrder) {
      const panel = this.panels.get(id)!;
      lines += this.renderPanel(panel);
    }

    this.totalLines = lines;
    this.rendered = true;
    process.stdout.write(SHOW_CURSOR);
  }

  /**
   * Render a single agent panel. Returns number of lines written.
   */
  private renderPanel(panel: AgentPanel): number {
    const { codename, role, status, toolCalls, summary } = panel;
    let lines = 0;

    // Header
    const statusIcon = status === 'done' ? `${GREEN}done${RESET}`
      : status === 'failed' ? `${RED}failed${RESET}`
      : `${YELLOW}working${RESET}`;
    const callCount = toolCalls.filter(tc => tc.action !== 'starting...' && tc.action !== 'submitting result...').length;
    const callStr = callCount > 0 ? ` ${DIM}[${callCount} calls]${RESET}` : '';

    const header = `${BOLD}${CYAN}${codename}${RESET} ${DIM}(${role})${RESET} ${statusIcon}${callStr}`;
    process.stdout.write(`${CLEAR_LINE}  ${header}\n`);
    lines++;

    if (status === 'done' || status === 'failed') {
      // Show summary line only
      const summaryText = summary ?? (status === 'done' ? 'completed' : 'error');
      const color = status === 'done' ? GREEN : RED;
      process.stdout.write(`${CLEAR_LINE}  ${DIM}${color}  -> ${summaryText}${RESET}\n`);
      lines++;
    } else {
      // Show recent tool calls
      const visible = toolCalls.slice(-MAX_VISIBLE_CALLS);
      for (const tc of visible) {
        const truncated = tc.action.length > PANEL_WIDTH
          ? tc.action.slice(0, PANEL_WIDTH - 3) + '...'
          : tc.action;
        process.stdout.write(`${CLEAR_LINE}  ${DIM}  ${truncated}${RESET}\n`);
        lines++;
      }

      // Pad with empty lines if fewer than MAX_VISIBLE_CALLS
      // This keeps the layout stable as new calls come in
      for (let i = visible.length; i < MAX_VISIBLE_CALLS; i++) {
        process.stdout.write(`${CLEAR_LINE}\n`);
        lines++;
      }
    }

    // Blank separator line
    process.stdout.write(`${CLEAR_LINE}\n`);
    lines++;

    return lines;
  }

  /**
   * Plain text fallback for non-TTY environments.
   */
  private renderPlain(): void {
    // Only print new events, don't reprint everything
    for (const id of this.panelOrder) {
      const panel = this.panels.get(id)!;
      const latest = panel.toolCalls[panel.toolCalls.length - 1];
      if (!latest) continue;

      if (panel.status === 'done') {
        console.log(`  [done] ${panel.codename}: ${panel.summary ?? 'completed'}`);
      } else if (panel.status === 'failed') {
        console.log(`  [fail] ${panel.codename}: ${panel.summary ?? 'error'}`);
      } else {
        console.log(`  ${panel.codename}: ${latest.action}`);
      }
    }
  }

  /**
   * Finalize the display — clear the updating region and print a static summary.
   */
  finalize(): void {
    if (!this.isTTY) return;

    // Move back and clear the dynamic region
    if (this.rendered && this.totalLines > 0) {
      process.stdout.write(CURSOR_UP(this.totalLines));
      for (let i = 0; i < this.totalLines; i++) {
        process.stdout.write(`${CLEAR_LINE}\n`);
      }
      process.stdout.write(CURSOR_UP(this.totalLines));
    }

    // Print static final summary
    for (const id of this.panelOrder) {
      const panel = this.panels.get(id)!;
      const callCount = panel.toolCalls.filter(
        tc => tc.action !== 'starting...' && tc.action !== 'submitting result...'
      ).length;

      const icon = panel.status === 'done' ? `${GREEN}v${RESET}`
        : panel.status === 'failed' ? `${RED}x${RESET}`
        : `${YELLOW}~${RESET}`;

      const summary = panel.summary ?? (panel.status === 'done' ? 'completed' : 'working');
      const calls = callCount > 0 ? ` ${DIM}(${callCount} tool calls)${RESET}` : '';

      process.stdout.write(`  ${icon} ${BOLD}${panel.codename}${RESET}: ${summary}${calls}\n`);
    }
    process.stdout.write('\n');

    this.rendered = false;
    this.totalLines = 0;
  }

  /**
   * Get the full tool call history for a specific agent.
   * Useful for "tap into" / inspect functionality.
   */
  getAgentHistory(agentId: string): ToolCallEntry[] {
    return this.panels.get(agentId)?.toolCalls ?? [];
  }

  /**
   * Get the status of all agents.
   */
  getStatus(): Array<{ agentId: string; codename: string; status: string; toolCalls: number; summary?: string }> {
    return this.panelOrder.map(id => {
      const panel = this.panels.get(id)!;
      return {
        agentId: id,
        codename: panel.codename,
        status: panel.status,
        toolCalls: panel.toolCalls.length,
        summary: panel.summary,
      };
    });
  }

  /**
   * Check if all agents have completed (done or failed).
   */
  get allComplete(): boolean {
    return [...this.panels.values()].every(p => p.status === 'done' || p.status === 'failed');
  }
}
