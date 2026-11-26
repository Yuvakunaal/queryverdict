// Finding categories (P-026) mapped to PRD §4 display labels, severities and confidence, and the
// findings of one validated join. Observed properties are not defects: legitimate one-to-many
// expansion is an observation. "Confirmed issue" has no P0 producer (ARCHITECTURE §14.3).
import type { Confidence, DisplayLabel, ExpectationOutcome, Finding, FindingCategory, JoinDerived, JoinStats, JoinType, Severity } from './types';

export const CATEGORY: Record<FindingCategory, { label: DisplayLabel; severity: Severity }> = {
  observed: { label: 'Observation', severity: 'info' },
  suspicious: { label: 'Suspicious pattern', severity: 'warning' },
  'expectation-violation': { label: 'Expectation violation', severity: 'error' },
  'expectation-unchecked': { label: 'Unchecked', severity: 'status' },
  unsupported: { label: 'Unsupported', severity: 'status' },
  inconclusive: { label: 'Inconclusive', severity: 'status' },
  'diagnostic-failure': { label: 'Diagnostic failure', severity: 'operational-error' },
  'query-failure': { label: 'Query failure', severity: 'operational-error' },
};

const STATUS_CONFIDENCE: Partial<Record<FindingCategory, Confidence>> = { unsupported: 'unsupported', inconclusive: 'incomplete', 'expectation-unchecked': 'incomplete', 'diagnostic-failure': 'incomplete', 'query-failure': 'incomplete' };

export function finding(category: FindingCategory, code: string, message: string, evidence?: Record<string, string>, confidence?: Confidence): Finding {
  return { category, ...CATEGORY[category], confidence: confidence ?? STATUS_CONFIDENCE[category] ?? 'validated', code, message, ...(evidence ? { evidence } : {}) };
}

/**
 * Observations and suspicious patterns of one join. `confidence` is 'validated' only when the
 * evidence passed every check; otherwise the same measurements are labelled incomplete.
 */
export function joinFindings(type: JoinType, s: JoinStats, d: JoinDerived, confidence: Confidence): Finding[] {
  const f: Finding[] = [];
  const ev = (x: Record<string, bigint | string>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, String(v)]));
  const add = (category: 'observed' | 'suspicious', code: string, message: string, evidence: Record<string, bigint | string>) => f.push(finding(category, code, message, ev(evidence), confidence));
  const matched = d.matchedRelationship === 'no-matches' ? 'no matches' : `${d.matchedRelationship} among matched keys`;
  add('observed', 'join-cardinality', `${type} JOIN: ${s.leftRows} left × ${s.rightRows} right input rows → ${d.outputRows} output rows (${d.relationship} by key uniqueness; ${matched}).`,
    { outputRows: d.outputRows, leftRows: s.leftRows, rightRows: s.rightRows, matchedPairs: s.matchedPairs, leftRowsMatched: s.leftRowsMatched, rightRowsMatched: s.rightRowsMatched, relationship: d.relationship, matchedRelationship: d.matchedRelationship });
  if (s.leftExcessCopies > 0n) {
    add('observed', 'left-rows-multiplied', `${s.leftRowsMultiplied} left input row(s) match more than one right row and appear ${s.leftExcessCopies} extra time(s) in the output.`, { leftRowsMultiplied: s.leftRowsMultiplied, leftExcessCopies: s.leftExcessCopies });
  }
  if (s.rightExcessCopies > 0n) {
    add('observed', 'right-rows-multiplied', `${s.rightRowsMultiplied} right input row(s) match more than one left row and appear ${s.rightExcessCopies} extra time(s) in the output.`, { rightRowsMultiplied: s.rightRowsMultiplied, rightExcessCopies: s.rightExcessCopies });
  }
  if (d.leftRowsDropped > 0n || d.rightRowsDropped > 0n) {
    add('observed', 'unmatched-rows-dropped', `${d.leftRowsDropped} left and ${d.rightRowsDropped} right input row(s) have no match and contribute no output.`, { leftRowsDropped: d.leftRowsDropped, rightRowsDropped: d.rightRowsDropped });
  }
  if (d.leftRowsPreserved > 0n) {
    add('observed', 'unmatched-left-rows-preserved', `${d.leftRowsPreserved} left input row(s) have no match and are kept once, with NULL right-side columns.`, { leftRowsPreserved: d.leftRowsPreserved });
  }
  if (s.leftNullKeyRows > 0n || s.rightNullKeyRows > 0n) {
    add('observed', 'null-join-keys', `${s.leftNullKeyRows} left and ${s.rightNullKeyRows} right input row(s) have a NULL key component; NULL never equals NULL, so these rows cannot match.`, { leftNullKeyRows: s.leftNullKeyRows, rightNullKeyRows: s.rightNullKeyRows });
  }
  if (d.matchedRelationship === 'many-to-many') {
    add('suspicious', 'many-to-many-join', 'Matched keys are duplicated on both sides, so rows multiply on both sides. This is sometimes intended (bridge tables) but often means a key column is missing or the grains differ.',
      { leftMaxMultiplicityMatched: s.leftMaxMultiplicityMatched, rightMaxMultiplicityMatched: s.rightMaxMultiplicityMatched });
  }
  for (const side of ['left', 'right'] as const) {
    const dropped = side === 'left' ? d.leftRowsDropped : d.rightRowsDropped;
    const extra = side === 'left' ? s.leftExcessCopies : s.rightExcessCopies;
    if (dropped > 0n && extra > 0n) {
      add('suspicious', 'loss-and-fan-out', `On the ${side} side, ${dropped} row(s) are dropped while other rows gain ${extra} extra copies. A row count alone would hide both effects.`, { side, rowsDropped: dropped, excessCopies: extra });
    }
  }
  return f;
}

/** Findings for expectation outcomes: one per violated or unchecked expectation. */
export function outcomeFindings(outcomes: readonly ExpectationOutcome[]): Finding[] {
  const out: Finding[] = [];
  for (const o of outcomes) {
    const kind = (o.expectation as { kind?: unknown } | null)?.kind;
    const k = typeof kind === 'string' ? kind : 'unknown';
    if (o.outcome === 'violated') out.push(finding('expectation-violation', `${k}-violated`, `Expectation ${o.index} (${k}) is violated. ${o.reason ?? ''}`.trim(), { index: String(o.index), ...(o.evidence ?? {}) }, 'validated'));
    else if (o.outcome === 'unchecked') out.push(finding('expectation-unchecked', 'expectation-unchecked', `Expectation ${o.index} (${k}) was not checked: ${o.reason ?? 'no reason recorded'}.`, { index: String(o.index) }));
  }
  return out;
}
