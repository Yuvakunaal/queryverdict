// Exact join-cardinality arithmetic and invariants (ported from the spike's stats.ts, verified there
// against an independent Python oracle and DuckDB; restricted to the P0 join types INNER and LEFT).
// Pure: no engine dependency.
//
// For a key tuple k with every component non-NULL, L(k) and R(k) are the left and right input rows
// with that key. A row with any NULL key component never matches (NULL never equals NULL).
//
//   matched pairs        P  = Σ_k L(k)·R(k)
//   left rows matched    Lm = Σ_{k: R(k)>0} L(k)        left unmatched  Lu = |L| − Lm (includes NULL-key rows)
//   right rows matched   Rm = Σ_{k: L(k)>0} R(k)        right unmatched Ru = |R| − Rm
//   INNER output = P     LEFT output = P + Lu
//   left rows multiplied = Σ_{k: R(k)>1} L(k)        left excess copies = Σ_{k: R(k)>1} L(k)·(R(k)−1)
//   (and symmetrically for the right side)
//
// These identities hold only when grouping by the key uses the join's own equality. That is why
// P0 accepts only same-type integer keys, and why every result is also checked against the
// invariants below and the engine's own join (SEMI JOIN recount, executed count, witnesses).
import type { Exact, JoinDerived, JoinStats, JoinType, Relationship } from './types';

export const STAT_FIELDS: readonly (keyof JoinStats)[] = [
  'leftRows', 'rightRows', 'leftNullKeyRows', 'rightNullKeyRows', 'leftKeyedRows', 'rightKeyedRows',
  'leftDistinctKeys', 'rightDistinctKeys', 'leftDuplicateKeys', 'rightDuplicateKeys', 'leftMaxMultiplicity', 'rightMaxMultiplicity',
  'leftMaxMultiplicityMatched', 'rightMaxMultiplicityMatched', 'matchedKeys', 'matchedPairs', 'leftRowsMatched', 'rightRowsMatched',
  'leftRowsMultiplied', 'leftExcessCopies', 'rightRowsMultiplied', 'rightExcessCopies',
];

/** Parses an exact integer count from engine text. Anything else is an error (never a guess). */
export function parseCount(v: string | null | undefined): bigint {
  if (typeof v !== 'string' || !/^-?\d+$/.test(v)) throw new TypeError(`expected an integer count, got ${JSON.stringify(v)}`);
  return BigInt(v);
}

/**
 * Invariants every correct statistics set satisfies. A violation means the frequency model does
 * not describe this join (or a defect): the join is inconclusive and nothing that depends on it
 * is published.
 */
export function checkInvariants(s: JoinStats): string[] {
  const v: string[] = [];
  const req = (ok: boolean, what: string) => {
    if (!ok) v.push(what);
  };
  for (const k of STAT_FIELDS) req(typeof s[k] === 'bigint' && s[k] >= 0n, `${k} is negative or missing (${String(s[k])})`);
  if (v.length) return v;
  for (const side of ['left', 'right'] as const) {
    const L = side === 'left';
    const rows = L ? s.leftRows : s.rightRows;
    const nulls = L ? s.leftNullKeyRows : s.rightNullKeyRows;
    const keyed = L ? s.leftKeyedRows : s.rightKeyedRows;
    const distinct = L ? s.leftDistinctKeys : s.rightDistinctKeys;
    const dups = L ? s.leftDuplicateKeys : s.rightDuplicateKeys;
    const max = L ? s.leftMaxMultiplicity : s.rightMaxMultiplicity;
    const maxM = L ? s.leftMaxMultiplicityMatched : s.rightMaxMultiplicityMatched;
    const matched = L ? s.leftRowsMatched : s.rightRowsMatched;
    const multiplied = L ? s.leftRowsMultiplied : s.rightRowsMultiplied;
    const excess = L ? s.leftExcessCopies : s.rightExcessCopies;
    req(nulls <= rows, `${side}: NULL-key rows exceed input rows`);
    req(keyed === rows - nulls, `${side}: Σ key frequencies (${keyed}) ≠ input rows − NULL-key rows (${rows - nulls})`);
    req(matched <= keyed, `${side}: matched rows (${matched}) exceed non-NULL-key rows (${keyed})`);
    req(distinct <= keyed, `${side}: more distinct keys than rows`);
    req((distinct === 0n) === (keyed === 0n), `${side}: distinct keys and keyed rows disagree about emptiness`);
    req(dups <= distinct, `${side}: more duplicated keys than distinct keys`);
    req((dups === 0n) === (max <= 1n), `${side}: duplicated-key count inconsistent with maximum multiplicity`);
    req(max <= keyed, `${side}: maximum multiplicity exceeds keyed rows`);
    req(maxM <= max, `${side}: matched-key maximum exceeds overall maximum`);
    req(multiplied <= matched, `${side}: multiplied rows exceed matched rows`);
    req(excess >= multiplied, `${side}: excess copies fewer than multiplied rows`);
    req((multiplied === 0n) === (excess === 0n), `${side}: multiplied rows and excess copies disagree`);
    req(s.matchedPairs === matched + excess, `${side}: matched pairs (${s.matchedPairs}) ≠ matched rows + excess copies (${matched + excess})`);
  }
  req(s.matchedKeys <= s.leftDistinctKeys && s.matchedKeys <= s.rightDistinctKeys, 'matched keys exceed distinct keys');
  const none = s.matchedKeys === 0n;
  req(none === (s.matchedPairs === 0n) && none === (s.leftRowsMatched === 0n) && none === (s.rightRowsMatched === 0n), 'matched keys, pairs and rows disagree about whether anything matched');
  req(none === (s.leftMaxMultiplicityMatched === 0n) && none === (s.rightMaxMultiplicityMatched === 0n), 'matched-key maxima disagree about whether anything matched');
  req((s.rightMaxMultiplicityMatched > 1n) === (s.leftRowsMultiplied > 0n), 'left rows multiplied iff some matched key has R(k) > 1');
  req((s.leftMaxMultiplicityMatched > 1n) === (s.rightRowsMultiplied > 0n), 'right rows multiplied iff some matched key has L(k) > 1');
  return v;
}

export function relationshipOf(leftUnique: boolean, rightUnique: boolean): Relationship {
  if (leftUnique && rightUnique) return 'one-to-one';
  if (leftUnique) return 'one-to-many';
  if (rightUnique) return 'many-to-one';
  return 'many-to-many';
}

export function derive(type: JoinType, s: JoinStats): JoinDerived {
  const leftUnmatchedRows = s.leftRows - s.leftRowsMatched;
  const rightUnmatchedRows = s.rightRows - s.rightRowsMatched;
  const preserveLeft = type === 'LEFT';
  return {
    outputRows: s.matchedPairs + (preserveLeft ? leftUnmatchedRows : 0n),
    leftUnmatchedRows,
    rightUnmatchedRows,
    leftRowsDropped: preserveLeft ? 0n : leftUnmatchedRows,
    rightRowsDropped: rightUnmatchedRows,
    leftRowsPreserved: preserveLeft ? leftUnmatchedRows : 0n,
    relationship: relationshipOf(s.leftDuplicateKeys === 0n, s.rightDuplicateKeys === 0n),
    matchedRelationship: s.matchedKeys === 0n ? 'no-matches' : relationshipOf(s.leftMaxMultiplicityMatched <= 1n, s.rightMaxMultiplicityMatched <= 1n),
  };
}

/** Derived values must agree with the statistics they come from (checked again before publishing). */
export function checkDerived(type: JoinType, s: JoinStats, d: JoinDerived): string[] {
  const v: string[] = [];
  const req = (ok: boolean, what: string) => {
    if (!ok) v.push(what);
  };
  req(d.leftUnmatchedRows >= 0n && d.rightUnmatchedRows >= 0n, 'unmatched rows are negative');
  req(d.leftUnmatchedRows >= s.leftNullKeyRows && d.rightUnmatchedRows >= s.rightNullKeyRows, 'NULL-key rows must be unmatched');
  req(d.outputRows === s.matchedPairs + (type === 'LEFT' ? d.leftUnmatchedRows : 0n), 'output identity does not hold');
  req(d.leftRowsDropped + d.leftRowsPreserved === d.leftUnmatchedRows, 'left unmatched rows are neither dropped nor preserved');
  req(d.rightRowsDropped === d.rightUnmatchedRows, 'right unmatched rows must be dropped in INNER and LEFT joins');
  req(d.relationship === relationshipOf(s.leftDuplicateKeys === 0n, s.rightDuplicateKeys === 0n), 'relationship does not follow from duplicate keys');
  return v;
}

export const exactStats = (s: JoinStats): Exact<JoinStats> => Object.fromEntries(STAT_FIELDS.map((k) => [k, String(s[k])])) as Exact<JoinStats>;
export function exactDerived(d: JoinDerived): Exact<JoinDerived> {
  return {
    outputRows: String(d.outputRows), leftUnmatchedRows: String(d.leftUnmatchedRows), rightUnmatchedRows: String(d.rightUnmatchedRows),
    leftRowsDropped: String(d.leftRowsDropped), rightRowsDropped: String(d.rightRowsDropped), leftRowsPreserved: String(d.leftRowsPreserved),
    relationship: d.relationship, matchedRelationship: d.matchedRelationship,
  };
}
