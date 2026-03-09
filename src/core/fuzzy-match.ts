/**
 * Cascading Fuzzy Matcher
 *
 * 4-level strategy for finding text in content, ordered by confidence:
 * 1. Exact match (1.0)
 * 2. Whitespace-normalized (0.9) — handles indentation drift
 * 3. Trimmed-lines (0.8) — per-line trim + contiguous match
 * 4. Line-anchor (0.7) — first/last line anchors + similarity check
 */

export interface MatchResult {
  matched: string;
  strategy: 'exact' | 'whitespace-normalized' | 'trimmed-lines' | 'line-anchor';
  confidence: number;
}

// ---------------------------------------------------------------------------
// Strategy 1: Exact
// ---------------------------------------------------------------------------

function exactMatch(content: string, search: string): MatchResult | null {
  if (!content.includes(search)) return null;
  return { matched: search, strategy: 'exact', confidence: 1.0 };
}

// ---------------------------------------------------------------------------
// Strategy 2: Whitespace-normalized
// ---------------------------------------------------------------------------

function normalizeWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n');
}

function whitespaceNormMatch(content: string, search: string): MatchResult | null {
  const normContent = normalizeWhitespace(content);
  const normSearch = normalizeWhitespace(search);

  const idx = normContent.indexOf(normSearch);
  if (idx === -1) return null;

  // Map back to original content positions.
  // Walk both strings simultaneously to find the original span.
  const originalStart = mapNormToOriginal(content, normContent, idx);
  const originalEnd = mapNormToOriginal(content, normContent, idx + normSearch.length);

  const matched = content.slice(originalStart, originalEnd);
  return { matched, strategy: 'whitespace-normalized', confidence: 0.9 };
}

/**
 * Map a position in the normalized string back to the original string.
 * Walks through both strings, tracking position correspondence.
 */
function mapNormToOriginal(original: string, normalized: string, normPos: number): number {
  let oi = 0;
  let ni = 0;
  while (ni < normPos && oi < original.length) {
    if (original[oi] === normalized[ni]) {
      oi++;
      ni++;
    } else {
      // original has extra whitespace that was collapsed
      oi++;
    }
  }
  return oi;
}

// ---------------------------------------------------------------------------
// Strategy 3: Trimmed-lines — trim each line, find contiguous match
// ---------------------------------------------------------------------------

function trimmedLinesMatch(content: string, search: string): MatchResult | null {
  const contentLines = content.split('\n');
  const searchLines = search.split('\n');

  if (searchLines.length === 0) return null;

  const trimmedSearch = searchLines.map(l => l.trim());
  const trimmedContent = contentLines.map(l => l.trim());

  // Find contiguous subsequence
  outer:
  for (let i = 0; i <= trimmedContent.length - trimmedSearch.length; i++) {
    for (let j = 0; j < trimmedSearch.length; j++) {
      if (trimmedContent[i + j] !== trimmedSearch[j]) continue outer;
    }
    // Found match at line i..i+searchLines.length-1
    const matchedLines = contentLines.slice(i, i + searchLines.length);
    return { matched: matchedLines.join('\n'), strategy: 'trimmed-lines', confidence: 0.8 };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Strategy 4: Line-anchor — first/last non-empty lines as anchors
// ---------------------------------------------------------------------------

function lineAnchorMatch(content: string, search: string): MatchResult | null {
  const searchLines = search.split('\n');
  const nonEmpty = searchLines.filter(l => l.trim().length > 0);
  if (nonEmpty.length < 2) return null;

  const firstAnchor = nonEmpty[0]!.trim();
  const lastAnchor = nonEmpty[nonEmpty.length - 1]!.trim();

  const contentLines = content.split('\n');
  const trimmedContent = contentLines.map(l => l.trim());

  // Find first anchor
  for (let start = 0; start < trimmedContent.length; start++) {
    if (trimmedContent[start] !== firstAnchor) continue;

    // Find last anchor after start
    for (let end = start + 1; end < trimmedContent.length; end++) {
      if (trimmedContent[end] !== lastAnchor) continue;

      // Check similarity of the block between anchors
      const blockLines = trimmedContent.slice(start, end + 1);
      const trimmedSearch = searchLines.map(l => l.trim()).filter(l => l.length > 0);

      const similarity = computeLineSimilarity(blockLines, trimmedSearch);
      if (similarity >= 0.9) {
        const matched = contentLines.slice(start, end + 1).join('\n');
        return { matched, strategy: 'line-anchor', confidence: 0.7 };
      }
    }
  }

  return null;
}

/**
 * Compute similarity ratio between two arrays of lines.
 * Returns ratio of matching lines to total unique lines.
 */
function computeLineSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let matches = 0;
  for (const line of setA) {
    if (setB.has(line)) matches++;
  }
  const total = new Set([...a, ...b]).size;
  return total === 0 ? 1 : matches / total;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const STRATEGIES = [exactMatch, whitespaceNormMatch, trimmedLinesMatch, lineAnchorMatch] as const;

export function fuzzyFind(content: string, search: string): MatchResult | null {
  for (const strategy of STRATEGIES) {
    const result = strategy(content, search);
    if (result) return result;
  }
  return null;
}

export function fuzzyReplace(
  content: string,
  search: string,
  replace: string,
): { newContent: string; result: MatchResult } | null {
  const result = fuzzyFind(content, search);
  if (!result) return null;

  // Replace the first occurrence of the matched text
  const idx = content.indexOf(result.matched);
  if (idx === -1) return null;

  const newContent = content.slice(0, idx) + replace + content.slice(idx + result.matched.length);
  return { newContent, result };
}
