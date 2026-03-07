# ForgeCouncil

A multi-agent engineering council that transforms vague ideas into production-ready plans through structured deliberation. Built on Bun + Mastra with a team of 12 specialized AI agents.

## What It Does

Give ForgeCouncil a vague idea like "Build a collaborative markdown editor" and it will:

1. **Plan** — Ford (executor) creates a comprehensive engineering plan
2. **Review** — 11 council members review in parallel, each from their specialized perspective
3. **Score** — Each agent scores dimensions relevant to their expertise (weighted average)
4. **Iterate** — If mean score < 7.5, Ford revises based on anonymized feedback
5. **Ship** — Fresh Eyes validator does a final pass with zero debate context

The loop runs max 3 times or until threshold is met.

## The Team

| Agent | Codename | Role | Specialty |
|-------|----------|------|-----------|
| executor | **Ford** | Assembly Master | Orchestrates, synthesizes, writes code |
| architect | **Torvalds** | System Architect | Design, scalability, simplicity |
| coder | **Carmack** | Implementation Quality | Code quality, performance, type safety |
| reviewer | **Guido** | Readability & Consistency | Naming, docs, subtle bugs |
| spec-agent | **Fowler** | Requirements & Spec Writer | Clarity, completeness, testability |
| planner | **Doshi** | Project Manager | MVP scope, timeline, dependencies |
| designer | **Jobs** | UX/UI Designer | User experience, journey, interface |
| researcher | **Scott** | Technology Researcher | Tech fit, tool maturity, ecosystem |
| qa | **Whittaker** | QA Engineer | Testability, edge cases, chaos readiness |
| security | **Schneier** | Security Engineer | Auth, data protection, defense in depth |
| integrator | **Tesla** | Infrastructure | Deployment, CI/CD, automation |
| docs | **Knuth** | Documentation | API docs, README, developer experience |
| scout | **Scout** | Requirements Clarifier | Interviews users to clarify vague requirements |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Ralph Loop (max 3)                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐          │
│   │ CLARIFY  │────▶│   PLAN   │────▶│  REVIEW  │          │
│   │ (Scout)  │     │  (Ford)  │     │ (Council)│          │
│   └──────────┘     └──────────┘     └──────────┘          │
│        │                │                │                 │
│        │                │                │                 │
│        ▼                ▼                ▼                 │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐        │
│   │  Score   │     │  Score   │     │  Score   │        │
│   │  ≥7.5?   │     │  ≥7.5?   │     │  ≥7.5?   │        │
│   └────┬─────┘     └────┬─────┘     └────┬─────┘        │
│        │                │                │                 │
│        ▼                ▼                ▼                 │
│   ┌──────────────────────────────────────────┐            │
│   │             FRESH EYES                    │            │
│   │  (Zero context independent validation)   │            │
│   └──────────────────────────────────────────┘            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Principles

- **Anonymized scoring** — Agents see aggregated feedback, not who said what (prevents conformity)
- **Stagnation detection** — Stops if scores oscillate or plateau
- **Git-as-memory** — Executor commits per micro-task with semantic messages
- **Per-agent context scoping** — Security agent sees auth code; designer sees UI files
- **Compaction mode** — Context auto-compresses at 80% token threshold

## Current Status

- **Agents**: 13 (all implemented)
- **Providers**: Anthropic, OpenAI, OpenRouter, GitHub Copilot
- **Models**: 38+ built-in across providers
- **Tests**: 71 passing

## Install

```bash
bun install
```

## Quick Start

### Interactive mode (recommended)

```bash
bun run src/index.ts
# or
bun run interactive
```

### Direct idea

```bash
bun run src/index.ts "Build a secure internal docs portal"
```

## Configuration

### Config locations

- Global: `~/.forgecouncil/config.json`
- Project: `./.forgecouncil/config.json`

Project config merges with global; project values take precedence.

### Config commands

```bash
bun run config:init    # create missing config files
bun run config:setup   # interactive setup wizard
bun run config:show    # print resolved config
bun run config:where   # show config file paths
```

### Model selection

Each agent resolves models from:
1. `agents.overrides.<agentId>.model.primary` → specific agent override
2. `agents.defaults.model.primary` → default for all agents

Format: `provider/modelId` (e.g., `anthropic/claude-opus-4-6`)

Fallback chains supported.

## CLI Commands

```bash
# Run a session
bun run src/index.ts "Build a todo app"

# Resume previous session
bun run resume
bun run src/index.ts resume [session-id]

# View status
bun run status
bun run sessions
bun run logs

# List council agents
bun run council

# Inject guidance mid-session
bun run steer "focus more on security"

# Configuration
bun run config init
bun run config setup
bun run config show
bun run config where
```

## Environment Variables

Set via config (`$VAR_NAME` syntax) or environment:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export OPENROUTER_API_KEY="sk-or-..."
export GITHUB_TOKEN="ghp_..."
```

## Development

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Both
bun run check
```

### Test coverage

```bash
# Council logic
src/council/scorer.test.ts         # Weighted scoring
src/council/anonymizer.test.ts     # Identity stripping
src/council/stagnation.test.ts     # Oscillation detection
src/council/schemas.test.ts        # Zod validation

# Config
src/config/loader.test.ts          # Config loading/merging
src/council/agent-registry.test.ts # Agent model resolution

# Tools
src/mastra/tools/git-tools.test.ts # Git operations

# Context
src/context/manager.test.ts       # Context compaction
```

## Project Structure

```
forge-council/
├── src/
│   ├── cli/                    # CLI entry + commands
│   │   ├── commands/           # forge, steer, status, etc.
│   │   └── index.ts            # Citty command tree
│   │
│   ├── council/                # Core council logic
│   │   ├── agent-registry.ts   # 12 agent definitions
│   │   ├── parallel-review.ts   # Fan-out to agents
│   │   ├── scorer.ts           # Weighted scoring
│   │   ├── anonymizer.ts       # Strip agent identity
│   │   ├── stagnation.ts       # Oscillation detection
│   │   ├── fresh-eyes.ts       # Independent validation
│   │   └── schemas.ts          # Zod schemas
│   │
│   ├── config/                 # Configuration system
│   │   ├── schema.ts           # Zod config schema
│   │   ├── loader.ts           # Config loading/merging
│   │   ├── resolver.ts         # Model resolution
│   │   └── defaults.ts         # Default config
│   │
│   ├── context/                # Context management
│   │   └── manager.ts          # Token tracking, compaction
│   │
│   ├── mastra/                 # Mastra integration
│   │   ├── index.ts            # Agent registry export
│   │   ├── tools/              # Git tools for agents
│   │   └── workflows/          # Ralph loop workflow
│   │
│   └── server/                 # HTTP + WebSocket
│       ├── index.ts            # Hono server
│       ├── routes/             # API + WS handlers
│       ├── session.ts          # Session management
│       └── store.ts            # SQLite persistence
│
├── .forgecouncil/              # Project config (gitignored)
└── package.json
```

## Key Files for Understanding

| File | Purpose |
|------|---------|
| `src/council/agent-registry.ts` | All 12 agent definitions with personas, scoring dimensions |
| `src/mastra/workflows/ralph-loop.ts` | Main orchestration loop |
| `src/council/scorer.ts` | Weighted score calculation |
| `src/council/stagnation.ts` | Oscillation/plateau detection |
| `src/config/schema.ts` | Complete config Zod schema |
| `src/context/manager.ts` | Per-agent context scoping + compaction |

## Design Decisions

1. **Mastra over raw Vercel AI SDK** — Supervisor pattern, workflows, memory, evals built-in
2. **Git as memory bus** — Commits per micro-task; agents read git log for context
3. **Anonymized peer review** — Prevents conformity; Wu et al. 2025 research
4. **Max 3 rounds** — NeurIPS 2025: accuracy drops after 3 iterations
5. **Fresh Eyes validation** — Catches groupthink from debating agents
6. **Per-agent context scopes** — Security sees auth code; designer sees UI files

## Future Work

- [ ] Integrate git-tools into ralph-loop for auto-commit
- [ ] Hook up context manager to agents
- [ ] Desktop UI with electrobun
- [ ] Persona marketplace (YAML configs)
- [ ] Eval framework for measuring council quality



## Tools System

ForgeCouncil agents have hands, not just opinions. Each agent gets tools matching their expertise:

### Tool Categories

| Category | Tools | Description |
|----------|-------|-------------|
| Code Execution | run-shell, run-code, run-tests, lint-code, type-check | Execute and validate code |
| File System | read-file, write-file, edit-file, list-dir, search-files, delete-file | File operations with path traversal protection |
| Git | git-commit, git-log, git-diff, git-branch, git-stash | Source control operations |
| Web | web-fetch, web-search, fetch-docs | External API and documentation access |
| Analysis | dependency-audit, secrets-scan, code-complexity, test-coverage | Security and quality analysis |
| Infrastructure | docker, env-manager, package-manager, port-check | DevOps and deployment |
| Codebase | codebase-index, find-symbol, analyze-imports | Code intelligence |

### Permission Model

| Level | Access | Agents |
|-------|--------|--------|
| READ_ONLY | Read files, run analysis | reviewer, security, scout |
| READ_WRITE | Read + write + execute | coder, qa, integrator |
| ADMIN | Full access including delete | executor (Ford) |

### Agent Tool Access

| Agent | Permission | Example Tools |
|-------|------------|---------------|
| Ford | ADMIN | All 30 tools |
| Carmack | READ_WRITE | run-code, git-commit, write-file |
| Schneier | READ_ONLY | secrets-scan, dependency-audit |
| Scout | READ_ONLY | web-search, codebase-index |

### Tool Examples

```bash
# Scout interviews users before planning
web-search "best practices for markdown editors"
codebase-index "src/**/*.ts"

# Ford executes the plan
run-code "bun build"
git-commit -m "feat: implement collaborative editing"
write-file "docs/api.md" "# API Documentation"

# Security audits the result
secrets-scan "src/"
dependency-audit --production

# QA validates implementation
run-tests --coverage
code-complexity --max-lines 100
```
