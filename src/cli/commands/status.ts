import * as p from '@clack/prompts';
import { SessionManager } from '../../server/session.ts';

export async function statusCommand(): Promise<void> {
  const session = await SessionManager.load();

  if (!session) {
    p.log.info('No active session.');
    return;
  }

  const lines = [
    `ID:      ${session.id}`,
    `Idea:    ${session.idea}`,
    `Status:  ${session.status}`,
    `Round:   ${session.currentRound}`,
    `Port:    ${session.port}`,
    `PID:     ${session.pid}`,
    `Agents:  ${session.activeAgents.length > 0 ? session.activeAgents.join(', ') : 'None active'}`,
  ];

  if (session.scores.length > 0) {
    lines.push(``, `Scores:`);
    for (const score of session.scores) {
      lines.push(`  Round ${score.round}: mean=${score.mean.toFixed(2)}`);
      for (const [agent, value] of Object.entries(score.agents)) {
        lines.push(`    ${agent}: ${value.toFixed(2)}`);
      }
    }
  }

  if (session.guidance && session.guidance.length > 0) {
    lines.push(``, `Guidance:`);
    for (const g of session.guidance) {
      lines.push(`  - ${g}`);
    }
  }

  p.note(lines.join('\n'), 'Session Status');
}
