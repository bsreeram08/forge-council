import type {
  PlanContribution,
  MergedPlan,
  MergedPlanItem,
  PlanChange,
  ContestedItem,
  PlanItem,
} from './schemas.ts';

// ---------------------------------------------------------------------------
// Review Agent Selection — Ford picks 2-3 based on code content
// ---------------------------------------------------------------------------

export interface ReviewAgentSelection {
  agentIds: string[];
  reasons: Record<string, string>;
}

export function selectReviewAgents(files: string[]): ReviewAgentSelection {
  const agentIds: string[] = [];
  const reasons: Record<string, string> = {};

  // Always include Guido for code quality
  agentIds.push('reviewer');
  reasons['reviewer'] = 'Code quality review (always included)';

  const allContent = files.map(f => f.toLowerCase());
  const allPaths = files;

  // Security agent — auth, env, secrets, crypto patterns
  const securityPatterns = [
    /auth/i, /password/i, /secret/i, /token/i, /jwt/i,
    /encrypt/i, /hash/i, /\.env/i, /api[_-]?key/i, /session/i,
    /cookie/i, /cors/i, /csrf/i, /oauth/i, /middleware/i,
  ];
  if (allPaths.some(p => securityPatterns.some(rx => rx.test(p))) ||
      allContent.some(c => securityPatterns.some(rx => rx.test(c)))) {
    agentIds.push('security');
    reasons['security'] = 'Auth/security code detected';
  }

  // QA agent — test files present or testing needed
  const testPatterns = [/\.test\./i, /\.spec\./i, /test\//i, /__tests__/i];
  if (allPaths.some(p => testPatterns.some(rx => rx.test(p)))) {
    agentIds.push('qa');
    reasons['qa'] = 'Test files present';
  }

  // Infra agent — docker, CI, deployment configs
  const infraPatterns = [
    /docker/i, /\.yml$/i, /\.yaml$/i, /ci\//i, /deploy/i,
    /nginx/i, /terraform/i, /k8s/i, /kubernetes/i,
  ];
  if (allPaths.some(p => infraPatterns.some(rx => rx.test(p)))) {
    agentIds.push('integrator');
    reasons['integrator'] = 'Infrastructure/deployment code detected';
  }

  // UX agent — UI components, HTML, CSS, frontend
  const uiPatterns = [
    /\.tsx$/i, /\.jsx$/i, /\.svelte$/i, /\.vue$/i, /\.css$/i,
    /\.html$/i, /component/i, /page/i, /layout/i, /ui\//i,
  ];
  if (allPaths.some(p => uiPatterns.some(rx => rx.test(p)))) {
    agentIds.push('designer');
    reasons['designer'] = 'UI/frontend code detected';
  }

  // Cap at 3 reviewers
  if (agentIds.length > 3) {
    return {
      agentIds: agentIds.slice(0, 3),
      reasons: Object.fromEntries(
        Object.entries(reasons).filter(([id]) => agentIds.slice(0, 3).includes(id)),
      ),
    };
  }

  return { agentIds, reasons };
}

// ---------------------------------------------------------------------------
// Pass 2: Apply 2/3 Consensus Changes
// ---------------------------------------------------------------------------

export function applyPass2Changes(
  plan: MergedPlan,
  changes: PlanChange[],
): { updatedPlan: MergedPlan; contested: ContestedItem[] } {
  const addVotes: Record<string, { item: PlanItem; voters: string[] }> = {};
  const removeVotes: Record<string, { voters: string[]; reasons: string[] }> = {};

  for (const change of changes) {
    for (const addition of change.additions) {
      const key = addition.item.title.toLowerCase();
      if (!addVotes[key]) addVotes[key] = { item: addition.item, voters: [] };
      addVotes[key]!.voters.push(change.agentId);
    }

    for (const removal of change.removals) {
      if (!removeVotes[removal.itemId]) {
        removeVotes[removal.itemId] = { voters: [], reasons: [] };
      }
      removeVotes[removal.itemId]!.voters.push(change.agentId);
      removeVotes[removal.itemId]!.reasons.push(removal.reason);
    }
  }

  const updatedPlan = structuredClone(plan);
  const contested: ContestedItem[] = [];

  // Apply additions with 2/3 agreement
  for (const [, vote] of Object.entries(addVotes)) {
    if (vote.voters.length >= 2) {
      addItemToPlan(updatedPlan, vote.item);
    } else {
      contested.push({
        type: 'add',
        item: vote.item,
        supporters: vote.voters,
      });
    }
  }

  // Apply removals with 2/3 agreement
  for (const [itemId, vote] of Object.entries(removeVotes)) {
    if (vote.voters.length >= 2) {
      removeItemFromPlan(updatedPlan, itemId);
    } else {
      contested.push({
        type: 'remove',
        itemId,
        supporters: vote.voters,
        reasons: vote.reasons,
      });
    }
  }

  return { updatedPlan, contested };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addItemToPlan(plan: MergedPlan, item: PlanItem): void {
  const category = item.category || 'General';
  let cat = plan.categories.find(c => c.name.toLowerCase() === category.toLowerCase());
  if (!cat) {
    cat = { name: category, items: [] };
    plan.categories.push(cat);
  }
  cat.items.push({
    id: item.id,
    title: item.title,
    description: item.description,
    priority: item.priority,
    phase: item.phase,
    source: 'pass2-consensus',
    selected: item.priority !== 'could',
  });
}

function removeItemFromPlan(plan: MergedPlan, itemId: string): void {
  for (const cat of plan.categories) {
    const idx = cat.items.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      cat.items.splice(idx, 1);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Ford's merge prompt builder — used by the workflow
// ---------------------------------------------------------------------------

export function buildMergeInstructions(contributions: PlanContribution[]): string {
  const parts = [
    '## Agent Contributions to Merge',
    '',
    `You have ${contributions.length} contributions from different planning agents.`,
    'Merge them into a single MergedPlan following your system instructions.',
    '',
  ];

  for (const c of contributions) {
    parts.push(`### ${c.agentId}`);
    parts.push(`Items (${c.items.length}):`);
    parts.push(JSON.stringify(c.items, null, 2));
    if (c.techSuggestions && c.techSuggestions.length > 0) {
      parts.push(`Tech suggestions:`);
      parts.push(JSON.stringify(c.techSuggestions, null, 2));
    }
    parts.push('');
  }

  return parts.join('\n');
}
