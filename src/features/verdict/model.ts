// Presentation model of a Verdict report (M09; PRD §4 labels; DESIGN_SYSTEM §5 microcopy;
// UI_SPECIFICATION §5). Pure functions: they only name, order and group what the published report
// already contains. Nothing here measures, derives a count, or decides authority — categories,
// severities, confidence, outcomes and authority all come from the M08 core (findings.ts,
// expectations.ts, report.ts) and the report store's currency. Counts stay exact decimal strings.
import type { Expectation, ExpectationOutcome, Finding, JoinEvidence, ReportStatus, VerdictReport, Witness, WitnessKind } from '../../core/verdict/types';
import { groupDigits } from '../explorer/model';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'violation';

/** Per-kind witness bound (PRD QV-VER-002) and the report's total witness rendering bound (M09 field 14). */
export const WITNESSES_PER_KIND = 5;
export const WITNESS_KINDS: readonly WitnessKind[] = ['fan-out', 'unmatched-left', 'unmatched-right'];

/** An exact count for display: digit grouping only, never converted to a JavaScript number. */
export const count = (exact: string | undefined): string => (exact === undefined ? '–' : groupDigits(exact));
export const plural = (exact: string, one: string, many: string) => `${count(exact)} ${exact === '1' ? one : many}`;

const RELATIONSHIP_TEXT: Record<string, string> = {
  'one-to-one': 'one-to-one',
  'one-to-many': 'one-to-many',
  'many-to-one': 'many-to-one',
  'many-to-many': 'many-to-many',
  'no-matches': 'no matches',
};
export const relationshipText = (r: string) => RELATIONSHIP_TEXT[r] ?? r;
export const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------------------------
// Report identity, authority and state

/** Who the inputs are, as written in the query: `orders AS o`, or `orders`. */
export const relationLabel = (r: { name: string; ref: string }) => (r.ref && r.ref !== r.name ? `${r.name} AS ${r.ref}` : r.name);

/** The join's equality condition as analysed, e.g. `o.customer_id = c.customer_id`. */
export function keyCondition(join: Pick<JoinEvidence, 'left' | 'right' | 'keys'>): string[] {
  return join.keys.map((k) => `${join.left.ref}.${k.left} = ${join.right.ref}.${k.right}`);
}

/** The report's evidence state, as a badge. Authority comes from the report (`authoritative`). */
export function evidenceBadge(report: VerdictReport): { label: string; tone: Tone } {
  if (report.authoritative) return { label: 'Validated evidence', tone: 'info' };
  switch (report.status) {
    case 'analyzed':
      return { label: 'Not authoritative', tone: 'neutral' };
    case 'partially-analyzed':
      return { label: 'Partially analyzed', tone: 'neutral' };
    case 'budget-exhausted':
      return report.join?.stats ? { label: 'Limited evidence', tone: 'neutral' } : { label: 'Inconclusive', tone: 'neutral' };
    case 'inconclusive':
      return { label: 'Inconclusive', tone: 'neutral' };
    case 'unsupported':
      return { label: 'Unsupported', tone: 'neutral' };
    case 'query-failed':
      return { label: 'Query failure', tone: 'neutral' };
    case 'diagnostic-failed':
      return { label: 'Diagnostic failure', tone: 'neutral' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'stale':
      return { label: 'Stale', tone: 'neutral' };
  }
}

/** Report states whose join measurements are validated (complete evidence, every check agreed). */
export const hasValidatedJoin = (r: VerdictReport) => (r.status === 'analyzed' || r.status === 'partially-analyzed') && !!r.join?.stats && !!r.join.derived;

/** Plain-language reason a report is historical (reportStore's currency reasons). */
export function historicalText(reason: string | undefined): string {
  switch (reason) {
    case 'query changed':
      return 'The SQL was edited after this analysis.';
    case 'expectations changed':
      return 'The declared expectations changed after this analysis; its outcomes are for the earlier declarations.';
    case 'data may have changed':
      return 'Inputs may have changed since this analysis (an import, a removal or a statement that can change data).';
    case 'engine restarted':
      return 'The engine restarted after this analysis; its evidence cannot be reproduced in this session.';
    case 'session ended':
      return 'The session ended.';
    case 'analysis never reached the engine':
      return 'The analysis never reached the engine.';
    default:
      return 'The workspace changed after this analysis.';
  }
}

export interface StateNotice {
  readonly title: string;
  readonly tone: Tone;
  readonly body: readonly string[];
  readonly next: readonly string[];
}

const SUPPORTED_SCOPE = 'Supported: one SELECT with one INNER or LEFT JOIN of two session tables, on equalities between integer columns of the same type (ON … AND … or USING).';

/**
 * The state notice shown at the top of a report that is not a complete, current analysis
 * (DESIGN_SYSTEM §5 microcopy; UI_SPECIFICATION §5 "Unavailable analysis"). Null for a complete
 * analysis. Reasons come from the report's own findings and non-authoritative reasons.
 */
export function stateNotice(report: VerdictReport): StateNotice | null {
  const reasons = report.nonAuthoritativeReasons;
  const s: ReportStatus = report.status;
  switch (s) {
    case 'analyzed':
      return report.authoritative ? null : { title: 'Not authoritative', tone: 'neutral', body: reasons, next: ['Analyze again to refresh the evidence.'] };
    case 'partially-analyzed':
      return {
        title: 'Partially analyzed',
        tone: 'neutral',
        body: ['The join measurements below are validated, but at least one expectation could not be evaluated. Unchecked expectations are not counted as held.'],
        next: ['Correct or remove the unchecked expectation, then analyze again.'],
      };
    case 'unsupported':
      return {
        title: 'Verdict unavailable for this query',
        tone: 'neutral',
        body: ['The construct that stopped the analysis is named under Findings. This is a limit of the analysis, not an error in the SQL.'],
        next: [SUPPORTED_SCOPE, 'Run SQL remains available when the engine policy allows it.', 'Check table schemas and key types in Datasets.'],
      };
    case 'query-failed':
      return {
        title: 'Query cannot be analyzed',
        tone: 'neutral',
        body: ['Verdict did not run the query: it failed to parse or bind. The error is under Findings.'],
        next: ['Fix the SQL, then analyze again. Run SQL shows the same error with its position.'],
      };
    case 'inconclusive':
      return {
        title: 'Analysis incomplete',
        tone: 'neutral',
        body: ['A validation step did not agree or could not run, so no measurements from this run are shown as evidence. The reason is under Findings.'],
        next: ['Analyze again. If the inputs keep changing during the analysis, wait until other work has finished.'],
      };
    case 'budget-exhausted': {
      const limited = !!report.join?.stats;
      return {
        title: 'Analysis incomplete',
        tone: 'neutral',
        body: [
          limited
            ? 'The measurements below are limited evidence: some validation probes did not run, and expectations were not evaluated.'
            : 'No measurements from this run are shown.',
          'The limit that stopped it is under Findings.',
        ],
        next: ['Analyze a smaller input, for example a table with fewer rows. The work limits stay in place.'],
      };
    }
    case 'diagnostic-failed':
      return {
        title: 'Diagnostic failure',
        tone: 'neutral',
        body: ['A diagnostic step failed (see Findings). A failed diagnostic step says nothing about whether the query itself works.'],
        next: ['Analyze again. Run SQL is not affected.'],
      };
    case 'cancelled':
      return { title: 'Analysis cancelled', tone: 'neutral', body: ['No evidence or expectation outcome from this run is shown.', ...reasons.slice(0, 1)], next: ['Analyze again when you are ready.'] };
    case 'stale':
      return {
        title: 'Analysis stale',
        tone: 'neutral',
        body: ['The engine or the data changed while this analysis ran, so none of its evidence is shown.', ...reasons.slice(0, 2)],
        next: ['Analyze the current query again.'],
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Expectations

export const EXPECTATION_KIND_LABEL: Record<Expectation['kind'], string> = {
  relationship: 'Relationship',
  'no-row-loss': 'No row loss',
  'no-fan-out': 'No fan-out',
  'row-count': 'Output row count',
};

/** A declared expectation in words, e.g. "No left fan-out". Unknown shapes are named, never guessed. */
export function describeExpectation(e: unknown): string {
  const x = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
  switch (x.kind) {
    case 'relationship':
      return `Relationship at most ${typeof x.expected === 'string' ? x.expected : '(not set)'}`;
    case 'no-row-loss':
      return `No row loss on the ${x.side === 'left' || x.side === 'right' ? x.side : '(no side)'}`;
    case 'no-fan-out':
      return x.side === 'left' || x.side === 'right' ? `No ${x.side} fan-out` : 'No fan-out (no side)';
    case 'row-count': {
      const min = typeof x.min === 'number' ? groupDigits(String(x.min)) : null;
      const max = typeof x.max === 'number' ? groupDigits(String(x.max)) : null;
      if (min !== null && max !== null) return min === max ? `Output rows exactly ${min}` : `Output rows between ${min} and ${max} (inclusive)`;
      if (min !== null) return `Output rows at least ${min}`;
      if (max !== null) return `Output rows at most ${max}`;
      return 'Output row count (no bounds)';
    }
    default:
      return typeof x.kind === 'string' ? `Unrecognised expectation “${x.kind}”` : 'Unrecognised expectation';
  }
}

/** Which part of the join an expectation is about. */
export function expectationTarget(e: unknown): string {
  const x = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
  switch (x.kind) {
    case 'relationship':
      return 'Join 1 · whole inputs';
    case 'no-row-loss':
    case 'no-fan-out':
      return `Join 1 · ${x.side === 'right' ? 'right' : x.side === 'left' ? 'left' : '?'} input`;
    case 'row-count':
      return 'Join 1 · output rows';
    default:
      return 'Not a supported target';
  }
}

/**
 * How definitive a report's results may look (Codex M09): `definitive` only for a CURRENT and
 * AUTHORITATIVE report; `limited` for a current report that is not authoritative (partial,
 * incomplete); `historical` for any report that is no longer current. Currency comes from the
 * report store, authority from the report; neither is recomputed here.
 */
export type Presentation = 'definitive' | 'limited' | 'historical';
export const presentation = (report: Pick<VerdictReport, 'authoritative'>, current: boolean): Presentation =>
  !current ? 'historical' : report.authoritative ? 'definitive' : 'limited';

export interface OutcomeView {
  readonly label: string;
  readonly tone: Tone;
}

/**
 * The outcome as displayed. Only a definitive report shows held or violated as such: a historical
 * report's outcomes carry "historical", a non-authoritative report's carry "not authoritative",
 * both in the neutral tone. `unchecked` is never shown as held.
 */
export function outcomeView(o: Pick<ExpectationOutcome, 'outcome'>, p: Presentation): OutcomeView {
  const base = o.outcome === 'held' ? 'Held' : o.outcome === 'violated' ? 'Violated' : 'Unchecked';
  if (p === 'historical') return { label: `${base} · historical`, tone: 'neutral' };
  if (p === 'limited') return { label: o.outcome === 'unchecked' ? base : `${base} · not authoritative`, tone: 'neutral' };
  return { label: base, tone: o.outcome === 'held' ? 'success' : o.outcome === 'violated' ? 'violation' : 'neutral' };
}


const is1 = (n: string) => n === '1';
const pos = (n: string | undefined) => n !== undefined && n !== '0';
const rowsOf = (n: string, table: string) => `${count(n)} ${table} ${is1(n) ? 'row' : 'rows'}`;
const verb = (n: string, one: string, many: string) => (is1(n) ? one : many);

/** The outcome of one expectation in user words (from its evidence; the M08 reason otherwise). */
export function outcomeSentence(o: ExpectationOutcome, join: JoinEvidence | null): string {
  const e = o.evidence ?? {};
  const x = (o.expectation && typeof o.expectation === 'object' ? o.expectation : {}) as Record<string, unknown>;
  const table = (side: unknown) => (side === 'right' ? join?.right.name : join?.left.name) ?? (side === 'right' ? 'right' : 'left');
  if (o.outcome === 'unchecked') return `Not checked: ${friendlyReason(o.reason)}`;
  const held = o.outcome === 'held';
  switch (x.kind) {
    case 'no-fan-out':
      return held ? `Held: no ${table(x.side)} row appears more than once.` : `Violated: ${rowsOf(e.rowsMultiplied ?? '?', table(x.side))} ${verb(e.rowsMultiplied ?? '', 'appears', 'appear')} more than once (${count(e.excessCopies)} extra ${is1(e.excessCopies ?? '') ? 'copy' : 'copies'}).`;
    case 'no-row-loss':
      return held ? `Held: every ${table(x.side)} row is in the output.` : `Violated: ${rowsOf(e.rowsDropped ?? '?', table(x.side))} ${verb(e.rowsDropped ?? '', 'is', 'are')} dropped${pos(e.nullKeyRows) ? ` (${count(e.nullKeyRows)} with a NULL key)` : ''}.`;
    case 'relationship':
      return held ? `Held: the tables are ${relationshipText(e.observed ?? '')}, within the allowed ${relationshipText(String(x.expected))}.` : `Violated: the tables are ${relationshipText(e.observed ?? '')}, more than the allowed ${relationshipText(String(x.expected))} (duplicate key values: ${count(e.leftDuplicateKeys)} in ${table('left')}, ${count(e.rightDuplicateKeys)} in ${table('right')}).`;
    case 'row-count':
      return `${held ? 'Held' : 'Violated'}: the join produces ${count(e.outputRows)} rows${held ? ', within' : ', outside'} the allowed range.`;
    default:
      return `${held ? 'Held' : 'Violated'}: ${o.reason ?? ''}`.trim();
  }
}

/** Unchecked reasons in user words. */
export function friendlyReason(reason: string | undefined): string {
  const r = reason ?? 'no reason recorded';
  if (r.startsWith('invalid expectation: ')) return `the rule is not valid (${r.slice('invalid expectation: '.length).replace(/are outside the P0 diagnostic scope/, 'are not supported by Verdict')}).`;
  if (/cancelled/.test(r)) return 'the analysis was cancelled.';
  if (/outside the supported diagnostic scope/.test(r)) return 'Verdict could not analyze this query.';
  if (/cannot be (parsed|bound)|join keys cannot be resolved/.test(r)) return 'the query could not be read.';
  if (/validation incomplete|budget|deadline/.test(r)) return 'some checks were skipped (analysis limits), so rules are not evaluated.';
  if (/engine|data may have changed|disposed|stale/.test(r)) return 'the engine or the data changed during the analysis.';
  if (/transaction is open/.test(r)) return 'a transaction was open.';
  if (/not a stable managed table|key/.test(r)) return 'Verdict could not analyze this query.';
  return `${r}.`;
}


// ---------------------------------------------------------------------------------------------
// Findings

const EVIDENCE_LABEL: Record<string, string> = {
  outputRows: 'Output rows',
  leftRows: 'Left input rows',
  rightRows: 'Right input rows',
  matchedPairs: 'Matched pairs',
  leftRowsMatched: 'Left rows matched',
  rightRowsMatched: 'Right rows matched',
  relationship: 'Whole-input relationship',
  matchedRelationship: 'Matched-key relationship',
  leftRowsMultiplied: 'Left rows multiplied',
  leftExcessCopies: 'Left excess copies',
  rightRowsMultiplied: 'Right rows multiplied',
  rightExcessCopies: 'Right excess copies',
  leftRowsDropped: 'Left rows dropped',
  rightRowsDropped: 'Right rows dropped',
  leftRowsPreserved: 'Left rows preserved',
  leftNullKeyRows: 'Left NULL-key rows',
  rightNullKeyRows: 'Right NULL-key rows',
  leftMaxMultiplicityMatched: 'Most left rows for one matched key',
  rightMaxMultiplicityMatched: 'Most right rows for one matched key',
  leftMaxMultiplicity: 'Most left rows for one key',
  rightMaxMultiplicity: 'Most right rows for one key',
  leftDuplicateKeys: 'Left duplicate key groups',
  rightDuplicateKeys: 'Right duplicate key groups',
  side: 'Side',
  rowsDropped: 'Rows dropped',
  rowsMultiplied: 'Rows multiplied',
  excessCopies: 'Excess copies',
  nullKeyRows: 'NULL-key rows',
  expected: 'Expected',
  observed: 'Observed',
  joinType: 'Join type',
  min: 'Minimum (inclusive)',
  max: 'Maximum (inclusive)',
  construct: 'Construct',
  detail: 'Detail',
  maxInputRows: 'Input row limit',
  estimate: 'Estimate',
};

/** camelCase evidence key → words, for keys without a fixed label. */
const words = (k: string) => capitalise(k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());

/** Evidence pairs for display: fixed labels, exact counts with digit grouping, relationships in words. */
export function evidenceRows(evidence: Readonly<Record<string, string>> | undefined, skip: readonly string[] = []): [string, string][] {
  if (!evidence) return [];
  return Object.entries(evidence)
    .filter(([k]) => !skip.includes(k))
    .map(([k, v]) => [EVIDENCE_LABEL[k] ?? words(k), /^\d+$/.test(v) ? count(v) : k === 'relationship' || k === 'matchedRelationship' || k === 'expected' || k === 'observed' ? relationshipText(v) : v]);
}

const TITLE: Record<string, string> = {
  'join-cardinality': 'Join cardinality',
  'left-rows-multiplied': 'Left rows multiplied',
  'right-rows-multiplied': 'Right rows multiplied',
  'unmatched-rows-dropped': 'Unmatched rows dropped',
  'unmatched-left-rows-preserved': 'Unmatched left rows preserved',
  'null-join-keys': 'NULL join keys',
  'many-to-many-join': 'Many-to-many match',
  'loss-and-fan-out': 'Row loss and fan-out together',
  'unsupported-construct': 'Verdict unavailable for this query',
  'unsupported-relation': 'Input not supported',
  'unsupported-key': 'Join key not supported',
  'not-a-select': 'Not a single SELECT',
  'parser-not-qualified': 'Engine version not qualified',
  'syntax-error': 'Syntax error',
  'bind-failed': 'Binding error',
  'key-resolution': 'Join keys not resolved',
  'parser-output': 'Parser output unreadable',
  'transaction-unavailable': 'Transaction open',
  'input-too-large': 'Input over the row limit',
  'grouping-over-budget': 'Grouping estimate over the limit',
  'budget-exhausted': 'Analysis incomplete',
  'invariant-violated': 'Statistics did not validate',
  'semantic-mismatch': 'Recount disagreed',
  'witness-mismatch': 'Witness check disagreed',
  'snapshot-inconsistent': 'Data changed during the analysis',
  'diagnostic-failed': 'Diagnostic failure',
  'analysis-cancelled': 'Analysis cancelled',
  'deadline-reached': 'Analysis deadline reached',
  'stale-analysis': 'Analysis stale',
  'analysis-failed': 'Analysis did not complete',
};

const CONFIDENCE: Record<Finding['confidence'], string> = { validated: 'Validated', incomplete: 'Incomplete evidence', unsupported: 'Unsupported' };

const SEVERITY_TONE: Record<Finding['severity'], Tone> = { info: 'info', warning: 'warning', error: 'violation', status: 'neutral', 'operational-error': 'neutral' };

/** Display order: violations, warnings, operational errors, status, observations. */
const ORDER: Record<Finding['category'], number> = {
  'expectation-violation': 0,
  suspicious: 1,
  'query-failure': 2,
  'diagnostic-failure': 2,
  unsupported: 3,
  inconclusive: 3,
  'expectation-unchecked': 4,
  observed: 5,
};

export interface FindingView {
  readonly key: string;
  readonly category: Finding['category'];
  /** The PRD §4 display label (from the core), with "historical" when the report is not current. */
  readonly label: string;
  readonly tone: Tone;
  readonly title: string;
  readonly message: string;
  /** Left, Right, Both inputs, Output or Query. */
  readonly side: string;
  /** Join 1 · INNER JOIN, or Query / Diagnostic probes. */
  readonly stage: string;
  readonly confidence: string;
  readonly evidence: readonly [string, string][];
}

function sideOf(f: Finding, outcomes: readonly ExpectationOutcome[], join: JoinEvidence | null): string {
  const ev = f.evidence ?? {};
  const L = join ? `Left input (${join.left.name})` : 'Left input';
  const R = join ? `Right input (${join.right.name})` : 'Right input';
  switch (f.code) {
    case 'left-rows-multiplied':
      return L;
    case 'right-rows-multiplied':
      return R;
    case 'unmatched-left-rows-preserved':
      return L;
    case 'loss-and-fan-out':
      return ev.side === 'right' ? R : L;
    case 'join-cardinality':
    case 'unmatched-rows-dropped':
    case 'null-join-keys':
    case 'many-to-many-join':
      return 'Both inputs';
  }
  if (f.category === 'expectation-violation') {
    const o = outcomes.find((x) => String(x.index) === ev.index);
    const x = o?.expectation as Record<string, unknown> | undefined;
    return x?.side === 'right' ? R : x?.side === 'left' ? L : o ? capitalise(expectationTarget(o.expectation).replace(/^Join 1 · /, '')) : 'Join 1';
  }
  return f.category === 'diagnostic-failure' ? 'Verdict checks' : 'Query';
}

/** Measured findings in user words, with table names (the core's message otherwise). */
function measuredText(f: Finding, join: JoinEvidence | null): string | null {
  const e = f.evidence ?? {};
  if (!join) return null;
  const L = join.left.name;
  const R = join.right.name;
  switch (f.code) {
    case 'join-cardinality':
      return `${rowsOf(e.leftRows ?? '?', L)} and ${rowsOf(e.rightRows ?? '?', R)} give ${count(e.outputRows)} output rows (${count(e.matchedPairs)} matched pairs). Whole tables: ${relationshipText(e.relationship ?? '')}; matched keys: ${relationshipText(e.matchedRelationship ?? '')}.`;
    case 'left-rows-multiplied':
      return `${rowsOf(e.leftRowsMultiplied ?? '?', L)} ${verb(e.leftRowsMultiplied ?? '', 'matches', 'match')} several ${R} rows and ${verb(e.leftRowsMultiplied ?? '', 'appears', 'appear')} more than once (${count(e.leftExcessCopies)} extra copies).`;
    case 'right-rows-multiplied':
      return `${rowsOf(e.rightRowsMultiplied ?? '?', R)} ${verb(e.rightRowsMultiplied ?? '', 'matches', 'match')} several ${L} rows and ${verb(e.rightRowsMultiplied ?? '', 'appears', 'appear')} more than once (${count(e.rightExcessCopies)} extra copies).`;
    case 'unmatched-rows-dropped': {
      const parts = [pos(e.leftRowsDropped) ? rowsOf(e.leftRowsDropped!, L) : '', pos(e.rightRowsDropped) ? rowsOf(e.rightRowsDropped!, R) : ''].filter(Boolean);
      const one = parts.length === 1 && is1((pos(e.leftRowsDropped) ? e.leftRowsDropped : e.rightRowsDropped) ?? '');
      return `${parts.join(' and ')} ${one ? 'has' : 'have'} no match and ${one ? 'is' : 'are'} not in the result.`;
    }
    case 'unmatched-left-rows-preserved':
      return `${rowsOf(e.leftRowsPreserved ?? '?', L)} ${verb(e.leftRowsPreserved ?? '', 'has', 'have')} no match and ${verb(e.leftRowsPreserved ?? '', 'is', 'are')} kept once with empty ${R} columns.`;
    case 'null-join-keys':
      return `${rowsOf(e.leftNullKeyRows ?? '?', L)} and ${rowsOf(e.rightNullKeyRows ?? '?', R)} have a NULL key. NULL never equals NULL, so these rows cannot match.`;
    case 'many-to-many-join':
      return `Matched keys repeat in both ${L} and ${R}, so rows multiply on both sides. Sometimes intended (a bridge table); often a sign of a missing key column.`;
    case 'loss-and-fan-out': {
      const t = e.side === 'right' ? R : L;
      return `In ${t}, ${count(e.rowsDropped)} ${is1(e.rowsDropped ?? '') ? 'row is' : 'rows are'} dropped while other rows gain ${count(e.excessCopies)} extra copies. The row count alone hides both.`;
    }
    default:
      return null;
  }
}

/**
 * Findings for display, most severe first. Unchecked-expectation findings are omitted here: every
 * expectation, with its outcome and reason, is listed once in the Expectations section.
 */
export function findingViews(report: VerdictReport, current: boolean): FindingView[] {
  const p = presentation(report, current);
  const stage = report.join ? `Join 1 · ${report.join.type} JOIN` : 'Query';
  return report.findings
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.category !== 'expectation-unchecked')
    .sort((a, b) => ORDER[a.f.category] - ORDER[b.f.category] || a.i - b.i)
    .map(({ f, i }) => {
      const violation = f.category === 'expectation-violation';
      const outcome = violation ? report.expectations.find((o) => String(o.index) === f.evidence?.index) : undefined;
      const title = violation ? (p === 'definitive' ? 'Expectation violated' : p === 'historical' ? 'Expectation was violated' : 'Expectation violated (not authoritative)') : (TITLE[f.code] ?? f.label);
      const message = violation && outcome ? `Expectation ${outcome.index + 1} · ${describeExpectation(outcome.expectation)}. ${outcomeSentence(outcome, report.join).replace(/^Violated: /, '')}` : (measuredText(f, report.join) ?? f.message);
      // Measurement findings of a non-definitive report are never shown in attention tones.
      const measured = f.category === 'observed' || f.category === 'suspicious' || violation;
      // Definitive: the core's severity tone. Historical: neutral. Limited: observations stay
      // informational; warnings and violations lose their attention tone; status findings keep theirs.
      const tone: Tone = p === 'definitive' ? SEVERITY_TONE[f.severity] : p === 'historical' ? 'neutral' : f.category === 'observed' ? 'info' : measured ? 'neutral' : SEVERITY_TONE[f.severity];
      return {
        key: `${i}-${f.code}`,
        category: f.category,
        label: p === 'historical' ? `${f.label} · historical` : p === 'limited' && measured ? `${f.label} · limited evidence` : f.label,
        tone,
        title,
        message,
        side: sideOf(f, report.expectations, report.join),
        stage: f.category === 'unsupported' || f.category === 'query-failure' ? 'Query' : f.category === 'diagnostic-failure' ? 'Verdict checks' : stage,
        confidence: CONFIDENCE[f.confidence],
        evidence: evidenceRows(f.evidence, violation ? ['index'] : []),
      };
    });
}

/**
 * "No issues found in these checks" (PRD QV-VER-006) is shown only for a current, authoritative
 * report with no violation and no suspicious pattern — and always together with its coverage.
 */
export const noIssuesFound = (report: VerdictReport, current: boolean) =>
  current && report.authoritative && !report.findings.some((f) => f.category === 'expectation-violation' || f.category === 'suspicious') && measuredLoss(report) === null;

/**
 * Rows the join drops, as measured (Codex M09; AM-011/P-102 still open): when any input row
 * contributes no output, the healthy summary is withheld and the loss stays visible, whatever its
 * category. Null when the report has no measurements or no loss.
 */
export function measuredLoss(report: VerdictReport): { left: string; right: string } | null {
  const d = report.join?.derived;
  if (!d || (d.leftRowsDropped === '0' && d.rightRowsDropped === '0')) return null;
  return { left: d.leftRowsDropped, right: d.rightRowsDropped };
}

// ---------------------------------------------------------------------------------------------
// Witnesses

export const WITNESS_LABEL: Record<WitnessKind, string> = { 'fan-out': 'Fan-out', 'unmatched-left': 'Unmatched left key', 'unmatched-right': 'Unmatched right key' };
export const WITNESS_FILTER_LABEL: Record<WitnessKind, string> = { 'fan-out': 'Fan-out', 'unmatched-left': 'Unmatched left', 'unmatched-right': 'Unmatched right' };

/** The report's witnesses of one kind (or all), in report order, at most five per kind. */
export function witnessRows(witnesses: readonly Witness[], kind: WitnessKind | 'all'): Witness[] {
  const out: Witness[] = [];
  for (const k of WITNESS_KINDS) {
    if (kind !== 'all' && kind !== k) continue;
    out.push(...witnesses.filter((w) => w.kind === k).slice(0, WITNESSES_PER_KIND));
  }
  return out;
}

/** Column headings for the key tuple: the left column, or `left = right` when the names differ. */
export function keyHeadings(join: Pick<JoinEvidence, 'keys'>): string[] {
  return join.keys.map((k) => (k.left === k.right ? k.left : `${k.left} = ${k.right}`));
}

/** Why a witness kind has no sample keys, from the report's own counts (no inference). */
export function emptyWitnessText(kind: WitnessKind, join: JoinEvidence): string {
  const s = join.stats;
  const d = join.derived;
  if (!s || !d) return 'No sample keys for this check: the join measurements were withheld.';
  if (join.validation.witnesses === 'not-run' && join.witnesses.length === 0) return 'No sample keys for this check: the witness step did not run.';
  if (kind === 'fan-out') return `No sample keys for this check. Rows multiplied: ${count(s.leftRowsMultiplied)} left, ${count(s.rightRowsMultiplied)} right.`;
  if (kind === 'unmatched-left') return `No sample keys for this check. Unmatched left rows: ${count(d.leftUnmatchedRows)}, of which ${count(s.leftNullKeyRows)} have a NULL key (NULL keys are not sample keys).`;
  return `No sample keys for this check. Unmatched right rows: ${count(d.rightUnmatchedRows)}, of which ${count(s.rightNullKeyRows)} have a NULL key (NULL keys are not sample keys).`;
}

export const witnessCheckText: Record<JoinEvidence['validation']['witnesses'], string> = {
  verified: 'Each sample key was re-counted on both inputs and through the join.',
  'not-run': 'The sample keys were not re-counted through the join (the work limit refused it); treat them as unverified.',
  mismatch: 'A witness re-count disagreed, so the evidence was withdrawn.',
};
