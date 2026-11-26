// QV-ENG-007: exactly one outcome per declaration, in order, with identity; P0 expectation semantics.
import { describe, expect, it } from 'vitest';
import { completeOutcomes, evaluateExpectation, invalidExpectation, withdrawOutcomes } from '../../../src/core/verdict/expectations';
import { derive } from '../../../src/core/verdict/stats';
import type { Expectation, JoinStats } from '../../../src/core/verdict/types';

const base: JoinStats = {
  leftRows: 3n, rightRows: 3n, leftNullKeyRows: 0n, rightNullKeyRows: 0n, leftKeyedRows: 3n, rightKeyedRows: 3n, leftDistinctKeys: 3n, rightDistinctKeys: 3n,
  leftDuplicateKeys: 0n, rightDuplicateKeys: 0n, leftMaxMultiplicity: 1n, rightMaxMultiplicity: 1n, leftMaxMultiplicityMatched: 1n, rightMaxMultiplicityMatched: 1n,
  matchedKeys: 3n, matchedPairs: 3n, leftRowsMatched: 3n, rightRowsMatched: 3n, leftRowsMultiplied: 0n, leftExcessCopies: 0n, rightRowsMultiplied: 0n, rightExcessCopies: 0n,
};
// customers (unique) ← orders: left 1,2 ; right 1,1,2 (one-to-many, legitimate expansion)
const oneToMany: JoinStats = { ...base, leftRows: 2n, leftKeyedRows: 2n, leftDistinctKeys: 2n, rightDistinctKeys: 2n, rightDuplicateKeys: 1n, rightMaxMultiplicity: 2n, rightMaxMultiplicityMatched: 2n,
  matchedKeys: 2n, matchedPairs: 3n, leftRowsMatched: 2n, rightRowsMatched: 3n, leftRowsMultiplied: 1n, leftExcessCopies: 1n };
const ev = (e: Expectation, s = base, t: 'INNER' | 'LEFT' = 'INNER') => evaluateExpectation(e, t, s, derive(t, s));

describe('expectation validation', () => {
  it.each([
    [{ kind: 'relationship', join: 0, expected: 'one-to-one' }, null],
    [{ kind: 'no-row-loss', join: 0, side: 'right' }, null],
    [{ kind: 'no-fan-out', join: 0, side: 'left' }, null],
    [{ kind: 'row-count', min: 0 }, null],
    [{ kind: 'row-count', min: 2, max: 2 }, null],
    [null, 'not an object'],
    [[], 'not an object'],
    ['relationship', 'not an object'],
    [{ kind: 'relationship', join: 1, expected: 'one-to-one' }, 'join must be 0'],
    [{ kind: 'relationship', join: 0, expected: 'one-to-few' }, 'expected must be'],
    [{ kind: 'no-fan-out', join: 0 }, "side must be 'left' or 'right'"],
    [{ kind: 'no-row-loss', join: 0, side: 'both' }, "side must be 'left' or 'right'"],
    [{ kind: 'row-count' }, 'needs min, max or both'],
    [{ kind: 'row-count', min: 3, max: 2 }, 'min is greater than max'],
    [{ kind: 'row-count', min: -1 }, 'non-negative integers'],
    [{ kind: 'row-count', max: 1.5 }, 'non-negative integers'],
    [{ kind: 'row-count', max: 2 ** 60 }, 'non-negative integers'],
    [{ kind: 'row-count', min: '1' }, 'non-negative integers'],
    [{ kind: 'row-count', min: 1, extra: true }, 'unknown field(s) extra'],
    [{ kind: 'metric-preserved', column: 'amount' }, 'outside the P0 diagnostic scope'],
    [{ kind: 'grain', columns: ['id'] }, 'outside the P0 diagnostic scope'],
    [{ kind: 'unknown' }, 'unknown expectation kind'],
  ])('%j → %s', (e, problem) => {
    const r = invalidExpectation(e);
    if (problem === null) expect(r).toBeNull();
    else expect(r).toContain(problem);
  });
});

describe('expectation semantics (PRD §4 counting semantics)', () => {
  it('relationship allowances: one-to-one satisfies one-to-many and many-to-one; many-to-many allows anything', () => {
    expect(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'].map((x) => ev({ kind: 'relationship', join: 0, expected: x as never }).outcome)).toEqual(['held', 'held', 'held', 'held']);
    expect(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'].map((x) => ev({ kind: 'relationship', join: 0, expected: x as never }, oneToMany).outcome)).toEqual(['violated', 'held', 'violated', 'held']);
  });
  it('a one-to-many intentional join: declaring one-to-many holds; declaring no left fan-out is violated', () => {
    expect(ev({ kind: 'relationship', join: 0, expected: 'one-to-many' }, oneToMany).outcome).toBe('held');
    expect(ev({ kind: 'no-fan-out', join: 0, side: 'left' }, oneToMany)).toMatchObject({ outcome: 'violated', evidence: { rowsMultiplied: '1', excessCopies: '1' } });
    expect(ev({ kind: 'no-fan-out', join: 0, side: 'right' }, oneToMany).outcome).toBe('held');
  });
  it('no-row-loss: unmatched left rows are preserved by LEFT, dropped by INNER; right rows are dropped by both', () => {
    const lossy: JoinStats = { ...base, leftRowsMatched: 2n, rightRowsMatched: 2n, matchedKeys: 2n, matchedPairs: 2n };
    expect(ev({ kind: 'no-row-loss', join: 0, side: 'left' }, lossy, 'LEFT').outcome).toBe('held');
    expect(ev({ kind: 'no-row-loss', join: 0, side: 'left' }, lossy, 'INNER')).toMatchObject({ outcome: 'violated', evidence: { rowsDropped: '1' } });
    expect(ev({ kind: 'no-row-loss', join: 0, side: 'right' }, lossy, 'LEFT').outcome).toBe('violated');
  });
  it('row-count bounds are inclusive and exact', () => {
    expect(ev({ kind: 'row-count', min: 3, max: 3 }).outcome).toBe('held');
    expect(ev({ kind: 'row-count', min: 4 }).outcome).toBe('violated');
    expect(ev({ kind: 'row-count', max: 2 }).outcome).toBe('violated');
  });
});

describe('complete outcomes', () => {
  const declared: unknown[] = [{ kind: 'row-count', min: 3 }, { kind: 'bad' }, { kind: 'relationship', join: 0, expected: 'one-to-one' }, null, { kind: 'no-fan-out', join: 0, side: 'left' }];
  it('one outcome per declaration, same order and object identity, with evidence', () => {
    const o = completeOutcomes(declared, { type: 'INNER', stats: base, derived: derive('INNER', base) }, 'n/a');
    expect(o.map((x) => [x.index, x.outcome])).toEqual([[0, 'held'], [1, 'unchecked'], [2, 'held'], [3, 'unchecked'], [4, 'held']]);
    o.forEach((x, i) => expect(x.expectation).toBe(declared[i]));
  });
  it('without complete evidence every valid declaration is unchecked with the reason (never held)', () => {
    const o = completeOutcomes(declared, null, 'witnesses not verified');
    expect(o.every((x) => x.outcome === 'unchecked')).toBe(true);
    expect(o[0]?.reason).toBe('witnesses not verified');
    expect(o[1]?.reason).toMatch(/^invalid expectation/);
  });
  it('withdrawal keeps identity and turns held/violated into unchecked', () => {
    const o = withdrawOutcomes(completeOutcomes(declared, { type: 'INNER', stats: oneToMany, derived: derive('INNER', oneToMany) }, 'x'), 'stale');
    expect(o.map((x) => x.outcome)).toEqual(['unchecked', 'unchecked', 'unchecked', 'unchecked', 'unchecked']);
    expect(o[1]?.reason).toMatch(/^invalid/);
    expect(o[4]?.reason).toBe('stale');
    o.forEach((x, i) => expect(x.expectation).toBe(declared[i]));
  });
});
