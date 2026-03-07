# Copilot Instructions for forge-council

## Build, test, and lint commands

Use Bun for all local commands.

- Install dependencies: `bun install`
- Run the current entrypoint: `bun run index.ts`
- Run all tests: `bun test`
- Run a single test file: `bun test path/to/file.test.ts`

Current status of task scripts:
- `package.json` does not define `scripts` yet.
- No dedicated lint command is configured in this repository yet.
- No dedicated build command is configured in this repository yet.

## High-level architecture

This repository is currently a Bun scaffold (`index.ts` + TypeScript config) with architecture direction documented in `CLAUDE.md`.

The intended product architecture is:
- Bun + TypeScript runtime
- Mastra-based agent layer (`executor` + specialist agents)
- Custom "council" orchestration logic for:
  - Ralph Loop (`plan -> build -> review -> fix`, max 3 rounds)
  - Mean score threshold (`>= 7.5`) across agent reviews
  - Anonymized peer feedback
  - Fresh Eyes final validation
- Hono server + WebSocket streaming + Svelte dashboard
- Git as decision/audit memory for incremental work

When implementing new code, keep architecture work aligned with `CLAUDE.md`'s v2 direction unless a newer doc in this repo supersedes it.

## Key conventions used in this codebase

- Bun-first development: prefer Bun-native commands and APIs (`Bun.serve`, `bun:sqlite`, built-in WebSocket) over Node.js-oriented alternatives.
- Keep shared structured outputs in Zod schemas (especially for agent reviews/scoring payloads).
- Keep modules small and composable; TypeScript strict mode is enabled (`strict: true` in `tsconfig.json`).
- Preserve council-specific behavior (Ralph Loop rules, anonymized feedback, weighted persona scoring) when evolving orchestration logic.
