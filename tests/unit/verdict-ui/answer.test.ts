// P-106 state matrix: the Verdict answer (headline, meaning, next steps, sections) for every report
// state, built from reports produced by the real M08 functions. Measured statistics come from key
// lists through a brute-force counter written here (independent of the code under test) and are
// checked by M08's own invariants.
import { describe, expect, it } from 'vitest';
import { finding } from '../../../src/core/verdict/findings';
import { checkInvariants } from '../../../src/core/verdict/stats';
import type { JoinStats, JoinType, Witness } from '../../../src/core/verdict/types';
import { announcementFor, answerFor, reasonOf, type Answer } from '../../../src/features/verdict/answer';
import { analyzedDraft, failedDraft, NO_LEFT_FAN_OUT, report } from './fixtures';

type K = number | null;
function freq(keys: readonly K[]) {
  const m = new Map<number, number>();
  for (const k of keys) if (k !== null) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}
/** Statistics of an equality join on one integer key, by counting. */
function statsFrom(l: readonly K[], r: readonly K[]): JoinStats {
  const L = freq(l);
  const R = freq(r);
  const big = (n: number) => BigInt(n);
  let matchedKeys = 0, pairs = 0, lm = 0, rm = 0, lmul = 0, lex = 0, rmul = 0, rex = 0, lmaxm = 0, rmaxm = 0;
  for (const [k, a] of L) {
    const b = R.get(k);
    if (!b) continue;
    matchedKeys++; pairs += a * b; lm += a; rm += b;
    if (b > 1) { lmul += a; lex += a * (b - 1); }
    if (a > 1) { rmul += b; rex += b * (a - 1); }
    lmaxm = Math.max(lmaxm, a); rmaxm = Math.max(rmaxm, b);
  }
  const dup = (m: Map<number, number>) => [...m.values()].filter((c) => c > 1).length;
  const max = (m: Map<number, number>) => Math.max(0, ...m.values());
  const nulls = (x: readonly K[]) => x.filter((k) => k === null).length;
  return {
    leftRows: big(l.length), rightRows: big(r.length), leftNullKeyRows: big(nulls(l)), rightNullKeyRows: big(nulls(r)),
    leftKeyedRows: big(l.length - nulls(l)), rightKeyedRows: big(r.length - nulls(r)), leftDistinctKeys: big(L.size), rightDistinctKeys: big(R.size),
    leftDuplicateKeys: big(dup(L)), rightDuplicateKeys: big(dup(R)), leftMaxMultiplicity: big(max(L)), rightMaxMultiplicity: big(max(R)),
    leftMaxMultiplicityMatched: big(lmaxm), rightMaxMultiplicityMatched: big(rmaxm), matchedKeys: big(matchedKeys), matchedPairs: big(pairs),
    leftRowsMatched: big(lm), rightRowsMatched: big(rm), leftRowsMultiplied: big(lmul), leftExcessCopies: big(lex), rightRowsMultiplied: big(rmul), rightExcessCopies: big(rex),
  };
}
function witnessesFrom(type: JoinType, l: readonly K[], r: readonly K[]): Witness[] {
  const L = freq(l), R = freq(r);
  const fan = [...L].filter(([k, a]) => R.has(k) && (a > 1 || (R.get(k) as number) > 1)).sort(([ka, a], [kb, b]) => b * (R.get(kb) as number) - a * (R.get(ka) as number) || ka - kb).slice(0, 5);
  const ul = [...L].filter(([k]) => !R.has(k)).sort(([a], [b]) => a - b).slice(0, 5);
  const ur = [...R].filter(([k]) => !L.has(k)).sort(([a], [b]) => a - b).slice(0, 5);
  return [
    ...fan.map(([k, a]) => ({ kind: 'fan-out' as const, key: [String(k)], leftRows: String(a), rightRows: String(R.get(k)), outputRows: String(a * (R.get(k) as number)) })),
    ...ul.map(([k, a]) => ({ kind: 'unmatched-left' as const, key: [String(k)], leftRows: String(a), rightRows: '0', outputRows: type === 'LEFT' ? String(a) : '0' })),
    ...ur.map(([k, b]) => ({ kind: 'unmatched-right' as const, key: [String(k)], leftRows: '0', rightRows: String(b), outputRows: '0' })),
  ];
}
function measured(type: JoinType, l: readonly K[], r: readonly K[], declared: unknown[] = []): Answer {
  const s = statsFrom(l, r);
  expect(checkInvariants(s)).toEqual([]);
  return answerFor(report(analyzedDraft(type, s, declared, witnessesFrom(type, l, r))), true);
}
const unsupported = (...f: ReturnType<typeof finding>[]) => answerFor(report(failedDraft('unsupported', f, 'the query is outside the supported diagnostic scope', [])), true);
const construct = (c: string, detail = 'x') => finding('unsupported', 'unsupported-construct', `${c} is outside the Verdict diagnostic scope (${detail}). No data conclusions are drawn.`, { construct: c, detail });
const JARGON = /\b(probe|epoch|generation|oid|fence|invariant|SEMI JOIN|P0|diagnostic scope)\b/i;
const visible = (a: Answer) => [a.headline, ...a.meaning, ...a.next, ...a.effects, ...a.also].join(' ');

describe('state matrix: unsupported queries (one primary reason, the rest listed)', () => {
  it.each([
    ['multiple statements', [construct('multiple statements', '2 statements; Verdict analyses exactly one SELECT')], 'unsupported:multiple-statements', 'Analyze reads the whole editor, and it holds 2 statements.'],
    ['not a SELECT', [finding('unsupported', 'not-a-select', 'Only one SELECT statement can be analysed (x).', { construct: 'statement' })], 'unsupported:not-select', 'This is not a single SELECT query, so there is no join to analyze.'],
    ['UNION', [construct('set operation (UNION / INTERSECT / EXCEPT)')], 'unsupported:set-operation', 'UNION, INTERSECT and EXCEPT combine several queries; Verdict analyzes one join at a time.'],
    ['no join + GROUP BY + aggregate', [construct('GROUP BY'), construct('function or aggregate in SELECT'), construct('single relation (no join)')], 'unsupported:no-join', 'No join to analyze: this query reads a single table.'],
    ['two joins', [construct('left input: join chain or nested join')], 'unsupported:multi-join', 'This query has more than one join; Verdict analyzes exactly one join between two tables.'],
    ['view', [finding('unsupported', 'unsupported-relation', 'v: v is a view; views may be volatile or read files, so they are not stable relations for Verdict. No data conclusions are drawn.')], 'unsupported:relation-view', 'v is a view; Verdict analyzes tables stored in this session.'],
    ['file input', [finding('unsupported', 'unsupported-relation', "f: 'x.csv' is not a table in the catalog (a file reference, replacement scan or missing table); only stable managed tables are analysed.")], 'unsupported:relation-not-table', 'One input is not a table in this session (for example a file path).'],
    ['CTE', [construct('WITH (CTE)')], 'unsupported:relation-derived', 'One input is a subquery, CTE or table function; Verdict analyzes joins of two stored tables.'],
    ['RIGHT JOIN', [construct('RIGHT JOIN')], 'unsupported:join-right', 'RIGHT JOIN is not analyzed; Verdict analyzes INNER and LEFT joins.'],
    ['CROSS JOIN', [construct('CROSS JOIN')], 'unsupported:join-cross', 'This join has no ON condition, so every row pairs with every row; Verdict analyzes joins on key columns.'],
    ['key types differ', [finding('unsupported', 'unsupported-key', 'key types differ (a.k INTEGER vs b.k BIGINT); implicit casts change matching, so only same-type keys are analysed. No data conclusions are drawn.')], 'unsupported:key-types', 'The join keys have different types: a.k INTEGER and b.k BIGINT.'],
    ['text key', [finding('unsupported', 'unsupported-key', 'key name has type VARCHAR; only same-type integer keys are analysed (text keys may use collations that change equality). No data conclusions are drawn.')], 'unsupported:key-not-integer', 'The join key name is VARCHAR; Verdict analyzes integer keys only.'],
    ['OR in ON', [construct('OR in join condition')], 'unsupported:key-condition', 'The ON condition is not a plain column = column match.'],
    ['GROUP BY over a join', [construct('GROUP BY'), construct('function or aggregate in SELECT')], 'unsupported:aggregation', 'Verdict cannot check the aggregation, but the join underneath it is where counts and sums get inflated.'],
    ['WHERE', [construct('WHERE')], 'unsupported:where', 'Verdict analyzes the join itself, before any WHERE filter, and this query has one.'],
    ['computed SELECT', [construct('function or aggregate in SELECT')], 'unsupported:aggregation', 'Verdict cannot check the aggregation, but the join underneath it is where counts and sums get inflated.'],
    ['ORDER BY', [construct('ORDER BY')], 'unsupported:modifier', 'Verdict analyzes the join without ORDER BY.'],
    ['engine', [finding('unsupported', 'parser-not-qualified', 'Verdict is unavailable: x.')], 'unsupported:engine', 'This engine version is not qualified for Verdict, so nothing was analyzed.'],
  ])('%s', (_n, findings, kind, headline) => {
    const a = unsupported(...findings);
    expect(a.kind).toBe(kind);
    expect(a.headline).toBe(headline);
    expect(a.measured).toBe(false);
    expect(a.tone).toBe('neutral');
    expect(a.next.length).toBeGreaterThan(0);
    expect(a.next.length).toBeLessThanOrEqual(2);
    expect(visible(a)).not.toMatch(JARGON);
  });
  it('lists secondary reasons, never the primary one, and adds the aggregation hint to a no-join query', () => {
    const a = unsupported(construct('GROUP BY'), construct('function or aggregate in SELECT'), construct('single relation (no join)'));
    expect(a.also).toEqual(['GROUP BY', 'Function or aggregate in SELECT']);
    expect(a.next[1]).toMatch(/repeated rows inflate counts and sums/);
  });
  it('classifies every recogniser construct into a named reason (no generic titles)', () => {
    expect(reasonOf(construct('cast in join key')).title).toBe('ON condition is not a column = column match');
    expect(reasonOf(construct('join without condition')).kind).toBe('join-cross');
    expect(reasonOf(construct('derived table (subquery in FROM)')).title).toBe('Subquery as input');
    expect(reasonOf(construct('DISTINCT')).kind).toBe('modifier');
  });
});

describe('state matrix: failures, incomplete and interrupted runs', () => {
  it.each([
    ['syntax', 'query-failed', 'syntax-error', 'Verdict cannot read this query: it has a syntax error.'],
    ['binding', 'query-failed', 'bind-failed', 'Verdict cannot read this query: a table, column or type in it is not valid.'],
    ['keys', 'query-failed', 'key-resolution', 'Verdict cannot match the join keys to the two tables.'],
    ['transaction', 'inconclusive', 'transaction-unavailable', 'A transaction is open, so Verdict could not read the data in one consistent state.'],
    ['snapshot', 'inconclusive', 'snapshot-inconsistent', 'The data changed while Verdict was reading it, so it shows no measurements.'],
    ['too large', 'budget-exhausted', 'input-too-large', 'An input table has more rows than the analysis allows, so nothing was measured.'],
    ['grouping', 'budget-exhausted', 'grouping-over-budget', 'Counting the join keys would need more memory than the analysis allows, so nothing was measured.'],
    ['recount', 'inconclusive', 'semantic-mismatch', 'Two independent counts of this join disagreed, so Verdict shows no measurements.'],
    ['diagnostic', 'diagnostic-failed', 'diagnostic-failed', 'One of Verdict’s checks failed to run, so nothing from this run is shown.'],
  ] as const)('%s', (_n, status, code, headline) => {
    const cat = status === 'query-failed' ? 'query-failure' : status === 'diagnostic-failed' ? 'diagnostic-failure' : 'inconclusive';
    const a = answerFor(report(failedDraft(status, [finding(cat, code, 'The query cannot be parsed: Parser Error: syntax error at or near "SELEC"')], 'x', [NO_LEFT_FAN_OUT])), true);
    expect(a.headline).toBe(headline);
    expect(a.measured).toBe(false);
    expect(a.next).toHaveLength(1);
    expect(visible(a)).not.toMatch(/raise|increase|disable/i);
  });
  it('the engine message is shown for a query failure, and the user is sent to fix the SQL', () => {
    const a = answerFor(report(failedDraft('query-failed', [finding('query-failure', 'syntax-error', 'The query cannot be parsed: Parser Error: syntax error at or near "SELEC"')], 'x', [])), true);
    expect(a.meaning[0]).toBe('Parser Error: syntax error at or near "SELEC"');
    expect(a.next[0]).toBe('Fix the SQL, then analyze again. Run SQL shows the same error.');
  });
  it('cancelled and stale runs show no result', () => {
    const b = analyzedDraft('INNER', statsFrom([1], [1]), []);
    expect(answerFor(report(b, { cancelled: true }), true).headline).toBe('Analysis cancelled. No results from this run are shown.');
    expect(answerFor(report(b, { terminal: { status: 'stale', reason: 'generation-changed' } }), true).headline).toBe('The engine or the data changed while Verdict was working, so no results from this run are shown.');
  });
});

describe('state matrix: complete analyses, by what the join did (tables orders × customers)', () => {
  it('clean: every row matched once; healthy summary', () => {
    const a = measured('INNER', [1, 2, 3], [1, 2, 3]);
    expect(a.kind).toBe('measured:clean');
    expect(a.headline).toBe('Each row appears exactly once: 3 orders rows and 3 customers rows give 3 result rows.');
    expect(a.healthy).toBe(true);
    expect(a.tone).toBe('info');
  });
  it('one-to-many expansion: described as how the join works, informational, no rule pushed when rules exist', () => {
    const a = measured('INNER', [1, 2], [1, 1, 2]);
    expect(a.headline).toBe('The result has 3 rows from 2 orders rows: 1 orders row appears more than once (1 extra row).');
    expect(a.tone).toBe('info'); // an observation in the core's mapping, not a warning
    expect(a.next[0]).toBe('If you need one row per orders row: reduce customers to one row per customer_id before joining (for example GROUP BY customer_id with SUM or MAX), then join.');
    expect(a.fate?.[0]).toMatchObject({ rows: '2', once: '1', multiple: '1', extra: '1', missing: '0', kept: '0' });
  });
  it('lookup (many-to-one): shared right rows', () => {
    expect(measured('INNER', [1, 1, 2], [1, 2]).headline).toBe('Each orders row appears exactly once in the result (3 result rows); 1 customers row is shared by several orders rows.');
  });
  it('fan-out with named duplicate keys, complete list when fewer than five', () => {
    const a = measured('INNER', [1, 2, 3], [1, 2, 2, 3, 3]);
    expect(a.headline).toBe('The result has 5 rows from 3 orders rows: 2 orders rows appear more than once (2 extra rows).');
    expect(a.effects[0]).toBe('customers has several rows for customer_id 2 (2 rows) and 3 (2 rows), so the matching orders rows repeat.');
  });
  it('loss only: dropped rows with NULL keys counted; no healthy summary; warning-free', () => {
    const a = measured('INNER', [1, 2, null], [1, 3]);
    expect(a.headline).toBe('The result has 1 row from 3 orders rows: 2 orders rows are missing (no matching customers row).');
    expect(a.effects).toContain('2 orders rows have no matching customers row (customer_id 2); 1 of them has an empty (NULL) key, which never matches.');
    expect(a.healthy).toBe(false);
    expect(a.next[0]).toBe('If every orders row should stay: use LEFT JOIN, which keeps unmatched orders rows with empty customers columns.');
    expect(a.fate?.[0]).toMatchObject({ rows: '3', once: '1', multiple: '0', missing: '2' });
  });
  it('loss and fan-out with the same row count: "same number of rows, different rows"; violated rule first', () => {
    const a = measured('INNER', [101, 102, 103, 104, 105, 106, 107, null], [101, 102, 102, 103, 104, 105, 105, 106, 109], [NO_LEFT_FAN_OUT]);
    expect(a.headline).toBe('The result has 8 rows from 8 orders rows: the same count, but different rows — 2 orders rows appear more than once (2 extra rows); 2 orders rows are missing (no matching customers row).');
    expect(a.meaning[0]).toBe('Your rule “No left fan-out” is broken: 2 orders rows appear more than once (2 extra copies).');
    expect(a.tone).toBe('violation');
    expect(a.next).toEqual([
      'If you need one row per orders row: reduce customers to one row per customer_id before joining (for example GROUP BY customer_id with SUM or MAX), then join.',
      'If every orders row should stay: use LEFT JOIN, which keeps unmatched orders rows with empty customers columns.',
    ]);
    expect(a.fate).toEqual([
      { table: 'orders', side: 'left', rows: '8', once: '4', multiple: '2', extra: '2', missing: '2', kept: '0' },
      { table: 'customers', side: 'right', rows: '9', once: '8', multiple: '0', extra: '0', missing: '1', kept: '0' },
    ]);
  });
  it('many-to-many: rows multiply on both sides', () => {
    expect(measured('INNER', [1, 1], [1, 1]).headline).toBe('The result has 4 rows from 2 orders rows: 2 orders rows appear more than once (2 extra rows).');
  });
  it('no matches, empty input and all-NULL keys', () => {
    expect(measured('INNER', [1], [2]).headline).toBe('No orders row matched any customers row, so the result has no rows.');
    expect(measured('LEFT', [1], [2]).headline).toBe('No orders row matched any customers row, so each orders row is kept once with empty customers columns.');
    expect(measured('INNER', [], [1]).headline).toBe('orders is empty, so the result has no rows.');
    expect(measured('LEFT', [1], []).headline).toBe('customers is empty, so every orders row is kept once with empty customers columns.');
    expect(measured('INNER', [null, null], [1]).headline).toBe('Every orders row has an empty (NULL) key, so no row can match and the result has no rows.');
  });
  it('LEFT JOIN: unmatched rows are kept, never "dropped"', () => {
    const a = measured('LEFT', [1, 2, null], [1]);
    expect(a.headline).toBe('The result has 3 rows from 3 orders rows: 2 orders rows have no matching customers row and are kept with empty customers columns.');
    expect(visible(a)).not.toMatch(/dropped|missing/);
    expect(a.fate?.[0]).toMatchObject({ kept: '2', missing: '0' });
  });
  it('no jargon in any measured answer', () => {
    for (const [t, l, r] of [['INNER', [1, 2], [1, 1]], ['LEFT', [1, 2, 2], [2, 3]], ['INNER', [1, 1, 2], [1, 3, 3]]] as const) expect(visible(measured(t, l, r))).not.toMatch(JARGON);
  });
});

describe('state matrix: authority and currency', () => {
  const s = statsFrom([101, 102, 103, 104, 105, 106, 107, null], [101, 102, 102, 103, 104, 105, 105, 106, 109]);
  it('partial (not authoritative): limited evidence first, neutral tone, no healthy summary', () => {
    const a = answerFor(report(analyzedDraft('INNER', s, [NO_LEFT_FAN_OUT, { kind: 'row-count', min: -1 }])), true);
    expect(a.presentation).toBe('limited');
    expect(a.tone).toBe('neutral');
    expect(a.meaning[0]).toMatch(/^Limited evidence: the measurements are valid, but the result is not authoritative because a rule could not be checked\.$/);
    expect(a.healthy).toBe(false);
  });
  it('historical: headline names the reason, the earlier answer is labelled, one action', () => {
    const r = report(analyzedDraft('INNER', s, [NO_LEFT_FAN_OUT]));
    for (const [reason, text] of [['query changed', 'Historical: The SQL was edited after this analysis.'], ['expectations changed', 'Historical: The declared expectations changed after this analysis; its outcomes are for the earlier declarations.'], ['data may have changed', 'Historical: Inputs may have changed since this analysis (an import, a removal or a statement that can change data).'], ['engine restarted', 'Historical: The engine restarted after this analysis; its evidence cannot be reproduced in this session.'], ['analysis never reached the engine', 'Historical: The analysis never reached the engine.']]) {
      const a = answerFor(r, false, reason);
      expect(a.headline).toBe(text);
      expect(a.meaning[0]).toMatch(/^Earlier result: The result has 8 rows from 8 orders rows/);
      expect(a.next).toEqual(['Analyze again for current evidence.']);
      expect(a.tone).toBe('neutral');
      expect(a.healthy).toBe(false);
    }
  });
  it('announcement = the headline, historical when the store says so', () => {
    const r = report(analyzedDraft('INNER', s, [NO_LEFT_FAN_OUT]));
    expect(announcementFor(r, { report: r, current: true })).toBe('Verdict: The result has 8 rows from 8 orders rows: the same count, but different rows — 2 orders rows appear more than once (2 extra rows); 2 orders rows are missing (no matching customers row).');
    expect(announcementFor(r, { report: r, current: false, historicalReason: 'query changed' })).toMatch(/^Analysis finished, but its report is already historical/);
  });
});
