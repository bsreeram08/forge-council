import { describe, test, expect } from 'bun:test';
import { assemblePrompt, buildMessages, buildAgentMessages } from './prompt-assembler.ts';
import type { IntentClassification, MergedPlan, PlanContribution } from './schemas.ts';
import type { AssembledContext } from './context-assembler.ts';

const mockClassification: IntentClassification = {
  taskType: 'greenfield',
  domains: ['api'],
  contextNeeded: {
    filePatterns: [],
    gitLogCount: 0,
    gitLogFilter: null,
    includeProjectStructure: false,
    includeDependencies: false,
    externalDocs: [],
  },
  complexity: 'moderate',
};

const mockContext: AssembledContext = {
  files: [{ path: 'src/index.ts', content: 'console.log("hi")', tokens: 5 }],
  gitLog: ['abc1234 initial commit'],
  projectStructure: './src\n./src/index.ts',
  dependencies: '{"name": "test"}',
  externalDocs: [],
  totalTokens: 50,
};

const emptyContext: AssembledContext = {
  files: [],
  gitLog: [],
  projectStructure: '',
  dependencies: '',
  externalDocs: [],
  totalTokens: 0,
};

describe('assemblePrompt', () => {
  test('produces all 3 layers for plan phase', () => {
    const layers = assemblePrompt({
      agentId: 'architect',
      idea: 'Build a todo app',
      phase: 'plan',
      classification: mockClassification,
      context: emptyContext,
    });

    expect(layers.general).toContain('Torvalds');
    expect(layers.general).toContain('System Architect');
    expect(layers.intent).toContain('Build a todo app');
    expect(layers.intent).toContain('greenfield');
    expect(layers.plan).toBeUndefined();
  });

  test('includes user guidance in Layer 2', () => {
    const layers = assemblePrompt({
      agentId: 'planner',
      idea: 'Build a chat app',
      phase: 'plan',
      classification: mockClassification,
      context: emptyContext,
      userGuidance: 'Focus on real-time features',
    });

    expect(layers.intent).toContain('User Guidance');
    expect(layers.intent).toContain('Focus on real-time features');
  });

  test('adds Layer 4 for pass 2', () => {
    const plan: MergedPlan = {
      summary: 'Test plan',
      categories: [],
      techStack: {},
      phases: [],
    };
    const contributions: PlanContribution[] = [{
      agentId: 'architect',
      items: [{ id: 'a1', category: 'Arch', title: 'API', description: 'API layer', priority: 'must', phase: 1 }],
      techSuggestions: [],
    }];

    const layers = assemblePrompt({
      agentId: 'architect',
      idea: 'Build an app',
      phase: 'plan',
      classification: mockClassification,
      context: emptyContext,
      pass2Plan: plan,
      pass1Contributions: contributions,
    });

    expect(layers.plan).toBeDefined();
    expect(layers.plan).toContain('First Draft Plan');
    expect(layers.plan).toContain('2 out of 3 agents agree');
    expect(layers.plan).toContain('architect');
  });
});

describe('buildMessages', () => {
  test('produces system + user messages', () => {
    const layers = assemblePrompt({
      agentId: 'coder',
      idea: 'Build a CLI tool',
      phase: 'code',
      classification: mockClassification,
      context: mockContext,
    });

    const messages = buildMessages(layers);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');

    const userContent = messages[1]!.content as string;
    expect(userContent).toContain('Build a CLI tool');
    expect(userContent).toContain('src/index.ts');
    expect(userContent).toContain('initial commit');
  });

  test('appends task instructions to user message', () => {
    const layers = assemblePrompt({
      agentId: 'coder',
      idea: 'Build X',
      phase: 'code',
      classification: mockClassification,
      context: emptyContext,
    });

    const messages = buildMessages(layers, 'Implement the API endpoint');
    const userContent = messages[1]!.content as string;
    expect(userContent).toContain('Implement the API endpoint');
  });
});

describe('buildAgentMessages', () => {
  test('is a convenience wrapper', () => {
    const messages = buildAgentMessages({
      agentId: 'reviewer',
      idea: 'Review this',
      phase: 'review',
      classification: mockClassification,
      context: emptyContext,
      taskInstructions: 'Check for bugs',
    });

    expect(messages).toHaveLength(2);
    const userContent = messages[1]!.content as string;
    expect(userContent).toContain('Check for bugs');
  });
});
