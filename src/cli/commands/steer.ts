import * as p from '@clack/prompts';
import { SessionManager } from '../../server/session.ts';
import { exitWithError } from '../../errors/exit.ts';

export async function steerCommand(guidance: string): Promise<void> {
  const session = await SessionManager.load();

  if (!session) {
    exitWithError('steer', new Error('No active session. Run `forge` to start one.'));
  }

  if (session.status !== 'running') {
    exitWithError('steer', new Error(`Session is not running (status: ${session.status}).`), {
      sessionId: session.id,
      status: session.status,
    });
  }

  const s = p.spinner();
  s.start('Sending guidance...');

  try {
    const response = await fetch(`http://localhost:${session.port}/api/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guidance }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      throw new Error(`Server responded with ${response.status}: ${errorBody}`);
    }

    s.stop('Guidance submitted.');
    p.log.success(`"${guidance}"`);
  } catch (error) {
    s.stop('Failed.');
    exitWithError('steer.request', error, {
      sessionId: session.id,
      port: session.port,
      guidance,
    });
  }
}
