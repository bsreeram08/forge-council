import * as p from '@clack/prompts';
import { loadConfig } from '../../config/loader.ts';
import { sessionManager } from '../../server/session.ts';
import { createServer, startServer } from '../../server/index.ts';
import { getStore } from '../../server/store.ts';
import { exitWithError, handleError } from '../../errors/exit.ts';
import { runWorkflow } from '../../core/workflow.ts';

/** Options for the `forge` command. */
export interface ForgeOptions {
  /** Planning mode: 'default' (3 planners), 'council' (all agents), or 'custom' (user-selected). */
  mode?: 'default' | 'council' | 'custom';
  /** Agent IDs to use when mode is 'custom' (e.g. ['architect', 'security', 'coder']). */
  agents?: string[];
}

export async function forgeCommand(idea: string, options?: ForgeOptions): Promise<void> {
  const s = p.spinner();

  s.start('Loading configuration...');
  const config = await loadConfig();
  s.stop('Configuration loaded.');

  const mode = options?.mode ?? 'default';
  const modeLabel = mode === 'council' ? '🏛️  Council (deep review)'
    : mode === 'custom' ? '🎯 Custom'
    : '🚀 Default (ship fast)';
  p.log.info(`Mode: ${modeLabel}`);

  // Create and start the server
  const app = createServer(sessionManager);
  const { port: actualPort } = startServer(app, 0);
  if (!actualPort) {
    exitWithError('forge.server', new Error('Failed to bind to any available port'), { idea });
  }

  // Create session
  const session = sessionManager.create(
    idea, actualPort,
    config.council.maxRounds,
    config.council.scoreThreshold,
    JSON.stringify(config),
  );
  await sessionManager.save();

  p.log.info(`Session ${session.id.slice(0, 8)}`);
  p.log.info(`Status page: http://localhost:${actualPort}`);
  p.note(idea, 'Idea');

  try {
    const result = await runWorkflow({
      idea,
      config,
      mode,
      customAgentIds: options?.agents,
    });

    sessionManager.update({ status: 'completed' });
    await sessionManager.save();

    p.outro(`Done! ${result.codingOutputs?.length ?? 0} commits, ${result.reviews?.length ?? 0} reviews. Cost: ~$${result.tokenCounter.estimatedCost.toFixed(2)}`);
  } catch (error) {
    sessionManager.update({ status: 'failed' });
    await sessionManager.save();
    exitWithError('forge.workflow', error, { idea, sessionId: session.id });
  }
}

export async function resumeCommand(sessionId?: string): Promise<void> {
  const store = getStore();
  let targetId = sessionId;

  if (!targetId) {
    const resumable = store.getResumableSessions();
    if (resumable.length === 0) {
      p.log.info('No resumable sessions found.');
      return;
    }

    const selected = await p.select({
      message: 'Select a session to resume:',
      options: resumable.map((sess) => ({
        value: sess.id,
        label: `${sess.id.slice(0, 8)} — ${sess.idea.slice(0, 60)}`,
        hint: `${sess.status} | ${sess.started_at.slice(0, 10)}`,
      })),
    });

    if (p.isCancel(selected)) {
      p.cancel('Cancelled.');
      return;
    }
    targetId = selected;
  }

  const stored = store.getSession(targetId);
  if (!stored) {
    p.log.error(`Session ${targetId} not found.`);
    return;
  }

  let config;
  try {
    config = stored.config_snapshot !== '{}' ? JSON.parse(stored.config_snapshot) : await loadConfig();
  } catch (e) {
    handleError('resume.config-parse', e, { sessionId: targetId });
    config = await loadConfig();
  }

  // Start server
  const app = createServer(sessionManager);
  const { port: actualPort } = startServer(app, 0);
  if (!actualPort) {
    exitWithError('resume.server', new Error('Failed to bind to any available port'), { sessionId: targetId });
  }

  // Restore session
  const session = sessionManager.restore(targetId);
  if (!session) {
    p.log.error(`Failed to restore session ${targetId}.`);
    return;
  }

  sessionManager.update({ port: actualPort });
  await sessionManager.save();

  p.log.info(`Resumed session ${session.id.slice(0, 8)}`);
  p.log.info(`Status page: http://localhost:${actualPort}`);
  p.note(session.idea, 'Idea');

  try {
    const result = await runWorkflow({
      idea: session.idea,
      config,
    });

    sessionManager.update({ status: 'completed' });
    await sessionManager.save();

    p.outro(`Done! Cost: ~$${result.tokenCounter.estimatedCost.toFixed(2)}`);
  } catch (error) {
    sessionManager.update({ status: 'failed' });
    await sessionManager.save();
    exitWithError('resume.workflow', error, { sessionId: session.id });
  }
}
