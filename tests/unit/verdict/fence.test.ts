// QV-ENG-002 / QV-SA-002: the publication fence decides authority at hand-off time.
import { describe, expect, it } from 'vitest';
import type { DataEpoch, Generation, SessionState, Terminal } from '../../../src/core/engine/types';
import { completeOutcomes } from '../../../src/core/verdict/expectations';
import { finding, joinFindings, outcomeFindings } from '../../../src/core/verdict/findings';
import { currency, publish, type DraftReport, type FenceContext } from '../../../src/core/verdict/report';
import { derive, exactDerived, exactStats } from '../../../src/core/verdict/stats';
import type { JoinStats } from '../../../src/core/verdict/types';

const G = (n: number) => n as Generation;
const E = (n: number) => n as DataEpoch;
const stats: JoinStats = {
  leftRows: 3n, rightRows: 4n, leftNullKeyRows: 0n, rightNullKeyRows: 0n, leftKeyedRows: 3n, rightKeyedRows: 4n, leftDistinctKeys: 1n, rightDistinctKeys: 1n,
  leftDuplicateKeys: 1n, rightDuplicateKeys: 1n, leftMaxMultiplicity: 3n, rightMaxMultiplicity: 4n, leftMaxMultiplicityMatched: 3n, rightMaxMultiplicityMatched: 4n,
  matchedKeys: 1n, matchedPairs: 12n, leftRowsMatched: 3n, rightRowsMatched: 4n, leftRowsMultiplied: 3n, leftExcessCopies: 9n, rightRowsMultiplied: 4n, rightExcessCopies: 8n,
};
const derived = derive('INNER', stats);
const declared = [{ kind: 'no-fan-out', join: 0, side: 'left' }, { kind: 'row-count', min: 12, max: 12 }, { kind: 'nope' }];
const outcomes = completeOutcomes(declared, { type: 'INNER', stats, derived }, 'x');

function draft(over: Partial<DraftReport> = {}): DraftReport {
  return {
    sqlText: 'SELECT * FROM l JOIN r ON l.k = r.k', queryHash: 'h', inputs: [], stamp: { generation: G(1), epoch: E(5) }, status: 'analyzed', nonAuthoritativeReasons: [],
    join: { type: 'INNER', left: { name: 'l', ref: 'l' }, right: { name: 'r', ref: 'r' }, keys: [], stats: exactStats(stats), derived: exactDerived(derived), witnesses: [], validation: { invariants: 'held', invariantViolations: [], semiJoin: 'agreed', executedCount: 'agreed', witnesses: 'verified', snapshot: 'verified', notes: [] } },
    findings: [...joinFindings('INNER', stats, derived, 'validated'), ...outcomeFindings(outcomes)], expectations: outcomes.slice(0, 2), coverage: { checked: ['x'], notChecked: [] }, resources: null, ...over,
  };
}
const ready: SessionState = { kind: 'ready' };
function ctx(over: Partial<FenceContext> = {}): FenceContext {
  return { id: 'r1', sqlText: 'SELECT * FROM l JOIN r ON l.k = r.k', queryHash: 'h', declared: declared.slice(0, 2), terminal: { status: 'ok' }, resultGeneration: G(1), cancelled: false, deadlineMs: null, session: { generation: G(1), epoch: E(5), state: ready }, now: 1, ...over };
}

describe('publication fence', () => {
  it('an uninterrupted, complete run is authoritative and keeps its evidence and outcomes', () => {
    const r = publish(draft(), ctx());
    expect(r).toMatchObject({ authoritative: true, status: 'analyzed', nonAuthoritativeReasons: [] });
    expect(r.join?.stats?.matchedPairs).toBe('12');
    expect(r.expectations.map((o) => o.outcome)).toEqual(['violated', 'held']);
  });

  const interruptions: [string, Partial<FenceContext>, string][] = [
    ['cancel requested before hand-off', { cancelled: true }, 'cancelled'],
    ['cancelled by the user during the final ROLLBACK', { terminal: { status: 'cancelled', by: 'user', stop: 'cooperative' } }, 'cancelled'],
    ['session deadline', { terminal: { status: 'cancelled', by: 'deadline', stop: 'terminated' } }, 'budget-exhausted'],
    ['analysis deadline (including queue wait)', { deadlineMs: 30_000 }, 'budget-exhausted'],
    ['engine replaced while running', { terminal: { status: 'stale', reason: 'generation-changed' } }, 'stale'],
    ['session disposed while running', { terminal: { status: 'stale', reason: 'disposed' } }, 'stale'],
    ['generation changed at the hand-off', { session: { generation: G(2), epoch: E(6), state: ready } }, 'stale'],
    ['late result from an older generation', { resultGeneration: G(0) }, 'stale'],
    ['data changed between completion and publication', { session: { generation: G(1), epoch: E(6), state: ready } }, 'stale'],
    ['session disposed before publication', { session: { generation: G(1), epoch: E(5), state: { kind: 'disposed' } } }, 'stale'],
    ['engine recovering at publication', { session: { generation: G(1), epoch: E(5), state: { kind: 'recovering', reason: 'x' } } }, 'stale'],
    ['ROLLBACK could not be confirmed', { terminal: { status: 'error', phase: 'engine', message: 'cleanup could not be confirmed; the engine was restarted' } }, 'diagnostic-failed'],
    ['refused (queue wait)', { terminal: { status: 'refused', reason: 'queue-wait' } }, 'diagnostic-failed'],
  ];
  it.each(interruptions)('%s → not authoritative, no measurements, no held or violated outcome', (_name, over, status) => {
    const r = publish(draft(), ctx(over));
    expect(r.authoritative).toBe(false);
    expect(r.status).toBe(status);
    expect(r.join).toBeNull();
    expect(r.findings.some((f) => f.category === 'expectation-violation' || f.category === 'observed' || f.category === 'suspicious')).toBe(false);
    expect(r.expectations.map((o) => [o.index, o.expectation, o.outcome])).toEqual([[0, declared[0], 'unchecked'], [1, declared[1], 'unchecked']]);
    expect(r.nonAuthoritativeReasons.length).toBeGreaterThan(0);
  });

  it('no draft (the body never finished) still gives one unchecked outcome per declaration, invalid ones stay invalid', () => {
    const r = publish(null, ctx({ terminal: { status: 'stale', reason: 'generation-changed' } as Terminal, declared }));
    expect(r.expectations.map((o) => [o.index, o.outcome, o.reason?.startsWith('invalid') ?? false])).toEqual([[0, 'unchecked', false], [1, 'unchecked', false], [2, 'unchecked', true]]);
    expect(r.expectations[2]?.expectation).toBe(declared[2]);
  });

  it('a non-authoritative draft never becomes authoritative', () => {
    const r = publish(draft({ status: 'budget-exhausted', nonAuthoritativeReasons: ['witnesses not run'] }), ctx());
    expect(r).toMatchObject({ authoritative: false, status: 'budget-exhausted' });
    const r2 = publish(draft({ status: 'partially-analyzed', nonAuthoritativeReasons: [] }), ctx());
    expect(r2.authoritative).toBe(false);
  });

  it('historical rules: generation, epoch, query and disposal make a published report historical', () => {
    const r = publish(draft(), ctx());
    expect(currency(r, { generation: G(1), epoch: E(5), state: ready })).toEqual({ current: true });
    expect(currency(r, { generation: G(2), epoch: E(5), state: ready }).reason).toBe('engine restarted');
    expect(currency(r, { generation: G(1), epoch: E(6), state: ready }).reason).toBe('data may have changed');
    expect(currency(r, { generation: G(1), epoch: E(5), state: ready, queryHash: 'other' }).reason).toBe('query changed');
    expect(currency(r, { generation: G(1), epoch: E(5), state: { kind: 'disposed' } }).reason).toBe('session ended');
  });

  it('labels every finding category with its PRD display label', () => {
    expect(finding('suspicious', 'x', 'y')).toMatchObject({ label: 'Suspicious pattern', severity: 'warning' });
    expect(finding('expectation-unchecked', 'x', 'y')).toMatchObject({ label: 'Unchecked', confidence: 'incomplete' });
    expect(finding('query-failure', 'x', 'y')).toMatchObject({ label: 'Query failure', severity: 'operational-error' });
  });
});
