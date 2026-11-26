import { describe, expect, it } from 'vitest';
import { checkInvariants, derive, evaluateJoinExpectation, joinFindings, parseBig } from '../../src/analysis/stats';
import { LosslessNumber, parseLossless, stringifyLossless } from '../../src/analysis/json';
import { recognizeMvp } from '../../src/analysis/ast';
import type { JoinStats } from '../../src/analysis/types';

// Worked example from COMPETITOR_RESEARCH.md: left keys A,A,B; right keys A,A,C.
const worked: JoinStats = {
  leftRows: 3n, rightRows: 3n, leftNullKeyRows: 0n, rightNullKeyRows: 0n, leftKeyedRows: 3n, rightKeyedRows: 3n,
  leftDistinctKeys: 2n, rightDistinctKeys: 2n, leftDuplicateKeys: 1n, rightDuplicateKeys: 1n, leftMaxMultiplicity: 2n, rightMaxMultiplicity: 2n,
  leftMaxMultiplicityMatched: 2n, rightMaxMultiplicityMatched: 2n, matchedKeys: 1n, matchedPairs: 4n,
  leftRowsMatched: 2n, rightRowsMatched: 2n, leftRowsMultiplied: 2n, leftExcessCopies: 2n, rightRowsMultiplied: 2n, rightExcessCopies: 2n,
};

describe('derive', () => {
  it('reproduces the research worked example for every join type', () => {
    expect(['INNER', 'LEFT', 'RIGHT', 'FULL'].map((t) => derive(t as never, worked).outputRows)).toEqual([4n, 5n, 5n, 6n]);
    const d = derive('INNER', worked);
    expect([d.leftRowsDropped, d.rightRowsDropped, d.relationship, d.effectiveRelationship]).toEqual([1n, 1n, 'many-to-many', 'many-to-many']);
    expect(d.outputRows - worked.leftRows).toBe(worked.leftExcessCopies - d.leftUnmatchedRows);
  });

  it('is exact above 2^53', () => {
    const big = 100_000_000n;
    const s = { ...worked, leftRows: big, rightRows: big, matchedPairs: big * big, leftRowsMatched: big, rightRowsMatched: big };
    expect(derive('INNER', s).outputRows).toBe(10_000_000_000_000_000n);
    expect(parseBig('10000000000000000')).toBe(10n ** 16n);
    expect(() => parseBig('1e16')).toThrow();
    expect(() => parseBig('NULL')).toThrow(); // a missing count is an error, never zero
  });
});

describe('invariants (Codex H2)', () => {
  it('hold for the worked example', () => expect(checkInvariants(worked)).toEqual([]));

  it('catch the Codex collation reproduction (matched right rows exceed right input)', () => {
    // VARCHAR 'A','a' JOIN VARCHAR COLLATE NOCASE 'a': frequency model counted 2 right rows matched out of 1.
    const h2: JoinStats = { ...worked, leftRows: 2n, rightRows: 1n, leftKeyedRows: 2n, rightKeyedRows: 1n, leftDistinctKeys: 2n, rightDistinctKeys: 1n,
      leftDuplicateKeys: 0n, rightDuplicateKeys: 0n, leftMaxMultiplicity: 1n, rightMaxMultiplicity: 1n, leftMaxMultiplicityMatched: 1n, rightMaxMultiplicityMatched: 1n,
      matchedKeys: 2n, matchedPairs: 2n, leftRowsMatched: 2n, rightRowsMatched: 2n, leftRowsMultiplied: 0n, leftExcessCopies: 0n, rightRowsMultiplied: 0n, rightExcessCopies: 0n };
    const v = checkInvariants(h2);
    expect(v.join(' ')).toContain('right: matched rows (2) exceed non-NULL-key rows (1)');
    expect(v.join(' ')).toContain('matched keys exceed distinct keys');
    expect(derive('INNER', h2).rightUnmatchedRows).toBe(-1n); // what would have been reported
  });

  it.each([
    ['negative count', { leftExcessCopies: -1n }],
    ['keyed rows inconsistent', { leftKeyedRows: 2n }],
    ['pairs ≠ matched + excess', { matchedPairs: 5n }],
    ['multiplied without excess', { leftExcessCopies: 0n }],
    ['duplicates without multiplicity', { leftMaxMultiplicity: 1n }],
    ['matched max above overall max', { rightMaxMultiplicityMatched: 3n }],
  ])('flag %s', (_n, patch) => expect(checkInvariants({ ...worked, ...patch } as JoinStats).length).toBeGreaterThan(0));
});

describe('expectation outcomes (no silent results)', () => {
  it('relationship: stricter observations hold, looser ones are violated, with evidence', () => {
    const oneToOne = { ...worked, leftDuplicateKeys: 0n, rightDuplicateKeys: 0n };
    expect(evaluateJoinExpectation('INNER', oneToOne, derive('INNER', oneToOne), { kind: 'relationship', join: 0, expected: 'many-to-one' }).outcome).toBe('held');
    const o = evaluateJoinExpectation('INNER', worked, derive('INNER', worked), { kind: 'relationship', join: 0, expected: 'many-to-one' });
    expect(o.outcome).toBe('violated');
    expect(o.evidence).toMatchObject({ observed: 'many-to-many', rightDuplicateKeys: '1' });
  });

  it('no-fan-out defaults to the left side', () => {
    const lookup = { ...worked, leftExcessCopies: 0n, leftRowsMultiplied: 0n };
    expect(evaluateJoinExpectation('INNER', lookup, derive('INNER', lookup), { kind: 'no-fan-out', join: 0 }).outcome).toBe('held');
    expect(evaluateJoinExpectation('INNER', lookup, derive('INNER', lookup), { kind: 'no-fan-out', join: 0, side: 'right' }).outcome).toBe('violated');
  });

  it('no-row-loss depends on join type', () => {
    expect(evaluateJoinExpectation('LEFT', worked, derive('LEFT', worked), { kind: 'no-row-loss', join: 0, side: 'left' }).outcome).toBe('held');
    expect(evaluateJoinExpectation('INNER', worked, derive('INNER', worked), { kind: 'no-row-loss', join: 0, side: 'left' }).outcome).toBe('violated');
  });

  it('join findings contain no aggregate attribution and no pass', () => {
    const codes = joinFindings(0, 'FULL', worked, derive('FULL', worked)).map((x) => x.code);
    expect(codes).toEqual(['join-cardinality', 'join-expansion', 'right-rows-repeated', 'unmatched-rows-preserved', 'unmatched-right-rows-preserved', 'many-to-many-join']);
  });
});

describe('lossless JSON (Codex H1)', () => {
  const src = '{"a":9007199254740993,"h":170141183460469231731687303715884105727,"d":-12345678901234567890.123456789,"e":1.5e+300,"s":"x\\"y","n":null,"t":true,"l":[1,2.50]}';
  it('keeps every numeric literal exactly', () => {
    const v = parseLossless(src);
    expect(v.a).toBeInstanceOf(LosslessNumber);
    expect(String(v.a)).toBe('9007199254740993');
    expect(String(v.h)).toBe('170141183460469231731687303715884105727');
    expect(String(v.d)).toBe('-12345678901234567890.123456789');
    expect(String(v.l[1])).toBe('2.50');
    expect(stringifyLossless(v)).toBe(src);
    expect(JSON.parse(src).a).toBe(9007199254740992); // what JSON.parse would have done
  });
  it('refuses to serialise unsafe JavaScript integers', () => expect(() => stringifyLossless({ x: 2 ** 60 })).toThrow());
  it('rejects malformed input', () => expect(() => parseLossless('{"a":1,}')).toThrow());
});

describe('MVP allowlist (ast.recognizeMvp)', () => {
  const stmt = (node: object) => ({ error: false, statements: [{ node }] });
  const base = { type: 'SELECT_NODE', modifiers: [], cte_map: { map: [] }, select_list: [{ class: 'STAR', type: 'STAR', alias: '', relation_name: '', exclude_list: [], replace_list: [], columns: false, expr: null, qualified_exclude_list: [], rename_list: [] }],
    from_table: { type: 'JOIN', alias: '', sample: null, left: { type: 'BASE_TABLE', alias: '', sample: null, schema_name: '', table_name: 'a', column_name_alias: [], catalog_name: '', at_clause: null },
      right: { type: 'BASE_TABLE', alias: '', sample: null, schema_name: '', table_name: 'b', column_name_alias: [], catalog_name: '', at_clause: null },
      condition: { class: 'COMPARISON', type: 'COMPARE_EQUAL', alias: '', left: { class: 'COLUMN_REF', type: 'COLUMN_REF', alias: '', column_names: ['a', 'k'] }, right: { class: 'COLUMN_REF', type: 'COLUMN_REF', alias: '', column_names: ['b', 'k'] } },
      join_type: 'INNER', ref_type: 'REGULAR', using_columns: [], delim_flipped: false, duplicate_eliminated_columns: [] },
    where_clause: null, group_expressions: [], group_sets: [], aggregate_handling: 'STANDARD_HANDLING', having: null, sample: null, qualify: null };
  it('accepts the canonical shape', () => expect(recognizeMvp(stmt(base)).ok).toBe(true));
  it('accepts parser source-position metadata', () => expect(recognizeMvp(stmt({ ...base, from_table: { ...base.from_table, query_location: 14 } })).ok).toBe(true));
  it('rejects unknown fields (future parser output) instead of ignoring them', () => {
    expect(recognizeMvp(stmt({ ...base, new_field: 1 })).ok).toBe(false);
    expect(recognizeMvp(stmt({ ...base, from_table: { ...base.from_table, new_join_field: true } })).ok).toBe(false);
  });
  it('rejects RIGHT/FULL, WHERE, modifiers and CTEs', () => {
    expect(recognizeMvp(stmt({ ...base, from_table: { ...base.from_table, join_type: 'RIGHT' } })).ok).toBe(false);
    expect(recognizeMvp(stmt({ ...base, where_clause: { class: 'CONSTANT' } })).ok).toBe(false);
    expect(recognizeMvp(stmt({ ...base, modifiers: [{ type: 'LIMIT_MODIFIER' }] })).ok).toBe(false);
    expect(recognizeMvp(stmt({ ...base, cte_map: { map: [{ key: 'x' }] } })).ok).toBe(false);
  });
});
