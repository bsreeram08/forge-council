// Suppress AI SDK warnings about unsupported features (e.g. structuredOutputs via copilot)
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

import { defineCommand, runMain } from 'citty';
import * as p from '@clack/prompts';
import { forgeCommand, resumeCommand } from './commands/forge.ts';
import { statusCommand } from './commands/status.ts';
import { steerCommand } from './commands/steer.ts';
import { logsCommand } from './commands/logs.ts';
import { configInitCommand, configShowCommand, configWhereCommand } from './commands/config.ts';
import { councilCommand } from './commands/council.ts';
import { setupCommand } from './commands/setup.ts';
import { sessionsCommand } from './commands/sessions.ts';

const LOGO = `
       ___
      /   \\        ┌──────────────────────────────────────┐
     / === \\       │       F O R G E   C O U N C I L      │
    /  ___  \\      │                                      │
   /  /   \\  \\     │  Plan -> Review -> Iterate -> Ship   │
  /  / ___ \\  \\    └──────────────────────────────────────┘
 /__/_/   \\_\\__\\
  ||  o   o  ||    Multi-Agent Engineering Council
  ||  o   o  ||    13 agents. 3 rounds. 1 consensus.
  ||_________||
`;

function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

async function interactiveMode() {
  clearScreen();
  console.log(LOGO);

  p.intro('ForgeCouncil v0.1.0');

  const action = await p.select({
    message: 'What would you like to do?',
    options: [
      { value: 'run', label: 'Start a new council session', hint: 'deliberate on an idea' },
      { value: 'resume', label: 'Resume a previous session', hint: 'continue where you left off' },
      { value: 'sessions', label: 'View session history', hint: 'list past sessions' },
      { value: 'setup', label: 'Setup agents & config', hint: 'configure models, agents, providers' },
      { value: 'status', label: 'View session status', hint: 'check the current session' },
      { value: 'steer', label: 'Steer active session', hint: 'inject guidance mid-loop' },
      { value: 'council', label: 'List council agents', hint: 'see available agents' },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel('Cancelled.');
    return;
  }

  switch (action) {
    case 'run': {
      const idea = await p.text({
        message: 'What do you want to build?',
        placeholder: 'e.g. "A real-time collaborative markdown editor"',
      });

      if (p.isCancel(idea)) {
        p.cancel('Cancelled.');
        return;
      }

      await forgeCommand(idea);
      break;
    }
    case 'resume':
      await resumeCommand();
      break;
    case 'sessions':
      await sessionsCommand();
      break;
    case 'setup':
      await setupCommand();
      break;
    case 'status':
      await statusCommand();
      break;
    case 'steer': {
      const guidance = await p.text({
        message: 'Enter guidance for the council:',
        placeholder: 'e.g. "Focus on security, use OAuth instead of email/password"',
      });

      if (p.isCancel(guidance)) {
        p.cancel('Cancelled.');
        return;
      }

      await steerCommand(guidance);
      break;
    }
    case 'council':
      await councilCommand();
      break;
  }

  p.outro('Done.');
}

const main = defineCommand({
  meta: {
    name: 'forge',
    version: '0.1.0',
    description: 'ForgeCouncil — multi-agent engineering council',
  },
  subCommands: {
    status: defineCommand({
      meta: { description: 'Show current session status' },
      run: () => statusCommand(),
    }),
    steer: defineCommand({
      meta: { description: 'Inject guidance into the running session' },
      args: {
        guidance: {
          type: 'positional',
          description: 'Guidance text',
          required: true,
        },
      },
      run: ({ args }) => steerCommand(String(args.guidance)),
    }),
    logs: defineCommand({
      meta: { description: 'View session logs' },
      args: {
        session: {
          type: 'positional',
          description: 'Session ID (optional, defaults to latest)',
          required: false,
        },
      },
      run: ({ args }) => logsCommand(args.session ? String(args.session) : undefined),
    }),
    sessions: defineCommand({
      meta: { description: 'List past sessions' },
      run: () => sessionsCommand(),
    }),
    resume: defineCommand({
      meta: { description: 'Resume a previous session' },
      args: {
        session: {
          type: 'positional',
          description: 'Session ID (optional, shows picker if omitted)',
          required: false,
        },
      },
      run: ({ args }) => resumeCommand(args.session ? String(args.session) : undefined),
    }),
    config: defineCommand({
      meta: { description: 'Configuration commands' },
      subCommands: {
        init: defineCommand({
          meta: { description: 'Initialize config files (global + project)' },
          run: () => configInitCommand(),
        }),
        setup: defineCommand({
          meta: { description: 'Interactive setup wizard for providers, models, and agents' },
          run: () => setupCommand(),
        }),
        show: defineCommand({
          meta: { description: 'Show resolved runtime config (redacted)' },
          run: () => configShowCommand(),
        }),
        where: defineCommand({
          meta: { description: 'Show config file locations and existence' },
          run: () => configWhereCommand(),
        }),
      },
      run: () => {
        p.log.info('Usage: forge config <init|setup|show|where>');
      },
    }),
    council: defineCommand({
      meta: { description: 'List available council agents' },
      run: () => councilCommand(),
    }),
    setup: defineCommand({
      meta: { description: 'Alias for "forge config setup"' },
      run: () => setupCommand(),
    }),
  },
  run({ rawArgs }) {
    if (rawArgs.length === 0) {
      return interactiveMode();
    }

    // Check if first argument is a subcommand
    const firstArg = rawArgs[0]!;
    const subCommands = ['status', 'steer', 'logs', 'sessions', 'resume', 'config', 'council', 'setup', 'run'];

    if (!subCommands.includes(firstArg)) {
      // Treat as direct idea invocation: forge "idea here"
      const idea = rawArgs.join(' ');
      return forgeCommand(idea);
    }
  },
});

export function runCLI(): void {
  runMain(main);
}
