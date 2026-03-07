import * as p from '@clack/prompts';
import { getStore } from '../../server/store.ts';

export async function logsCommand(sessionId?: string): Promise<void> {
  const store = getStore();

  let targetId = sessionId;

  if (!targetId) {
    // Try to find the most recent session
    const sessions = store.listSessions(1);
    if (sessions.length === 0) {
      p.log.info('No sessions found.');
      return;
    }
    targetId = sessions[0]!.id;
  }

  const session = store.getSession(targetId);
  if (!session) {
    p.log.error(`Session ${targetId} not found.`);
    return;
  }

  const logs = store.getLogs(targetId, 0, 200);

  if (logs.length === 0) {
    p.log.info(`No logs for session ${targetId.slice(0, 8)}.`);
    return;
  }

  const lines = logs.map((entry) => {
    const time = entry.timestamp.slice(11, 19);
    return `${time}  [${entry.source.padEnd(10)}]  ${entry.message}`;
  });

  p.note(lines.join('\n'), `Logs — Session ${targetId.slice(0, 8)} (${session.idea.slice(0, 50)})`);

  // Also show the latest plan summary if available
  const plan = store.getLatestPlan(targetId);
  if (plan) {
    p.note(
      plan.plan.executiveSummary.slice(0, 500) + (plan.plan.executiveSummary.length > 500 ? '...' : ''),
      `Latest Plan (Round ${plan.round})`,
    );
  }
}
