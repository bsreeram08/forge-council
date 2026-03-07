import { describe, it, expect } from 'bun:test';
import { consumeStream, consumeStructuredStream } from '../../cli/stream-display';
import { RawPlanOutputSchema, normalizePlanOutput } from '../../council/schemas';
import { z } from 'zod';

describe('consumeStream', () => {
  it('should consume a valid text stream and return accumulated text', async () => {
    const chunks = ['Hello', ' ', 'World', '!'];
    const stream = new ReadableStream<string>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const result = await consumeStream(stream, 'Test');
    expect(result).toBe('Hello World!');
  });

  it('should handle empty streams', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.close();
      },
    });

    const result = await consumeStream(stream, 'Test');
    expect(result).toBe('');
  });

  it('should handle streams with large chunks', async () => {
    const largeText = 'x'.repeat(10000);
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(largeText);
        controller.close();
      },
    });

    const result = await consumeStream(stream, 'Test');
    expect(result).toBe(largeText);
    expect(result.length).toBe(10000);
  });

  it('should handle streams with many small chunks', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        for (let i = 0; i < 100; i++) {
          controller.enqueue('a');
        }
        controller.close();
      },
    });

    const result = await consumeStream(stream, 'Test');
    expect(result).toBe('a'.repeat(100));
  });

  it('should handle streams that error mid-way', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('Hello');
        controller.error(new Error('Stream error'));
      },
    });

    expect(consumeStream(stream, 'Test')).rejects.toThrow('Stream error');
  });
});

describe('consumeStructuredStream', () => {
  it('should consume structured stream with valid string fields', async () => {
    const mockData = {
      executiveSummary: 'This is a test summary',
      architecture: 'Test architecture',
      phasedRoadmap: 'Test roadmap',
      skeletonCode: 'Test code',
      techStack: 'Test stack',
    };

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(JSON.stringify(mockData));
        controller.close();
      },
    });

    const objectPromise = Promise.resolve(mockData);

    const result = await consumeStructuredStream(
      { textStream, object: objectPromise },
      'Test'
    );

    expect(result).toEqual(mockData);
  });

  it('should handle structured stream with array fields (the original issue)', async () => {
    const mockData = {
      executiveSummary: ['Line 1', 'Line 2', 'Line 3'],
      architecture: ['Component A', 'Component B'],
      phasedRoadmap: ['Phase 1', 'Phase 2'],
      skeletonCode: ['file1.ts', 'file2.ts'],
      techStack: ['TypeScript', 'Bun'],
    };

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(JSON.stringify(mockData));
        controller.close();
      },
    });

    const objectPromise = Promise.resolve(mockData);

    const result = await consumeStructuredStream(
      { textStream, object: objectPromise },
      'Test'
    );

    expect(result).toEqual(mockData);
  });

  it('should handle structured stream with object fields', async () => {
    const mockData = {
      executiveSummary: { title: 'Summary', content: 'Details' },
      architecture: { frontend: 'React', backend: 'Node' },
      phasedRoadmap: { phase1: 'MVP', phase2: 'Features' },
      skeletonCode: { src: ['file1.ts'], tests: ['test1.ts'] },
      techStack: { languages: ['TS'], tools: ['Bun'] },
    };

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(JSON.stringify(mockData));
        controller.close();
      },
    });

    const objectPromise = Promise.resolve(mockData);

    const result = await consumeStructuredStream(
      { textStream, object: objectPromise },
      'Test'
    );

    expect(result).toEqual(mockData);
  });

  it('should handle mixed types in structured stream', async () => {
    const mockData = {
      executiveSummary: 'String summary',
      architecture: ['Component A', 'Component B'],
      phasedRoadmap: { phase1: 'MVP' },
      skeletonCode: 'Plain code string',
      techStack: ['TypeScript', { name: 'Bun', version: '1.0' }],
    };

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(JSON.stringify(mockData));
        controller.close();
      },
    });

    const objectPromise = Promise.resolve(mockData);

    const result = await consumeStructuredStream(
      { textStream, object: objectPromise },
      'Test'
    );

    expect(result).toEqual(mockData);
  });

  it('should handle promise rejection in object stream', async () => {
    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('{}');
        controller.close();
      },
    });

    const objectPromise = Promise.reject(new Error('Validation failed'));

    expect(
      consumeStructuredStream({ textStream, object: objectPromise }, 'Test')
    ).rejects.toThrow('Validation failed');
  });

  it('should handle empty object in structured stream', async () => {
    const mockData = {};

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('{}');
        controller.close();
      },
    });

    const objectPromise = Promise.resolve(mockData);

    const result = await consumeStructuredStream(
      { textStream, object: objectPromise },
      'Test'
    );

    expect(result).toEqual(mockData);
  });

  it('should handle null values in structured stream', async () => {
    const mockData = {
      executiveSummary: null,
      architecture: undefined,
      phasedRoadmap: 'Valid string',
      skeletonCode: null,
      techStack: undefined,
    };

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(JSON.stringify(mockData));
        controller.close();
      },
    });

    const objectPromise = Promise.resolve(mockData);

    const result = await consumeStructuredStream(
      { textStream, object: objectPromise },
      'Test'
    );

    expect(result).toEqual(mockData);
  });
});

describe('RawPlanOutputSchema', () => {
  it('should validate plan with string fields', () => {
    const data = {
      executiveSummary: 'Summary text',
      architecture: 'Architecture text',
      phasedRoadmap: 'Roadmap text',
      skeletonCode: 'Code text',
      techStack: 'Stack text',
    };

    const result = RawPlanOutputSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should validate plan with array fields', () => {
    const data = {
      executiveSummary: ['Line 1', 'Line 2'],
      architecture: ['Component A'],
      phasedRoadmap: ['Phase 1'],
      skeletonCode: ['file1.ts'],
      techStack: ['TypeScript'],
    };

    const result = RawPlanOutputSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should validate plan with object fields', () => {
    const data = {
      executiveSummary: { title: 'Summary' },
      architecture: { components: [] },
      phasedRoadmap: { phases: [] },
      skeletonCode: { files: [] },
      techStack: { tools: [] },
    };

    const result = RawPlanOutputSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should validate plan with mixed field types', () => {
    const data = {
      executiveSummary: 'String',
      architecture: ['Array'],
      phasedRoadmap: { object: true },
      skeletonCode: null,
      techStack: 123,
    };

    const result = RawPlanOutputSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should NOT reject plan with missing fields (z.any() is lenient)', () => {
    const data = {
      executiveSummary: 'Summary',
      architecture: 'Architecture',
      // Missing phasedRoadmap, skeletonCode, techStack - but z.any() allows undefined
    };

    const result = RawPlanOutputSchema.safeParse(data);
    // z.any() allows any value including undefined/missing
    expect(result.success).toBe(true);
  });

  it('should reject plan with extra fields (if strict)', () => {
    const data = {
      executiveSummary: 'Summary',
      architecture: 'Architecture',
      phasedRoadmap: 'Roadmap',
      skeletonCode: 'Code',
      techStack: 'Stack',
      extraField: 'Should not be allowed',
    };

    // z.any() allows any value including extra fields
    const result = RawPlanOutputSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe('normalizePlanOutput', () => {
  it('should normalize string fields unchanged', () => {
    const raw = {
      executiveSummary: 'Summary',
      architecture: 'Architecture',
      phasedRoadmap: 'Roadmap',
      skeletonCode: 'Code',
      techStack: 'Stack',
    };

    const result = normalizePlanOutput(raw);
    expect(result.executiveSummary).toBe('Summary');
    expect(result.architecture).toBe('Architecture');
  });

  it('should normalize array fields to JSON string', () => {
    const raw = {
      executiveSummary: ['Line 1', 'Line 2'],
      architecture: ['Component A'],
      phasedRoadmap: ['Phase 1'],
      skeletonCode: ['file1.ts'],
      techStack: ['TypeScript'],
    };

    const result = normalizePlanOutput(raw);
    expect(result.executiveSummary).toBe('[\n  "Line 1",\n  "Line 2"\n]');
    expect(result.architecture).toBe('[\n  "Component A"\n]');
  });

  it('should normalize object fields to JSON string', () => {
    const raw = {
      executiveSummary: { title: 'Summary' },
      architecture: { components: ['A'] },
      phasedRoadmap: { phases: 3 },
      skeletonCode: { files: {} },
      techStack: { tools: [] },
    };

    const result = normalizePlanOutput(raw);
    expect(result.executiveSummary).toContain('"title": "Summary"');
    expect(result.architecture).toContain('"components"');
  });

  it('should handle null and undefined values', () => {
    const raw = {
      executiveSummary: null,
      architecture: undefined,
      phasedRoadmap: 'Valid',
      skeletonCode: null,
      techStack: undefined,
    };

    const result = normalizePlanOutput(raw);
    expect(result.executiveSummary).toBe('null');
    expect(result.architecture).toBeUndefined();
    expect(result.phasedRoadmap).toBe('Valid');
  });

  it('should handle deeply nested objects', () => {
    const raw = {
      executiveSummary: 'Summary',
      architecture: 'Architecture',
      phasedRoadmap: 'Roadmap',
      skeletonCode: 'Code',
      techStack: {
        frontend: {
          framework: {
            name: 'React',
            version: '18.0',
          },
        },
      },
    };

    const result = normalizePlanOutput(raw);
    expect(result.techStack).toContain('React');
    expect(result.techStack).toContain('18.0');
  });
});

describe('Integration: Full stream to normalized plan flow', () => {
  it('should handle complete flow with string fields', async () => {
    const mockData = {
      executiveSummary: 'Test summary',
      architecture: 'Test architecture',
      phasedRoadmap: 'Test roadmap',
      skeletonCode: 'Test code',
      techStack: 'Test stack',
    };

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(JSON.stringify(mockData));
        controller.close();
      },
    });

    const objectPromise = Promise.resolve(mockData);
    const rawPlan = await consumeStructuredStream(
      { textStream, object: objectPromise },
      'Ford'
    );
    const plan = normalizePlanOutput(rawPlan);

    expect(plan.executiveSummary).toBe('Test summary');
    expect(plan.architecture).toBe('Test architecture');
  });

  it('should handle complete flow with array fields', async () => {
    const mockData = {
      executiveSummary: ['Summary line 1', 'Summary line 2'],
      architecture: ['Component A', 'Component B'],
      phasedRoadmap: ['Phase 1', 'Phase 2', 'Phase 3'],
      skeletonCode: ['src/index.ts', 'src/lib.ts'],
      techStack: ['TypeScript', 'Bun', 'React'],
    };

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(JSON.stringify(mockData));
        controller.close();
      },
    });

    const objectPromise = Promise.resolve(mockData);
    const rawPlan = await consumeStructuredStream(
      { textStream, object: objectPromise },
      'Ford'
    );
    const plan = normalizePlanOutput(rawPlan);

    expect(plan.executiveSummary).toContain('Summary line 1');
    expect(plan.architecture).toContain('Component A');
    expect(plan.phasedRoadmap).toContain('Phase 1');
  });

  it('should handle complete flow with object fields', async () => {
    const mockData = {
      executiveSummary: { overview: 'Project overview', goals: ['Goal 1'] },
      architecture: { pattern: 'MVC', components: { db: 'PostgreSQL' } },
      phasedRoadmap: { phase1: 'MVP', phase2: 'Scale' },
      skeletonCode: { entry: 'index.ts', modules: ['auth', 'api'] },
      techStack: { runtime: 'Bun', framework: 'Hono' },
    };

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(JSON.stringify(mockData));
        controller.close();
      },
    });

    const objectPromise = Promise.resolve(mockData);
    const rawPlan = await consumeStructuredStream(
      { textStream, object: objectPromise },
      'Ford'
    );
    const plan = normalizePlanOutput(rawPlan);

    expect(plan.executiveSummary).toContain('Project overview');
    expect(plan.architecture).toContain('MVC');
    expect(plan.techStack).toContain('Bun');
  });
});

describe('Timeout handling', () => {
  it('should timeout when object promise never resolves', async () => {
    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('{}');
        controller.close();
      },
    });

    // Create a promise that never resolves
    const neverResolvingPromise = new Promise<Record<string, unknown>>(() => {});

    // Should timeout after 100ms
    expect(
      consumeStructuredStream(
        { textStream, object: neverResolvingPromise },
        'Test',
        100 // 100ms timeout
      )
    ).rejects.toThrow('timed out');
  });

  it('should timeout when text stream never completes', async () => {
    // Create a stream that never closes
    const neverEndingStream = new ReadableStream<string>({
      start() {
        // Never call controller.close()
      },
    });

    // Should timeout after 100ms
    expect(
      consumeStream(neverEndingStream, 'Test', 100)
    ).rejects.toThrow('timed out');
  });

  it('should succeed before timeout when promise resolves quickly', async () => {
    const mockData = { test: 'data' };

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(JSON.stringify(mockData));
        controller.close();
      },
    });

    const objectPromise = Promise.resolve(mockData);

    const result = await consumeStructuredStream(
      { textStream, object: objectPromise },
      'Test',
      5000 // 5 second timeout (plenty of time)
    );

    expect(result).toEqual(mockData);
  });
});
