// M09 presentation model: labels, ordering and grouping only (no evidence is computed here).
import { describe, expect, it } from 'vitest';
import { finding } from '../../../src/core/verdict/findings';
import type { ReportStatus, VerdictReport, Witness } from '../../../src/core/verdict/types';
import {
  count, describeExpectation, measuredLoss, presentation, emptyWitnessText, evidenceBadge, evidenceRows, expectationTarget, findingViews, hasValidatedJoin, historicalText,
  keyCondition, noIssuesFound, outcomeView, stateNotice, witnessRows,
} from '../../../src/features/verdict/model';
import { buildExpectation } from '../../../src/features/verdict/ExpectationsEditor';
import { analyzedDraft, failedDraft, ILLUSTRATIVE, LOSS_ONLY, ILLUSTRATIVE_WITNESSES, LEGIT_LEFT, NO_LEFT_FAN_OUT, report, unsupportedFinding } from './fixtures';

describe('exact counts', () => {
  it('groups digits of decimal strings without converting to Number', () => {
    expect(count('9007199254740993')).toBe('9,007,199,254,740,993');
    expect(count('340282366920938463463374607431768211455')).toBe('340,282,366,920,938,463,463,374,607,431,768,211,455');
    expect(count('0')).toBe('0');
    expect(count(undefined)).toBe('–');
  });
  it('evidence rows: fixed labels, grouped integers, relationships in words, index omitted on request', () => {
    expect(evidenceRows({ leftRowsMultiplied: '1234', matchedRelationship: 'no-matches', side: 'left', index: '0' }, ['index'])).toEqual([
      ['Left rows multiplied', '1,234'],
      ['Matched-key relationship', 'no matches'],
      ['Side', 'left'],
    ]);
  });
});

describe('expectations in words', () => {
  it('describes the four rule types and their targets', () => {
    expect(describeExpectation({ kind: 'relationship', join: 0, expected: 'one-to-many' })).toBe('Relationship at most one-to-many');
    expect(describeExpectation({ kind: 'no-row-loss', join: 0, side: 'right' })).toBe('No row loss on the right');
    expect(describeExpectation(NO_LEFT_FAN_OUT)).toBe('No left fan-out');
    expect(describeExpectation({ kind: 'row-count', min: 5, max: 5 })).toBe('Output rows exactly 5');
    expect(describeExpectation({ kind: 'row-count', min: 1000, max: 20000 })).toBe('Output rows between 1,000 and 20,000 (inclusive)');
    expect(describeExpectation({ kind: 'row-count', max: 3 })).toBe('Output rows at most 3');
    expect(expectationTarget(NO_LEFT_FAN_OUT)).toBe('Join 1 · left input');
    expect(expectationTarget({ kind: 'row-count', min: 1 })).toBe('Join 1 · output rows');
  });
  it('names unknown declarations without guessing', () => {
    expect(describeExpectation({ kind: 'metric-preserved' })).toBe('Unrecognised expectation “metric-preserved”');
    expect(describeExpectation(null)).toBe('Unrecognised expectation');
    expect(expectationTarget({ kind: 'grain' })).toBe('Not a supported target');
  });
  it('outcomes: unchecked is never held; only a current AND authoritative report shows held/violated as definitive', () => {
    expect(outcomeView({ outcome: 'unchecked' }, 'definitive')).toEqual({ label: 'Unchecked', tone: 'neutral' });
    expect(outcomeView({ outcome: 'violated' }, 'definitive')).toEqual({ label: 'Violated', tone: 'violation' });
    expect(outcomeView({ outcome: 'held' }, 'definitive')).toEqual({ label: 'Held', tone: 'success' });
    for (const p of ['historical', 'limited'] as const) for (const o of ['held', 'violated', 'unchecked'] as const) expect(outcomeView({ outcome: o }, p).tone).toBe('neutral');
    expect(outcomeView({ outcome: 'violated' }, 'historical').label).toBe('Violated · historical');
    expect(outcomeView({ outcome: 'violated' }, 'limited').label).toBe('Violated · not authoritative');
    expect(outcomeView({ outcome: 'unchecked' }, 'limited').label).toBe('Unchecked');
    expect(presentation({ authoritative: true }, true)).toBe('definitive');
    expect(presentation({ authoritative: false }, true)).toBe('limited');
    expect(presentation({ authoritative: true }, false)).toBe('historical');
  });
});

describe('expectation form → declaration (core validation)', () => {
  const base = { kind: 'row-count' as const, expected: 'one-to-many' as const, side: 'left' as const, min: '', max: '' };
  it('builds valid declarations of each kind', () => {
    expect(buildExpectation({ ...base, kind: 'relationship' }).value).toEqual({ kind: 'relationship', join: 0, expected: 'one-to-many' });
    expect(buildExpectation({ ...base, kind: 'no-fan-out', side: 'right' }).value).toEqual({ kind: 'no-fan-out', join: 0, side: 'right' });
    expect(buildExpectation({ ...base, min: ' 3 ', max: '' }).value).toEqual({ kind: 'row-count', min: 3 });
  });
  it('reports field errors and builds nothing for malformed input', () => {
    expect(buildExpectation({ ...base, min: '-1' })).toEqual({ value: null, errors: { min: 'Enter a whole number of 0 or more, digits only.' } });
    expect(buildExpectation({ ...base, max: '1.5' }).errors.max).toMatch(/whole number/);
    expect(buildExpectation({ ...base, min: '9007199254740992' }).errors.min).toMatch(/no larger than/);
    expect(buildExpectation({ ...base, min: '9', max: '3' })).toEqual({ value: null, errors: { max: 'The maximum must be at least the minimum.' } });
    expect(buildExpectation(base)).toEqual({ value: null, errors: { form: 'Enter a minimum, a maximum or both.' } });
  });
});

describe('report state and authority (from the report, never recomputed)', () => {
  const statuses: [ReportStatus, () => VerdictReport, string, string][] = [
    ['analyzed', () => report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT])), 'Validated evidence', ''],
    ['partially-analyzed', () => report(analyzedDraft('INNER', ILLUSTRATIVE, [{ kind: 'nope' }])), 'Partially analyzed', 'Partially analyzed'],
    ['unsupported', () => report(failedDraft('unsupported', [unsupportedFinding()], 'outside scope', [])), 'Unsupported', 'Verdict unavailable for this query'],
    ['query-failed', () => report(failedDraft('query-failed', [finding('query-failure', 'syntax-error', 'x')], 'cannot parse', [])), 'Query failure', 'Query cannot be analyzed'],
    ['inconclusive', () => report(failedDraft('inconclusive', [finding('inconclusive', 'snapshot-inconsistent', 'x')], 'not validated', [])), 'Inconclusive', 'Analysis incomplete'],
    ['budget-exhausted', () => report(failedDraft('budget-exhausted', [finding('inconclusive', 'grouping-over-budget', 'x')], 'over budget', [])), 'Inconclusive', 'Analysis incomplete'],
    ['diagnostic-failed', () => report(failedDraft('diagnostic-failed', [finding('diagnostic-failure', 'diagnostic-failed', 'x')], 'failed', [])), 'Diagnostic failure', 'Diagnostic failure'],
    ['cancelled', () => report(analyzedDraft('INNER', ILLUSTRATIVE, []), { cancelled: true }), 'Cancelled', 'Analysis cancelled'],
    ['stale', () => report(analyzedDraft('INNER', ILLUSTRATIVE, []), { terminal: { status: 'stale', reason: 'generation-changed' } }), 'Stale', 'Analysis stale'],
  ];
  it.each(statuses)('%s → badge and notice', (status, make, badge, notice) => {
    const r = make();
    expect(r.status).toBe(status);
    expect(evidenceBadge(r).label).toBe(badge);
    expect(stateNotice(r)?.title ?? '').toBe(notice);
    if (status !== 'analyzed') expect(evidenceBadge(r).tone).toBe('neutral');
  });
  it('validated join evidence only for complete analyses', () => {
    expect(hasValidatedJoin(report(analyzedDraft('INNER', ILLUSTRATIVE, [])))).toBe(true);
    expect(hasValidatedJoin(report(analyzedDraft('INNER', ILLUSTRATIVE, []), { cancelled: true }))).toBe(false);
  });
  it('"No issues found in these checks" only for a current, authoritative report without violations or warnings', () => {
    const healthy = report(analyzedDraft('LEFT', LEGIT_LEFT, []));
    expect(noIssuesFound(healthy, true)).toBe(true);
    expect(noIssuesFound(healthy, false)).toBe(false);
    expect(noIssuesFound(report(analyzedDraft('INNER', ILLUSTRATIVE, [])), true)).toBe(false); // loss-and-fan-out warning
    expect(noIssuesFound(report(analyzedDraft('LEFT', LEGIT_LEFT, []), { cancelled: true }), true)).toBe(false);
    // Codex M09: row loss alone (an observation under P-076) still withholds the healthy summary.
    const loss = report(analyzedDraft('INNER', LOSS_ONLY, []));
    expect(loss.authoritative).toBe(true);
    expect(loss.findings.some((f) => f.category === 'suspicious')).toBe(false);
    expect(measuredLoss(loss)).toEqual({ left: '2', right: '1' });
    expect(noIssuesFound(loss, true)).toBe(false);
  });
  it('historical reasons in plain words', () => {
    expect(historicalText('expectations changed')).toMatch(/declared expectations changed/);
    expect(historicalText('engine restarted')).toMatch(/engine restarted/);
  });
});

describe('findings', () => {
  const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT]));
  it('orders violations, warnings, then observations; omits unchecked-expectation findings (listed once in Expectations)', () => {
    const partial = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT, { kind: 'bad' }]));
    expect(partial.findings.some((f) => f.category === 'expectation-unchecked')).toBe(true);
    expect(findingViews(partial, true).some((f) => f.category === 'expectation-unchecked')).toBe(false);
    const v = findingViews(r, true);
    expect(v.map((f) => f.category)).toEqual(['expectation-violation', 'suspicious', 'observed', 'observed', 'observed', 'observed']);
    expect(v.map((f) => f.label)).toEqual(['Expectation violation', 'Suspicious pattern', 'Observation', 'Observation', 'Observation', 'Observation']);
  });
  it('names side, stage and evidence; violation text comes from the matching outcome', () => {
    const [violation, warning, cardinality, multiplied] = findingViews(r, true);
    expect(violation).toMatchObject({ side: 'Left input (orders)', stage: 'Join 1 · INNER JOIN', tone: 'violation', confidence: 'Validated' });
    expect(violation!.message).toBe('Expectation 1 · No left fan-out. 2 orders rows appear more than once (2 extra copies).');
    expect(violation!.evidence.map(([k]) => k)).not.toContain('Expectation');
    expect(warning).toMatchObject({ side: 'Left input (orders)', tone: 'warning', title: 'Row loss and fan-out together' });
    expect(cardinality).toMatchObject({ side: 'Both inputs', tone: 'info' });
    expect(multiplied).toMatchObject({ side: 'Left input (orders)', tone: 'info', title: 'Left rows multiplied' });
  });
  it('a current but non-authoritative (partial) report never shows a violation or warning in attention tones (Codex M09)', () => {
    const partial = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT, { kind: 'row-count', min: -1 }]));
    expect(partial).toMatchObject({ status: 'partially-analyzed', authoritative: false });
    expect(partial.expectations.map((o) => o.outcome)).toEqual(['violated', 'unchecked']);
    const v = findingViews(partial, true);
    const violation = v.find((f) => f.category === 'expectation-violation')!;
    expect(violation).toMatchObject({ tone: 'neutral', label: 'Expectation violation · limited evidence', title: 'Expectation violated (not authoritative)' });
    expect(v.find((f) => f.category === 'suspicious')).toMatchObject({ tone: 'neutral', label: 'Suspicious pattern · limited evidence' });
    expect(v.filter((f) => f.tone === 'violation' || f.tone === 'warning')).toEqual([]);
  });

  it('historical findings are neutral and labelled historical', () => {
    for (const f of findingViews(r, false)) {
      expect(f.tone).toBe('neutral');
      expect(f.label).toMatch(/· historical$/);
    }
  });
  it('unsupported and query-failure findings are attributed to the query, diagnostic failures to the probes', () => {
    const u = findingViews(report(failedDraft('unsupported', [unsupportedFinding()], 'x', [])), true)[0]!;
    expect(u).toMatchObject({ side: 'Query', stage: 'Query', tone: 'neutral', title: 'Verdict unavailable for this query' });
    const d = findingViews(report(failedDraft('diagnostic-failed', [finding('diagnostic-failure', 'diagnostic-failed', 'x')], 'x', [])), true)[0]!;
    expect(d).toMatchObject({ side: 'Verdict checks', stage: 'Verdict checks' });
  });
});

describe('witnesses', () => {
  it('keeps report order, at most five per kind', () => {
    const w: Witness[] = [...Array.from({ length: 7 }, (_, i) => ({ kind: 'fan-out' as const, key: [String(i)], leftRows: '1', rightRows: '2', outputRows: '2' })), ...ILLUSTRATIVE_WITNESSES];
    expect(witnessRows(w, 'fan-out').map((x) => x.key[0])).toEqual(['0', '1', '2', '3', '4']);
    expect(witnessRows(w, 'all')).toHaveLength(7);
    expect(witnessRows(w, 'unmatched-right').map((x) => x.key[0])).toEqual(['109']);
  });
  it('empty kinds say so with counts from the report, and NULL keys are named', () => {
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [], ILLUSTRATIVE_WITNESSES));
    expect(emptyWitnessText('unmatched-left', r.join!)).toBe('No sample keys for this check. Unmatched left rows: 2, of which 1 have a NULL key (NULL keys are not sample keys).');
    const withheld = { ...r.join!, stats: null, derived: null, witnesses: [] };
    expect(emptyWitnessText('fan-out', withheld)).toBe('No sample keys for this check: the join measurements were withheld.');
  });
  it('key condition uses the query’s references', () => {
    expect(keyCondition({ left: { name: 'orders', ref: 'o' }, right: { name: 'customers', ref: 'c' }, keys: [{ left: 'a', right: 'b', type: 'INTEGER' }, { left: 'x', right: 'x', type: 'BIGINT' }] })).toEqual(['o.a = c.b', 'o.x = c.x']);
  });
});
