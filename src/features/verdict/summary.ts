// Copyable Verdict summary (PRD QV-UI-003; UI_SPECIFICATION §5 "Coverage and reproduction"; M12).
//
// The summary is built from an ALLOWLIST: every line is a fixed sentence filled only with exact
// counts, enumerated values (join type, key types, statuses, relationship names, expectation kinds)
// and validated integers. Free text from the report — finding messages, evidence, error reasons,
// non-authoritative reasons, coverage lines — is never copied, because it can quote table and
// column names, SQL fragments, key values or engine error text. Unknown codes and malformed
// declarations become a neutral placeholder.
//
// By default it leaves out the SQL text, table and column names, aliases and witness key values;
// each can be added with an explicit option. It also never includes the report id, the query hash,
// catalog ids, file names, or the analysis time. It is not anonymous: the counts and outcomes
// themselves describe the data.
import { DISCLAIMER } from '../../core/verdict/report';
import { RELATIONSHIPS, type ExpectationOutcome, type JoinEvidence, type ReportStatus, type VerdictReport, type WitnessKind } from '../../core/verdict/types';

/** Longest SQL text the summary includes (characters); longer SQL is shortened, with a note. */
export const MAX_SUMMARY_SQL_CHARS = 20_000;

export interface SummaryOptions {
  /** Whether the report is current for the live workspace (from the report store). */
  readonly current: boolean;
  /** Why it is historical (the report store's reason); mapped to fixed text. */
  readonly historicalReason?: string;
  /** Add the analysed SQL text. */
  readonly includeSql?: boolean;
  /** Add table names, aliases and key column names. */
  readonly includeIdentifiers?: boolean;
  /** Add witness key values and their counts. */
  readonly includeWitnesses?: boolean;
}

const HISTORICAL: Readonly<Record<string, string>> = {
  'engine restarted': 'the engine restarted after this analysis',
  'data may have changed': 'the data may have changed since this analysis',
  'query changed': 'the query in the editor changed since this analysis',
  'expectations changed': 'the declared expectations changed since this analysis',
  'session ended': 'the session ended',
  'newer report': 'a newer analysis replaced this report',
};

const STATUS: Readonly<Record<ReportStatus, string>> = {
  analyzed: 'analysed: every supported check ran and was validated',
  'partially-analyzed': 'partly analysed: the join was measured and validated, but some expectations were not checked',
  inconclusive: 'inconclusive: the measurements could not be validated and are withheld',
  unsupported: 'unsupported: the query is outside the diagnostic scope, so nothing was measured',
  'query-failed': 'query failed: the query cannot be parsed, bound or resolved',
  'diagnostic-failed': 'diagnostic failed: a diagnostic step failed (this does not mean the query fails)',
  'budget-exhausted': 'stopped at a limit: the analysis reached a resource or time limit before completing',
  cancelled: 'cancelled before it completed',
  stale: 'stale: the engine or data changed during the analysis',
};

/** Fixed titles by finding code; anything else is summarised without its text. */
const FINDING: Readonly<Record<string, string>> = {
  'join-cardinality': 'join size measured',
  'left-rows-multiplied': 'left rows appear more than once in the output',
  'right-rows-multiplied': 'right rows appear more than once in the output',
  'unmatched-rows-dropped': 'rows without a match are not in the output',
  'unmatched-left-rows-preserved': 'unmatched left rows are kept with empty right-side columns',
  'null-join-keys': 'rows with a NULL key cannot match',
  'many-to-many-join': 'matched keys are duplicated on both sides',
  'loss-and-fan-out': 'rows are lost and duplicated on the same side',
  'relationship-violated': 'the declared relationship does not hold',
  'no-row-loss-violated': 'the declared no-row-loss expectation does not hold',
  'no-fan-out-violated': 'the declared no-fan-out expectation does not hold',
  'row-count-violated': 'the declared row-count range does not hold',
  'expectation-unchecked': 'an expectation was not checked',
  'analysis-cancelled': 'the analysis was cancelled',
  'deadline-reached': 'the analysis reached its time limit',
  'stale-analysis': 'the analysis is stale',
  'analysis-failed': 'the analysis did not complete',
  'budget-exhausted': 'a resource limit stopped part of the analysis',
  'diagnostic-failed': 'a diagnostic statement failed',
  'parser-output': 'the parser output could not be read',
  'parser-not-qualified': 'the SQL parser is not qualified for this engine version',
  'transaction-unavailable': 'a user transaction was open',
  'syntax-error': 'the query cannot be parsed',
  'not-a-select': 'the statement is not a single SELECT',
  'unsupported-construct': 'the query uses a construct outside the diagnostic scope',
  'unsupported-relation': 'an input is not a stable managed table',
  'unsupported-key': 'the join keys are outside the supported scope',
  'bind-failed': 'the query cannot be bound',
  'key-resolution': 'the join keys cannot be resolved',
  'input-too-large': 'an input is over the row limit',
  'grouping-over-budget': 'the estimated grouping state is over the budget',
  'invariant-violated': 'the statistics failed their invariants',
  'semantic-mismatch': 'the key statistics disagree with the engine\'s own join',
  'witness-mismatch': 'witness recounts disagree with the key statistics',
  'snapshot-inconsistent': 'the input data changed during the analysis',
};

const KEY_TYPES = /^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?)$/;
const WITNESS_KIND: Record<WitnessKind, string> = { 'fan-out': 'fan-out key', 'unmatched-left': 'unmatched left key', 'unmatched-right': 'unmatched right key' };
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const exact = (v: string) => (/^-?\d+$/.test(v) ? v : '?');
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
/** One line of free text the user opted into: line breaks cannot forge summary lines. */
const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ');

/** A declared expectation in fixed words; anything not well-formed is not echoed. */
function describeExpectation(e: unknown): string {
  const x = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
  const side = x.side === 'left' || x.side === 'right' ? x.side : null;
  switch (x.kind) {
    case 'relationship':
      return typeof x.expected === 'string' && (RELATIONSHIPS as readonly string[]).includes(x.expected) ? `relationship is ${x.expected}` : 'relationship (not a valid declaration)';
    case 'no-row-loss':
      return side ? `no ${side} rows lost` : 'no row loss (not a valid declaration)';
    case 'no-fan-out':
      return side ? `no ${side} rows multiplied` : 'no fan-out (not a valid declaration)';
    case 'row-count': {
      const min = isInt(x.min) ? x.min : null;
      const max = isInt(x.max) ? x.max : null;
      if ((x.min !== undefined && min === null) || (x.max !== undefined && max === null) || (min === null && max === null)) return 'row count (not a valid declaration)';
      return `output rows ${min !== null && max !== null ? `between ${min} and ${max}` : min !== null ? `at least ${min}` : `at most ${max}`}`;
    }
    default:
      return 'an expectation of an unsupported kind';
  }
}

function outcomeWord(o: ExpectationOutcome, current: boolean): string {
  if (!current && o.outcome !== 'unchecked') return `${o.outcome} (historical)`;
  return o.outcome;
}

function joinLine(join: JoinEvidence, ids: boolean): string {
  const types = [...new Set(join.keys.map((k) => (KEY_TYPES.test(k.type) ? k.type : 'integer')))].join(', ');
  const n = join.keys.length;
  if (!ids) return `${join.type} JOIN of the left table and the right table on ${n} key column${n === 1 ? '' : 's'} (${types}).`;
  const side = (r: JoinEvidence['left']) => (r.ref.toLowerCase() !== r.name.toLowerCase() ? `${quote(r.name)} AS ${quote(r.ref)}` : quote(r.name));
  const on = join.keys.map((k) => `${quote(join.left.ref)}.${quote(k.left)} = ${quote(join.right.ref)}.${quote(k.right)}`).join(' AND ');
  return `${side(join.left)} ${join.type} JOIN ${side(join.right)} ON ${on} (${types}).`;
}

/** The summary text exactly as the preview shows it and Copy writes it. Pure. */
export function buildSummary(report: VerdictReport, options: SummaryOptions): string {
  const ids = options.includeIdentifiers === true;
  const lines: string[] = ['QueryVerdict summary', ''];
  const historical = !options.current;
  lines.push(historical ? `Report: historical — ${HISTORICAL[options.historicalReason ?? ''] ?? 'the workspace changed since this analysis'}. It describes an earlier state, not the current workspace.` : 'Report: current.');
  lines.push(`Status: ${STATUS[report.status] ?? 'unknown'}.`);
  lines.push(
    report.authoritative
      ? historical
        ? 'Authority: authoritative when it was produced, within the supported join-stage checks; now historical.'
        : 'Authority: authoritative within the supported join-stage checks, for the analysed snapshot of the data.'
      : 'Authority: not authoritative. Its values are not a validated answer.',
  );
  if (report.replay) lines.push(`Engine: DuckDB ${report.replay.engine.duckdb} (duckdb-wasm ${report.replay.engine.package}), in this browser tab.`);
  const join = report.join;
  if (join) {
    lines.push('', `Join: ${joinLine(join, ids)}`);
    const s = join.stats;
    const d = join.derived;
    if (s && d) {
      const label = historical ? 'Measured (exact counts, historical)' : 'Measured (exact counts)';
      const leftName = ids ? quote(join.left.ref) : 'left table';
      const rightName = ids ? quote(join.right.ref) : 'right table';
      lines.push(`${label}:`);
      lines.push(`- Output rows: ${exact(d.outputRows)}.`);
      lines.push(`- ${leftName}: ${exact(s.leftRows)} rows; ${exact(s.leftRowsMatched)} matched; ${exact(s.leftRowsMultiplied)} appear more than once (${exact(s.leftExcessCopies)} extra copies); ${exact(d.leftUnmatchedRows)} without a match (${exact(d.leftRowsDropped)} not in the output, ${exact(d.leftRowsPreserved)} kept with empty columns); ${exact(s.leftNullKeyRows)} with a NULL key.`);
      lines.push(`- ${rightName}: ${exact(s.rightRows)} rows; ${exact(s.rightRowsMatched)} matched; ${exact(s.rightRowsMultiplied)} appear more than once (${exact(s.rightExcessCopies)} extra copies); ${exact(d.rightUnmatchedRows)} without a match (${exact(d.rightRowsDropped)} not in the output); ${exact(s.rightNullKeyRows)} with a NULL key.`);
      const rel = (r: string) => ((RELATIONSHIPS as readonly string[]).includes(r) || r === 'no-matches' ? r : 'unknown');
      lines.push(`- Relationship: ${rel(d.relationship)} by key uniqueness; ${d.matchedRelationship === 'no-matches' ? 'no keys matched' : `${rel(d.matchedRelationship)} among matched keys`}.`);
      if (!report.authoritative) lines.push(report.status === 'partially-analyzed' ? '- The measurements were validated; some expectations were not checked, so the report is not authoritative.' : '- These measurements are limited evidence: not every validation check completed.');
    } else {
      lines.push('Measurements: withheld (none were validated in this run).');
    }
  }

  const titles = [...new Set(report.findings.map((f) => `${f.label}: ${FINDING[f.code] ?? 'another finding (details are in the app)'}.`))];
  if (titles.length) lines.push('', 'Findings:', ...titles.map((t) => `- ${t}`));

  if (report.expectations.length) {
    lines.push('', 'Expectations:');
    for (const o of report.expectations) lines.push(`- ${o.index + 1}. ${describeExpectation(o.expectation)}: ${outcomeWord(o, options.current)}.`);
  }

  if (options.includeWitnesses && join && join.witnesses.length) {
    lines.push('', `Witness keys (at most five per kind${historical ? ', historical' : ''}):`);
    for (const w of join.witnesses) {
      lines.push(`- ${WITNESS_KIND[w.kind] ?? 'key'} (${w.key.map(exact).join(', ')}): ${exact(w.leftRows)} left rows, ${exact(w.rightRows)} right rows, ${exact(w.outputRows)} output rows.`);
    }
  }

  if (options.includeSql) {
    const sql = report.identity.sqlText;
    const shown = sql.length > MAX_SUMMARY_SQL_CHARS ? sql.slice(0, MAX_SUMMARY_SQL_CHARS) : sql;
    lines.push('', 'Analysed SQL (the query as written: it can contain table and column names and literal values):', ...shown.split(/\r\n|[\r\n\u2028\u2029]/).map((l) => `  ${oneLine(l)}`));
    if (shown.length < sql.length) lines.push(`  [Shortened: the first ${MAX_SUMMARY_SQL_CHARS.toLocaleString('en-US')} of ${sql.length.toLocaleString('en-US')} characters. The full query is in the editor.]`);
  }

  // Whether the query was bound is known only from the analysis's own checks (never assumed).
  const bound = report.coverage.checked.some((c) => c.startsWith('the query binds'));
  lines.push('', `Not checked: whether the query expresses the intended business logic; whether it executes (${bound ? 'it was bound, not run' : 'Verdict did not run it and did not confirm that it binds'}); aggregate inflation, metric preservation and grain.`);
  lines.push(DISCLAIMER);
  // What the summary holds, by section (the SQL section, when added, can itself contain names and values).
  const omitted = [!options.includeSql && 'the analysed SQL', !ids && 'table, alias and column names in the Join and Measured lines', !options.includeWitnesses && 'the witness keys section'].filter(Boolean) as string[];
  const parts: string[] = [];
  if (omitted.length) parts.push(`Left out of this summary: ${omitted.join('; ')}.`);
  else parts.push('This summary includes the analysed SQL, table and column names and the witness keys section.');
  if (options.includeSql) parts.push('The analysed SQL is included as written, so it can contain table and column names and values even where other sections leave them out.');
  parts.push('The counts and outcomes above describe the data.');
  lines.push('', parts.join(' '));
  return `${lines.join('\n')}\n`;
}
