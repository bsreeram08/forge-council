/**
 * Built-in Skills — the default skill definitions for ForgeCouncil agents.
 *
 * Each skill bundles: tools + prompt template + domain knowledge + activation conditions.
 * Agents reference these by ID in their `skillIds` array.
 */

import type { Skill } from './skill.ts';
import type { IntentClassification } from './schemas.ts';

// ---------------------------------------------------------------------------
// Helper: check if classification includes any of the given domains
// ---------------------------------------------------------------------------

function domainMatch(domains: string[]) {
  return (c: IntentClassification) => c.domains.some(d => domains.includes(d));
}

// ---------------------------------------------------------------------------
// Built-in skills
// ---------------------------------------------------------------------------

export const BUILTIN_SKILLS: Skill[] = [
  // ===== PLANNING & ARCHITECTURE =====
  {
    id: 'system-design',
    name: 'System Design',
    description: 'Architectural reasoning — system boundaries, module decomposition, data flow, state management, and technology selection.',
    domains: ['api', 'database', 'auth', 'realtime', 'storage'],
    tools: ['codebase-index', 'find-symbol', 'analyze-imports', 'read-file', 'list-dir'],
    promptTemplate: [
      '## System Design Skill',
      'When designing systems:',
      '1. Identify system boundaries and module ownership',
      '2. Map data flow — who produces, who consumes, where does state live?',
      '3. Choose boring, proven tech. No premature optimization.',
      '4. Design for the current requirements, not hypothetical future ones.',
      '5. Prefer composition over inheritance. Prefer flat over nested.',
      '6. Every module should have a single clear owner and a minimal public API.',
    ].join('\n'),
    knowledgeBase: [
      'Key principles:',
      '- Single Responsibility: each module does one thing well',
      '- Dependency Inversion: depend on abstractions, not concretions',
      '- Interface Segregation: small, focused interfaces over fat ones',
      '- YAGNI: do not build for hypothetical requirements',
      '- 12-Factor App: env-based config, stateless processes, port binding',
    ].join('\n'),
    priority: 8,
  },

  {
    id: 'project-planning',
    name: 'Project Planning',
    description: 'Scope management, MVP definition, risk identification, phase planning, and dependency mapping.',
    domains: [],
    tools: ['list-dir', 'git-log', 'read-file', 'search-files'],
    promptTemplate: [
      '## Project Planning Skill',
      'When planning:',
      '1. Define the MVP — absolute minimum to validate the idea',
      '2. Break into phases — what ships first?',
      '3. Map dependencies — what blocks what?',
      '4. Identify risks — what could go wrong?',
      '5. Cut scope aggressively. Every "should" must justify itself.',
    ].join('\n'),
    activationCondition: (c) => c.taskType === 'greenfield',
    priority: 7,
  },

  {
    id: 'tech-research',
    name: 'Technology Research',
    description: 'Evaluate tools, frameworks, and services — ecosystem maturity, integration cost, and developer experience.',
    domains: [],
    tools: ['web-fetch', 'web-search', 'fetch-docs', 'dependency-audit', 'read-file'],
    promptTemplate: [
      '## Technology Research Skill',
      'When evaluating technologies:',
      '1. Name specific packages/services, not vague categories',
      '2. Check ecosystem maturity: GitHub stars, last release, open issues',
      '3. Assess integration cost — the happy path is easy; what about error handling?',
      '4. Consider the team: prefer tools the team already knows',
      '5. Weigh dependencies — each one is a liability',
    ].join('\n'),
    priority: 5,
  },

  // ===== IMPLEMENTATION =====
  {
    id: 'implementation',
    name: 'Code Implementation',
    description: 'Writing production code — TypeScript implementation, module design, testing, and performance.',
    domains: [],
    tools: [
      'read-file', 'write-file', 'edit-file', 'list-dir', 'search-files',
      'run-tests', 'type-check', 'lint-code', 'git-commit',
    ],
    promptTemplate: [
      '## Implementation Skill',
      'When writing code:',
      '1. Write complete, compilable files. No placeholders.',
      '2. Types first — define interfaces before implementations.',
      '3. One concern per file. Small, focused modules.',
      '4. Every file has correct imports.',
      '5. Test alongside implementation when the plan calls for it.',
      '6. Commit message format: "feat: <what>" or "fix: <what>"',
    ].join('\n'),
    priority: 9,
  },

  // ===== CODE REVIEW =====
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Review code for readability, consistency, correctness, naming, and type safety.',
    domains: [],
    tools: ['read-file', 'search-files', 'lint-code', 'type-check', 'find-symbol', 'code-complexity'],
    promptTemplate: [
      '## Code Review Skill',
      'When reviewing code:',
      '1. Focus on real problems, not style preferences',
      '2. Every issue must have a concrete fix suggestion',
      '3. Check naming clarity — can you understand from names alone?',
      '4. Look for subtle bugs: off-by-one, null checks, race conditions',
      '5. Verify type safety — no type holes or unsafe casts',
      '6. Score honestly — 7 means genuinely good code',
    ].join('\n'),
    priority: 7,
  },

  // ===== SECURITY =====
  {
    id: 'security-audit',
    name: 'Security Audit',
    description: 'Vulnerability detection — auth flaws, injection, secret exposure, dependency risks.',
    domains: ['auth', 'security', 'api', 'payments'],
    tools: ['read-file', 'search-files', 'secrets-scan', 'dependency-audit', 'find-symbol'],
    promptTemplate: [
      '## Security Audit Skill',
      'When auditing security:',
      '1. Check authentication and authorization boundaries',
      '2. Look for injection vectors: SQL, XSS, command injection, path traversal',
      '3. Verify secret management — no hardcoded keys, proper env var handling',
      '4. Check data exposure — logging PII, error message leaks',
      '5. Audit dependencies for known vulnerabilities',
      '6. Only flag exploitable issues, not theoretical risks',
    ].join('\n'),
    knowledgeBase: [
      'OWASP Top 10 (2024):',
      '1. Broken Access Control — missing authorization checks, IDOR',
      '2. Cryptographic Failures — weak hashing, plaintext secrets',
      '3. Injection — SQL, NoSQL, OS command, LDAP, XSS',
      '4. Insecure Design — missing threat modeling, no defense-in-depth',
      '5. Security Misconfiguration — default credentials, verbose errors',
      '6. Vulnerable Components — outdated dependencies with known CVEs',
      '7. Authentication Failures — weak passwords, missing MFA, session fixation',
      '8. Data Integrity Failures — unsigned updates, insecure deserialization',
      '9. Logging Failures — missing audit trail, no monitoring',
      '10. SSRF — server-side request forgery via URL manipulation',
    ].join('\n'),
    activationCondition: domainMatch(['auth', 'security', 'payments']),
    priority: 9,
  },

  // ===== TESTING =====
  {
    id: 'testing',
    name: 'Testing & QA',
    description: 'Test strategy — coverage analysis, edge case identification, error handling verification.',
    domains: ['testing'],
    tools: ['read-file', 'search-files', 'run-tests', 'test-coverage', 'type-check'],
    promptTemplate: [
      '## Testing Skill',
      'When testing:',
      '1. Focus on tests that prevent real bugs, not coverage metrics',
      '2. Test critical paths first — happy path, then error paths',
      '3. Edge cases: empty input, max values, concurrent access, timeout',
      '4. Assertions must verify behavior, not implementation details',
      '5. Missing error handling counts as a testing issue',
    ].join('\n'),
    activationCondition: domainMatch(['testing']),
    priority: 7,
  },

  // ===== INFRASTRUCTURE =====
  {
    id: 'infrastructure',
    name: 'Infrastructure & Deployment',
    description: 'Deployment readiness — environment config, containers, CI/CD, health checks.',
    domains: ['deployment', 'monitoring'],
    tools: [
      'read-file', 'write-file', 'edit-file', 'list-dir',
      'docker', 'env-manager', 'package-manager', 'port-check',
    ],
    promptTemplate: [
      '## Infrastructure Skill',
      'When reviewing infrastructure:',
      '1. Verify environment configuration (env vars, config files)',
      '2. Check build and deployment readiness',
      '3. Docker/container correctness — multi-stage builds, no root',
      '4. CI/CD pipeline completeness — lint, test, build, deploy',
      '5. Health checks and graceful shutdown',
      '6. Resource limits and port conflicts',
    ].join('\n'),
    activationCondition: domainMatch(['deployment', 'monitoring']),
    priority: 6,
  },

  // ===== UX DESIGN =====
  {
    id: 'ux-design',
    name: 'UX & UI Design',
    description: 'User experience analysis — flow clarity, error messages, accessibility, consistency.',
    domains: ['ui'],
    tools: ['read-file', 'search-files', 'list-dir', 'web-fetch'],
    promptTemplate: [
      '## UX Design Skill',
      'When reviewing UX:',
      '1. User flow clarity — is the path obvious?',
      '2. Error messages — helpful, actionable, not technical',
      '3. Loading states and edge cases in UI',
      '4. Accessibility basics — semantic HTML, contrast, keyboard nav',
      '5. Consistency in UI patterns across the app',
    ].join('\n'),
    activationCondition: domainMatch(['ui']),
    priority: 5,
  },

  // ===== DOCUMENTATION =====
  {
    id: 'documentation',
    name: 'Documentation',
    description: 'Technical writing — README files, API docs, developer guides, and code comments.',
    domains: [],
    tools: ['read-file', 'write-file', 'edit-file', 'list-dir', 'find-symbol'],
    promptTemplate: [
      '## Documentation Skill',
      'When writing docs:',
      '1. Examples over explanations',
      '2. Keep it short — every sentence earns its place',
      '3. Structure: Overview → Quick Start → API → Examples → Troubleshooting',
      '4. Code samples must be runnable and tested',
    ].join('\n'),
    activationCondition: (c) => c.taskType === 'docs',
    priority: 4,
  },

  // ===== CONTEXT SEARCH (auto for all agents) =====
  {
    id: 'context-search',
    name: 'Context Search',
    description: 'Semantic search across the project codebase and documentation using QMD index.',
    domains: [],
    tools: ['search-files', 'codebase-index', 'read-file'],
    promptTemplate: [
      '## Context Search Skill',
      'You have access to an indexed codebase. Use semantic search to find relevant code:',
      '1. Search by concept, not just keywords — "authentication flow" not "auth"',
      '2. Combine semantic search with pattern search for precision',
      '3. Read the actual file content after finding a match',
      '4. Do not load files speculatively — search first, then read',
    ].join('\n'),
    priority: 3,
  },

  // ===== RECURSIVE ANALYSIS (RLM) =====
  {
    id: 'recursive-analysis',
    name: 'Recursive Analysis',
    description: 'Decompose and analyze large codebases recursively — chunk, filter, and aggregate results across context boundaries.',
    domains: [],
    tools: [],
    promptTemplate: [
      '## Recursive Analysis Skill',
      'For large contexts that exceed your window:',
      '1. Use peekContext to inspect handle metadata before diving in',
      '2. Use searchContext to find relevant sections within a handle',
      '3. Use decomposeContext to break large handles into focused chunks',
      '4. Use spawnSubAgent for independent analysis of chunks',
      '5. Aggregate sub-agent results — do not re-read what sub-agents already processed',
      '6. Budget your depth: max 3 levels of recursion',
    ].join('\n'),
    priority: 2,
  },
];

// ---------------------------------------------------------------------------
// Agent → Skill ID mapping (default assignments for built-in agents)
// ---------------------------------------------------------------------------

export const AGENT_SKILL_MAP: Record<string, string[]> = {
  executor: ['project-planning', 'context-search'],
  architect: ['system-design', 'tech-research', 'context-search'],
  planner: ['project-planning', 'context-search'],
  researcher: ['tech-research', 'context-search'],
  coder: ['implementation', 'context-search'],
  reviewer: ['code-review', 'context-search'],
  security: ['security-audit', 'code-review', 'context-search'],
  qa: ['testing', 'code-review', 'context-search'],
  integrator: ['infrastructure', 'context-search'],
  designer: ['ux-design', 'context-search'],
  'spec-agent': ['project-planning', 'documentation', 'context-search'],
  docs: ['documentation', 'context-search'],
};
