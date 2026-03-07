# FORGECOUNCIL — Comprehensive Build Plan
## The Complete Engineering Prompt

> This document is the single source of truth for building ForgeCouncil v4. It consolidates architecture decisions from v1–v4, real-world usage feedback, existing codebase analysis, Hydra patterns to adopt, and the LSP integration spec. Hand this to any engineer (human or AI) and they can build ForgeCouncil.

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [Core Philosophy](#2-core-philosophy)
3. [The Flow](#3-the-flow)
4. [Prompt Architecture (v4 Core)](#4-prompt-architecture)
5. [Planning Phase — 2/3 Consensus Model](#5-planning-phase)
6. [Code Phase — Carmack + Ford](#6-code-phase)
7. [Review Phase — Schema-Only, Targeted](#7-review-phase)
8. [Fix & Ship Phases](#8-fix--ship-phases)
9. [Agent Roster & Personas](#9-agent-roster--personas)
10. [Output Schemas](#10-output-schemas)
11. [Human Authority System](#11-human-authority-system)
12. [Tools & Permissions](#12-tools--permissions)
13. [MCP Integration](#13-mcp-integration)
14. [LSP Integration](#14-lsp-integration)
15. [Hydra Patterns to Adopt](#15-hydra-patterns)
16. [Context Management & Compaction](#16-context-management)
17. [Session Persistence & Resume](#17-session-persistence)
18. [Token Budget System](#18-token-budget)
19. [Modes — Default, Council, Custom](#19-modes)
20. [Tech Stack](#20-tech-stack)
21. [UI — CLI + Web (Feature Parity)](#21-ui)
22. [Existing Codebase — What to Keep, Refactor, Build](#22-existing-codebase)
23. [Project Structure](#23-project-structure)
24. [Development Phases](#24-development-phases)
25. [Design Decision Log](#25-design-decisions)

---

## 1. Product Vision

ForgeCouncil takes a vague idea and turns it into working code — planned by a council of AI personas, curated by the user, coded by an AI engineer, reviewed by targeted specialists, and shipped.

**One-liner:** Idea in → working code out. 3 agents plan, user picks, 1 agent codes, 2-3 agents review the code, user ships.

**What it is NOT:**
- Not a 12-agent debate club (v2 spent $25 on 3 rounds of essays and never wrote code)
- Not a consensus-seeking machine (scores went DOWN over more rounds: 5.88 → 7.02 → 6.50)
- Not a prompt wrapper (it writes real code, commits to git, runs tests, integrates with LSP)

**What it IS:**
- A tool that writes code, with intelligent planning and targeted review
- An open-source, provider-agnostic, Mastra-based orchestrator
- Configurable personas, shareable via YAML
- CLI + Web UI with full feature parity

---

## 2. Core Philosophy

### The Five Rules

1. **3 agents max for planning.** Full council is an opt-in "deep review" mode (`--council`). Never the default.
2. **Human is god.** User can approve, reject, override, skip, or force-ship at ANY point. No score, no agent, no threshold blocks the user.
3. **Code first, review second.** Review real code, not hypothetical plans. Plans are cheap to change; code reveals real problems.
4. **Schema outputs only.** No prose reviews. Agents return structured data in tight Zod schemas. Plan text and code files are the only free-form outputs. This saves ~25x on review token costs.
5. **UI = CLI.** Every feature in the terminal works in the dashboard. No second-class interface.

### Lessons from v2 (Real Usage)

These are hard-won truths from actually running the system:

- 12 agents reviewing a plan is wasteful — they all found the same 5 bugs, 12x the tokens for 1x the insight
- Scores went DOWN over 3 rounds (sycophancy exhaustion, research predicted this)
- The system never wrote code — 3 rounds of plan reviews, zero implementation
- Structured reviews with strengths/concerns/suggestions are token-expensive and mostly redundant
- The first plan was usually decent — subsequent rounds made it worse
- Users need human override — the council shouldn't be able to block shipping

---

## 3. The Flow

```
Idea → [3 agents plan] → [User picks] → [Code] → [Review CODE] → [Fix] → Ship
```

### Detailed Flow

```
① PLAN (3 agents, parallel, ~30 seconds)
   Architect + Planner + Researcher draft independently
   Ford merges into unified plan with checkboxes
   
② PICK (Human curates, ~2 minutes)
   Merged plan shown as interactive checkboxes
   User toggles items, edits, adds custom items
   User: [Approve & Build] or [Refine] (triggers Pass 2)
   
③ CODE (Ford + Carmack, writes real code)
   Carmack implements approved plan items
   Writes files, runs tests, git commits per micro-task
   LSP provides real-time diagnostics after each file write
   User can: pause, redirect, skip to review, ship now
   
④ REVIEW (2-3 targeted agents review CODE, not plan)
   Ford picks reviewers based on what was built
   Schema-only output: { score, verdict, issues[] }
   Each issue: { severity, file, line, what, fix }
   
⑤ FIX (Carmack fixes user-selected issues)
   User picks which issues to fix via checkboxes
   Carmack fixes, commits per fix
   User can skip fixes and ship anyway
   
⑥ SHIP
   Working code in git repo
   Full commit history as audit trail
   Optional: Knuth writes README/docs
```

---

## 4. Prompt Architecture

Every agent call goes through the same 4-layer prompt assembly pipeline. The layers are identical in structure for all agents. Only Layer 1 content differs per persona.

### The 4 Layers

```
┌─────────────────────────────────────────────────────┐
│ LAYER 1: GENERAL (always present)                   │
│   System Prompt + Skills + Persona Config            │
│   (800-1200 tokens, per-persona)                     │
├─────────────────────────────────────────────────────┤
│ LAYER 2: INTENT (always present)                    │
│   User's idea/task + Intent classification result   │
│   Phase context + User guidance/overrides            │
├─────────────────────────────────────────────────────┤
│ LAYER 3: SUPPORTING CONTEXT (static, assembled once)│
│   Relevant code files + File tree + Git log          │
│   External docs + Previous session state             │
│   Selected by intent classifier BEFORE the call      │
├─────────────────────────────────────────────────────┤
│ LAYER 4: PLAN (Pass 2 only — additive)              │
│   Merged plan from Pass 1                            │
│   All 3 agents' Pass 1 contributions (visible)       │
│   "2/3 agreement required to change" instruction     │
└─────────────────────────────────────────────────────┘
```

### Key Rules

1. **Same layers, same structure, for EVERY agent.** Only the sys prompt/skills/persona in Layer 1 differs.
2. **Supporting context is STATIC.** Intent classifier runs once, selects files/code, freezes it. No mid-call retrieval.
3. **Layer 4 is additive.** Pass 2 doesn't rebuild — it adds the plan on top of identical Layers 1-3. Same foundation, new lens.
4. **Intent classifier is cheap.** Fast model call (~200 tokens) returning structured data about what context to load.

### Intent Classifier

Runs before any agent call. Returns structured decision about context assembly.

```typescript
const IntentClassification = z.object({
  taskType: z.enum([
    'greenfield', 'feature', 'bugfix', 'refactor', 'review', 'docs', 'infra',
  ]),
  domains: z.array(z.enum([
    'auth', 'api', 'database', 'ui', 'testing', 'payments', 'email',
    'storage', 'realtime', 'deployment', 'monitoring', 'security',
  ])),
  contextNeeded: z.object({
    filePatterns: z.array(z.string()),
    gitLogCount: z.number(),
    gitLogFilter: z.string().optional(),
    includeProjectStructure: z.boolean(),
    includeDependencies: z.boolean(),
    externalDocs: z.array(z.string()),
  }),
  complexity: z.enum(['simple', 'moderate', 'complex']),
});
```

### Prompt Assembly Pipeline

```typescript
async function assemblePrompt(
  agentId: string,
  userIdea: string,
  phase: 'plan' | 'code' | 'review' | 'fix',
  options?: {
    pass2Plan?: MergedPlan;
    pass1Contributions?: AgentContribution[];
    userGuidance?: string;
  }
): Promise<PromptLayers> {
  // 1. Load persona config (Layer 1) — from YAML
  const persona = loadPersona(agentId);
  const general = buildLayer1(persona);

  // 2. Classify intent (cheap, fast) — ~200 tokens
  const classification = await classifyIntent(userIdea, phase);

  // 3. Assemble static supporting context based on classification
  const context = await assembleContext(classification); // FROZEN after this

  // 4. Build layers
  const intent = buildLayer2(userIdea, classification, phase, options?.userGuidance);
  const supportingContext = buildLayer3(context);
  const plan = options?.pass2Plan
    ? buildLayer4(options.pass2Plan, options.pass1Contributions)
    : undefined;

  return { general, intent, supportingContext, plan };
}
```

---

## 5. Planning Phase

### Pass 1: Draft (parallel, independent)

- 3 agents (architect, planner, researcher) receive Layers 1-3 independently
- Each returns `PlanContributionSchema` (structured items, not prose)
- No agent sees the others' work
- Ford merges into `MergedPlanSchema` — deduplicates, categorizes, sets priority defaults

### User Decision Point

- **Approve** → Skip Pass 2, go to Code
- **Refine** → Run Pass 2
- **Edit** → User modifies plan directly, then Approve

### Pass 2: Refine (only if user requests)

- Same 3 agents, same Layers 1-3, **+ Layer 4** (merged plan + each other's Pass 1 contributions visible)
- Each returns `PlanChangeSchema` — proposed additions and removals with reasons
- **2/3 Consensus Rule:**
  - Addition applied if ≥ 2 of 3 agents suggest adding it
  - Removal applied if ≥ 2 of 3 agents suggest removing it
  - 1/3 suggestions shown as "contested" items — user manually accepts/rejects
- Updated plan shown to user for final approval

### Consensus Logic

```typescript
function applyPass2Changes(
  plan: MergedPlan,
  changes: PlanChange[],
): { updatedPlan: MergedPlan; contested: ContestedItem[] } {
  const addVotes: Record<string, { item: PlanItem; voters: string[] }> = {};
  const removeVotes: Record<string, { voters: string[]; reasons: string[] }> = {};

  for (const change of changes) {
    for (const addition of change.additions) {
      const key = addition.item.title.toLowerCase();
      if (!addVotes[key]) addVotes[key] = { item: addition.item, voters: [] };
      addVotes[key].voters.push(change.agentId);
    }
    for (const removal of change.removals) {
      if (!removeVotes[removal.itemId]) removeVotes[removal.itemId] = { voters: [], reasons: [] };
      removeVotes[removal.itemId].voters.push(change.agentId);
      removeVotes[removal.itemId].reasons.push(removal.reason);
    }
  }

  // Apply changes with 2/3 agreement
  // Auto-add if 2+ agents agree, auto-remove if 2+ agents agree
  // Show 1/3 items as contested for user decision
}
```

### Plan UI (CLI)

```
◇  Plan ──────────────────────────────────────────────╮
│                                                      │
│  Architecture:                                       │
│  ☑ [must]  Hono REST API on Bun       (architect)    │
│  ☑ [must]  PostgreSQL + Drizzle ORM   (architect)    │
│  ☐ [could] Redis caching layer        (researcher)   │
│                                                      │
│  Phase 1 — Core:                                     │
│  ☑ [must]  Stripe integration         (planner)      │
│  ☑ [should] Webhook signature verify  (researcher)   │
│  ☐ [could] Invoice PDF generation     (planner)      │
│                                                      │
│  [Enter] Approve & Build                             │
│  [e] Edit  [a] Add  [Space] Toggle  [r] Refine      │
│  [s] Ship as-is  [c] Council mode                    │
├──────────────────────────────────────────────────────╯
```

---

## 6. Code Phase

After user approves the plan, Carmack writes real code. Ford orchestrates.

### Process

1. Intent classifier re-runs for code phase (determines what docs/deps to load)
2. Carmack receives: approved plan items + codebase context + LSP access
3. For each plan item:
   - Write code file(s)
   - LSP returns diagnostics immediately
   - If errors → fix before committing
   - Run tests if applicable
   - `git commit` with structured message: `[coder] feat: description`
   - Layer 3 updates between files (new files become context for next file)
4. User can: pause (`p`), redirect (`r`), skip to review (`s`), ship now (`Ctrl+S`)

### Git Commit Format

```
[agent-id] type: description

Types: feat, fix, doc, test, refactor, config, plan
Examples:
  [coder] feat: add user auth middleware
  [coder] test: add edge case tests for expired tokens
  [executor] plan: phase-1 scope locked
```

### LSP Feedback Loop (During Coding)

```
Carmack writes file → LSP returns diagnostics instantly
  → If errors: Carmack fixes before committing
  → If clean: commit + move to next file
  
Available LSP features for coder:
  - Errors and warnings after each write
  - Go-to-definition / find references (understand existing code)
  - Hover info (type signatures, docs)
  - Code actions (auto-fix suggestions)
```

---

## 7. Review Phase

### What Changed from v2

| v2 | v4 |
|----|-----|
| All 12 agents review | 2-3 targeted agents |
| Review the PLAN | Review the CODE |
| Prose reviews (~2000 tokens/agent) | Schema-only (~300 tokens/agent) |
| 3 rounds max | 1 round, user decides |
| Scores block shipping | Scores inform, never block |

### Review Output Schema

```typescript
const CodeReviewSchema = z.object({
  score: z.number().min(1).max(10),
  verdict: z.enum(['approve', 'fix']),
  issues: z.array(z.object({
    id: z.string(),
    severity: z.enum(['critical', 'warning', 'suggestion']),
    file: z.string(),
    line: z.number().optional(),
    what: z.string().max(100),
    fix: z.string().max(200),
  })).max(10),
});
```

### Agent Selection (Ford picks based on code content)

| Code Contains | Agents Activated |
|---------------|-----------------|
| Auth/session code | Schneier (security) |
| API endpoints | Guido (reviewer) |
| Test files | Whittaker (QA) |
| Docker/CI config | Tesla (integrator) |
| UI components | Jobs (designer) |

### LSP Diagnostics in Review Context

When Guido and other reviewers receive code for review, the current LSP diagnostic state is injected into their Layer 3 (supporting context). Reviewers see what the compiler already flagged, so they focus on logic/design issues rather than wasting tokens on type errors LSP already caught.

### Review UI (CLI)

```
◇  Code Review ────────────────────────────────────────╮
│                                                       │
│  Schneier (security): 7.2/10 — fix                    │
│  ⚠ CRITICAL  src/routes/stripe.ts:45                  │
│    Webhook signature not verified                      │
│    → Add Stripe.webhooks.constructEvent()              │
│                                                       │
│  Guido (reviewer): 8.1/10 — approve                   │
│  💡 SUGGEST   src/routes/stripe.ts:12                  │
│    Magic string should be env var                      │
│    → Move to STRIPE_PRICE_ID env variable              │
│                                                       │
│  ☑ Fix: Webhook signature (critical)                   │
│  ☑ Fix: Magic string to env var                        │
│  ☐ Skip: Rate limiting (Phase 2)                       │
│                                                       │
│  [Enter] Fix selected  [a] Fix all  [s] Ship anyway   │
├───────────────────────────────────────────────────────╯
```

---

## 8. Fix & Ship Phases

### Fix Phase

- Carmack receives: current code + selected issues to fix
- Fixes each issue, commits per fix
- LSP verifies fixes don't introduce new errors
- User reviews fixes or ships

### Ship Phase

- Working code in git repo
- Full commit history (audit trail of every micro-task)
- Summary: what was built, what was deferred, known issues
- Optional: Knuth writes README/docs (user triggers with `--docs`)

---

## 9. Agent Roster & Personas

### Planning Agents (Default: 3)

| ID | Codename | Persona | Archetype | Model |
|----|----------|---------|-----------|-------|
| `architect` | Torvalds | Linus Torvalds | The Uncompromising Purist | Opus |
| `planner` | Doshi | Shreyas Doshi | The Scope Surgeon | Sonnet |
| `researcher` | Scott | Kevin Scott | The Tech Scout | Opus |

### Executor + Coder

| ID | Codename | Persona | Role | Model |
|----|----------|---------|------|-------|
| `executor` | Ford | Henry Ford | Orchestrator, merger, delegator | Opus |
| `coder` | Carmack | John Carmack | Writes all code, fixes issues | Opus |

### Review Agents (Ford picks 2-3 per run)

| ID | Codename | Persona | Activated When | Model |
|----|----------|---------|---------------|-------|
| `reviewer` | Guido | Guido van Rossum | Code quality | Sonnet |
| `security` | Schneier | Bruce Schneier | Auth/data/API code | Opus |
| `qa` | Whittaker | James Whittaker | Tests present | Sonnet |
| `integrator` | Tesla | Nikola Tesla | Infra/deploy code | Sonnet |
| `designer` | Jobs | Steve Jobs | UI/UX code | Sonnet |

### On-Demand Agents

| ID | Codename | Persona | When |
|----|----------|---------|------|
| `spec-agent` | Fowler | Martin Fowler | Explicit spec writing |
| `docs` | Knuth | Donald Knuth | README/docs (opt-in at ship) |
| `scout` | Scout | Requirements Clarifier | Vague prompts |

### Persona Configuration (YAML)

Every agent is fully configurable via YAML. Personas are shareable.

```yaml
id: architect
codename: Torvalds
displayName: System Architect
archetype: "The Uncompromising Purist"
inspiration: "Inspired by Linus Torvalds"

systemPrompt: |
  You are Torvalds, a system architect who values simplicity above all.
  # ... full persona prompt (800-1200 tokens)

skills:
  - System design and architecture
  - Technology selection and trade-off analysis

behavioralRules:
  - "Reject over-engineering. Simple is better than clever."
  - "No microservices for MVP. Monolith first."

model: "anthropic/claude-opus-4-6"
temperature: 0.3
maxTokens: 2000
harshness: 0.8

scoring:
  dimensions:
    - { name: "System Design", weight: 0.30, description: "..." }
    - { name: "Scalability", weight: 0.25, description: "..." }
    - { name: "Simplicity", weight: 0.25, description: "..." }
    - { name: "Interface Design", weight: 0.20, description: "..." }
  anchors:
    "1-3": "Fundamentally broken."
    "4-5": "Works but significant issues."
    "6-7": "Solid with minor concerns."
    "8-9": "Excellent."
    "10": "Exceptional — rare."
```

---

## 10. Output Schemas

### Rule: No prose. Only structured data + code files.

| Output | Schema | Max Tokens |
|--------|--------|------------|
| Intent classification | `IntentClassification` | ~200 |
| Plan contribution (per agent) | `PlanContributionSchema` | ~500 |
| Plan changes (Pass 2, per agent) | `PlanChangeSchema` | ~300 |
| Merged plan (shown to user) | `MergedPlanSchema` | ~800 |
| Code files | Actual files on disk | Varies |
| Git commits | Structured message format | ~50 |
| Code review | `CodeReviewSchema` | ~300 |

```typescript
// --- Planning ---

const PlanContributionSchema = z.object({
  agentId: z.string(),
  items: z.array(z.object({
    id: z.string(),
    category: z.string(),
    title: z.string().max(80),
    description: z.string().max(200),
    priority: z.enum(['must', 'should', 'could']),
    phase: z.number(),
  })),
  techSuggestions: z.array(z.object({
    tool: z.string(),
    reason: z.string().max(100),
    alternative: z.string().optional(),
  })).optional(),
});

const PlanChangeSchema = z.object({
  agentId: z.string(),
  additions: z.array(z.object({
    item: z.object({ /* same as PlanContribution item */ }),
    reason: z.string().max(100),
  })),
  removals: z.array(z.object({
    itemId: z.string(),
    reason: z.string().max(100),
  })),
});

const MergedPlanSchema = z.object({
  summary: z.string().max(500),
  categories: z.array(z.object({
    name: z.string(),
    items: z.array(z.object({
      id: z.string(),
      title: z.string().max(80),
      description: z.string().max(200),
      priority: z.enum(['must', 'should', 'could']),
      phase: z.number(),
      source: z.string(),
      selected: z.boolean(), // must=true, should=true, could=false
    })),
  })),
  techStack: z.record(z.string()),
  phases: z.array(z.object({
    number: z.number(),
    title: z.string(),
    scope: z.string().max(200),
    effort: z.string(),
  })),
});

// --- Code Review ---

const CodeReviewSchema = z.object({
  score: z.number().min(1).max(10),
  verdict: z.enum(['approve', 'fix']),
  issues: z.array(z.object({
    id: z.string(),
    severity: z.enum(['critical', 'warning', 'suggestion']),
    file: z.string(),
    line: z.number().optional(),
    what: z.string().max(100),
    fix: z.string().max(200),
  })).max(10),
});
```

### Lenient Schema Pattern (from existing codebase — KEEP)

The existing `RawAgentReviewSchema` + `normalizeAgentReview()` pattern is excellent. Apply this to EVERY schema:

```typescript
// Lenient: accepts any shape from LLM
const RawCodeReviewSchema = z.object({
  score: z.any().optional(),
  verdict: z.any().optional(),
  issues: z.any().optional(),
});

// Normalizer: coerces garbage into valid typed output
function normalizeCodeReview(raw: Record<string, unknown>): CodeReview {
  // Handle missing fields, wrong types, objects-as-strings, etc.
  // Always return valid CodeReview
}
```

---

## 11. Human Authority System

The user is NEVER blocked. At every phase:

| Phase | User Actions |
|-------|-------------|
| Plan (Pass 1) | Approve, Edit, Refine, Reject & start over |
| Plan (Pass 2) | Approve, Edit, accept/reject contested items |
| Code | Pause, Redirect, Skip to Review, Ship Now |
| Review | Fix selected issues, Ship without fixes, Request more reviews |
| Fix | Ship, request another review |
| Any time | Force ship, change mode, add guidance |

**No score, no agent, no threshold blocks the user.**

### Implementation

```typescript
enum UserAction {
  APPROVE = 'approve',
  APPROVE_WITH_NOTES = 'approve-with-notes',
  REJECT = 'reject',
  SKIP = 'skip',
  FORCE_SHIP = 'force-ship',
  EDIT = 'edit',
  ESCALATE = 'escalate', // Switch to council mode
}
```

---

## 12. Tools & Permissions

### 29 Built-in Tools (7 Categories)

**Code Execution:** `run-shell`, `run-code`, `run-tests`, `lint-code`, `type-check`
**File System:** `read-file`, `write-file`, `edit-file`, `list-dir`, `search-files`, `delete-file`
**Git:** `git-commit`, `git-log`, `git-diff`, `git-branch`, `git-stash`
**Web/API:** `web-fetch`, `web-search`, `fetch-docs`
**Analysis:** `dependency-audit`, `secrets-scan`, `code-complexity`, `test-coverage`
**Infrastructure:** `docker`, `env-manager`, `package-manager`, `port-check`
**Codebase Intel:** `codebase-index`, `find-symbol`, `analyze-imports`

### Permission Levels

| Level | Can Do |
|-------|--------|
| READ_ONLY | Read files, view git, run analysis, search web |
| READ_WRITE | + Write files, run code, commit, install packages |
| ADMIN | + Delete files, Docker, full infra access |

### Per-Agent Permissions

| Agent | Level | Key Tools |
|-------|-------|-----------|
| Ford (Executor) | ADMIN | Everything |
| Carmack (Coder) | READ_WRITE | Full code execution, file write, git commit |
| Torvalds (Architect) | READ_ONLY | Read code, analyze, web research |
| Doshi (Planner) | READ_ONLY | Read structure, git log |
| Scott (Researcher) | READ_ONLY | Extensive web, read code, analyze deps |
| Guido (Reviewer) | READ_ONLY | Read code, lint, type-check, complexity |
| Schneier (Security) | READ_ONLY | Read code, dep audit, secrets scan |
| Whittaker (QA) | READ_WRITE | Run tests, write test files, coverage |
| Tesla (Integrator) | READ_WRITE | Shell, Docker, env vars, packages |
| Jobs (Designer) | READ_ONLY | Read code, web research |
| Knuth (Docs) | READ_WRITE | Read code, write docs |

### Runtime Enforcement

Tools are filtered via Mastra's `onDelegationStart` hook. When Ford delegates, the target agent receives only allowed tools. Denied tools return a message: "Ask Ford to perform this action."

---

## 13. MCP Integration

MCP is core, not optional. Bidirectional.

### Inbound — ForgeCouncil connects TO external tools

```yaml
# forgecouncil.config.yaml
mcp:
  clients:
    github:
      url: "https://github-mcp.example.com/sse"
      allowedAgents: [executor, planner, coder, reviewer, integrator]
    jira:
      url: "${JIRA_MCP_URL}"
      allowedAgents: [executor, planner, spec-agent]
    sentry:
      command: "npx"
      args: ["-y", "@sentry/mcp-server"]
      allowedAgents: [executor, qa, security, coder]
    # Users add their own MCP servers here
```

### Outbound — ForgeCouncil AS an MCP server

Expose agents and workflows to Cursor, Claude Desktop, Windsurf:

```typescript
const forgeCouncilMCP = new MCPServer({
  name: 'ForgeCouncil',
  agents: { ford: executor, schneier: security, torvalds: architect },
  workflows: { ralphLoop },
  tools: { gitLog, codebaseIndex, dependencyAudit },
});
```

---

## 14. LSP Integration

### Why

Without LSP, Carmack writes code, commits, and only discovers type errors later. With LSP, every edit gets instant diagnostics — like red squiggly underlines in the agent's brain.

### Language Server Selection

Auto-detect from project files:
- `tsconfig.json` → tsserver (TypeScript/JavaScript) — always available as default
- `pyproject.toml` / `requirements.txt` → Pyright
- `Cargo.toml` → rust-analyzer
- `go.mod` → gopls

### Which Agents Get LSP

| Agent | LSP Access | Why |
|-------|-----------|-----|
| Carmack (coder) | Full — diagnostics, go-to-def, hover, code actions | Tight feedback loop while writing |
| Guido (reviewer) | Diagnostics summary in context | Focus on logic, not type errors |

### LSP Features Used

| Feature | Used By | Purpose |
|---------|---------|---------|
| Errors/warnings after write | Carmack | Fix before committing |
| Go-to-definition | Carmack | Understand existing code before editing |
| Hover info (types, docs) | Carmack | Know function signatures |
| Code actions (auto-fix) | Carmack | Apply LSP-suggested fixes automatically |

### Implementation

```typescript
// Start LSP at beginning of code phase
const lsp = await startLanguageServer(projectPath); // Auto-detects language

// After each file write
const diagnostics = await lsp.getDiagnostics(filePath);
if (diagnostics.errors.length > 0) {
  // Feed errors back to Carmack for immediate fix
  // Do NOT commit until clean
}

// Code actions for auto-fixes
const actions = await lsp.getCodeActions(filePath, diagnostic);
// Carmack can apply these automatically

// For Guido's review context
const allDiagnostics = await lsp.getProjectDiagnostics();
// Inject into Layer 3 of Guido's prompt
```

---

## 15. Hydra Patterns to Adopt

Six patterns from the Hydra project to integrate:

### 1. Event-Sourced Daemon (HTTP State + Replay)

Session state managed through an event log. Enables replay, snapshots, and crash recovery. All state changes are events; current state is derived by replaying events.

### 2. Intelligent Route Classification (Zero-Cost Local Heuristic)

Local heuristic classifies prompts before dispatching to agents. Maps directly to our intent classifier. Zero API calls for routing decisions.

### 3. Git Worktree Isolation (Parallel Agent Work)

Each task runs in its own git worktree. Agents can work in parallel without stepping on each other. Essential for council mode where multiple agents may need to write code.

### 4. Token Budget Tracking (3-Tier)

```typescript
const TokenBudget = z.object({
  weekly: z.object({ limit: z.number(), used: z.number(), remaining: z.number() }),
  daily: z.object({ limit: z.number(), used: z.number(), remaining: z.number() }),
  sliding: z.object({ windowHours: z.number(), limit: z.number(), used: z.number() }),
  autoModelSwitch: z.boolean(), // Switch to cheaper model at budget threshold
  thresholds: z.object({
    warning: z.number(),  // e.g., 0.8 — warn at 80% usage
    critical: z.number(), // e.g., 0.95 — switch models at 95%
  }),
});
```

### 5. Virtual Sub-Agents (Role → Physical Agent Resolver)

Roles like "security-reviewer" or "test-writer" resolve to physical agents at runtime. Enables swapping implementations without changing orchestration logic.

### 6. Nightly/Evolve Self-Improvement Pipelines

Scheduled automation that scans TODO comments, GitHub issues, and improvement opportunities → prioritizes → executes autonomously with budget tracking.

---

## 16. Context Management

### Compaction Mode (Mastra Observational Memory)

When context windows fill up, Mastra's observational memory compresses conversation history into dense observation logs. Keeps recent context full, summarizes older rounds.

```typescript
memory: new Memory({
  storage: new LibSQLStore({ /* ... */ }),
  options: {
    lastMessages: 20,
    semanticRecall: { topK: 5, messageRange: 3 },
  },
}),
```

### Per-Agent Context Scoping

Not every agent needs the same context. Enforced via delegation hooks.

### Git as Shared Memory Bus

Ford commits per micro-task with structured messages. Any agent reconstructs context from `git log`. No vector DB needed for a coding harness.

---

## 17. Session Persistence & Resume

Sessions save to disk (Mastra storage + git). Users can resume any session.

```typescript
const SessionSchema = z.object({
  id: z.string(),
  idea: z.string(),
  status: z.enum(['planning', 'approved', 'coding', 'reviewing', 'fixing', 'shipped', 'paused']),
  currentPhase: z.enum(['plan', 'pick', 'code', 'review', 'fix', 'ship']),
  plan: MergedPlanSchema.optional(),
  userSelections: z.array(z.string()).optional(),
  gitBranch: z.string().optional(),
  lastCommit: z.string().optional(),
  reviews: z.array(CodeReviewSchema).optional(),
  selectedFixes: z.array(z.string()).optional(),
  mode: z.enum(['default', 'council', 'custom']),
  activeAgents: z.array(z.string()),
  tokenUsage: z.object({ input: z.number(), output: z.number(), cost: z.number() }),
  userOverrides: z.array(z.object({
    phase: z.string(), action: z.string(), timestamp: z.string(), note: z.string().optional(),
  })),
});
```

---

## 18. Token Budget

### Default Mode Estimate

| Phase | Tokens | Cost |
|-------|--------|------|
| Intent classify | ~400 | $0.01 |
| Plan (3 agents) | ~9K | $0.40 |
| Ford merge | ~6K | $0.25 |
| Code (Carmack) | ~70K | $2.50 |
| Review (2 agents) | ~17K | $0.70 |
| Fix (Carmack) | ~14K | $0.60 |
| **Total** | **~116K** | **~$4.50** |

vs v2: ~578K tokens, ~$24.50. **80% savings + working code.**

---

## 19. Modes

### Default: "Ship" (3 agents for planning)
Fast, cheap, daily driver. ~$3-5 per run.

### Council: "Deep Review" (`--council`)
All agents participate in planning + review. ~$10-15 per run.

### Custom: User picks agents (`--agents architect,security,coder`)
Any combination.

---

## 20. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Foundation** | Mastra | Supervisor, workflows, memory, evals, tracing, Studio |
| **Runtime** | Bun | Native TS, WebSocket, SQLite, single-executable builds |
| **LLM Routing** | Mastra (= AI SDK) | 40+ providers |
| **Web Framework** | Hono | 14KB, WebSocket + SSE |
| **CLI** | Citty + @clack/prompts | Lightweight, Bun-compatible |
| **Frontend** | Svelte 5 | Near-zero runtime |
| **State** | Mastra storage (LibSQL) | Workflow persistence |
| **Validation** | Zod | Shared schemas |
| **VCS / Memory** | Git | Commits per micro-task |
| **LSP** | Auto-detected (tsserver, pyright, rust-analyzer, gopls) | Real-time diagnostics |
| **MCP** | Mastra MCPClient + MCPServer | External tools in, ForgeCouncil exposed out |
| **Distribution** | `bun build --compile` | Single executable |

---

## 21. UI — CLI + Web (Feature Parity)

Every feature must exist in both. No exceptions.

| Feature | CLI | Web UI |
|---------|-----|--------|
| Start session | `forge "idea"` | Text input + button |
| Resume | `forge --resume <id>` | Session list |
| Plan checkboxes | Space to toggle | Click checkboxes |
| Edit plan | `e` inline | Click to edit |
| Approve plan | Enter | "Approve & Build" |
| Watch coding | Default streaming | Live output panel |
| Pause | `p` | Pause button |
| Redirect | `r` + guidance | Redirect button + input |
| Review fixes | Space to toggle | Checkboxes |
| Ship | Enter / `s` | Ship button |
| Force ship | `Ctrl+S` | "Ship Now" (confirm) |
| Council mode | `c` / `--council` | Toggle |
| Token usage | `t` | Always visible |
| Git history | `forge history` | Timeline panel |

---

## 22. Existing Codebase — What to Keep, Refactor, Build

### KEEP AS-IS (solid, well-tested)

| File | What | Why Keep |
|------|------|----------|
| `scorer.ts` + tests | Weighted averages, mean calculation, threshold checks | Math is correct, reusable |
| `stagnation.ts` + tests | Oscillation detection, stagnation detection | Useful for council mode |
| `anonymizer.ts` + tests | Fisher-Yates shuffle, review stripping | Keep for council mode |
| `schemas.ts` (partial) | `RawAgentReviewSchema`, `normalizeAgentReview()`, `normalizePlanOutput()` | Brilliant lenient→strict pattern. Apply to all new schemas |
| `parallel-review.ts` | Semaphore, retry, `Promise.allSettled`, event bus | Solid concurrency. Reuse for parallel planning |
| `agent-registry.ts` | Model chain resolution, lazy building, per-agent overrides | Good foundation |
| All test files | Comprehensive edge case coverage | Keep and extend |

### REFACTOR

| Current | Change To | Why |
|---------|-----------|-----|
| 13 agents all as reviewers | Split: 3 planners, 1 coder, 5+ reviewers | Different roles per phase |
| `PlanOutput` (5 prose fields) | `MergedPlanSchema` with items + checkboxes | User picks, not reads essays |
| `AgentReview` (prose) | `CodeReviewSchema` (schema-only issues[]) | 25x cheaper, reviews code not plans |
| `GoalAncestry` (round tracking) | Session phases (plan→pick→code→review→fix→ship) | Different flow model |
| `fresh-eyes.ts` | Move to opt-in council mode only | Default: 1-2 passes max |
| `parallel-review.ts` prompts | Use 4-layer prompt assembler | Standardize all prompt construction |
| Ford's instructions | Split: merger role (planning) + orchestrator role (coding/review) | Ford does different things per phase |

### BUILD NEW

| Component | Priority | Description |
|-----------|----------|-------------|
| Intent classifier | P0 | Cheap call that determines what context to load |
| Prompt assembler | P0 | 4-layer pipeline (General→Intent→Context→Plan) |
| Planning flow | P0 | 3 agents draft → Ford merges → checkboxes → Pass 2 consensus |
| Code phase | P0 | Carmack writes files, runs tests, commits to git |
| Code review schema | P0 | `{ score, verdict, issues[] }` — not prose |
| Human override system | P0 | Approve/reject/skip/force-ship at every phase |
| Git tools | P0 | commit, log, diff, branch as Mastra tools |
| LSP integration | P1 | Language server for diagnostics during coding |
| Token budget tracking | P1 | 3-tier from Hydra (weekly/daily/sliding) |
| Event-sourced daemon | P1 | HTTP state + replay from Hydra |
| Git worktree isolation | P1 | Parallel agent work from Hydra |
| Web UI (Svelte 5) | P2 | Full CLI feature parity |
| MCP client/server | P2 | External tools, expose ForgeCouncil as MCP |
| Nightly pipelines | P3 | Self-improvement from Hydra |
| Persona marketplace | P3 | YAML configs, community sharing |

---

## 23. Project Structure

```
forgecouncil/
├── package.json
├── bunfig.toml
├── tsconfig.json
├── forgecouncil.config.yaml          # User config (MCP, agents, budget)
│
├── src/
│   ├── mastra/
│   │   ├── index.ts                   # Mastra instance
│   │   ├── agents/
│   │   │   ├── executor.ts            # Ford — supervisor agent
│   │   │   ├── coder.ts              # Carmack — code writer
│   │   │   └── council/              # All persona agents
│   │   ├── workflows/
│   │   │   ├── plan.ts               # Plan → Pick flow
│   │   │   ├── code.ts               # Code → Commit flow
│   │   │   ├── review.ts             # Review → Fix flow
│   │   │   └── ship.ts               # Ship flow
│   │   └── tools/
│   │       ├── git.ts                # Git operations
│   │       ├── filesystem.ts         # File read/write/edit
│   │       ├── code-execution.ts     # Shell, run code, tests
│   │       ├── web.ts               # Fetch, search, docs
│   │       ├── analysis.ts          # Audit, secrets, complexity
│   │       ├── infra.ts             # Docker, env, packages
│   │       └── codebase.ts          # Index, symbols, imports
│   │
│   ├── core/
│   │   ├── prompt-assembler.ts       # 4-layer pipeline
│   │   ├── intent-classifier.ts      # Cheap context decision
│   │   ├── plan-merger.ts            # Ford merges 3 agent plans
│   │   ├── consensus.ts              # 2/3 agreement logic for Pass 2
│   │   └── human-authority.ts        # Override system
│   │
│   ├── council/                       # EXISTING — keep/refactor
│   │   ├── agent-registry.ts          # Keep: model chains, lazy build
│   │   ├── schemas.ts                 # Keep: lenient→strict normalization
│   │   ├── scorer.ts                  # Keep: weighted scoring math
│   │   ├── stagnation.ts             # Keep: oscillation detection
│   │   ├── anonymizer.ts             # Keep: for council mode
│   │   ├── parallel-review.ts        # Keep: semaphore + retry
│   │   └── fresh-eyes.ts             # Move to council-mode only
│   │
│   ├── lsp/
│   │   ├── manager.ts                # Start/stop language servers
│   │   ├── diagnostics.ts            # Get errors/warnings after writes
│   │   ├── navigation.ts             # Go-to-def, hover, references
│   │   ├── actions.ts                # Code actions, auto-fix
│   │   └── detector.ts               # Auto-detect language from project
│   │
│   ├── budget/
│   │   ├── tracker.ts                # 3-tier token tracking
│   │   ├── model-switcher.ts         # Auto-switch at budget threshold
│   │   └── reporter.ts               # Usage display
│   │
│   ├── personas/
│   │   ├── loader.ts                  # YAML → PersonaConfig
│   │   ├── types.ts                   # TypeScript types
│   │   └── defaults/                  # Built-in persona YAMLs
│   │
│   ├── config/
│   │   ├── schema.ts                  # EXISTING — config types
│   │   ├── defaults.ts                # EXISTING — default config
│   │   └── resolver.ts                # EXISTING — model resolution
│   │
│   ├── cli/
│   │   ├── index.ts                   # Citty CLI entry
│   │   ├── commands/
│   │   │   ├── forge.ts               # `forge "idea"`
│   │   │   ├── resume.ts             # `forge --resume`
│   │   │   ├── config.ts             # `forge config`
│   │   │   ├── persona.ts            # `forge persona`
│   │   │   └── history.ts            # `forge history`
│   │   ├── renderer.ts               # Terminal streaming
│   │   ├── plan-picker.ts            # Checkbox UI for plans
│   │   └── review-picker.ts          # Checkbox UI for fixes
│   │
│   ├── server/
│   │   ├── index.ts                   # Hono server
│   │   ├── routes/
│   │   │   ├── api.ts                # REST endpoints
│   │   │   ├── ws.ts                 # WebSocket for dashboard
│   │   │   └── mcp.ts               # MCP server endpoints
│   │   └── session.ts                # EXISTING — session state
│   │
│   └── dashboard/                     # Svelte 5 SPA
│       ├── src/
│       │   ├── App.svelte
│       │   └── components/
│       └── build/
│
├── personas/
│   ├── defaults/                      # Built-in persona YAMLs
│   └── community/                     # Community-contributed
│
└── tests/
    ├── council/                       # EXISTING — keep + extend
    ├── core/
    ├── lsp/
    ├── tools/
    └── integration/
```

---

## 24. Development Phases

### Phase 1 — MVP: Plan + Code (4-6 weeks)

- [ ] Intent classifier (cheap, structured context decision)
- [ ] Prompt assembler (4-layer pipeline)
- [ ] 3 planning agents draft in parallel (reuse `parallel-review.ts` pattern)
- [ ] Ford merger (plan contributions → merged plan)
- [ ] Merged plan with checkbox UI (CLI, using @clack/prompts)
- [ ] Human approve → Carmack codes (with git commits per micro-task)
- [ ] Git tools (commit, log, diff as Mastra tools)
- [ ] File system tools (read, write, edit, list)
- [ ] Basic session persistence
- [ ] `forge "idea"` command
- [ ] Token counter (basic)
- [ ] Refactor existing `agent-registry.ts` for phase-based activation

### Phase 2 — Review + Fix + Pass 2 (3-4 weeks)

- [ ] Code review with `CodeReviewSchema` (schema-only, tight)
- [ ] Ford auto-picks 2-3 review agents based on code content
- [ ] Issue selection UI (checkboxes for which to fix)
- [ ] Carmack fixes selected issues
- [ ] Human override (ship anyway, skip review)
- [ ] Pass 2 planning with 2/3 consensus
- [ ] Session resume
- [ ] LSP integration (tsserver for TypeScript)
- [ ] LSP diagnostics fed to Carmack during coding
- [ ] LSP diagnostics in Guido's review context
- [ ] Token budget tracking (3-tier: weekly/daily/sliding)

### Phase 3 — Web UI + Polish (3-4 weeks)

- [ ] Svelte 5 dashboard with full CLI feature parity
- [ ] Live coding output stream via WebSocket
- [ ] Interactive plan checkboxes
- [ ] Review issue cards with fix/skip toggles
- [ ] Token cost display (always visible)
- [ ] Session management UI
- [ ] Git timeline panel

### Phase 4 — Extensions (ongoing)

- [ ] Council mode (opt-in, `--council`)
- [ ] Custom agent selection (`--agents`)
- [ ] MCP client (GitHub, Jira, Slack, Sentry, databases)
- [ ] MCP server (expose ForgeCouncil to Cursor/Claude Desktop)
- [ ] Event-sourced daemon (from Hydra)
- [ ] Git worktree isolation (from Hydra)
- [ ] Nightly/evolve pipelines (from Hydra)
- [ ] Persona marketplace (YAML configs, community)
- [ ] Auto-detect more LSP servers (Python, Rust, Go)
- [ ] `bun build --compile` single executable
- [ ] Fresh Eyes as opt-in post-review (council mode only)

---

## 25. Design Decision Log

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Framework | Mastra (built on Vercel AI SDK) | Supervisor, workflows, memory, evals, tracing, Studio. Mastra IS AI SDK + orchestration. |
| 2 | Default agent count | 3 for planning | 12 is wasteful — all found same bugs in v2 testing |
| 3 | Planning rounds | Up to 2 passes (skip 2nd if user approves 1st) | First plan usually decent. More rounds = worse scores. |
| 4 | Plan changes | 2/3 consensus required | Protects first draft. Prevents degradation. |
| 5 | Pass 2 context | Agents see plan + each other's Pass 1 | Enables informed refinement, not blind re-drafting |
| 6 | Score threshold | Informs only, never blocks | User is god. No score blocks shipping. |
| 7 | Review target | Code, not plans | Reviewing plans is theater. Code reveals real bugs. |
| 8 | Review format | Schema-only (300 tokens/agent) | 25x cheaper than prose (2000 tokens/agent) |
| 9 | Code phase | Core of the system | The literal point of the tool — v2 never wrote code |
| 10 | Prompt architecture | 4 layers, same for all agents | Universal pipeline, only Layer 1 differs per persona |
| 11 | Context assembly | Static, via intent classifier | No mid-call retrieval surprises. Cheap gatekeeper. |
| 12 | LSP | Auto-detect, Carmack + Guido | Real-time diagnostics = tight feedback loop |
| 13 | Git memory | Commits per micro-task | Ordered, diffable, auditable, free, no vector DB |
| 14 | MCP | Core, bidirectional | Connect TO external tools AND expose AS MCP server |
| 15 | Human override | Every phase | User knows their context better than the AI council |
| 16 | Token budget | 3-tier (Hydra pattern) | Visible cost, auto model-switch at threshold |
| 17 | UI parity | CLI = Web, no exceptions | No second-class interface |
| 18 | Runtime | Bun | Native TS, WebSocket, SQLite, Anthropic-backed |
| 19 | Personas | YAML, shareable | Community flywheel, swappable configurations |
| 20 | Lenient schemas | Raw → normalize → strict | LLMs return garbage; normalize into valid types |
