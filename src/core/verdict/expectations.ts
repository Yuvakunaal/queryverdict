// P0 join-stage expectations (PRD QV-VER-003; P-037; QV-ENG-007). Every declared expectation gets
// exactly one outcome, in declaration order, carrying its index and the declared value unchanged.
// `violated` comes only from complete, validated evidence; anything else is `unchecked` with a
// reason, and `unchecked` never becomes `held`.
import type { Expectation, ExpectationOutcome, JoinDerived, JoinStats, JoinType, Relationship } from './types';
import { RELATIONSHIPS } from './types';

const FIELDS: Record<Expectation['kind'], readonly string[]> = {
  relationship: ['kind', 'join', 'expected'],
  'no-row-loss': ['kind', 'join', 'side'],
  'no-fan-out': ['kind', 'join', 'side'],
  'row-count': ['kind', 'min', 'max'],
};

/** Why a declaration is malformed, or null when it is one of the four supported shapes. */
export function invalidExpectation(e: unknown): string | null {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return 'not an object';
  const x = e as Record<string, unknown>;
  const kind = x.kind;
  if (kind === 'metric-preserved' || kind === 'grain') return `${kind} expectations are outside the P0 diagnostic scope`;
  if (typeof kind !== 'string' || !(kind in FIELDS)) return `unknown expectation kind ${JSON.stringify(kind)}`;
  const allowed = FIELDS[kind as Expectation['kind']];
  const extra = Object.keys(x).filter((k) => !allowed.includes(k));
  if (extra.length) return `unknown field(s) ${extra.join(', ')}`;
  switch (kind) {
    case 'relationship':
      if (x.join !== 0) return 'join must be 0 (P0 analyses exactly one join)';
      return RELATIONSHIPS.includes(x.expected as Relationship) ? null : `expected must be one of ${RELATIONSHIPS.join(', ')}`;
    case 'no-row-loss':
    case 'no-fan-out':
      if (x.join !== 0) return 'join must be 0 (P0 analyses exactly one join)';
      return x.side === 'left' || x.side === 'right' ? null : "side must be 'left' or 'right'";
    default: {
      const ok = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
      if (!ok(x.min) || !ok(x.max)) return 'min and max must be non-negative integers';
      if (x.min === undefined && x.max === undefined) return 'row-count needs min, max or both';
      if (x.min !== undefined && x.max !== undefined && (x.min as number) > (x.max as number)) return 'min is greater than max';
      return null;
    }
  }
}

/** Relationship allowances: the expectation states the maximum multiplicity allowed on each side. */
const ALLOWED: Record<Relationship, (observed: Relationship) => boolean> = {
  'one-to-one': (r) => r === 'one-to-one',
  'one-to-many': (r) => r === 'one-to-one' || r === 'one-to-many',
  'many-to-one': (r) => r === 'one-to-one' || r === 'many-to-one',
  'many-to-many': () => true,
};

type Evaluated = Omit<ExpectationOutcome, 'index' | 'expectation'>;

/** Evaluates one valid expectation against complete, validated evidence. */
export function evaluateExpectation(e: Expectation, type: JoinType, s: JoinStats, d: JoinDerived): Evaluated {
  switch (e.kind) {
    case 'relationship': {
      const held = ALLOWED[e.expected](d.relationship);
      return {
        outcome: held ? 'held' : 'violated',
        evidence: { expected: e.expected, observed: d.relationship, leftDuplicateKeys: String(s.leftDuplicateKeys), rightDuplicateKeys: String(s.rightDuplicateKeys), leftMaxMultiplicity: String(s.leftMaxMultiplicity), rightMaxMultiplicity: String(s.rightMaxMultiplicity) },
        ...(held ? {} : { reason: `Expected ${e.expected}, but the inputs are ${d.relationship}: ${s.leftDuplicateKeys} duplicated key value(s) on the left, ${s.rightDuplicateKeys} on the right.` }),
      };
    }
    case 'no-row-loss': {
      const dropped = e.side === 'left' ? d.leftRowsDropped : d.rightRowsDropped;
      const nulls = e.side === 'left' ? s.leftNullKeyRows : s.rightNullKeyRows;
      return {
        outcome: dropped > 0n ? 'violated' : 'held',
        evidence: { side: e.side, joinType: type, rowsDropped: String(dropped), nullKeyRows: String(nulls) },
        ...(dropped > 0n ? { reason: `This ${type} JOIN drops ${dropped} ${e.side} input row(s) with no match (${nulls} of the ${e.side} rows have a NULL key).` } : {}),
      };
    }
    case 'no-fan-out': {
      const rows = e.side === 'left' ? s.leftRowsMultiplied : s.rightRowsMultiplied;
      const extra = e.side === 'left' ? s.leftExcessCopies : s.rightExcessCopies;
      return {
        outcome: extra > 0n ? 'violated' : 'held',
        evidence: { side: e.side, rowsMultiplied: String(rows), excessCopies: String(extra) },
        ...(extra > 0n ? { reason: `${rows} ${e.side} input row(s) appear more than once in the output (${extra} extra copies).` } : {}),
      };
    }
    case 'row-count': {
      const n = d.outputRows;
      const okMin = e.min === undefined || n >= BigInt(e.min);
      const okMax = e.max === undefined || n <= BigInt(e.max);
      const held = okMin && okMax;
      return {
        outcome: held ? 'held' : 'violated',
        evidence: { outputRows: String(n), min: e.min === undefined ? 'none' : String(e.min), max: e.max === undefined ? 'none' : String(e.max) },
        ...(held ? {} : { reason: `Expected between ${e.min ?? 'no minimum'} and ${e.max ?? 'no maximum'} output rows (inclusive); the join produces ${n}.` }),
      };
    }
  }
}

/**
 * One outcome per declaration, in order. `evidence` is supplied only when the join evidence is
 * complete and validated; otherwise every valid expectation is unchecked with `uncheckedReason`.
 */
export function completeOutcomes(
  declared: readonly unknown[],
  evidence: { type: JoinType; stats: JoinStats; derived: JoinDerived } | null,
  uncheckedReason: string,
): ExpectationOutcome[] {
  return declared.map((e, index) => {
    const bad = invalidExpectation(e);
    if (bad) return { index, expectation: e, outcome: 'unchecked', reason: `invalid expectation: ${bad}` };
    if (!evidence) return { index, expectation: e, outcome: 'unchecked', reason: uncheckedReason };
    return { index, expectation: e, ...evaluateExpectation(e as Expectation, evidence.type, evidence.stats, evidence.derived) };
  });
}

/** Withdraws every held/violated outcome (cancelled or stale runs), keeping index and identity. */
export function withdrawOutcomes(outcomes: readonly ExpectationOutcome[], reason: string): ExpectationOutcome[] {
  return outcomes.map((o) => (o.outcome === 'unchecked' && o.reason?.startsWith('invalid expectation') ? o : { index: o.index, expectation: o.expectation, outcome: 'unchecked', reason }));
}
