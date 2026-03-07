import * as p from '@clack/prompts';
import { Agent } from '@mastra/core/agent';
import type { ForgeCouncilConfig } from '../../config/schema.ts';
import type { PlanOutput, ScoreCard, GoalAncestry, AgentReview, ClarificationOutput, ClarifiedRequirements } from '../../council/schemas.ts';
import { RawPlanOutputSchema, normalizePlanOutput, ClarificationOutputSchema } from '../../council/schemas.ts';
import { buildScoreCard } from '../../council/scorer.ts';
import { anonymizeReviews, anonymizeConcerns } from '../../council/anonymizer.ts';
import { runParallelReviews } from '../../council/parallel-review.ts';
import { runFreshEyes } from '../../council/fresh-eyes.ts';
import { sessionManager, logBuffer } from '../../server/session.ts';
import { eventBus } from '../../server/routes/ws.ts';
import { getRegistry } from '../../council/agent-registry.ts';
import { logError } from '../../errors/logger.ts';
import { initStreamDisplay, destroyStreamDisplay, printStreamHint, consumeStructuredStream, pauseStreamDisplay } from '../../cli/stream-display.ts';

function log(level: 'info' | 'agent' | 'score' | 'error' | 'system', source: string, message: string): void {
  logBuffer.append(level, source, message);
}

function buildPlanPrompt(idea: string, guidance: string[], round: number, feedback?: string): string {
  const parts = [
    `## Engineering Plan Request`,
    ``,
    `Create a comprehensive engineering plan with skeleton code for the following idea:`,
    `"${idea}"`,
  ];

  if (guidance.length > 0) {
    parts.push(``, `### User Guidance`, ...guidance.map((g) => `- ${g}`));
  }

  if (round > 1 && feedback) {
    parts.push(
      ``,
      `### Previous Round Feedback (Round ${round - 1})`,
      ``,
      `The following anonymized feedback was provided by the council. Address each concern in your revised plan:`,
      ``,
      feedback,
    );
  }

  parts.push(
    ``,
    `### Required Output Structure`,
    ``,
    `Respond with a JSON object containing these sections:`,
    `1. executiveSummary — what we're building and why`,
    `2. architecture — system design, components, data flow`,
    `3. phasedRoadmap — Phase 1 MVP scope, Phase 2+`,
    `4. skeletonCode — key files with function signatures, types, folder structure`,
    `5. techStack — chosen technologies with rationale`,
  );

  return parts.join('\n');
}

function formatAnonymizedFeedback(reviews: AgentReview[]): string {
  const anonymized = anonymizeReviews(reviews);
  const concerns = anonymizeConcerns(reviews);

  const parts: string[] = [];

  for (const review of anonymized) {
    parts.push(
      `---`,
      `Score: ${review.weightedScore.toFixed(1)}/10 | Verdict: ${review.verdict}`,
      `${review.summary}`,
    );

    if (review.concerns.length > 0) {
      parts.push(`Concerns:`, ...review.concerns.map((c) => `  - ${c}`));
    }

    if (review.suggestions.length > 0) {
      parts.push(`Suggestions:`, ...review.suggestions.map((s) => `  - ${s}`));
    }

    parts.push(``);
  }

  if (concerns.length > 0) {
    parts.push(`Top Concerns (aggregated):`, ...concerns.map((c) => `  - ${c}`));
  }

  return parts.join('\n');
}

function formatScoreCard(scoreCard: ScoreCard, threshold: number): string {
  const lines: string[] = [
    `Mean: ${scoreCard.mean.toFixed(2)} / ${threshold}  ${scoreCard.passed ? 'PASSED' : 'BELOW THRESHOLD'}`,
    ``,
  ];

  for (const [agentId, score] of Object.entries(scoreCard.agentScores)) {
    const bar = makeBar(score, 10);
    lines.push(`  ${agentId.padEnd(12)} ${bar} ${score.toFixed(1)}`);
  }

  if (scoreCard.stagnated) {
    lines.push(``, `Stagnation detected — scores are not improving.`);
  }

  return lines.join('\n');
}

function makeBar(value: number, max: number, width = 20): string {
  const filled = Math.round((value / max) * width);
  const empty = width - filled;
  return `[${'='.repeat(filled)}${' '.repeat(empty)}]`;
}

function formatReviewSummary(reviews: AgentReview[]): string {
  const lines: string[] = [];

  for (const review of reviews) {
    lines.push(
      `${review.codename} (${review.agentId}): ${review.weightedScore.toFixed(1)}/10 — ${review.verdict}`,
      `  ${review.summary}`,
    );

    if (review.concerns.length > 0) {
      for (const concern of review.concerns.slice(0, 3)) {
        lines.push(`    - ${concern}`);
      }
    }

    lines.push(``);
  }

  return lines.join('\n');
}

export interface ResumeState {
  startRound: number;
  lastPlan: PlanOutput | null;
  lastScoreCards: ScoreCard[];
  clarifiedRequirements?: ClarifiedRequirements;
}

async function analyzeWithScout(
  scoutAgent: Agent,
  idea: string,
): Promise<ClarificationOutput> {
  const prompt = `Analyze this project idea for clarity and completeness:

\"\"\"${idea}\"\"\"

Determine if this prompt is clear enough to proceed with planning. A clear prompt should specify:
1. WHAT specifically should be built (specific features, not vague terms like "something" or "feature")
2. WHO the target user is (the audience for this product)
3. KEY constraints: technology preferences, timeline, or scope limitations

Respond with a JSON object containing:
{
  "isClear": boolean,        // true if prompt has sufficient detail
  "isVague": boolean,        // true if prompt lacks critical information
  "questions": string[],     // 2-3 targeted questions if clarification needed, empty array if clear
  "clarifiedIdea": string,   // your best interpretation of what they want to build
  "reasoning": string        // brief explanation of your assessment
}`;

  try {
    const streamResult = await scoutAgent.stream(prompt, {
      structuredOutput: { schema: ClarificationOutputSchema },
    });
    return await consumeStructuredStream(streamResult, 'Scout');
  } catch (err) {
    log('error', 'scout', `Scout analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      isClear: true,
      isVague: false,
      questions: [],
      clarifiedIdea: idea,
      reasoning: 'Scout analysis failed, proceeding with original prompt',
    };
  }
}

async function runClarificationFlow(
  idea: string,
  scoutAgent: Agent,
  maxRounds = 3,
): Promise<ClarifiedRequirements> {
  let currentIdea = idea;
  let rounds = 0;
  const qaHistory: Array<{ question: string; answer: string }> = [];

  const clarifySpinner = p.spinner();
  clarifySpinner.start('Scout is analyzing your request...');

  while (rounds < maxRounds) {
    rounds++;
    log('agent', 'scout', `Clarification round ${rounds}/${maxRounds}`);

    const analysis = await analyzeWithScout(scoutAgent, currentIdea);

    // Fast path: prompt is clear
    if (analysis.isClear && !analysis.isVague) {
      clarifySpinner.stop(`Prompt is clear — proceeding to planning.`);
      log('agent', 'scout', 'Prompt determined to be clear, skipping clarification');

      return {
        originalIdea: idea,
        whatToBuild: analysis.clarifiedIdea,
        targetUser: 'General users (inferred from context)',
        constraints: {},
        keyFeatures: [],
        clarifyingQuestions: qaHistory,
        clarificationRounds: rounds,
      };
    }

    // Need clarification - show questions
    clarifySpinner.stop(`Clarification needed (round ${rounds}/${maxRounds})`);

    if (analysis.questions.length === 0) {
      // Scout found it vague but didn't generate questions - use defaults
      analysis.questions = [
        'What specifically should be built? Describe the key features.',
        'Who is the target user or audience?',
        'What are the key constraints (tech stack, timeline, or scope)?',
      ];
    }

    p.note(analysis.questions.map((q, i) => `${i + 1}. ${q}`).join('\\n'), `Scout has questions`);

    // Ask user for answers (limit to first 3 questions)
    const answers: string[] = [];
    for (let i = 0; i < Math.min(analysis.questions.length, 3); i++) {
      const answer = await p.text({
        message: `Q${i + 1}: ${analysis.questions[i]}`,
        placeholder: 'Your answer...',
      });

      if (p.isCancel(answer)) {
        throw new Error('User cancelled clarification');
      }

      answers.push(answer);
      qaHistory.push({ question: analysis.questions[i]!, answer });
    }

    // Synthesize the clarified idea
    currentIdea = `${idea}\\n\\nClarified requirements:\\n` +
      qaHistory.map((qa, i) => `Q${i + 1}: ${qa.question}\\nA: ${qa.answer}`).join('\\n\\n');

    log('agent', 'scout', `Received ${answers.length} clarifying answers`);

    // Re-analyze with Scout to see if we're done
    clarifySpinner.start('Scout is re-analyzing...');
  }

  // Max rounds reached - proceed with what we have
  clarifySpinner.stop(`Clarification complete (${rounds} rounds).`);
  log('agent', 'scout', `Max clarification rounds reached, proceeding with gathered requirements`);

  return {
    originalIdea: idea,
    whatToBuild: currentIdea,
    targetUser: 'To be determined from clarifications',
    constraints: {},
    keyFeatures: [],
    clarifyingQuestions: qaHistory,
    clarificationRounds: rounds,
  };
}

export async function clarifyAndRunRalphLoop(
  idea: string,
  config: ForgeCouncilConfig,
  resume?: ResumeState,
): Promise<{ plan: PlanOutput; scoreCards: ScoreCard[]; freshEyesReview?: AgentReview; clarifiedRequirements?: ClarifiedRequirements }> {
  const registry = getRegistry();
  
  // Check if we already have clarified requirements (from resume)
  let clarifiedRequirements = resume?.clarifiedRequirements;
  
  if (!clarifiedRequirements && !resume) {
    // Run clarification step
    const scoutAgent = registry.get('scout');
    
    if (scoutAgent) {
      try {
        clarifiedRequirements = await runClarificationFlow(idea, scoutAgent);
        log('system', 'scout', `Clarification complete: ${clarifiedRequirements.clarifyingQuestions.length} questions answered`);
      } catch (err) {
        if (err instanceof Error && err.message === 'User cancelled clarification') {
          throw err;
        }
        // If clarification fails, log and proceed with original idea
        log('error', 'scout', `Clarification failed: ${err instanceof Error ? err.message : String(err)}`);
        clarifiedRequirements = {
          originalIdea: idea,
          whatToBuild: idea,
          targetUser: '',
          constraints: {},
          keyFeatures: [],
          clarifyingQuestions: [],
          clarificationRounds: 0,
        };
      }
    } else {
      log('system', 'council', 'Scout agent not available, skipping clarification');
      clarifiedRequirements = {
        originalIdea: idea,
        whatToBuild: idea,
        targetUser: '',
        constraints: {},
        keyFeatures: [],
        clarifyingQuestions: [],
        clarificationRounds: 0,
      };
    }
  }
  
  // Now run the main Ralph Loop with clarified requirements
  const result = await runRalphLoop(
    clarifiedRequirements?.whatToBuild ?? idea,
    config,
    resume,
  );
  
  return {
    ...result,
    clarifiedRequirements,
  };
}

export async function runRalphLoop(
  idea: string,
  config: ForgeCouncilConfig,
  resume?: ResumeState,
): Promise<{ plan: PlanOutput; scoreCards: ScoreCard[]; freshEyesReview?: AgentReview }> {
  const { council } = config;
  const registry = getRegistry();
  const executorAgent = registry.getExecutor();
  const councilAgents = registry.getReviewers();
  if (councilAgents.length === 0) {
    throw new Error('No council agents available for review');
  }

  initStreamDisplay();
  printStreamHint();

  p.log.step(`Council assembled: ${councilAgents.map((a) => `${a.name} (${a.id})`).join(', ')}`);
  log('system', 'council', `Council assembled: ${councilAgents.map((a) => a.name).join(', ')}`);

  const scoreCards: ScoreCard[] = resume?.lastScoreCards ?? [];
  let currentPlan: PlanOutput | null = resume?.lastPlan ?? null;
  const startRound = resume?.startRound ?? 1;

  if (resume) {
    log('system', 'session', `Resuming from round ${startRound}. ${scoreCards.length} previous scores loaded.`);
  }

  for (let round = startRound; round <= council.maxRounds; round++) {
    const guidance = sessionManager.get()?.guidance ?? [];

    // Update session
    sessionManager.update({
      currentRound: round,
      activeAgents: ['executor'],
    });
    await sessionManager.save();
    eventBus.publish('round', { round, phase: 'planning' });

    // --- Plan Step: Ford creates/revises the plan ---
    const feedback = round > startRound || (resume && scoreCards.length > 0)
      ? (scoreCards.length > 0 ? formatAnonymizedFeedback(scoreCards[scoreCards.length - 1]!.reviews) : undefined)
      : (round > 1 && scoreCards.length > 0 ? formatAnonymizedFeedback(scoreCards[scoreCards.length - 1]!.reviews) : undefined);

    const isRevision = round > 1 || (resume && currentPlan !== null);
    const planPrompt = buildPlanPrompt(idea, guidance, round, feedback);

    const planSpinner = p.spinner();
    planSpinner.start(`Round ${round}/${council.maxRounds}: Ford is ${isRevision ? 'revising' : 'creating'} the plan...`);
    log('agent', 'ford', `Round ${round}: ${isRevision ? 'Revising' : 'Creating'} plan...`);

    try {
      const streamResult = await executorAgent.stream(planPrompt, {
        structuredOutput: { schema: RawPlanOutputSchema },
      });

      planSpinner.stop(`Round ${round}: Ford is streaming...`);

      try {
        const rawPlan = await consumeStructuredStream(streamResult, 'Ford');
        currentPlan = normalizePlanOutput(rawPlan);
      } catch (validationErr) {
        // Some models return objects instead of strings — normalize and retry parse
        const rawText = await streamResult.text;
        try {
          const rawObj = JSON.parse(rawText) as Record<string, unknown>;
          currentPlan = normalizePlanOutput(rawObj);
          log('info', 'ford', `Normalized plan output (model returned objects instead of strings)`);
        } catch {
          throw validationErr;
        }
      }

      p.log.success(`Round ${round}: Plan ${isRevision ? 'revised' : 'created'}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      planSpinner.stop(`Round ${round}: Plan generation failed.`);
      log('error', 'ford', `Plan generation failed: ${msg}`);
      logError('ralph-loop.plan', err, { round, idea });
      throw err;
    }

    // Persist plan
    sessionManager.savePlan(round, currentPlan);
    eventBus.publish('plan', { round, plan: currentPlan });

    // Show plan summary
    p.note(
      currentPlan.executiveSummary.slice(0, 500) + (currentPlan.executiveSummary.length > 500 ? '...' : ''),
      `Plan Summary (Round ${round})`,
    );

    // --- Review Step: Council reviews in parallel ---
    const ancestry: GoalAncestry = {
      idea,
      phase: 'Phase 1: MVP',
      task: `Review engineering plan (round ${round})`,
      round,
      previousScores: scoreCards.length > 0
        ? {
            mean: scoreCards[scoreCards.length - 1]!.mean,
            concerns: anonymizeConcerns(scoreCards[scoreCards.length - 1]!.reviews),
          }
        : undefined,
    };

    sessionManager.update({
      activeAgents: councilAgents.map((a) => a.id),
    });
    await sessionManager.save();
    eventBus.publish('round', { round, phase: 'reviewing' });
    log('system', 'council', `Round ${round}: Council reviewing (${councilAgents.map((a) => a.name).join(', ')})`);

    const reviewSpinner = p.spinner();
    reviewSpinner.start(`Round ${round}: Council reviewing (${councilAgents.map((a) => a.name).join(', ')})...`);

    let reviews: AgentReview[];
    try {
      reviews = await runParallelReviews(councilAgents, currentPlan, ancestry, config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reviewSpinner.stop(`Round ${round}: Review failed.`);
      log('error', 'council', `All reviews failed: ${msg}`);
      logError('ralph-loop.review', err, { round, idea });

      // Don't crash the entire session — skip scoring and continue to next round
      p.log.warn(`Round ${round}: All agent reviews failed. Skipping to next round.`);
      continue;
    }

    reviewSpinner.stop(`Round ${round}: ${reviews.length}/${councilAgents.length} reviews collected.`);

    // Log each review
    for (const review of reviews) {
      log('agent', review.agentId, `${review.codename}: ${review.weightedScore.toFixed(1)}/10 — ${review.verdict}`);
      if (review.concerns.length > 0) {
        log('agent', review.agentId, `Concerns: ${review.concerns.join('; ')}`);
      }
    }

    // Persist reviews
    sessionManager.saveReviews(round, reviews);

    // Show individual reviews
    p.note(formatReviewSummary(reviews), `Reviews (Round ${round})`);

    // --- Score Step: Aggregate and check ---
    const scoreCard = buildScoreCard(round, reviews, council.scoreThreshold, scoreCards);
    scoreCards.push(scoreCard);

    // Persist score
    sessionManager.saveScore(scoreCard);

    sessionManager.update({
      scores: [
        ...(sessionManager.get()?.scores ?? []),
        { round, mean: scoreCard.mean, agents: scoreCard.agentScores },
      ],
    });
    await sessionManager.save();
    eventBus.publish('score', { round, scoreCard });

    log('score', 'council', `Round ${round}: Mean ${scoreCard.mean.toFixed(2)} / ${council.scoreThreshold} — ${scoreCard.passed ? 'PASSED' : 'BELOW THRESHOLD'}`);

    // Show score card
    p.note(formatScoreCard(scoreCard, council.scoreThreshold), `Scores (Round ${round})`);

    if (scoreCard.passed) {
      p.log.success(`Round ${round}: Threshold passed! (${scoreCard.mean.toFixed(2)} >= ${council.scoreThreshold})`);
      log('system', 'council', `Threshold passed! Mean ${scoreCard.mean.toFixed(2)} >= ${council.scoreThreshold}`);
      break;
    }

    if (scoreCard.stagnated) {
      p.log.warn(`Round ${round}: Stagnation detected, stopping iterations.`);
      log('system', 'council', `Stagnation detected, stopping iterations.`);
      break;
    }

    if (round === council.maxRounds) {
      p.log.warn(`Max rounds (${council.maxRounds}) reached.`);
      log('system', 'council', `Max rounds (${council.maxRounds}) reached.`);
      break;
    }

    // --- Between rounds: offer user chance to steer ---
    const resumeKeys = pauseStreamDisplay();
    const wantToSteer = await p.confirm({
      message: `Score ${scoreCard.mean.toFixed(2)} < ${council.scoreThreshold}. Add guidance before next round?`,
      initialValue: false,
    });

    if (!p.isCancel(wantToSteer) && wantToSteer) {
      const steerInput = await p.text({
        message: 'Enter guidance for Ford:',
        placeholder: 'e.g. "Focus more on error handling" or "Simplify the architecture"',
      });

      if (!p.isCancel(steerInput)) {
        sessionManager.addGuidance(steerInput);
        await sessionManager.save();
        p.log.info(`Guidance added: "${steerInput}"`);
        log('info', 'user', `Guidance: ${steerInput}`);
      }
    }
    resumeKeys();
  }

  // --- Fresh Eyes Step ---
  let freshEyesReview: AgentReview | undefined;

  if (council.freshEyes && currentPlan) {
    const freshEyesAgent = registry.get('reviewer') ?? councilAgents[0];

    if (freshEyesAgent) {
      sessionManager.update({ activeAgents: [freshEyesAgent.id] });
      await sessionManager.save();

      log('system', 'fresh-eyes', `Fresh Eyes validation starting (${freshEyesAgent.name})`);

      const freshSpinner = p.spinner();
      freshSpinner.start(`Fresh Eyes validation (${freshEyesAgent.name}, zero prior context)...`);

      try {
        // runFreshEyes now uses CodeReview schema (v4) — adapt to AgentReview for legacy flow
        const codeReview = await runFreshEyes(freshEyesAgent, [], idea);
        freshEyesReview = {
          agentId: freshEyesAgent.id ?? 'fresh-eyes',
          codename: freshEyesAgent.name ?? 'Fresh Eyes',
          dimensions: [],
          weightedScore: codeReview.score,
          verdict: codeReview.verdict === 'approve' ? 'approve' : 'request-changes',
          summary: codeReview.issues.map(i => i.what).join('; ') || 'No issues found',
          concerns: codeReview.issues.filter(i => i.severity === 'critical').map(i => i.what),
          suggestions: codeReview.issues.filter(i => i.severity === 'suggestion').map(i => i.fix),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        freshSpinner.stop(`Fresh Eyes validation failed.`);
        log('error', 'fresh-eyes', `Validation failed: ${msg}`);
        logError('ralph-loop.fresh-eyes', err, { idea });
        // Don't throw — fresh eyes is optional
      }

      if (freshEyesReview) {
        freshSpinner.stop(`Fresh Eyes: ${freshEyesReview.weightedScore.toFixed(1)}/10 (${freshEyesReview.verdict})`);
        eventBus.publish('freshEyes', { review: freshEyesReview });
        log('score', 'fresh-eyes', `Score: ${freshEyesReview.weightedScore.toFixed(1)}/10 — ${freshEyesReview.verdict}`);

        if (freshEyesReview.concerns.length > 0) {
          p.note(
            freshEyesReview.concerns.map((c) => `- ${c}`).join('\n'),
            'Fresh Eyes Concerns',
          );
        }
      }
    }
  }

  sessionManager.update({ activeAgents: [] });
  await sessionManager.save();
  destroyStreamDisplay();

  // --- Final Summary ---
  const lastCard = scoreCards[scoreCards.length - 1];
  const summaryLines = [
    `Rounds completed: ${scoreCards.length}`,
    `Final mean score: ${lastCard?.mean.toFixed(2) ?? 'N/A'}`,
    `Threshold: ${council.scoreThreshold}`,
    `Result: ${lastCard?.passed ? 'PASSED' : 'DID NOT PASS'}`,
  ];

  if (freshEyesReview) {
    summaryLines.push(`Fresh Eyes: ${freshEyesReview.weightedScore.toFixed(1)}/10 (${freshEyesReview.verdict})`);
  }

  p.note(summaryLines.join('\n'), 'Council Deliberation Complete');
  log('system', 'council', `Complete. Final score: ${lastCard?.mean.toFixed(2) ?? 'N/A'} — ${lastCard?.passed ? 'PASSED' : 'DID NOT PASS'}`);

  return { plan: currentPlan!, scoreCards, freshEyesReview };
}
