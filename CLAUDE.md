# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

ForgeCouncil turns a vague idea into working code. 3 AI agents draft a plan, the user picks what to build, an AI coder writes it, targeted reviewers check the code, the user ships.

```
Idea → [3 agents plan] → [User picks] → [Code] → [Review CODE] → [Fix] → Ship
```

**Not** a debate club. A tool that writes code.

**Stack**: Bun + TypeScript (strict) + Mastra (on Vercel AI SDK) + Hono + Zod v4 + citty + @clack/prompts

## Commands

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test src/<path>      # Run a single test file
bun run typecheck        # Type check (tsc --noEmit)
bun run check            # Alias for typecheck
bun run dev              # Run the CLI
```

## Architecture

### The Flow: Plan → Pick → Code → Review → Fix → Ship

1. **PLAN** — 3 agents (Torvalds/architect, Doshi/planner, Scott/researcher) plan in parallel. Ford merges into a categorized plan with must/should/could priorities. User picks items via checkboxes. Optional Pass 2 refines with 2/3 consensus rule.
2. **CODE** — Carmack (coder) writes code file by file, runs tests, git commits per item. User can pause/redirect/skip/ship at any time.
3. **REVIEW** — Ford auto-picks 2-3 reviewers based on what was built (auth code → Schneier, tests → Whittaker, etc). Schema-only output: score + verdict + issues. User picks which fixes to apply.
4. **FIX** — Carmack fixes selected issues, commits.
5. **SHIP** — Working code in git with full commit history.

### Prompt Architecture (4-Layer Pipeline)

Every agent call goes through the same layered prompt assembly. Only Layer 1 content differs per persona.

- **Layer 1 (General)**: System prompt + skills (first-class) + persona config (static per agent)
- **Layer 2 (Intent)**: User idea + intent classification + phase context + user guidance
- **Layer 3 (Supporting Context)**: Code files via QMD semantic search or glob fallback. In RLM mode: context handle metadata instead of inline content.
- **Layer 4 (Plan)**: Only on planning Pass 2 — adds the merged plan + all Pass 1 contributions. 2/3 agreement required to add/remove items.

The **intent classifier** is a cheap fast model call (~200 tokens) that runs before any agent call. Returns structured data: taskType, domains, filePatterns to load, complexity estimate.

### Skills System

Skills are first-class entities (not just string labels). A Skill = tool bundle + prompt template + domain knowledge + activation conditions. Agents reference skills by ID. Skills can be shared across agents and auto-activate based on intent classification.

- **Built-in skills** (12): system-design, project-planning, tech-research, implementation, code-review, security-audit, testing, infrastructure, ux-design, documentation, context-search, recursive-analysis
- **Custom skills**: `~/.forgecouncil/skills/*.json` (global) + `.forgecouncil/skills/*.json` (project)
- **Prompt injection**: Layer 1 now injects full skill context (description + prompt template + knowledge base), not just skill names
- **Auto-activation**: Skills can auto-activate based on intent classification domains (e.g., security-audit activates when auth/payments domains detected)

### QMD Integration (Semantic Search)

QMD (`@tobilu/qmd`) provides on-device BM25 + vector + LLM reranking search. It serves as the primary context source for the context assembler.

- **Smart assembly**: `assembleContextSmart()` uses QMD when available, falls back to glob-based file loading
- **Agent tools**: `searchCodebase`, `searchDocs`, `getFileContext` — available to all agents when QMD is ready
- **Config**: `qmd` section in config — enabled, storePath, indexOnStart, excludePatterns, collections, minScore

### RLM (Recursive Language Models)

Based on the paper "Recursive Language Models" (arXiv 2512.24601v2). For large codebases that exceed context windows:

- **Context handles**: Large context stored externally, agents receive only metadata (summary, structure, token count)
- **Examination tools**: peekContext, searchContext, readChunk, decomposeContext — agents explore context on demand
- **Sub-agent spawning**: Agents can recursively call sub-agents on context chunks via `spawnSubAgent`
- **Auto-activation**: When assembled context exceeds `rlm.contextThreshold` (default 50K tokens), RLM mode activates
- **Safety guards**: Max recursion depth (3), max sub-agent calls (10), sub-agent token budget fraction
- **Config**: `rlm` section — enabled, contextThreshold, maxDepth, maxSubAgentCalls, subAgentBudgetFraction

### Agent Roster

**Planning (default 3)**: Torvalds (architect, Opus), Doshi (planner, Sonnet), Scott (researcher, Opus)
**Executor + Coder**: Ford (executor/merger, Opus), Carmack (writes all code, Opus)
**Review (Ford picks 2-3)**: Guido (code quality), Schneier (security), Whittaker (QA), Tesla (infra), Jobs (UX)
**On-demand**: Fowler (specs), Knuth (docs at ship time)

### Modes

- **Default "Ship"** — 3 planning agents, targeted review. Fast, ~$4-5/run.
- **Council `--council`** — All agents participate. ~$10-15/run. For critical decisions.
- **Custom `--agents architect,security,coder`** — User picks agents.

### Pipeline Engine (Configurable Phases)

The workflow is driven by a **configurable pipeline** — an ordered array of phases, each declaring which agents participate, whether they run in parallel, and under what conditions. The default pipeline is the Ralph Loop, but projects can override it entirely.

```
Pipeline = Phase[] + Loop[]

Phase { id, name, handler, agents[], parallel, condition, dynamicAgents }
Loop  { startPhase, endPhase, maxRounds, exitWhen[] }
```

**Phase handlers** are registered in a global registry. Built-in: classify, plan, merge, pick, code, review, fix, ship, clarify, fresh-eyes. Custom handlers can be registered for project-specific phases.

**Phase conditions**: `always`, `has-issues`, `score-below`, `input-vague`, `user-approved`, `files-changed`.

**Exit conditions**: `score-threshold`, `no-issues`, `stagnation`, `max-rounds`.

Pipeline state is fully serializable for **resume from any phase**.

### Custom Agents

Agents can be defined in JSON config files:
- Global: `~/.forgecouncil/agents/*.json`
- Project: `.forgecouncil/agents/*.json`

Custom agents declare: id, codename, systemPrompt, skills, behavioralRules, model, temperature, phases (which pipeline phases they participate in), permission level, scoring dimensions, tool access.

Project-level `agent.md` (or `.forgecouncil/agent.md`) injects extra instructions into ALL agents for project-specific context.

### Edit Review (Accept/Reject Changes)

AI-generated file changes go through an edit review step where the user can:
- **Accept all** / **Reject all** — bulk actions
- **Per-file review** — see diff, accept or reject each file
- **Auto-accept** — small changes under a configured threshold
- Configure via `editReview` in config: `enabled`, `autoAcceptThreshold`, `groupBy`

### Key Design Rules

1. **Human authority** — No score, agent, or threshold blocks the user. The system informs, the user decides. User can force ship at any point.
2. **Schema-only output** — All agent output is Zod-validated structured data + code files. No prose, no explanations outside the schema.
3. **Agent tool exploration** — Agents use tools (readFile, listDir, searchFiles, etc.) to explore the codebase BEFORE producing output. Uses `generateText` with tools + a submit tool for structured output.
4. **2/3 consensus** — Pass 2 plan changes require 2 of 3 agents to agree. Contested items shown to user for manual decision.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/council/agent-registry.ts` | Agent definitions: id, persona, defaultModel, scoring dimensions, instructions |
| `src/mastra/workflows/ralph-loop.ts` | Main orchestration loop |
| `src/council/scorer.ts` | Weighted score calculation |
| `src/council/anonymizer.ts` | Strips agent identity from reviews |
| `src/council/stagnation.ts` | Oscillation/plateau detection |
| `src/council/parallel-review.ts` | Fan-out to agents with concurrency semaphore |
| `src/council/fresh-eyes.ts` | Independent validation with zero prior context |
| `src/council/schemas.ts` | Zod schemas for reviews, scores, plans |
| `src/config/schema.ts` | Zod config schema |
| `src/config/loader.ts` | Config loading/merging (global + project) |
| `src/config/resolver.ts` | Model resolution: provider/modelId → AI SDK instance |
| `src/context/manager.ts` | Per-agent context scoping + token-aware compaction |
| `src/mastra/tools/tool-registry.ts` | Tool definitions + per-agent access matrix |
| `src/mastra/tools/tool-guard.ts` | Permission enforcement, path traversal protection |
| `src/cli/index.ts` | CLI entry: citty commands + interactive menu |
| `src/core/pipeline.ts` | Pipeline engine: phase definitions, executor, conditions, loops, resume |
| `src/core/agent-loader.ts` | Custom agent loading from config files + agent.md injection |
| `src/core/agent-tools.ts` | AI SDK tool adapters for agent tool calling |
| `src/core/edit-review.ts` | Accept/reject AI file changes with diff display |
| `src/core/workflow.ts` | V4 workflow: generateText + tools pattern |
| `src/core/prompt-assembler.ts` | 4-layer prompt assembly (skill-aware, RLM-aware) |
| `src/core/intent-classifier.ts` | Intent classification with keyword fallback |
| `src/core/skill.ts` | Skill interface, SkillRegistry, composition |
| `src/core/builtin-skills.ts` | 12 built-in skills + agent→skill mapping |
| `src/core/skill-loader.ts` | Custom skill loading from config directories |
| `src/core/qmd-store.ts` | QMD SDK integration for semantic search |
| `src/core/qmd-tools.ts` | QMD-backed agent tools (searchCodebase, searchDocs) |
| `src/core/rlm/context-handle.ts` | Context handle abstraction + handle store |
| `src/core/rlm/rlm-tools.ts` | RLM examination tools (peek, search, read, decompose) |
| `src/core/rlm/sub-agent.ts` | Sub-agent spawning with safety guards |
| `src/core/rlm/index.ts` | RLM public API + shouldUseRlm + setupRlm |

## Config System

Two config locations merged (project overrides global):
- Global: `~/.forgecouncil/config.json`
- Project: `./.forgecouncil/config.json`

Model references: `provider/modelId` (e.g., `anthropic/claude-opus-4-6`). Resolution chain: agent override → agent defaults → fallback. Providers: Anthropic, OpenAI, OpenRouter, GitHub Copilot, custom OpenAI-compatible.

Personas are configurable via YAML (`personas/defaults/<agent>.yaml`) with: systemPrompt, skills, skillIds, behavioralRules, catchphrases, model, temperature, harshness.

Custom skills: `~/.forgecouncil/skills/*.json` (global) + `.forgecouncil/skills/*.json` (project). Fields: id, name, description, domains, tools, promptTemplate, knowledgeBase, priority.

## Tool System

29 built-in tools in `src/mastra/tools/` (filesystem, git, code-execution, web, analysis, infrastructure, codebase-intel) + MCP. Permission levels: READ_ONLY → READ_WRITE → ADMIN. Ford has ADMIN. Carmack/Whittaker/Tesla/Knuth have READ_WRITE. All others READ_ONLY. Tool guard enforces permissions + path traversal protection + dangerous command filtering.

## Output Schemas

All agent output uses Zod schemas with strict token limits:
- `PlanContributionSchema` — per-agent plan items (~500 tokens)
- `MergedPlanSchema` — Ford's merged plan with categories/priorities (~800 tokens)
- `PlanChangeSchema` — Pass 2 additions/removals (~300 tokens)
- `CodeReviewSchema` — score + verdict + issues array, max 10 issues (~300 tokens)
- `IntentClassification` — taskType, domains, contextNeeded, complexity (~200 tokens)

## Conventions

- Always use Bun (`bun install`, `bun test`, `bun run`)
- Tests use `bun:test` framework — colocated as `*.test.ts` next to source
- AI SDK v6: use `LanguageModel` type (union), `inputSchema:` (not `parameters:`), `stopWhen: stepCountIs(n)` (not `maxSteps`), `tc.input` (not `tc.args`), `maxOutputTokens` (not `maxTokens`)
- OpenAI strict schema: ALL properties must be `required` — use `.nullable().default(null)` instead of `.optional()`
- Zod v4 (API same as v3 for basic usage)
- Citty quirk: subcommands run alongside parent `run` handler — guard with `rawArgs` check
- Security: chmod 0o600 on config/session files, 0o700 on dirs, localhost-only server
- `createTool` from `@mastra/core/tools` for new tools — define inputSchema/outputSchema with Zod, register in tool-registry, assign permission level
- Mastra Agent `generate()` with structured output: `{ structuredOutput: { schema: ZodSchema } }` → returns `.object`
