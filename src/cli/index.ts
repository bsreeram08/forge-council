// Suppress AI SDK warnings about unsupported features (e.g. structuredOutputs via copilot)
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

import { defineCommand, runMain } from "citty";
import * as p from "@clack/prompts";
import { forgeCommand, resumeCommand } from "./commands/forge.ts";
import type { ForgeOptions } from "./commands/forge.ts";
import { AGENT_DEFS } from "../council/agent-registry.ts";
import { statusCommand } from "./commands/status.ts";
import { steerCommand } from "./commands/steer.ts";
import { logsCommand } from "./commands/logs.ts";
import {
  configInitCommand,
  configShowCommand,
  configWhereCommand,
} from "./commands/config.ts";
import { councilCommand } from "./commands/council.ts";
import { setupCommand } from "./commands/setup.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { historyCommand } from "./commands/history.ts";

const LOGO = `
  ╔════════════════════════════════════════╗
  ║         F O R G E C O U N C I L        ║
  ║                                        ║
  ║   Idea → Plan → Code → Review → Ship   ║
  ╚════════════════════════════════════════╝
`;

function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

async function interactiveMode() {
  clearScreen();
  console.log(LOGO);

  p.intro("ForgeCouncil v0.4.0 — Idea in → working code out");

  const action = await p.select({
    message: "What would you like to do?",
    options: [
      {
        value: "run",
        label: "New session — start building",
        hint: "idea → plan → code → ship",
      },
      {
        value: "resume",
        label: "Resume a previous session",
        hint: "continue where you left off",
      },
      {
        value: "sessions",
        label: "View session history",
        hint: "list past sessions",
      },
      { value: "history", label: "Git history", hint: "view recent commits" },
      {
        value: "setup",
        label: "Setup agents & config",
        hint: "configure models, agents, providers",
      },
      {
        value: "status",
        label: "View session status",
        hint: "check the current session",
      },
      {
        value: "steer",
        label: "Steer active session",
        hint: "inject guidance mid-loop",
      },
      {
        value: "council",
        label: "List council agents",
        hint: "see available agents",
      },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel("Cancelled.");
    return;
  }

  switch (action) {
    case "run": {
      // Mode selection
      const mode = await p.select({
        message: "Select a mode:",
        options: [
          {
            value: "default",
            label: "🚀 Default Ship",
            hint: "3 planners, targeted review — fast",
          },
          {
            value: "council",
            label: "🏛️  Council Deep Review",
            hint: "all agents plan — thorough",
          },
          {
            value: "custom",
            label: "🎯 Custom Agents",
            hint: "pick specific agents",
          },
        ],
      });

      if (p.isCancel(mode)) {
        p.cancel("Cancelled.");
        return;
      }

      const idea = await p.text({
        message: "What do you want to build?",
        placeholder: 'e.g. "A real-time collaborative markdown editor"',
      });

      if (p.isCancel(idea)) {
        p.cancel("Cancelled.");
        return;
      }

      const forgeOptions: ForgeOptions = { mode: mode as ForgeOptions["mode"] };

      if (mode === "custom") {
        // Group agents by role for organized display
        const agentGroups = [
          { label: "Planning", ids: ["architect", "planner", "researcher"] },
          {
            label: "Review",
            ids: ["reviewer", "security", "qa", "integrator", "designer"],
          },
          { label: "On-demand", ids: ["spec-agent", "docs"] },
        ];

        const agentOptions: Array<{
          value: string;
          label: string;
          hint: string;
        }> = [];
        for (const group of agentGroups) {
          for (const id of group.ids) {
            const def = AGENT_DEFS.find((d) => d.id === id);
            if (!def) continue;
            agentOptions.push({
              value: id,
              label: `${def.name} — ${def.role}`,
              hint: group.label,
            });
          }
        }

        const agents = await p.multiselect({
          message: "Select agents (core agents always active):",
          options: agentOptions,
          initialValues: ["architect", "planner", "researcher"],
          required: true,
        });

        if (p.isCancel(agents)) {
          p.cancel("Cancelled.");
          return;
        }

        forgeOptions.agents = agents;
      }

      await forgeCommand(idea, forgeOptions);
      break;
    }
    case "resume":
      await resumeCommand();
      break;
    case "sessions":
      await sessionsCommand();
      break;
    case "history":
      await historyCommand();
      break;
    case "setup":
      await setupCommand();
      break;
    case "status":
      await statusCommand();
      break;
    case "steer": {
      const guidance = await p.text({
        message: "Enter guidance for the council:",
        placeholder:
          'e.g. "Focus on security, use OAuth instead of email/password"',
      });

      if (p.isCancel(guidance)) {
        p.cancel("Cancelled.");
        return;
      }

      await steerCommand(guidance);
      break;
    }
    case "council":
      await councilCommand();
      break;
  }

  p.outro("Done.");
}

const main = defineCommand({
  meta: {
    name: "forge",
    version: "0.4.0",
    description: "ForgeCouncil — Idea in → working code out",
  },
  subCommands: {
    status: defineCommand({
      meta: { description: "Show current session status" },
      run: () => statusCommand(),
    }),
    steer: defineCommand({
      meta: { description: "Inject guidance into the running session" },
      args: {
        guidance: {
          type: "positional",
          description: "Guidance text",
          required: true,
        },
      },
      run: ({ args }) => steerCommand(String(args.guidance)),
    }),
    logs: defineCommand({
      meta: { description: "View session logs" },
      args: {
        session: {
          type: "positional",
          description: "Session ID (optional, defaults to latest)",
          required: false,
        },
      },
      run: ({ args }) =>
        logsCommand(args.session ? String(args.session) : undefined),
    }),
    sessions: defineCommand({
      meta: { description: "List past sessions" },
      run: () => sessionsCommand(),
    }),
    resume: defineCommand({
      meta: { description: "Resume a previous session" },
      args: {
        session: {
          type: "positional",
          description: "Session ID (optional, shows picker if omitted)",
          required: false,
        },
      },
      run: ({ args }) =>
        resumeCommand(args.session ? String(args.session) : undefined),
    }),
    config: defineCommand({
      meta: { description: "Configuration commands" },
      subCommands: {
        init: defineCommand({
          meta: { description: "Initialize config files (global + project)" },
          run: () => configInitCommand(),
        }),
        setup: defineCommand({
          meta: {
            description:
              "Interactive setup wizard for providers, models, and agents",
          },
          run: () => setupCommand(),
        }),
        show: defineCommand({
          meta: { description: "Show resolved runtime config (redacted)" },
          run: () => configShowCommand(),
        }),
        where: defineCommand({
          meta: { description: "Show config file locations and existence" },
          run: () => configWhereCommand(),
        }),
      },
      run: () => {
        p.log.info("Usage: forge config <init|setup|show|where>");
      },
    }),
    council: defineCommand({
      meta: { description: "List available council agents" },
      run: () => councilCommand(),
    }),
    history: defineCommand({
      meta: { description: "Show git commit history" },
      args: {
        count: {
          type: "positional",
          description: "Number of commits to show (default: 20)",
          required: false,
        },
      },
      run: ({ args }) =>
        historyCommand(args.count ? Number(args.count) : undefined),
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
    const subCommands = [
      "status",
      "steer",
      "logs",
      "sessions",
      "resume",
      "config",
      "council",
      "setup",
      "history",
      "run",
    ];

    if (!subCommands.includes(firstArg)) {
      // Treat as direct idea invocation: forge "idea here"
      const idea = rawArgs.join(" ");
      return forgeCommand(idea);
    }
  },
});

export function runCLI(): void {
  runMain(main);
}
