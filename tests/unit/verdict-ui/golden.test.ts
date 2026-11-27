// Golden report tests (IMPLEMENTATION_PLAN M09 field 15; PRD QV-VER-006; UI_SPECIFICATION UX-004):
// the production VerdictPanel rendered to static HTML for reports produced by the real M08
// functions (fixtures.ts), one per required case — natural fan-out, declared violation, missing
// evidence, unsupported syntax, SQL error, probe failure, cancellation — plus stale, historical,
// partially analysed and exact numbers beyond 2^53. Each asserts what is shown AND what must never
// be shown (a pass, a held/violated outcome from an incomplete run, a current violation in a
// historical report).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../../../src/core/verdict/stats';
import { finding } from '../../../src/core/verdict/findings';
import type { VerdictReport } from '../../../src/core/verdict/types';
import { VerdictPanel } from '../../../src/features/verdict/VerdictPanel';
import type { AnalysisState } from '../../../src/stores/analysisStore';
import type { EngineSnapshot } from '../../../src/stores/engineStore';
import { createExpectationStore } from '../../../src/stores/expectationStore';
import { analyzedDraft, failedDraft, G, E, ILLUSTRATIVE, ILLUSTRATIVE_WITNESSES, LEGIT_LEFT, LOSS_ONLY, NO_LEFT_FAN_OUT, report, unsupportedFinding, VALIDATED } from './fixtures';

const engine: EngineSnapshot = { state: { kind: 'ready' }, generation: G(1), epoch: E(4), info: null };
const idle: AnalysisState = { status: 'idle' };

function render(r: VerdictReport | null, current = true, historicalReason?: string, analysis: AnalysisState = idle) {
  const html = renderToStaticMarkup(
    createElement(VerdictPanel, {
      view: { report: r, current, ...(historicalReason ? { historicalReason } : {}) },
      analysis, engine, expectations: createExpectationStore(), analyzeKeys: 'Cmd Shift Enter', detail: false, cancelHere: false, onOpenDetail: () => undefined, onCancel: () => undefined,
    }),
  );
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  return { html, text };
}

/** Never shown for a report that is not complete, current and validated. */
function noPass(html: string, text: string) {
  expect(html).not.toContain('class="vd-healthy"');
  expect(html).not.toMatch(/data-outcome="(held|violated)"/);
  expect(text).not.toMatch(/\bpass(ed)?\b|score|\d+ ?%/i);
}

describe('golden Visual Verdict reports', () => {
  it('the hand-written illustrative statistics satisfy M08’s invariants', () => {
    expect(checkInvariants(ILLUSTRATIVE)).toEqual([]);
    expect(checkInvariants(LEGIT_LEFT)).toEqual([]);
  });

  it('natural fan-out: an observation, not a defect; no issues found in these checks, with coverage', () => {
    const r = report(analyzedDraft('LEFT', LEGIT_LEFT, []));
    expect(r.authoritative).toBe(true);
    const { html, text } = render(r);
    expect(html).toContain('class="vd-healthy"');
    expect(text).toContain('No issues found in these checks. This covers only what Verdict checks (see Details); it does not show that the query is correct.');
    expect(text).toContain('The result has 4 rows from 3 orders rows: 1 orders row appears more than once (1 extra row); 1 orders row has no matching customers row and is kept with empty customers columns.');
    expect(html).not.toMatch(/data-tone="(violation|warning)"/);
    expect(text).toContain('Observation Left rows multiplied'); // the label separator is CSS
    expect(text).toContain('1 unmatched, kept');
    expect(text).toContain('they are preserved, not dropped');
    expect(text).toContain('Validated evidence');
  });

  it('declared violation (UX-004): one violation and one warning, distinct; mockup counts', () => {
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT], ILLUSTRATIVE_WITNESSES));
    expect(r.authoritative).toBe(true);
    const { html, text } = render(r);
    expect(html.match(/data-category="expectation-violation"/g)).toHaveLength(1);
    expect(html.match(/data-category="suspicious"/g)).toHaveLength(1);
    expect(html).toMatch(/data-tone="violation" data-category="expectation-violation"/);
    expect(html).toMatch(/data-tone="warning" data-category="suspicious"/);
    expect(text).toContain('Expectation violation Expectation violated');
    expect(text).toContain('Expectation 1 · No left fan-out. 2 orders rows appear more than once (2 extra copies).');
    expect(text).toContain('The result has 8 rows from 8 orders rows: the same count, but different rows');
    expect(text).toContain('Your rule “No left fan-out” is broken: 2 orders rows appear more than once (2 extra copies).');
    expect(text).toContain('Suspicious pattern Row loss and fan-out together');
    expect(text).toContain('8 rows 1 NULL-key row 0 duplicate key groups');
    expect(text).toContain('9 rows 0 NULL-key rows 2 duplicate key groups');
    expect(text).toContain('8 rows 8 matched pairs');
    expect(text).toContain('6 matched 2 unmatched, dropped 2 multiplied (+2 copies)');
    expect(text).toContain('8 matched 1 unmatched, dropped 0 multiplied (+0 copies)');
    expect(text).toMatch(/Fan-out 102 1 2 2 .*Fan-out 105 1 2 2 .*Unmatched left key 107 1 0 0 .*Unmatched right key 109 0 1 0/);
    expect(text).toContain('NULL-key rows are counted separately and are never sample keys: 1 left, 0 right.');
    expect(html).toMatch(/data-outcome="violated"/);
    expect(html).not.toContain('class="vd-healthy"');
  });

  it('missing evidence (witness recounts refused by the budget): limited evidence, every expectation unchecked, no violation', () => {
    const b = analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT], ILLUSTRATIVE_WITNESSES);
    const limited = failedDraft('budget-exhausted', [finding('inconclusive', 'budget-exhausted', 'Some validation probes were not run because they exceed the execution budget.')], 'validation incomplete: witness recounts not run', [NO_LEFT_FAN_OUT], {
      ...b.draft.join!, validation: { ...VALIDATED, witnesses: 'not-run', executedCount: 'not-run' },
    });
    const r = report(limited);
    expect(r.authoritative).toBe(false);
    const { html, text } = render(r);
    noPass(html, text);
    expect(text).toContain('Limited evidence');
    expect(text).toContain('Limited evidence: some checks were skipped because of the analysis limits');
    expect(text).toContain('The limits stay in place.');
    expect(text).toContain('not re-counted through the join');
    expect(text).not.toContain('Validated evidence');
    expect(html).not.toContain('data-category="expectation-violation"');
    expect(text).toContain('some checks were skipped (analysis limits), so rules are not evaluated.');
  });

  it('unsupported syntax: named construct, no measurements, no evidence sections; not called an SQL error', () => {
    const r = report(failedDraft('unsupported', [unsupportedFinding()], 'the query is outside the supported diagnostic scope', [NO_LEFT_FAN_OUT]));
    const { html, text } = render(r);
    noPass(html, text);
    expect(text).toContain('Verdict analyzes the join itself, before any WHERE filter, and this query has one.');
    expect(text).toContain('this is a limit of Verdict, not an error in your SQL.');
    expect(text).toContain('WHERE is outside the Verdict diagnostic scope'); // the analyzer's own finding, under Details
    expect(html).not.toContain('<form');
    expect(text).not.toContain('Join overview');
    expect(text).not.toContain('Witnesses');
    expect(text).toContain('Unchecked');
  });

  it('SQL error: a query failure attributed to parsing or binding', () => {
    const r = report(failedDraft('query-failed', [finding('query-failure', 'bind-failed', 'The query cannot be bound (it would fail before running): Binder Error: column "x" not found')], 'the query cannot be bound', []));
    const { html, text } = render(r);
    noPass(html, text);
    expect(text).toContain('Verdict cannot read this query: a table, column or type in it is not valid.');
    expect(text).toContain('Binder Error: column "x" not found');
    expect(text).toContain('Verdict did not run the query.');
    expect(text).toContain('Run SQL shows the same error.');
  });

  it('probe failure: a diagnostic failure that makes no claim about the query', () => {
    const r = report(failedDraft('diagnostic-failed', [finding('diagnostic-failure', 'diagnostic-failed', 'A diagnostic statement failed: boom. This does not mean the query itself fails.')], 'a diagnostic statement failed', [NO_LEFT_FAN_OUT]));
    const { html, text } = render(r);
    noPass(html, text);
    expect(text).toContain('Diagnostic failure');
    expect(text).toContain('One of Verdict’s checks failed to run, so nothing from this run is shown.');
    expect(text).toContain('A failed check says nothing about whether your query works');
  });

  it('cancellation: the fence withdraws every measurement and every held/violated outcome', () => {
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT], ILLUSTRATIVE_WITNESSES), { cancelled: true });
    expect(r.status).toBe('cancelled');
    const { html, text } = render(r);
    noPass(html, text);
    expect(text).toContain('Analysis cancelled');
    expect(text).not.toContain('Join overview');
    expect(html).not.toContain('data-category="suspicious"');
    expect(text).toContain('Analysis cancelled. No results from this run are shown.');
    expect(text).toContain('the analysis was cancelled.');
  });

  it('stale: data changed before publication → no evidence', () => {
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT]), { session: { generation: G(1), epoch: E(5), state: { kind: 'ready' } } });
    expect(r.status).toBe('stale');
    const { html, text } = render(r);
    noPass(html, text);
    expect(text).toContain('Analysis stale');
  });

  it('historical: a past violation is labelled historical and never shown in violation or warning tones', () => {
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT], ILLUSTRATIVE_WITNESSES));
    const { html, text } = render(r, false, 'data may have changed');
    expect(html).not.toMatch(/data-tone="(violation|warning|success)"/);
    expect(text).toContain('Historical: Inputs may have changed since this analysis');
    expect(text).toContain('Earlier result: The result has 8 rows from 8 orders rows');
    expect(text).toContain('Expectation violation · historical Expectation was violated');
    expect(text).toContain('Violated · historical');
    expect(html).not.toContain('class="vd-healthy"');
    expect(text).toMatch(/Historical\s+Validated evidence/);
  });

  it('partially analysed: an invalid declaration is unchecked with its reason, the valid one is evaluated, never "held" for the invalid one', () => {
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT, { kind: 'grain', columns: ['x'] }], ILLUSTRATIVE_WITNESSES));
    expect(r.status).toBe('partially-analyzed');
    const { html, text } = render(r);
    expect(text).toContain('Partially analyzed');
    expect(html.match(/data-outcome="unchecked"/g)).toHaveLength(1);
    expect(text).toContain('the rule is not valid (grain expectations are not supported by Verdict).');
    expect(text).toContain('Unrecognised expectation “grain”');
    expect(html).not.toContain('class="vd-healthy"');
  });

  it('partial report (Codex M09): a current, non-authoritative report shows no definitive outcome or attention tone', () => {
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT, { kind: 'row-count', min: -1 }], ILLUSTRATIVE_WITNESSES));
    expect(r.authoritative).toBe(false);
    const { html, text } = render(r);
    expect(html).not.toMatch(/data-tone="(violation|warning|success)"/);
    expect(text).toContain('Violated · not authoritative');
    expect(text).toContain('limited evidence, not a definitive result');
    expect(text).toContain('Partially analyzed');
    expect(html).not.toContain('class="vd-healthy"');
  });

  it('row loss alone (Codex M09): no healthy summary; the loss stays visible outside the observations disclosure', () => {
    const { html, text } = render(report(analyzedDraft('INNER', LOSS_ONLY, [])));
    expect(html).not.toContain('class="vd-healthy"');
    expect(text).toContain('The result has 1 row from 3 orders rows: 2 orders rows are missing (no matching customers row).');
    expect(text).toContain('The missing orders rows are absent from every total computed from this result.');
    const disclosure = html.slice(html.indexOf('vd-observations'));
    expect(disclosure).not.toContain('Unmatched rows dropped');
    expect(html).toContain('Unmatched rows dropped');
  });

  it('exact counts beyond 2^53 are shown digit for digit', () => {
    const big = 9_007_199_254_740_993n;
    const s = { ...LEGIT_LEFT, leftRows: big, leftKeyedRows: big, leftDistinctKeys: big, leftRowsMatched: 2n };
    const b = analyzedDraft('LEFT', s, [], [{ kind: 'unmatched-left', key: ['18446744073709551615'], leftRows: '1', rightRows: '0', outputRows: '1' }]);
    const { text } = render(report(b));
    expect(text).toContain('9,007,199,254,740,993 rows');
    expect(text).toContain('18446744073709551615');
    expect(text).toContain('9,007,199,254,740,991 unmatched, kept'); // big − 2, exact
    expect(text).not.toContain('9,007,199,254,740,992'); // what a Number round trip would show
  });

  it('witness rendering is bounded: at most five per kind and fifteen in total, even if a report held more', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ kind: 'fan-out' as const, key: [String(200 + i)], leftRows: '1', rightRows: '2', outputRows: '2' }));
    const extra = ['unmatched-left', 'unmatched-right'].flatMap((kind) => Array.from({ length: 7 }, (_, i) => ({ kind: kind as 'unmatched-left', key: [String(900 + i)], leftRows: '1', rightRows: '0', outputRows: '0' })));
    const { html } = render(report(analyzedDraft('INNER', ILLUSTRATIVE, [], [...many, ...extra])));
    expect(html.match(/<tr data-kind="fan-out"/g)).toHaveLength(5);
    expect(html.match(/<tr data-kind="/g)).toHaveLength(15);
    expect(html).not.toContain('>205<');
  });

  it('no analysis yet, and an analysis in progress: no fabricated progress', () => {
    const empty = render(null);
    expect(empty.text).toContain('No analysis yet');
    expect(empty.text).toContain('it does not run the query itself');
    const busy = render(null, false, undefined, { status: 'analyzing', seq: 1, sql: 'x', expectations: 2 });
    expect(busy.text).toContain('Analyzing… Measuring the join and checking 2 expectations.');
    expect(busy.text).not.toMatch(/%|remaining|ETA|seconds left/);
  });

  it('identifiers and values render as text, never as markup', () => {
    const b = analyzedDraft('INNER', ILLUSTRATIVE, [], [{ kind: 'unmatched-left', key: ['<img src=x onerror=alert(1)>'], leftRows: '1', rightRows: '0', outputRows: '0' }]);
    const d = { ...b.draft, join: { ...b.draft.join!, left: { name: '<script>x</script>', ref: '"><b>o' } } };
    const { html } = render(report({ ...b, draft: d }));
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});
