/**
 * Workspace Pipeline — the new default pipeline for parallel coding.
 *
 * Flow:
 *   classify → decompose → workspace → review → fix → ship
 *
 * The 'workspace' phase replaces the old plan→code single-agent flow.
 * Multiple coders work in parallel on subtasks, each validated by QA.
 */

import type { PipelineConfig } from './pipeline.ts';

export const WORKSPACE_PIPELINE: PipelineConfig = {
  phases: [
    {
      id: 'classify',
      name: 'Classify Intent',
      handler: 'classify',
      agents: [],
      parallel: false,
      condition: { type: 'always' },
      dynamicAgents: false,
    },
    {
      id: 'decompose',
      name: 'Decompose Task',
      handler: 'decompose',
      agents: [
        { agentId: 'architect', required: true },
      ],
      parallel: false,
      condition: { type: 'always' },
      dynamicAgents: false,
    },
    {
      id: 'pick',
      name: 'User Approval',
      handler: 'pick',
      agents: [],
      parallel: false,
      condition: { type: 'always' },
      dynamicAgents: false,
    },
    {
      id: 'workspace',
      name: 'Parallel Coding',
      handler: 'workspace',
      agents: [
        { agentId: 'coder', required: true },
      ],
      parallel: true,
      condition: { type: 'always' },
      dynamicAgents: true,
    },
    {
      id: 'review',
      name: 'Council Review',
      handler: 'review',
      agents: [
        { agentId: 'reviewer', required: true },
      ],
      parallel: true,
      condition: { type: 'always' },
      dynamicAgents: true,
    },
    {
      id: 'fix',
      name: 'Fix Issues',
      handler: 'fix',
      agents: [{ agentId: 'coder', required: true }],
      parallel: false,
      condition: { type: 'has-issues' },
      dynamicAgents: false,
    },
    {
      id: 'ship',
      name: 'Ship',
      handler: 'ship',
      agents: [],
      parallel: false,
      condition: { type: 'always' },
      dynamicAgents: false,
    },
  ],
  loops: [
    {
      startPhase: 'workspace',
      endPhase: 'fix',
      maxRounds: 3,
      exitWhen: [
        { type: 'score-threshold', threshold: 7.5 },
        { type: 'no-issues' },
        { type: 'stagnation', delta: 0.5 },
      ],
    },
  ],
};
