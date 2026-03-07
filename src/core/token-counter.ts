// ---------------------------------------------------------------------------
// Token counting and cost estimation
// ---------------------------------------------------------------------------

// Rough estimation: 1 token ~= 4 characters for English text
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Cost tracking per session
// ---------------------------------------------------------------------------

interface ModelCost {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_COSTS: Record<string, ModelCost> = {
  'claude-opus-4-6': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5': { inputPer1M: 0.80, outputPer1M: 4 },
  'gpt-5.1': { inputPer1M: 10, outputPer1M: 30 },
  'gpt-5.1-mini': { inputPer1M: 0.40, outputPer1M: 1.60 },
};

function getCostForModel(modelId: string): ModelCost {
  // Try exact match, then partial match
  if (MODEL_COSTS[modelId]) return MODEL_COSTS[modelId];
  for (const [key, cost] of Object.entries(MODEL_COSTS)) {
    if (modelId.includes(key)) return cost;
  }
  // Default to sonnet pricing as middle ground
  return MODEL_COSTS['claude-sonnet-4-6']!;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  modelId: string;
  phase: string;
  agentId: string;
}

export class TokenCounter {
  private entries: TokenUsage[] = [];

  record(usage: TokenUsage): void {
    this.entries.push(usage);
  }

  get totalInput(): number {
    return this.entries.reduce((sum, e) => sum + e.inputTokens, 0);
  }

  get totalOutput(): number {
    return this.entries.reduce((sum, e) => sum + e.outputTokens, 0);
  }

  get totalTokens(): number {
    return this.totalInput + this.totalOutput;
  }

  get estimatedCost(): number {
    let total = 0;
    for (const entry of this.entries) {
      const cost = getCostForModel(entry.modelId);
      total += (entry.inputTokens / 1_000_000) * cost.inputPer1M;
      total += (entry.outputTokens / 1_000_000) * cost.outputPer1M;
    }
    return Math.round(total * 100) / 100;
  }

  byPhase(): Record<string, { input: number; output: number; cost: number }> {
    const phases: Record<string, { input: number; output: number; cost: number }> = {};
    for (const entry of this.entries) {
      if (!phases[entry.phase]) phases[entry.phase] = { input: 0, output: 0, cost: 0 };
      const p = phases[entry.phase]!;
      const cost = getCostForModel(entry.modelId);
      p.input += entry.inputTokens;
      p.output += entry.outputTokens;
      p.cost += (entry.inputTokens / 1_000_000) * cost.inputPer1M
        + (entry.outputTokens / 1_000_000) * cost.outputPer1M;
    }
    // Round costs
    for (const p of Object.values(phases)) {
      p.cost = Math.round(p.cost * 100) / 100;
    }
    return phases;
  }

  summary(): string {
    const lines = [
      `Tokens: ${this.totalInput.toLocaleString()} in / ${this.totalOutput.toLocaleString()} out`,
      `Total: ${this.totalTokens.toLocaleString()} tokens`,
      `Cost: ~$${this.estimatedCost.toFixed(2)}`,
    ];
    const phases = this.byPhase();
    if (Object.keys(phases).length > 1) {
      lines.push('', 'By phase:');
      for (const [phase, data] of Object.entries(phases)) {
        lines.push(`  ${phase}: ${(data.input + data.output).toLocaleString()} tokens (~$${data.cost.toFixed(2)})`);
      }
    }
    return lines.join('\n');
  }

  reset(): void {
    this.entries = [];
  }
}
