import * as p from '@clack/prompts';

export async function historyCommand(count?: number): Promise<void> {
  const limit = count ?? 20;

  try {
    const proc = Bun.spawn(
      ['git', 'log', `--max-count=${limit}`, '--format=%h %s (%cr)', '--no-color'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      p.log.error('Not in a git repository or git is not available.');
      return;
    }

    const lines = output.trim().split('\n').filter(Boolean);

    if (lines.length === 0) {
      p.log.info('No commits found.');
      return;
    }

    // Format commits with icons based on conventional commit type
    // Git format is: <hash> <subject> (<relative date>)
    const commitTypePattern = /^[a-f0-9]+ (?:\[[\w-]+\] )?(\w+):/;
    const formatted = lines.map(line => {
      const match = line.match(commitTypePattern);
      const type = match?.[1];
      const icon = type === 'feat' ? '✨'
        : type === 'fix' ? '🔧'
        : type === 'test' ? '🧪'
        : type === 'doc' || type === 'docs' ? '📚'
        : type === 'refactor' ? '♻️'
        : type === 'plan' ? '📋'
        : line.includes('[coder]') ? '💻'
        : line.includes('[executor]') ? '🏗️'
        : '•';
      return `  ${icon} ${line}`;
    }).join('\n');

    p.note(formatted, `Git History (${lines.length} commits)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(`Failed to read git history: ${msg}`);
  }
}
