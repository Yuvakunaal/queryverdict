// Ported from the spike's analysis-stats tests (stats.ts, json.ts), plus exactness beyond 2^53.
import { describe, expect, it } from 'vitest';
import { cloneLossless, LosslessNumber, parseLossless, stringifyLossless, type JsonObject } from '../../../src/core/util/lossless-json';
import { checkDerived, checkInvariants, derive, parseCount } from '../../../src/core/verdict/stats';
import type { JoinStats } from '../../../src/core/verdict/types';

// Worked example: left keys A,A,B; right keys A,A,C.
const worked: JoinStats = {
  leftRows: 3n, rightRows: 3n, leftNullKeyRows: 0n, rightNullKeyRows: 0n, leftKeyedRows: 3n, rightKeyedRows: 3n,
  leftDistinctKeys: 2n, rightDistinctKeys: 2n, leftDuplicateKeys: 1n, rightDuplicateKeys: 1n, leftMaxMultiplicity: 2n, rightMaxMultiplicity: 2n,
  leftMaxMultiplicityMatched: 2n, rightMaxMultiplicityMatched: 2n, matchedKeys: 1n, matchedPairs: 4n,
  leftRowsMatched: 2n, rightRowsMatched: 2n, leftRowsMultiplied: 2n, leftExcessCopies: 2n, rightRowsMultiplied: 2n, rightExcessCopies: 2n,
};

describe('derive (INNER and LEFT)', () => {
  it('reproduces the worked example', () => {
    expect([derive('INNER', worked).outputRows, derive('LEFT', worked).outputRows]).toEqual([4n, 5n]);
    const d = derive('INNER', worked);
    expect([d.leftRowsDropped, d.rightRowsDropped, d.leftRowsPreserved, d.relationship, d.matchedRelationship]).toEqual([1n, 1n, 0n, 'many-to-many', 'many-to-many']);
    const l = derive('LEFT', worked);
    expect([l.leftRowsDropped, l.leftRowsPreserved, l.rightRowsDropped]).toEqual([0n, 1n, 1n]);
    expect(checkDerived('LEFT', worked, l)).toEqual([]);
  });

  it('offsetting fan-out and loss: output equals input, both effects still measured', () => {
    // left 1,2; right 1,1: key 1 doubles one row, key 2 is lost.
    const s: JoinStats = { ...worked, leftRows: 2n, rightRows: 2n, leftKeyedRows: 2n, rightKeyedRows: 2n, leftDistinctKeys: 2n, rightDistinctKeys: 1n, leftDuplicateKeys: 0n, rightDuplicateKeys: 1n,
      leftMaxMultiplicity: 1n, rightMaxMultiplicity: 2n, leftMaxMultiplicityMatched: 1n, rightMaxMultiplicityMatched: 2n, matchedKeys: 1n, matchedPairs: 2n, leftRowsMatched: 1n, rightRowsMatched: 2n,
      leftRowsMultiplied: 1n, leftExcessCopies: 1n, rightRowsMultiplied: 0n, rightExcessCopies: 0n };
    expect(checkInvariants(s)).toEqual([]);
    const d = derive('INNER', s);
    expect([d.outputRows, d.leftRowsDropped, s.leftExcessCopies]).toEqual([2n, 1n, 1n]);
  });

  it('is exact above 2^53 (synthetic statistics, BigInt end to end)', () => {
    const big = 3_000_000_000n; // L(k)·R(k) = 9e18 > 2^63 − 1 would overflow BIGINT; HUGEINT/BigInt keep it exact
    const s: JoinStats = { ...worked, leftRows: big, rightRows: big, leftKeyedRows: big, rightKeyedRows: big, leftDistinctKeys: 1n, rightDistinctKeys: 1n, leftDuplicateKeys: 1n, rightDuplicateKeys: 1n,
      leftMaxMultiplicity: big, rightMaxMultiplicity: big, leftMaxMultiplicityMatched: big, rightMaxMultiplicityMatched: big, matchedKeys: 1n, matchedPairs: big * big,
      leftRowsMatched: big, rightRowsMatched: big, leftRowsMultiplied: big, leftExcessCopies: big * (big - 1n), rightRowsMultiplied: big, rightExcessCopies: big * (big - 1n) };
    expect(checkInvariants(s)).toEqual([]);
    expect(derive('INNER', s).outputRows).toBe(9_000_000_000_000_000_000n);
    expect(String(derive('INNER', s).outputRows)).toBe('9000000000000000000');
    expect(Number(9_000_000_000_000_000_001n) === Number(9_000_000_000_000_000_000n)).toBe(true); // why Number is never used
    expect(parseCount('9007199254740993')).toBe(9007199254740993n);
  });

  it('never guesses a count', () => {
    for (const bad of [null, undefined, '', 'NULL', '1e16', '1.0', ' 1']) expect(() => parseCount(bad as string)).toThrow();
  });
});

describe('invariants', () => {
  it('hold for the worked example', () => expect(checkInvariants(worked)).toEqual([]));

  it('catch the Codex collation reproduction (matched right rows exceed right input)', () => {
    const h2: JoinStats = { ...worked, leftRows: 2n, rightRows: 1n, leftKeyedRows: 2n, rightKeyedRows: 1n, leftDistinctKeys: 2n, rightDistinctKeys: 1n,
      leftDuplicateKeys: 0n, rightDuplicateKeys: 0n, leftMaxMultiplicity: 1n, rightMaxMultiplicity: 1n, leftMaxMultiplicityMatched: 1n, rightMaxMultiplicityMatched: 1n,
      matchedKeys: 2n, matchedPairs: 2n, leftRowsMatched: 2n, rightRowsMatched: 2n, leftRowsMultiplied: 0n, leftExcessCopies: 0n, rightRowsMultiplied: 0n, rightExcessCopies: 0n };
    const v = checkInvariants(h2).join(' ');
    expect(v).toContain('right: matched rows (2) exceed non-NULL-key rows (1)');
    expect(v).toContain('matched keys exceed distinct keys');
  });

  it.each([
    ['negative count', { leftExcessCopies: -1n }],
    ['keyed rows inconsistent', { leftKeyedRows: 2n }],
    ['pairs ≠ matched + excess', { matchedPairs: 5n }],
    ['multiplied without excess', { leftExcessCopies: 0n }],
    ['duplicates without multiplicity', { leftMaxMultiplicity: 1n }],
    ['matched max above overall max', { rightMaxMultiplicityMatched: 3n }],
    ['unmatched negative (matched rows exceed rows)', { leftRowsMatched: 4n }],
    ['missing field', { leftRows: undefined }],
  ])('flag %s', (_n, patch) => expect(checkInvariants({ ...worked, ...patch } as JoinStats).length).toBeGreaterThan(0));

  it('checkDerived rejects an output that does not follow from the statistics', () => {
    expect(checkDerived('INNER', worked, { ...derive('INNER', worked), outputRows: 5n }).length).toBeGreaterThan(0);
    expect(checkDerived('LEFT', worked, { ...derive('LEFT', worked), relationship: 'one-to-one' }).length).toBeGreaterThan(0);
  });
});

describe('lossless JSON (QV-ENG-006)', () => {
  const src = '{"a":9007199254740993,"loc":18446744073709551615,"h":170141183460469231731687303715884105727,"d":-12345678901234567890.123456789,"e":1.5e+300,"s":"x\\"y\\u00e9","n":null,"t":true,"l":[1,2.50]}';
  it('keeps every numeric literal exactly and round-trips byte for byte', () => {
    const v = parseLossless(src) as JsonObject;
    expect(v.a).toBeInstanceOf(LosslessNumber);
    expect(String(v.a)).toBe('9007199254740993');
    expect((v.loc as LosslessNumber).toBigInt()).toBe(18446744073709551615n);
    expect(String((v.l as LosslessNumber[])[1])).toBe('2.50');
    expect(v.s).toBe('x"yé');
    expect(stringifyLossless(v)).toBe(src.replace('\\u00e9', 'é'));
    expect((JSON.parse(src) as { a: number }).a).toBe(9007199254740992); // what JSON.parse would have done
    expect(stringifyLossless(cloneLossless(v))).toBe(stringifyLossless(v));
  });
  it('refuses plain numbers, duplicate keys, prototype keys and malformed input', () => {
    expect(() => stringifyLossless({ x: 2 ** 60 } as unknown as JsonObject)).toThrow();
    expect(() => parseLossless('{"a":1,"a":2}')).toThrow(/duplicate/);
    expect(Object.getPrototypeOf(parseLossless('{"__proto__":{"polluted":1}}'))).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    for (const bad of ['{"a":1,}', '[1 2]', '01', '{"a":1} x', '"\u0001"', '+1']) expect(() => parseLossless(bad)).toThrow();
  });
});
