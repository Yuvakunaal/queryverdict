// Pure, exact (BigInt) join-cardinality arithmetic and invariants. No engine dependency; unit-tested.
//
// Notation: for a join key value k (all key columns non-NULL), L(k) and R(k) are the number of
// left and right input rows with that key. Rows with any NULL key column never match.
//
//   matched pairs        P  = Σ_k L(k)·R(k)
//   left rows matched    Lm = Σ_{k: R(k)>0} L(k)          left unmatched  Lu = |L| − Lm  (includes NULL-key rows)
//   right rows matched   Rm = Σ_{k: L(k)>0} R(k)          right unmatched Ru = |R| − Rm
//   INNER = P   LEFT = P + Lu   RIGHT = P + Ru   FULL = P + Lu + Ru
//   left rows multiplied = Σ_{k: R(k)>1} L(k)   left excess copies = Σ_{k: R(k)>1} L(k)·(R(k)−1)
//
// These hold only if grouping by the key uses exactly the same equality as the join. That is not
// true for collations, coercions or other comparison semantics (Codex H2), so every result is
// checked against INVARIANTS below and against the engine's own join (analyze.ts) before use.
import type { Expectation, ExpectationOutcome, Finding, JoinDerived, JoinStats, JoinType, Relationship } from './types';

export const STAT_FIELDS: (keyof JoinStats)[] = [
  'leftRows', 'rightRows', 'leftNullKeyRows', 'rightNullKeyRows', 'leftKeyedRows', 'rightKeyedRows',
  'leftDistinctKeys', 'rightDistinctKeys', 'leftDuplicateKeys', 'rightDuplicateKeys', 'leftMaxMultiplicity', 'rightMaxMultiplicity',
  'leftMaxMultiplicityMatched', 'rightMaxMultiplicityMatched', 'matchedKeys', 'matchedPairs', 'leftRowsMatched', 'rightRowsMatched',
  'leftRowsMultiplied', 'leftExcessCopies', 'rightRowsMultiplied', 'rightExcessCopies',
];

export function parseBig(v: string | undefined | null): bigint {
  if (v === undefined || v === null || v === 'NULL' || v === '') throw new Error(`Expected an integer count, got ${JSON.stringify(v)}`);
  const t = v.trim();
  if (!/^-?\d+$/.test(t)) throw new Error(`Expected an integer count, got ${JSON.stringify(v)}`);
  return BigInt(t);
}

/**
 * Mathematical invariants that every correct statistics set satisfies. A violation means the
 * frequency model does not match the join's real semantics (or a bug); the join is then
 * inconclusive and all findings that depend on it are suppressed.
 */
export function checkInvariants(s: JoinStats): string[] {
  const v: string[] = [];
  const req = (ok: boolean, what: string) => {
    if (!ok) v.push(what);
  };
  for (const k of STAT_FIELDS) req(s[k] >= 0n, `${k} is negative (${s[k]})`);
  for (const side of ['left', 'right'] as const) {
    const rows = side === 'left' ? s.leftRows : s.rightRows;
    const nulls = side === 'left' ? s.leftNullKeyRows : s.rightNullKeyRows;
    const keyed = side === 'left' ? s.leftKeyedRows : s.rightKeyedRows;
    const distinct = side === 'left' ? s.leftDistinctKeys : s.rightDistinctKeys;
    const dups = side === 'left' ? s.leftDuplicateKeys : s.rightDuplicateKeys;
    const max = side === 'left' ? s.leftMaxMultiplicity : s.rightMaxMultiplicity;
    const maxM = side === 'left' ? s.leftMaxMultiplicityMatched : s.rightMaxMultiplicityMatched;
    const matched = side === 'left' ? s.leftRowsMatched : s.rightRowsMatched;
    const multiplied = side === 'left' ? s.leftRowsMultiplied : s.rightRowsMultiplied;
    const excess = side === 'left' ? s.leftExcessCopies : s.rightExcessCopies;
    req(nulls <= rows, `${side}: NULL-key rows exceed input rows`);
    req(keyed === rows - nulls, `${side}: Σ key frequencies (${keyed}) ≠ input rows − NULL-key rows (${rows - nulls})`);
    req(matched <= keyed, `${side}: matched rows (${matched}) exceed non-NULL-key rows (${keyed})`);
    req(distinct <= keyed, `${side}: more distinct keys than rows`);
    req(dups <= distinct, `${side}: more duplicated keys than distinct keys`);
    req((dups === 0n) === (max <= 1n), `${side}: duplicated-key count inconsistent with maximum multiplicity`);
    req(maxM <= max, `${side}: matched-key maximum exceeds overall maximum`);
    req(multiplied <= matched, `${side}: multiplied rows exceed matched rows`);
    req(excess >= multiplied, `${side}: excess copies fewer than multiplied rows`);
    req((multiplied === 0n) === (excess === 0n), `${side}: multiplied rows and excess copies disagree`);
    req(s.matchedPairs === matched + excess, `${side}: matched pairs (${s.matchedPairs}) ≠ matched rows + excess copies (${matched + excess})`);
  }
  req(s.matchedKeys <= s.leftDistinctKeys && s.matchedKeys <= s.rightDistinctKeys, 'matched keys exceed distinct keys');
  req((s.matchedKeys === 0n) === (s.matchedPairs === 0n) && (s.matchedPairs === 0n) === (s.leftRowsMatched === 0n), 'matched keys, pairs and rows disagree about whether anything matched');
  req((s.rightMaxMultiplicityMatched > 1n) === (s.leftRowsMultiplied > 0n), 'left rows multiplied iff some matched key has R(k) > 1');
  req((s.leftMaxMultiplicityMatched > 1n) === (s.rightRowsMultiplied > 0n), 'right rows multiplied iff some matched key has L(k) > 1');
  return v;
}

function relationshipOf(leftUnique: boolean, rightUnique: boolean): Relationship {
  if (leftUnique && rightUnique) return 'one-to-one';
  if (leftUnique) return 'one-to-many';
  if (rightUnique) return 'many-to-one';
  return 'many-to-many';
}

export function derive(type: JoinType, s: JoinStats): JoinDerived {
  const leftUnmatchedRows = s.leftRows - s.leftRowsMatched;
  const rightUnmatchedRows = s.rightRows - s.rightRowsMatched;
  const preserveLeft = type === 'LEFT' || type === 'FULL';
  const preserveRight = type === 'RIGHT' || type === 'FULL';
  const outputRows = s.matchedPairs + (preserveLeft ? leftUnmatchedRows : 0n) + (preserveRight ? rightUnmatchedRows : 0n);
  return {
    outputRows,
    leftUnmatchedRows,
    rightUnmatchedRows,
    leftRowsDropped: preserveLeft ? 0n : leftUnmatchedRows,
    rightRowsDropped: preserveRight ? 0n : rightUnmatchedRows,
    relationship: relationshipOf(s.leftDuplicateKeys === 0n, s.rightDuplicateKeys === 0n),
    effectiveRelationship: s.matchedKeys === 0n ? 'no-matches' : relationshipOf(s.leftMaxMultiplicityMatched <= 1n, s.rightMaxMultiplicityMatched <= 1n),
  };
}

const ALLOWED: Record<Relationship, (r: Relationship) => boolean> = {
  'one-to-one': (r) => r === 'one-to-one',
  'one-to-many': (r) => r === 'one-to-one' || r === 'one-to-many',
  'many-to-one': (r) => r === 'one-to-one' || r === 'many-to-one',
  'many-to-many': () => true,
};

/** Evaluates one join-level expectation against validated statistics. */
export function evaluateJoinExpectation(type: JoinType, s: JoinStats, d: JoinDerived, e: Expectation): Omit<ExpectationOutcome, 'index'> {
  if (e.kind === 'relationship') {
    const ev = { expected: e.expected, observed: d.relationship, leftDuplicateKeys: String(s.leftDuplicateKeys), rightDuplicateKeys: String(s.rightDuplicateKeys), leftMaxMultiplicity: String(s.leftMaxMultiplicity), rightMaxMultiplicity: String(s.rightMaxMultiplicity) };
    return { expectation: e, outcome: ALLOWED[e.expected](d.relationship) ? 'held' : 'violated', evidence: ev };
  }
  if (e.kind === 'no-row-loss') {
    const dropped = e.side === 'left' ? d.leftRowsDropped : d.rightRowsDropped;
    return { expectation: e, outcome: dropped > 0n ? 'violated' : 'held', evidence: { side: e.side, joinType: type, rowsDropped: String(dropped), nullKeyRows: String(e.side === 'left' ? s.leftNullKeyRows : s.rightNullKeyRows) } };
  }
  if (e.kind === 'no-fan-out') {
    const side = e.side ?? 'left';
    const rows = side === 'left' ? s.leftRowsMultiplied : s.rightRowsMultiplied;
    const extra = side === 'left' ? s.leftExcessCopies : s.rightExcessCopies;
    return { expectation: e, outcome: extra > 0n ? 'violated' : 'held', evidence: { side, rowsMultiplied: String(rows), excessCopies: String(extra) } };
  }
  return { expectation: e, outcome: 'unchecked', reason: 'not a join-level expectation' };
}

export function violationFinding(join: number, o: Omit<ExpectationOutcome, 'index'>): Finding {
  const e = o.expectation;
  const ev = o.evidence ?? {};
  const message =
    e.kind === 'relationship' ? `Expected a ${e.expected} relationship, but the data is ${String(ev.observed)}: ${String(ev.leftDuplicateKeys)} duplicated key value(s) on the left, ${String(ev.rightDuplicateKeys)} on the right.`
    : e.kind === 'no-row-loss' ? `Expected no ${e.side}-side rows to be lost, but this ${String(ev.joinType)} JOIN drops ${String(ev.rowsDropped)} ${e.side} row(s) (${String(ev.nullKeyRows)} with a NULL key).`
    : e.kind === 'no-fan-out' ? `Expected each ${String(ev.side)} input row to appear at most once, but ${String(ev.rowsMultiplied)} ${String(ev.side)} row(s) appear more than once (${String(ev.excessCopies)} extra copies).`
    : 'Expectation violated.';
  const code = e.kind === 'relationship' ? 'relationship-violated' : e.kind === 'no-row-loss' ? 'row-loss' : e.kind === 'no-fan-out' ? 'fan-out' : `${e.kind}-violated`;
  return { category: 'expectation-violation', code, join, message, evidence: ev };
}

/** Observed properties and suspicious patterns of one validated join. */
export function joinFindings(join: number, type: JoinType, s: JoinStats, d: JoinDerived): Finding[] {
  const f: Finding[] = [];
  const ev = (x: Record<string, bigint | string>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, String(v)]));
  f.push({
    category: 'observed', code: 'join-cardinality', join,
    message: `${type} JOIN: ${s.leftRows} left × ${s.rightRows} right input rows → ${d.outputRows} output rows (${d.relationship} by key uniqueness; ${d.effectiveRelationship} among matched keys).`,
    evidence: ev({ outputRows: d.outputRows, leftRows: s.leftRows, rightRows: s.rightRows, matchedPairs: s.matchedPairs, leftRowsMatched: s.leftRowsMatched, rightRowsMatched: s.rightRowsMatched, relationship: d.relationship, effectiveRelationship: d.effectiveRelationship }),
  });
  if (s.leftExcessCopies > 0n) {
    f.push({
      category: 'observed', code: 'join-expansion', join,
      message: `Join expansion: ${s.leftRowsMultiplied} left input row(s) match more than one right row and appear ${s.leftExcessCopies} extra time(s) in the join output.`,
      evidence: ev({ leftRowsMultiplied: s.leftRowsMultiplied, leftExcessCopies: s.leftExcessCopies }),
    });
  }
  if (s.rightExcessCopies > 0n) {
    f.push({
      category: 'observed', code: 'right-rows-repeated', join,
      message: `${s.rightRowsMultiplied} right input row(s) match more than one left row and appear ${s.rightExcessCopies} extra time(s) in the join output.`,
      evidence: ev({ rightRowsMultiplied: s.rightRowsMultiplied, rightExcessCopies: s.rightExcessCopies }),
    });
  }
  if (d.leftRowsDropped > 0n || d.rightRowsDropped > 0n) {
    f.push({
      category: 'observed', code: 'unmatched-rows-dropped', join,
      message: `${d.leftRowsDropped} left and ${d.rightRowsDropped} right input row(s) have no match and are not in the ${type} JOIN output.`,
      evidence: ev({ leftRowsDropped: d.leftRowsDropped, rightRowsDropped: d.rightRowsDropped }),
    });
  }
  if (d.leftUnmatchedRows > 0n && (type === 'LEFT' || type === 'FULL')) {
    f.push({ category: 'observed', code: 'unmatched-rows-preserved', join, message: `${d.leftUnmatchedRows} left row(s) have no match and are kept with NULL right-side columns.`, evidence: ev({ leftUnmatchedRows: d.leftUnmatchedRows }) });
  }
  if (d.rightUnmatchedRows > 0n && (type === 'RIGHT' || type === 'FULL')) {
    f.push({ category: 'observed', code: 'unmatched-right-rows-preserved', join, message: `${d.rightUnmatchedRows} right row(s) have no match and are kept with NULL left-side columns.`, evidence: ev({ rightUnmatchedRows: d.rightUnmatchedRows }) });
  }
  if (s.leftNullKeyRows > 0n || s.rightNullKeyRows > 0n) {
    f.push({
      category: 'observed', code: 'null-join-keys', join,
      message: `${s.leftNullKeyRows} left and ${s.rightNullKeyRows} right row(s) have a NULL in a join key column; NULL never equals NULL, so these rows cannot match.`,
      evidence: ev({ leftNullKeyRows: s.leftNullKeyRows, rightNullKeyRows: s.rightNullKeyRows }),
    });
  }
  if (d.effectiveRelationship === 'many-to-many') {
    f.push({
      category: 'suspicious', code: 'many-to-many-join', join,
      message: 'Both sides have duplicated matching keys, so rows multiply on both sides (many-to-many). This is sometimes intended (e.g. bridge tables) but often indicates a missing key column or a grain mismatch.',
      evidence: ev({ leftMaxMultiplicityMatched: s.leftMaxMultiplicityMatched, rightMaxMultiplicityMatched: s.rightMaxMultiplicityMatched }),
    });
  }
  return f;
}
