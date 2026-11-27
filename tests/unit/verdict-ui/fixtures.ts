// Report fixtures for the M09 presentation tests, built with the REAL M08 functions (derive,
// joinFindings, completeOutcomes, outcomeFindings, publish): the UI is tested against reports the
// core can actually produce, not hand-written report objects. Statistics are written by hand from
// the UI specification's illustrative fixture (UI_SPECIFICATION §5) and checked by M08's own
// invariants in the tests.
import type { DataEpoch, Generation, SessionState } from '../../../src/core/engine/types';
import { completeOutcomes } from '../../../src/core/verdict/expectations';
import { finding, joinFindings, outcomeFindings } from '../../../src/core/verdict/findings';
import { publish, type DraftReport, type FenceContext } from '../../../src/core/verdict/report';
import { derive, exactDerived, exactStats } from '../../../src/core/verdict/stats';
import type { JoinEvidence, JoinStats, JoinType, VerdictReport, Witness } from '../../../src/core/verdict/types';

export const G = (n: number) => n as Generation;
export const E = (n: number) => n as DataEpoch;
const ready: SessionState = { kind: 'ready' };

/** orders (8 rows: 101–107, NULL) INNER JOIN customers (9 rows: 101, 102, 102, 103, 104, 105, 105, 106, 109). */
export const ILLUSTRATIVE: JoinStats = {
  leftRows: 8n, rightRows: 9n, leftNullKeyRows: 1n, rightNullKeyRows: 0n, leftKeyedRows: 7n, rightKeyedRows: 9n,
  leftDistinctKeys: 7n, rightDistinctKeys: 7n, leftDuplicateKeys: 0n, rightDuplicateKeys: 2n,
  leftMaxMultiplicity: 1n, rightMaxMultiplicity: 2n, leftMaxMultiplicityMatched: 1n, rightMaxMultiplicityMatched: 2n,
  matchedKeys: 6n, matchedPairs: 8n, leftRowsMatched: 6n, rightRowsMatched: 8n,
  leftRowsMultiplied: 2n, leftExcessCopies: 2n, rightRowsMultiplied: 0n, rightExcessCopies: 0n,
};
export const ILLUSTRATIVE_WITNESSES: Witness[] = [
  { kind: 'fan-out', key: ['102'], leftRows: '1', rightRows: '2', outputRows: '2' },
  { kind: 'fan-out', key: ['105'], leftRows: '1', rightRows: '2', outputRows: '2' },
  { kind: 'unmatched-left', key: ['107'], leftRows: '1', rightRows: '0', outputRows: '0' },
  { kind: 'unmatched-right', key: ['109'], leftRows: '0', rightRows: '1', outputRows: '0' },
];

/** customers (1, 2, 3) LEFT JOIN orders (1, 2, 2): legitimate one-to-many expansion, one customer kept unmatched. */
export const LEGIT_LEFT: JoinStats = {
  leftRows: 3n, rightRows: 3n, leftNullKeyRows: 0n, rightNullKeyRows: 0n, leftKeyedRows: 3n, rightKeyedRows: 3n,
  leftDistinctKeys: 3n, rightDistinctKeys: 2n, leftDuplicateKeys: 0n, rightDuplicateKeys: 1n,
  leftMaxMultiplicity: 1n, rightMaxMultiplicity: 2n, leftMaxMultiplicityMatched: 1n, rightMaxMultiplicityMatched: 2n,
  matchedKeys: 2n, matchedPairs: 3n, leftRowsMatched: 2n, rightRowsMatched: 3n,
  leftRowsMultiplied: 1n, leftExcessCopies: 1n, rightRowsMultiplied: 0n, rightExcessCopies: 0n,
};

/** INNER JOIN of left keys 1, 2, 2 with right keys 1, 3: one pair; two left rows and one right row dropped; no fan-out (Codex M09). */
export const LOSS_ONLY: JoinStats = {
  leftRows: 3n, rightRows: 2n, leftNullKeyRows: 0n, rightNullKeyRows: 0n, leftKeyedRows: 3n, rightKeyedRows: 2n,
  leftDistinctKeys: 2n, rightDistinctKeys: 2n, leftDuplicateKeys: 1n, rightDuplicateKeys: 0n,
  leftMaxMultiplicity: 2n, rightMaxMultiplicity: 1n, leftMaxMultiplicityMatched: 1n, rightMaxMultiplicityMatched: 1n,
  matchedKeys: 1n, matchedPairs: 1n, leftRowsMatched: 1n, rightRowsMatched: 1n,
  leftRowsMultiplied: 0n, leftExcessCopies: 0n, rightRowsMultiplied: 0n, rightExcessCopies: 0n,
};

const VALIDATED: JoinEvidence['validation'] = { invariants: 'held', invariantViolations: [], semiJoin: 'agreed', executedCount: 'agreed', witnesses: 'verified', snapshot: 'verified', notes: [] };
const SQL = 'SELECT o.order_id, o.customer_id, c.region FROM orders AS o INNER JOIN customers AS c ON o.customer_id = c.customer_id';

export interface Built {
  readonly draft: DraftReport;
  readonly declared: readonly unknown[];
}

/** A complete, validated draft as the M08 service builds it at its step 14. */
export function analyzedDraft(type: JoinType, stats: JoinStats, declared: readonly unknown[], witnesses: Witness[] = [], over: Partial<DraftReport> = {}): Built {
  const derived = derive(type, stats);
  const expectations = completeOutcomes(declared, { type, stats, derived }, 'not evaluated');
  const unchecked = expectations.filter((o) => o.outcome === 'unchecked').length;
  const draft: DraftReport = {
    sqlText: SQL, queryHash: 'a'.repeat(64), inputs: [
      { relation: 'orders', database: 'memory', schema: 'main', oid: '11', temporary: false, origin: 'sql' },
      { relation: 'customers', database: 'memory', schema: 'main', oid: '12', temporary: false, origin: 'sql' },
    ],
    stamp: { generation: G(1), epoch: E(4) },
    status: unchecked ? 'partially-analyzed' : 'analyzed',
    nonAuthoritativeReasons: unchecked ? [`${unchecked} expectation(s) unchecked`, 'analysis status is partially-analyzed'] : [],
    join: {
      type, left: { name: 'orders', ref: 'o' }, right: { name: 'customers', ref: 'c' },
      keys: [{ left: 'customer_id', right: 'customer_id', type: 'INTEGER' }],
      stats: exactStats(stats), derived: exactDerived(derived), witnesses, validation: VALIDATED,
    },
    findings: [...joinFindings(type, stats, derived, 'validated'), ...outcomeFindings(expectations)],
    expectations,
    coverage: { checked: ['key frequencies of both inputs (exact counts)'], notChecked: ['whether the query expresses the intended business logic'] },
    resources: null,
    ...over,
  };
  return { draft, declared };
}

/** A draft for an outcome without complete validated evidence (the service's `draft()`). */
export function failedDraft(status: DraftReport['status'], findings: DraftReport['findings'], uncheckedReason: string, declared: readonly unknown[], join: JoinEvidence | null = null): Built {
  const expectations = completeOutcomes(declared, null, uncheckedReason);
  return {
    declared,
    draft: {
      sqlText: SQL, queryHash: 'a'.repeat(64), inputs: [], stamp: { generation: G(1), epoch: E(4) }, status,
      nonAuthoritativeReasons: [`analysis status is ${status}`, uncheckedReason],
      join, findings: [...findings, ...outcomeFindings(expectations)], expectations,
      coverage: { checked: [], notChecked: ['whether the query expresses the intended business logic', `join statistics and expectations (${uncheckedReason})`] },
      resources: null,
    },
  };
}

export function ctx(b: Built, over: Partial<FenceContext> = {}): FenceContext {
  return {
    id: 'r1', sqlText: b.draft.sqlText, queryHash: b.draft.queryHash, declared: b.declared, terminal: { status: 'ok' }, resultGeneration: G(1),
    cancelled: false, deadlineMs: null, session: { generation: G(1), epoch: E(4), state: ready }, now: 1_700_000_000_000, ...over,
  };
}

/** Publishes through the real fence. */
export const report = (b: Built, over: Partial<FenceContext> = {}): VerdictReport => publish(b.draft, ctx(b, over));

export const NO_LEFT_FAN_OUT = { kind: 'no-fan-out', join: 0, side: 'left' } as const;

export const unsupportedFinding = () =>
  finding('unsupported', 'unsupported-construct', 'WHERE is outside the Verdict diagnostic scope (post-join filter). No data conclusions are drawn.', { construct: 'WHERE', detail: 'post-join filter' });

export { VALIDATED };
