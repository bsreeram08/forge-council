import * as p from '@clack/prompts';
import { getStore } from '../../server/store.ts';

export async function sessionsCommand(): Promise<void> {
  const store = getStore();
  const sessions = store.listSessions(20);

  if (sessions.length === 0) {
    p.log.info('No sessions found.');
    return;
  }

  const lines: string[] = [];

  for (const sess of sessions) {
    const status = sess.status.padEnd(9);
    const id = sess.id.slice(0, 8);
    const date = sess.started_at.slice(0, 10);
    const idea = sess.idea.length > 60 ? sess.idea.slice(0, 57) + '...' : sess.idea;
    const round = `R${sess.current_round}/${sess.max_rounds}`;

    lines.push(`${id}  ${status}  ${round.padEnd(5)}  ${date}  ${idea}`);
  }

  p.note(
    `${'ID'.padEnd(8)}  ${'Status'.padEnd(9)}  ${'Round'.padEnd(5)}  ${'Date'.padEnd(10)}  Idea\n` +
    `${'─'.repeat(8)}  ${'─'.repeat(9)}  ${'─'.repeat(5)}  ${'─'.repeat(10)}  ${'─'.repeat(40)}\n` +
    lines.join('\n'),
    `Sessions (${sessions.length})`,
  );
}
