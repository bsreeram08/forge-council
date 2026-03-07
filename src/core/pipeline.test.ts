import { describe, test, expect } from 'bun:test';
import {
  evaluateCondition,
  evaluateExitConditions,
  executePipeline,
  registerPhaseHandler,
  validatePipeline,
  createInitialState,
  mergePipelines,
  DEFAULT_PIPELINE,
  type PipelineConfig,
  type PipelineState,
  type PhaseResult,
} from './pipeline.ts';

// ---------------------------------------------------------------------------
// evaluateCondition
// ---------------------------------------------------------------------------

describe('evaluateCondition', () => {
  const baseState = createInitialState('test', 'Build an app');

  test('always returns true', () => {
    expect(evaluateCondition({ type: 'always' }, baseState)).toBe(true);
  });

  test('has-issues returns false when no reviews', () => {
    expect(evaluateCondition({ type: 'has-issues' }, baseState)).toBe(false);
  });

  test('has-issues returns true when reviews have issues', () => {
    const state: PipelineState = {
      ...baseState,
      reviews: [{
        score: 5,
        verdict: 'fix',
        issues: [{ id: 'i1', severity: 'critical', file: 'a.ts', line: null, what: 'bad', fix: 'fix it' }],
      }],
    };
    expect(evaluateCondition({ type: 'has-issues' }, state)).toBe(true);
  });

  test('score-below returns true when no scores', () => {
    expect(evaluateCondition({ type: 'score-below', threshold: 7.5 }, baseState)).toBe(true);
  });

  test('score-below returns false when score above threshold', () => {
    const state: PipelineState = { ...baseState, scores: [8.0] };
    expect(evaluateCondition({ type: 'score-below', threshold: 7.5 }, state)).toBe(false);
  });

  test('input-vague detects short inputs', () => {
    const vagueState = createInitialState('test', 'fix it');
    expect(evaluateCondition({ type: 'input-vague' }, vagueState)).toBe(true);
  });

  test('input-vague returns false for detailed inputs', () => {
    const detailedState = createInitialState('test', 'Build a REST API with authentication and rate limiting');
    expect(evaluateCondition({ type: 'input-vague' }, detailedState)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateExitConditions
// ---------------------------------------------------------------------------

describe('evaluateExitConditions', () => {
  const baseState = createInitialState('test', 'Build an app');

  test('score-threshold met', () => {
    const state: PipelineState = { ...baseState, scores: [8.0] };
    expect(evaluateExitConditions(
      [{ type: 'score-threshold', threshold: 7.5 }],
      state,
    )).toBe(true);
  });

  test('score-threshold not met', () => {
    const state: PipelineState = { ...baseState, scores: [5.0] };
    expect(evaluateExitConditions(
      [{ type: 'score-threshold', threshold: 7.5 }],
      state,
    )).toBe(false);
  });

  test('no-issues when reviews are clean', () => {
    const state: PipelineState = {
      ...baseState,
      reviews: [{ score: 8, verdict: 'approve', issues: [] }],
    };
    expect(evaluateExitConditions(
      [{ type: 'no-issues' }],
      state,
    )).toBe(true);
  });

  test('stagnation detected when scores plateau', () => {
    const state: PipelineState = { ...baseState, scores: [6.0, 6.2] };
    expect(evaluateExitConditions(
      [{ type: 'stagnation', delta: 0.5 }],
      state,
    )).toBe(true);
  });

  test('stagnation not detected with significant improvement', () => {
    const state: PipelineState = { ...baseState, scores: [5.0, 7.0] };
    expect(evaluateExitConditions(
      [{ type: 'stagnation', delta: 0.5 }],
      state,
    )).toBe(false);
  });

  test('max-rounds reached', () => {
    const state: PipelineState = { ...baseState, round: 3 };
    expect(evaluateExitConditions(
      [{ type: 'max-rounds', max: 3 }],
      state,
    )).toBe(true);
  });

  test('any condition met is sufficient', () => {
    const state: PipelineState = { ...baseState, scores: [8.0], round: 1 };
    expect(evaluateExitConditions([
      { type: 'score-threshold', threshold: 7.5 },
      { type: 'max-rounds', max: 5 },
    ], state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validatePipeline
// ---------------------------------------------------------------------------

describe('validatePipeline', () => {
  test('default pipeline is valid', () => {
    const errors = validatePipeline(DEFAULT_PIPELINE);
    expect(errors).toHaveLength(0);
  });

  test('detects duplicate phase IDs', () => {
    const pipeline: PipelineConfig = {
      phases: [
        { id: 'a', name: 'A', handler: 'classify', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
        { id: 'a', name: 'A2', handler: 'plan', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
      ],
      loops: [],
    };
    const errors = validatePipeline(pipeline);
    expect(errors).toContain('Duplicate phase IDs found');
  });

  test('detects invalid loop references', () => {
    const pipeline: PipelineConfig = {
      phases: [
        { id: 'a', name: 'A', handler: 'classify', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
      ],
      loops: [
        { startPhase: 'nonexistent', endPhase: 'a', maxRounds: 3, exitWhen: [] },
      ],
    };
    const errors = validatePipeline(pipeline);
    expect(errors.some(e => e.includes('nonexistent'))).toBe(true);
  });

  test('detects reversed loop order', () => {
    const pipeline: PipelineConfig = {
      phases: [
        { id: 'b', name: 'B', handler: 'plan', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
        { id: 'a', name: 'A', handler: 'classify', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
      ],
      loops: [
        { startPhase: 'a', endPhase: 'b', maxRounds: 3, exitWhen: [] },
      ],
    };
    const errors = validatePipeline(pipeline);
    expect(errors.some(e => e.includes('must come before'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executePipeline
// ---------------------------------------------------------------------------

describe('executePipeline', () => {
  test('executes phases in order', async () => {
    const executed: string[] = [];

    registerPhaseHandler('test-a', async (ctx) => {
      executed.push('a');
      return { stateUpdates: {} };
    });
    registerPhaseHandler('test-b', async (ctx) => {
      executed.push('b');
      return { stateUpdates: {} };
    });

    const pipeline: PipelineConfig = {
      phases: [
        { id: 'p1', name: 'Phase 1', handler: 'test-a', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
        { id: 'p2', name: 'Phase 2', handler: 'test-b', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
      ],
      loops: [],
    };

    const state = createInitialState('test', 'hello');
    await executePipeline(pipeline, state);

    expect(executed).toEqual(['a', 'b']);
  });

  test('skips phases with unmet conditions', async () => {
    const executed: string[] = [];

    registerPhaseHandler('test-run', async () => {
      executed.push('run');
      return { stateUpdates: {} };
    });
    registerPhaseHandler('test-skip', async () => {
      executed.push('skipped');
      return { stateUpdates: {} };
    });

    const pipeline: PipelineConfig = {
      phases: [
        { id: 'p1', name: 'Run', handler: 'test-run', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
        { id: 'p2', name: 'Skip', handler: 'test-skip', agents: [], parallel: false, condition: { type: 'has-issues' }, dynamicAgents: false },
      ],
      loops: [],
    };

    const state = createInitialState('test', 'hello');
    await executePipeline(pipeline, state);

    expect(executed).toEqual(['run']);
  });

  test('halts when handler returns halt', async () => {
    const executed: string[] = [];

    registerPhaseHandler('test-halt', async () => {
      executed.push('halt');
      return { stateUpdates: {}, halt: true };
    });
    registerPhaseHandler('test-after', async () => {
      executed.push('after');
      return { stateUpdates: {} };
    });

    const pipeline: PipelineConfig = {
      phases: [
        { id: 'p1', name: 'Halt', handler: 'test-halt', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
        { id: 'p2', name: 'After', handler: 'test-after', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
      ],
      loops: [],
    };

    const state = createInitialState('test', 'hello');
    await executePipeline(pipeline, state);

    expect(executed).toEqual(['halt']);
  });

  test('resumes from a given phase', async () => {
    const executed: string[] = [];

    registerPhaseHandler('test-first', async () => {
      executed.push('first');
      return { stateUpdates: {} };
    });
    registerPhaseHandler('test-second', async () => {
      executed.push('second');
      return { stateUpdates: {} };
    });

    const pipeline: PipelineConfig = {
      phases: [
        { id: 'p1', name: 'First', handler: 'test-first', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
        { id: 'p2', name: 'Second', handler: 'test-second', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
      ],
      loops: [],
    };

    const state = createInitialState('test', 'hello');
    state.currentPhaseId = 'p2'; // Resume from p2
    await executePipeline(pipeline, state);

    expect(executed).toEqual(['second']);
  });

  test('passes agentIds to handler', async () => {
    let receivedAgents: string[] = [];

    registerPhaseHandler('test-agents', async (ctx) => {
      receivedAgents = ctx.agentIds;
      return { stateUpdates: {} };
    });

    const pipeline: PipelineConfig = {
      phases: [
        {
          id: 'p1',
          name: 'Agents',
          handler: 'test-agents',
          agents: [
            { agentId: 'architect', required: true },
            { agentId: 'planner', required: false },
          ],
          parallel: true,
          condition: { type: 'always' },
          dynamicAgents: false,
        },
      ],
      loops: [],
    };

    const state = createInitialState('test', 'hello');
    await executePipeline(pipeline, state);

    expect(receivedAgents).toEqual(['architect', 'planner']);
  });
});

// ---------------------------------------------------------------------------
// mergePipelines
// ---------------------------------------------------------------------------

describe('mergePipelines', () => {
  test('returns base when no overrides', () => {
    const result = mergePipelines(DEFAULT_PIPELINE, {});
    expect(result).toBe(DEFAULT_PIPELINE);
  });

  test('overrides phases completely', () => {
    const custom: PipelineConfig = {
      phases: [
        { id: 'only', name: 'Only', handler: 'classify', agents: [], parallel: false, condition: { type: 'always' }, dynamicAgents: false },
      ],
      loops: [],
    };
    const result = mergePipelines(DEFAULT_PIPELINE, custom);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.id).toBe('only');
  });
});
