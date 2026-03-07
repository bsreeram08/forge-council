/**
 * Agent Communication Tools — AI SDK tools for inter-agent coordination.
 *
 * These tools are injected into each coding agent alongside their normal
 * read-write tools. They let agents:
 *   - See the task board state
 *   - Claim and complete tasks
 *   - Post messages to other agents
 *   - Read messages from the board
 *   - Dynamically add new tasks
 *
 * Each tool closure captures the agent's ID and the shared TaskBoard reference.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { TaskBoard } from './task-board.ts';

export interface CommToolsOptions {
  /** Called when an agent requests human help — hook into SessionManager.addNotification */
  onHumanHelpRequest?: (notification: { agentId: string; severity: 'info' | 'warning' | 'critical'; title: string; detail: string; actionRequired: boolean }) => void;
}

/**
 * Create the set of communication tools for a specific agent.
 * These are AI SDK tools that can be spread into the agent's tool map.
 */
export function createCommTools(agentId: string, board: TaskBoard, options?: CommToolsOptions) {
  const getBoard = tool({
    description: 'Get the current state of the task board. Shows all tasks, their status, who claimed them, and recent messages from other agents. Call this FIRST to see what work is available.',
    inputSchema: z.object({}),
    execute: async () => {
      return board.snapshot();
    },
  });

  const claimTask = tool({
    description: 'Claim a task from the board to work on. Returns the task details if successful, or null if the task is unavailable. You must claim a task before implementing it.',
    inputSchema: z.object({
      taskId: z.string().describe('ID of the task to claim. Use getBoard first to see available tasks.'),
    }),
    execute: async ({ taskId }) => {
      const task = board.claim(taskId, agentId);
      if (!task) {
        return { success: false, error: `Task "${taskId}" is not available (already claimed, dependencies not met, or doesn't exist)` };
      }
      return {
        success: true,
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          category: task.category,
          phase: task.phase,
          priority: task.priority,
          dependsOn: task.dependsOn,
        },
      };
    },
  });

  const claimNextTask = tool({
    description: 'Claim the highest-priority available task from the board. The board picks the best task for you based on priority and phase ordering. Returns null if no tasks are available.',
    inputSchema: z.object({}),
    execute: async () => {
      const task = board.claimNext(agentId);
      if (!task) {
        return { success: false, available: 0, reason: 'No tasks available — all claimed, completed, or blocked by dependencies' };
      }
      return {
        success: true,
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          category: task.category,
          phase: task.phase,
          priority: task.priority,
          dependsOn: task.dependsOn,
        },
      };
    },
  });

  const completeTask = tool({
    description: 'Mark a task as completed. Call this AFTER you have written all files for the task. Provide the files you created/modified, a commit message, and a summary.',
    inputSchema: z.object({
      taskId: z.string().describe('ID of the task you completed'),
      files: z.array(z.string()).describe('File paths you created or modified for this task'),
      commitMessage: z.string().max(72).describe('Conventional commit message (feat:, fix:, etc.)'),
      summary: z.string().max(200).describe('One-line summary of what was done'),
    }),
    execute: async ({ taskId, files, commitMessage, summary }) => {
      const ok = board.complete(taskId, agentId, { files, commitMessage, summary });
      if (!ok) {
        return { success: false, error: `Cannot complete task "${taskId}" — not claimed by you` };
      }
      const snapshot = board.snapshot();
      return {
        success: true,
        boardStatus: {
          done: snapshot.done,
          total: snapshot.total,
          remaining: snapshot.pending + snapshot.claimed - 1, // -1 for just-completed
        },
      };
    },
  });

  const failTask = tool({
    description: 'Report that you cannot complete a task. It will be returned to the pool for another agent to attempt. Use this if you hit an unrecoverable issue.',
    inputSchema: z.object({
      taskId: z.string().describe('ID of the task that failed'),
      error: z.string().max(200).describe('What went wrong'),
    }),
    execute: async ({ taskId, error }) => {
      const ok = board.fail(taskId, agentId, error);
      return ok
        ? { success: true, message: 'Task returned to pool' }
        : { success: false, error: `Cannot fail task "${taskId}" — not claimed by you` };
    },
  });

  const postMessage = tool({
    description: 'Post a message to the board. Other agents can read it. Use this to coordinate: announce what you are working on, share discoveries about the codebase, flag conflicts, or request help.',
    inputSchema: z.object({
      content: z.string().max(500).describe('Message content'),
      toAgent: z.string().nullable().default(null).describe('Target agent ID, or null to broadcast to all'),
      taskId: z.string().nullable().default(null).describe('Related task ID for context'),
    }),
    execute: async ({ content, toAgent, taskId }) => {
      const msg = board.postMessage(agentId, content, {
        toAgent: toAgent ?? undefined,
        taskId: taskId ?? undefined,
      });
      return { success: true, messageId: msg.id };
    },
  });

  const readMessages = tool({
    description: 'Read messages from the board. See what other agents are saying — coordination messages, file conflicts, status updates. Call this periodically to stay in sync.',
    inputSchema: z.object({
      sinceTimestamp: z.number().default(0).describe('Only messages after this timestamp (0 = all)'),
      limit: z.number().default(20).describe('Max messages to return'),
    }),
    execute: async ({ sinceTimestamp, limit }) => {
      const msgs = board.readMessages({
        forAgent: agentId,
        sinceTimestamp: sinceTimestamp > 0 ? sinceTimestamp : undefined,
        limit,
      });
      return {
        messages: msgs.map(m => ({
          id: m.id,
          from: m.fromAgent,
          to: m.toAgent,
          content: m.content,
          taskId: m.taskId,
          timestamp: m.timestamp,
        })),
        count: msgs.length,
      };
    },
  });

  const addTask = tool({
    description: 'Dynamically add a new task to the board. Use this when you discover work that needs to be done but is not in the original plan — e.g., a shared utility, a missing type definition, or a test file.',
    inputSchema: z.object({
      id: z.string().describe('Unique task ID (use a descriptive slug, e.g., "shared-types-util")'),
      title: z.string().max(80).describe('Short task title'),
      description: z.string().max(200).describe('What needs to be done'),
      category: z.string().describe('Category (e.g., "API & Server", "Testing")'),
      phase: z.number().describe('Phase number (lower = earlier)'),
      priority: z.enum(['must', 'should', 'could']).describe('Priority level'),
      dependsOn: z.array(z.string()).default([]).describe('Task IDs this depends on'),
    }),
    execute: async ({ id, title, description, category, phase, priority, dependsOn }) => {
      // Check for duplicate
      if (board.getTask(id)) {
        return { success: false, error: `Task "${id}" already exists` };
      }
      const task = board.addTask(agentId, { id, title, description, category, phase, priority, dependsOn });
      return {
        success: true,
        task: { id: task.id, title: task.title, status: task.status },
      };
    },
  });

  const requestHumanHelp = tool({
    description: 'Send a notification to the human user requesting help or intervention. Use this when you are blocked, need a decision, or discovered something the user must know about. The notification will appear in both CLI and desktop app with a bell/alert.',
    inputSchema: z.object({
      severity: z.enum(['info', 'warning', 'critical']).describe('How urgent: info=FYI, warning=needs attention soon, critical=blocked and cannot continue'),
      title: z.string().max(100).describe('Short summary of what you need'),
      detail: z.string().max(500).describe('Full details — what you found, what you need, options you see'),
      actionRequired: z.boolean().default(true).describe('Whether you need the user to respond before you can continue'),
    }),
    execute: async ({ severity, title, detail, actionRequired }) => {
      // Post to board as a message too so other agents can see it
      board.postMessage(agentId, `[HELP NEEDED] ${title}: ${detail}`, { toAgent: undefined, taskId: undefined });

      // Fire the callback to push notification to SessionManager → EventBus → UI
      if (options?.onHumanHelpRequest) {
        options.onHumanHelpRequest({ agentId, severity, title, detail, actionRequired });
      }

      return {
        success: true,
        message: 'Notification sent to user. Continue with other work if possible, or wait for their response.',
        notification: { agentId, severity, title, detail, actionRequired },
      };
    },
  });

  return {
    getBoard,
    claimTask,
    claimNextTask,
    completeTask,
    failTask,
    postMessage,
    readMessages,
    addTask,
    requestHumanHelp,
  };
}
