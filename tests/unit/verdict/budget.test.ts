// QV-ENG-001 / QV-SA-001: the single budget gate (written before the probe pipeline used it).
import { describe, expect, it } from 'vitest';
import { createBudgetGate, groupingEstimate, PAIR_PRODUCING, type ProbeCost } from '../../../src/core/verdict/budget';

const limits = (pairs: bigint, grouping = 1_000_000n) => ({ executionPairRows: pairs, groupingBytes: grouping, maxInputRows: 1_000n, maxTransferBytes: 1_000 });
const pairsCost = (n: bigint): ProbeCost => ({ scansOfInputs: 2, pairRows: n, groupingBytes: 0n });

describe('budget gate', () => {
  it('QV-SA-001 arithmetic: a 3×4 same-key join (12 pairs) and its fan-out witness (12 pairs) are refused under a budget of 1', () => {
    const g = createBudgetGate(limits(1n));
    expect(g.approve('executed-count', pairsCost(12n))).toMatchObject({ ok: false, reason: expect.stringContaining('over the execution budget of 1') });
    expect(g.check([pairsCost(12n)]).ok).toBe(false);
    expect(g.approve('witness-join', pairsCost(12n)).ok).toBe(false);
    expect(g.spent.pairRows).toBe(0n);
    expect(g.log.map((r) => [r.probe, r.decision])).toEqual([['executed-count', 'refused'], ['witness-join', 'refused']]);
  });

  it('accounts pair-producing work cumulatively: each witness fits alone, together they do not', () => {
    const g = createBudgetGate(limits(10n));
    expect(g.approve('witness-join', pairsCost(4n)).ok).toBe(true);
    expect(g.approve('witness-join', pairsCost(4n)).ok).toBe(true);
    expect(g.approve('witness-join', pairsCost(4n))).toMatchObject({ ok: false, reason: expect.stringContaining('12 rows') });
    expect(g.spent.pairRows).toBe(8n);
    expect(g.check([pairsCost(1n), pairsCost(1n), pairsCost(1n)]).ok).toBe(false); // 8 + 3 > 10, and check spends nothing
    expect(g.check([pairsCost(1n), pairsCost(1n)]).ok).toBe(true);
    expect(g.spent.pairRows).toBe(8n);
  });

  it('exactly at the budget is allowed; one more row is not', () => {
    const g = createBudgetGate(limits(12n));
    expect(g.approve('executed-count', pairsCost(12n)).ok).toBe(true);
    expect(g.approve('witness-join', pairsCost(1n)).ok).toBe(false);
  });

  it.each([
    ['number instead of bigint', { scansOfInputs: 0, pairRows: 1 as unknown as bigint, groupingBytes: 0n }],
    ['negative pairs', { scansOfInputs: 0, pairRows: -1n, groupingBytes: 0n }],
    ['unknown grouping', { scansOfInputs: 0, pairRows: 0n, groupingBytes: undefined as unknown as bigint }],
    ['fractional scans', { scansOfInputs: 0.5, pairRows: 0n, groupingBytes: 0n }],
    ['missing cost', undefined as unknown as ProbeCost],
  ])('refuses unknown or invalid estimates (%s)', (_n, cost) => {
    const g = createBudgetGate(limits(100n));
    expect(g.approve('executed-count', cost)).toMatchObject({ ok: false, reason: expect.stringContaining('unknown or invalid cost') });
    expect(g.spent.pairRows).toBe(0n);
  });

  it('retained grouping state accumulates; transient state must fit next to it', () => {
    const g = createBudgetGate(limits(100n, 100n));
    expect(g.approve('frequencies-left', { scansOfInputs: 1, pairRows: 0n, groupingBytes: 40n, retainsGrouping: true }).ok).toBe(true);
    expect(g.approve('frequencies-right', { scansOfInputs: 1, pairRows: 0n, groupingBytes: 40n, retainsGrouping: true }).ok).toBe(true);
    expect(g.approve('statistics', { scansOfInputs: 0, pairRows: 0n, groupingBytes: 20n }).ok).toBe(true);
    expect(g.approve('semi-join-left', { scansOfInputs: 2, pairRows: 0n, groupingBytes: 21n }).ok).toBe(false);
    expect(g.spent.groupingBytes).toBe(100n);
    expect(g.spent.scansOfInputs).toBe(2);
  });

  it('diagnostic transfer is bounded, and an exceeded transfer limit refuses everything after it', () => {
    const g = createBudgetGate(limits(100n));
    expect(g.recordTransfer(600).ok).toBe(true);
    expect(g.recordTransfer(401).ok).toBe(false);
    expect(g.approve('relations', { scansOfInputs: 0, pairRows: 0n, groupingBytes: 0n }).ok).toBe(false);
  });

  it('invalid limits refuse every probe (fail closed)', () => {
    const g = createBudgetGate({ executionPairRows: 0n, groupingBytes: 1n, maxInputRows: 1n, maxTransferBytes: 1 });
    expect(g.approve('relations', { scansOfInputs: 0, pairRows: 0n, groupingBytes: 0n })).toMatchObject({ ok: false, reason: expect.stringContaining('invalid limits') });
  });

  it('deny records a refusal without spending', () => {
    const g = createBudgetGate(limits(100n));
    g.deny('witness-join', pairsCost(5n), 'plan refused');
    expect(g.spent.pairRows).toBe(0n);
    expect(g.log).toEqual([{ probe: 'witness-join', cost: { scansOfInputs: 2, pairRows: '5', groupingBytes: '0' }, decision: 'refused', reason: 'plan refused' }]);
  });

  it('names exactly the executed count and witness recounts as pair-producing', () => {
    expect([...PAIR_PRODUCING].sort()).toEqual(['executed-count', 'witness-join']);
    expect(groupingEstimate(10n, 8n)).toBe(880n); // 10 × (8 + 16 + 64)
  });
});
