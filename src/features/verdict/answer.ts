// The Verdict "answer" (M09 UX rewrite, P-106): for every report state, ONE headline that says what
// happened at the join (or why there is no answer), what it means for the user's own result, and at
// most two next steps. Pure presentation: every sentence is built from fields of the published
// report (status, findings[].code/evidence/message, join.stats/derived/witnesses, expectations,
// nonAuthoritativeReasons) and the report store's currency. Nothing is measured, inferred from the
// SQL text, or re-decided here; categories, authority and currency stay the core's.
import type { Finding, JoinEvidence, VerdictReport, Witness } from '../../core/verdict/types';
import { capitalise, count, describeExpectation, historicalText, presentation, type Presentation, type Tone } from './model';
export { friendlyReason, outcomeSentence } from './model';
import { outcomeSentence } from './model';

export interface Answer {
  /** State-matrix row (P-106), for tests and styling. */
  readonly kind: string;
  readonly tone: Tone;
  readonly headline: string;
  /** What this means for the user's own query result (1–3 short sentences). */
  readonly meaning: readonly string[];
  /** At most two concrete next steps. */
  readonly next: readonly string[];
  /** Effects of the join, one line each, when there is more than one (measured reports only). */
  readonly effects: readonly string[];
  /** Other reasons the analysis could not run ("Also outside the checks"). */
  readonly also: readonly string[];
  /** The report carries join measurements to show (overview, witnesses). */
  readonly measured: boolean;
  /** "No issues found in these checks" applies (current, authoritative, nothing to review). */
  readonly healthy: boolean;
  readonly presentation: Presentation;
  /** Measured reports: what happened to each table's rows. */
  readonly fate?: readonly RowFate[];
}

const NOTHING_MEASURED = 'Nothing was measured, and your Run SQL result is unaffected: this is a limit of Verdict, not an error in your SQL.';
const is1 = (n: string) => n === '1';
const pos = (n: string | undefined) => n !== undefined && n !== '0';

// ---------------------------------------------------------------------------------------------
// Unsupported: one primary reason, by priority; the rest are listed as "Also outside the checks".

type Reason = { readonly kind: string; readonly priority: number; readonly title: string; readonly detail: string; readonly construct: string };

const CLAUSE_TITLE: Record<string, string> = {
  WHERE: 'WHERE filter',
  'GROUP BY': 'GROUP BY',
  'GROUP BY ALL / aggregate handling': 'GROUP BY ALL',
  HAVING: 'HAVING',
  QUALIFY: 'QUALIFY',
  'USING SAMPLE': 'USING SAMPLE',
  DISTINCT: 'DISTINCT',
  'ORDER BY': 'ORDER BY',
  'LIMIT / OFFSET': 'LIMIT / OFFSET',
  'result modifier': 'Result modifier',
  'function or aggregate in SELECT': 'Function or aggregate in SELECT',
  'window function': 'Window function',
  'subquery in SELECT': 'Subquery in SELECT',
  'SELECT * modifier (EXCLUDE / REPLACE / RENAME / COLUMNS)': 'SELECT * modifier',
  'SELECT column reference': 'Column reference in SELECT',
  'SELECT list': 'Empty SELECT list',
};
const AGGREGATION = new Set(['GROUP BY', 'GROUP BY ALL / aggregate handling', 'HAVING', 'QUALIFY', 'function or aggregate in SELECT', 'window function']);

/** Classifies one unsupported or query-failure finding into a reason with a priority (P-106). */
export function reasonOf(f: Finding): Reason {
  const c = f.evidence?.construct ?? '';
  const d = f.evidence?.detail ?? '';
  const r = (kind: string, priority: number, title: string, detail = d) => ({ kind, priority, title, detail, construct: c });
  if (f.code === 'not-a-select') return r('not-select', 1, 'Not a SELECT', f.message);
  if (f.code === 'parser-not-qualified') return r('engine', 8, 'Engine version not qualified', f.message);
  if (f.code === 'unsupported-relation') {
    // The service writes "<reference>: <reason>. No data conclusions are drawn."; keep the reason.
    const m = f.message.replace(/^[^:\s]+: /, '').replace(/ No data conclusions are drawn\.$/, '');
    if (/is a view/.test(m)) return r('relation-view', 4, 'View as input', m);
    if (/not a table in the catalog/.test(m)) return r('relation-not-table', 4, 'Input is not a session table', m);
    if (/matches \d+ catalog objects/.test(m)) return r('relation-ambiguous', 4, 'Ambiguous table name', m);
    if (/outside the current schema/.test(m)) return r('relation-schema', 4, 'Table in another schema', m);
    if (/generated columns/.test(m)) return r('relation-generated', 4, 'Generated columns', m);
    return r('relation', 4, 'Input not supported', m);
  }
  if (f.code === 'unsupported-key') {
    const m = f.message;
    if (/key types differ/.test(m)) return r('key-types', 6, 'Key types differ', m);
    if (/only same-type integer keys/.test(m)) return r('key-not-integer', 6, 'Key is not an integer', m);
    if (/same input/.test(m)) return r('key-same-side', 6, 'Key compares one table with itself', m);
    if (/exceed the limit/.test(m)) return r('key-count', 6, 'Too many key columns', m);
    return r('key', 6, 'Join key not supported', m);
  }
  // Recogniser constructs (recognise.ts).
  if (c === 'multiple statements') return r('multiple-statements', 1, 'Several statements');
  if (c === 'statement' || c.startsWith('query node') || c === 'parser output') return r('not-select', 1, 'Not a single SELECT');
  if (c === 'set operation (UNION / INTERSECT / EXCEPT)') return r('set-operation', 1, 'UNION / INTERSECT / EXCEPT');
  if (c === 'single relation (no join)') return r('no-join', 2, 'No join');
  if (c === 'query without FROM' || c === 'VALUES list') return r('no-join', 2, c === 'VALUES list' ? 'VALUES list' : 'No table');
  if (/join chain or nested join/.test(c)) return r('multi-join', 3, 'More than one join');
  if (c === 'WITH (CTE)') return r('relation-derived', 4, 'WITH (CTE)');
  if (/derived table|table function/.test(c)) return r('relation-derived', 4, /table function/.test(c) ? 'Table function as input' : 'Subquery as input');
  if (/qualified table name|TABLESAMPLE|time travel|column aliases on a table|reserved name|table reference|FROM item/.test(c)) return r('relation', 4, capitalise(c));
  if (/ JOIN$/.test(c) || c === 'join without condition' || c === 'join shape' || c.startsWith('USING')) {
    return r(c === 'CROSS JOIN' || c === 'join without condition' ? 'join-cross' : c === 'RIGHT JOIN' ? 'join-right' : 'join-type', 5, c === 'join without condition' ? 'Join without ON' : c);
  }
  if (/join (condition|key)|in join condition|column reference in/.test(c) || c === 'cast in join key') return r('key-condition', 6, 'ON condition is not a column = column match');
  if (c in CLAUSE_TITLE) return r(AGGREGATION.has(c) ? 'aggregation' : c === 'WHERE' ? 'where' : /SELECT/.test(c) ? 'select-list' : 'modifier', 7, CLAUSE_TITLE[c] as string);
  return r('other', 9, c ? capitalise(c) : 'Unsupported query shape', d || f.message);
}

const SUPPORTED_SHAPE = 'Verdict checks one SELECT that joins two session tables with INNER or LEFT JOIN on integer key columns (ON a.key = b.key, combined with AND, or USING).';

function unsupportedAnswer(report: VerdictReport, p: Presentation): Answer {
  const reasons = report.findings.filter((f) => f.category === 'unsupported').map(reasonOf);
  const sorted = [...reasons].sort((a, b) => a.priority - b.priority);
  const primary = sorted[0] ?? reasonOf({ category: 'unsupported', code: 'unknown', message: 'The query shape is not supported.', label: 'Unsupported', severity: 'status', confidence: 'unsupported' });
  const also = [...new Set(sorted.slice(1).map((x) => x.title))].filter((t) => t !== primary.title);
  const hasAggregation = reasons.some((x) => x.kind === 'aggregation');
  let headline: string;
  let meaning: string[] = [NOTHING_MEASURED];
  let next: string[];
  switch (primary.kind) {
    case 'multiple-statements': {
      const n = /^(\d+) statements/.exec(primary.detail)?.[1];
      headline = `Analyze reads the whole editor, and it holds ${n ?? 'several'} statements.`;
      meaning = ['Verdict analyzes one SELECT at a time. Nothing was measured, and your Run SQL results are unaffected.'];
      next = ['Keep only the SELECT you want to check in the editor (comment out the other statements), then analyze again.'];
      break;
    }
    case 'not-select':
      headline = 'This is not a single SELECT query, so there is no join to analyze.';
      next = ['Analyze a SELECT that joins two tables.'];
      break;
    case 'set-operation':
      headline = 'UNION, INTERSECT and EXCEPT combine several queries; Verdict analyzes one join at a time.';
      next = ['Analyze each SELECT on its own.'];
      break;
    case 'no-join':
      headline = primary.construct === 'single relation (no join)' ? 'No join to analyze: this query reads a single table.' : 'No join to analyze: this query does not read two tables.';
      meaning = ['Verdict checks what a join does to rows: which rows match, repeat or disappear. Nothing was measured, and your Run SQL result is unaffected.'];
      next = [
        'Use Verdict on queries that join two tables on a key, for example FROM a JOIN b ON a.id = b.id.',
        ...(hasAggregation ? ['If you later join another table before aggregating, analyze that join first: repeated rows inflate counts and sums.'] : []),
      ];
      break;
    case 'multi-join':
      headline = 'This query has more than one join; Verdict analyzes exactly one join between two tables.';
      next = ['Analyze one join at a time: keep two tables and their ON condition, with SELECT *.'];
      break;
    case 'relation-view':
      headline = `${primary.detail.split(' is a view')[0] ?? 'An input'} is a view; Verdict analyzes tables stored in this session.`;
      next = ['Join the underlying tables instead, or store the view as a table first (CREATE TABLE … AS SELECT * FROM the view), then analyze.'];
      break;
    case 'relation-not-table':
      headline = 'One input is not a table in this session (for example a file path).';
      next = ['Import the file as a session table, then join the table.'];
      break;
    case 'relation-derived':
      headline = 'One input is a subquery, CTE or table function; Verdict analyzes joins of two stored tables.';
      next = ['Store that part as a table first (CREATE TABLE t AS …), then join the table.'];
      break;
    case 'relation-ambiguous':
    case 'relation-schema':
    case 'relation-generated':
    case 'relation':
      headline = `An input table cannot be analyzed: ${primary.title.toLowerCase()}.`;
      meaning = [primary.detail, NOTHING_MEASURED];
      next = ['Join two plain tables from this session, referred to by their names.'];
      break;
    case 'join-cross':
      headline = 'This join has no ON condition, so every row pairs with every row; Verdict analyzes joins on key columns.';
      next = ['Add ON a.key = b.key and use INNER JOIN or LEFT JOIN.'];
      break;
    case 'join-right':
      headline = 'RIGHT JOIN is not analyzed; Verdict analyzes INNER and LEFT joins.';
      next = ['Swap the two tables and use LEFT JOIN: it keeps the same rows.'];
      break;
    case 'join-type':
      headline = `${primary.title} is not analyzed; Verdict analyzes INNER and LEFT joins on key columns.`;
      next = ['Rewrite the join as INNER JOIN or LEFT JOIN … ON a.key = b.key.'];
      break;
    case 'key-types': {
      const m = /key types differ \((.+?) vs (.+?)\)/.exec(primary.detail);
      headline = m ? `The join keys have different types: ${m[1]} and ${m[2]}.` : 'The join keys have different types.';
      next = ['Join on key columns of the same integer type (convert one column in a new table first).'];
      break;
    }
    case 'key-not-integer': {
      const m = /key (.+?) has type (\S+?);/.exec(primary.detail);
      headline = m ? `The join key ${m[1]} is ${m[2]}; Verdict analyzes integer keys only.` : 'The join key is not an integer column; Verdict analyzes integer keys only.';
      next = ['Join on an integer id column if the tables have one.'];
      break;
    }
    case 'key-same-side':
      headline = 'An ON equality compares two columns of the same table; each must compare a column of one table with a column of the other.';
      next = ['Write ON a.key = b.key, with one column from each table.'];
      break;
    case 'key-count':
    case 'key':
      headline = `The join key cannot be analyzed: ${primary.detail}`;
      next = ['Join on fewer integer key columns, matched with ON a.key = b.key.'];
      break;
    case 'key-condition':
      headline = 'The ON condition is not a plain column = column match.';
      meaning = [`Found: ${primary.construct}.`, NOTHING_MEASURED];
      next = ['Use ON a.col = b.col, and combine several with AND.'];
      break;
    case 'aggregation':
      headline = 'Verdict cannot check the aggregation, but the join underneath it is where counts and sums get inflated.';
      next = ['Analyze the join on its own first: keep FROM … JOIN … ON …, use SELECT *, and remove GROUP BY and the aggregate functions.'];
      break;
    case 'where':
      headline = 'Verdict analyzes the join itself, before any WHERE filter, and this query has one.';
      next = ['Analyze the join without the WHERE clause (SELECT * FROM … JOIN … ON …), then add the filter back for Run SQL.'];
      break;
    case 'select-list':
      headline = 'This query computes values in SELECT; Verdict analyzes the join with SELECT * or plain columns.';
      meaning = ['The SELECT list does not change which rows the join produces. ' + NOTHING_MEASURED];
      next = ['Analyze the same join with SELECT *.'];
      break;
    case 'modifier':
      headline = `Verdict analyzes the join without ${primary.title}.`;
      next = [`Remove ${primary.title}, analyze, then add it back for Run SQL.`];
      break;
    case 'engine':
      headline = 'This engine version is not qualified for Verdict, so nothing was analyzed.';
      next = ['Run SQL is not affected.'];
      break;
    default:
      headline = `Verdict cannot analyze this query shape (${primary.title}).`;
      next = [SUPPORTED_SHAPE];
  }
  return { kind: `unsupported:${primary.kind}`, tone: 'neutral', headline, meaning, next: next.slice(0, 2), effects: [], also, measured: false, healthy: false, presentation: p };
}

// ---------------------------------------------------------------------------------------------
// Query failures, incomplete and interrupted runs.

function queryFailedAnswer(report: VerdictReport, p: Presentation): Answer {
  const f = report.findings.find((x) => x.category === 'query-failure');
  const message = f?.message ?? 'The query could not be read.';
  const headline =
    f?.code === 'syntax-error' ? 'Verdict cannot read this query: it has a syntax error.'
    : f?.code === 'bind-failed' ? 'Verdict cannot read this query: a table, column or type in it is not valid.'
    : f?.code === 'key-resolution' ? 'Verdict cannot match the join keys to the two tables.'
    : 'Verdict cannot read this query.';
  return {
    kind: `query-failed:${f?.code ?? 'unknown'}`, tone: 'neutral', headline,
    meaning: [message.replace(/^The query cannot be (parsed|bound) \(it would fail before running\): |^The query cannot be parsed: |^The join keys cannot be resolved: /, ''), 'Verdict did not run the query.'],
    next: ['Fix the SQL, then analyze again. Run SQL shows the same error.'], effects: [], also: [], measured: false, healthy: false, presentation: p,
  };
}

const INCOMPLETE: Record<string, { headline: string; next: string }> = {
  'transaction-unavailable': { headline: 'A transaction is open, so Verdict could not read the data in one consistent state.', next: 'Run COMMIT or ROLLBACK, then analyze again.' },
  'input-too-large': { headline: 'An input table has more rows than the analysis allows, so nothing was measured.', next: 'Analyze a smaller table, for example a sample stored as its own table.' },
  'grouping-over-budget': { headline: 'Counting the join keys would need more memory than the analysis allows, so nothing was measured.', next: 'Analyze smaller tables, or fewer key columns.' },
  'invariant-violated': { headline: 'Verdict’s cross-checks of its own counts disagreed, so it shows no measurements.', next: 'Analyze again.' },
  'semantic-mismatch': { headline: 'Two independent counts of this join disagreed, so Verdict shows no measurements.', next: 'Analyze again.' },
  'witness-mismatch': { headline: 'Re-counting the sample keys disagreed with the first count, so Verdict shows no measurements.', next: 'Analyze again.' },
  'snapshot-inconsistent': { headline: 'The data changed while Verdict was reading it, so it shows no measurements.', next: 'Wait for other work to finish, then analyze again.' },
  'deadline-reached': { headline: 'The analysis ran out of time, so nothing from this run is shown.', next: 'Analyze again when other work has finished, or analyze smaller tables.' },
  'budget-exhausted': { headline: 'Some checks would have built more row pairs than the analysis allows, so they were skipped.', next: 'Analyze smaller tables for a complete result. The limits stay in place.' },
};

function incompleteAnswer(report: VerdictReport, p: Presentation): Answer {
  const f = report.findings.find((x) => x.category === 'inconclusive' || x.category === 'diagnostic-failure');
  const code = f?.code ?? '';
  const known = INCOMPLETE[code];
  const failed = report.status === 'diagnostic-failed';
  const headline = failed ? 'One of Verdict’s checks failed to run, so nothing from this run is shown.' : (known?.headline ?? 'The analysis could not finish, so nothing from this run is shown.');
  return {
    kind: `${report.status}:${code || 'unknown'}`, tone: 'neutral', headline,
    meaning: [failed ? 'A failed check says nothing about whether your query works; Run SQL is unaffected.' : 'Your Run SQL result is unaffected.'],
    next: [failed ? 'Analyze again.' : (known?.next ?? 'Analyze again.')], effects: [], also: [], measured: false, healthy: false, presentation: p,
  };
}

function interruptedAnswer(report: VerdictReport, p: Presentation): Answer {
  const cancelled = report.status === 'cancelled';
  return {
    kind: report.status, tone: 'neutral',
    headline: cancelled ? 'Analysis cancelled. No results from this run are shown.' : 'The engine or the data changed while Verdict was working, so no results from this run are shown.',
    meaning: ['Your Run SQL result is unaffected.'], next: ['Analyze again when you are ready.'], effects: [], also: [], measured: false, healthy: false, presentation: p,
  };
}

// ---------------------------------------------------------------------------------------------
// Complete analyses: what the join did to the rows.

/** What happened to the rows of one input table (P-106 "row fate"): exact counts from the report. */
export interface RowFate {
  readonly table: string;
  readonly side: 'left' | 'right';
  readonly rows: string;
  /** In the result exactly once. */
  readonly once: string;
  /** In the result more than once, and the extra rows that adds. */
  readonly multiple: string;
  readonly extra: string;
  /** Not in the result (no match, INNER JOIN; or the right side of a LEFT JOIN). */
  readonly missing: string;
  /** No match but kept once with empty columns of the other table (left side of a LEFT JOIN). */
  readonly kept: string;
}

const sub = (a: string, b: string) => String(BigInt(a) - BigInt(b));
const plural = (n: string, one: string, many: string) => `${count(n)} ${is1(n) ? one : many}`;

/** "order_id 7008 (3 rows) and 7001 (2 rows)" — sample keys from the report's witnesses, with counts. */
function keyList(join: JoinEvidence, pick: (w: Witness) => boolean, n: (w: Witness) => string | null, side: 'left' | 'right'): string | null {
  const ws = join.witnesses.filter(pick);
  if (!ws.length) return null;
  const col = join.keys.map((k) => (side === 'left' ? k.left : k.right)).join(', ');
  const item = (w: Witness) => {
    const key = w.key.length === 1 ? (w.key[0] as string) : `(${w.key.join(', ')})`;
    const c = n(w);
    return c ? `${key} (${plural(c, 'row', 'rows')})` : key;
  };
  const items = ws.map(item);
  const list = items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  return `${join.keys.length > 1 ? `(${col})` : col} ${list}${ws.length >= 5 ? ' and possibly more' : ''}`;
}

/**
 * A complete analysis, told from the point of view of the FROM (left) table: did each of its rows
 * end up in the result exactly once? Then why (with sample keys), what it means for totals, and
 * what to do. The other table's rows are reported too, with the LEFT JOIN design made explicit.
 */
function measuredAnswer(report: VerdictReport, p: Presentation): Answer {
  const join = report.join as JoinEvidence;
  const s = join.stats!;
  const d = join.derived!;
  const L = join.left.name;
  const R = join.right.name;
  const left = join.type === 'LEFT';
  const out = d.outputRows;
  const fate = (side: 'left' | 'right'): RowFate => {
    const lt = side === 'left';
    const matched = lt ? s.leftRowsMatched : s.rightRowsMatched;
    const multiple = lt ? s.leftRowsMultiplied : s.rightRowsMultiplied;
    return {
      table: lt ? L : R, side, rows: lt ? s.leftRows : s.rightRows, once: sub(matched, multiple), multiple,
      extra: lt ? s.leftExcessCopies : s.rightExcessCopies,
      missing: lt ? d.leftRowsDropped : d.rightRowsDropped,
      kept: lt ? d.leftRowsPreserved : '0',
    };
  };
  const fl = fate('left');
  const fr = fate('right');
  const rowsWord = (n: string, t: string) => `${count(n)} ${t} ${is1(n) ? 'row' : 'rows'}`;

  // Why: sample keys, from the witnesses.
  const why: string[] = [];
  const fanKeysL = keyList(join, (w) => w.kind === 'fan-out' && w.rightRows !== '1', (w) => w.rightRows, 'right');
  const fanKeysR = keyList(join, (w) => w.kind === 'fan-out' && w.leftRows !== '1', (w) => w.leftRows, 'left');
  const lostKeysL = keyList(join, (w) => w.kind === 'unmatched-left', () => null, 'left');
  const lostKeysR = keyList(join, (w) => w.kind === 'unmatched-right', () => null, 'right');
  if (pos(fl.multiple)) why.push(`${R} has several rows for ${fanKeysL ?? 'some keys'}, so the matching ${L} rows repeat.`);
  if (pos(fr.multiple)) why.push(`${L} has several rows for ${fanKeysR ?? 'some keys'}, so the matching ${R} rows repeat.`);
  const leftNoMatch = pos(fl.missing) ? fl.missing : fl.kept;
  if (pos(leftNoMatch)) {
    const nulls = s.leftNullKeyRows;
    const keyed = sub(leftNoMatch, nulls);
    why.push(`${plural(leftNoMatch, `${L} row has`, `${L} rows have`)} no matching ${R} row${pos(keyed) && lostKeysL ? ` (${lostKeysL})` : ''}${pos(nulls) ? `; ${count(nulls)} of them ${is1(nulls) ? 'has' : 'have'} an empty (NULL) key, which never matches` : ''}.`);
  }
  if (pos(fr.missing)) {
    const nulls = s.rightNullKeyRows;
    why.push(`${plural(fr.missing, `${R} row has`, `${R} rows have`)} no matching ${L} row${lostKeysR ? ` (${lostKeysR})` : ''}${pos(nulls) ? `; ${count(nulls)} with an empty (NULL) key` : ''}${left ? ` and ${is1(fr.missing) ? 'is' : 'are'} not in the result. That is how a LEFT JOIN from ${L} works.` : ` and ${is1(fr.missing) ? 'is' : 'are'} not in the result.`}`);
  }

  // Headline: the FROM table's rows, then the result size.
  const effL: string[] = [];
  if (pos(fl.multiple)) effL.push(`${plural(fl.multiple, `${L} row appears`, `${L} rows appear`)} more than once (${plural(fl.extra, 'extra row', 'extra rows')})`);
  if (pos(fl.missing)) effL.push(`${plural(fl.missing, `${L} row is`, `${L} rows are`)} missing (no matching ${R} row)`);
  if (pos(fl.kept)) effL.push(`${plural(fl.kept, `${L} row has`, `${L} rows have`)} no matching ${R} row and ${is1(fl.kept) ? 'is' : 'are'} kept with empty ${R} columns`);
  let headline: string;
  if (s.leftRows === '0' || s.rightRows === '0') {
    headline = s.leftRows === '0' && s.rightRows === '0' ? 'Both tables are empty, so the result has no rows.'
      : s.leftRows === '0' ? `${L} is empty, so the result has no rows.`
      : left ? `${R} is empty, so every ${L} row is kept once with empty ${R} columns.` : `${R} is empty, so nothing matches and the result has no rows.`;
  } else if (s.leftKeyedRows === '0' || s.rightKeyedRows === '0') {
    const t = s.leftKeyedRows === '0' ? L : R;
    headline = `Every ${t} row has an empty (NULL) key, so no row can match${left ? `; the result keeps each ${L} row once with empty ${R} columns.` : ' and the result has no rows.'}`;
  } else if (s.matchedPairs === '0') {
    headline = `No ${L} row matched any ${R} row${left ? `, so each ${L} row is kept once with empty ${R} columns.` : ', so the result has no rows.'}`;
  } else if (!effL.length) {
    headline = pos(fr.multiple)
      ? `Each ${L} row appears exactly once in the result (${rowsWord(out, 'result')}); ${plural(fr.multiple, `${R} row is`, `${R} rows are`)} shared by several ${L} rows.`
      : pos(fr.missing)
        ? `Each ${L} row appears exactly once in the result (${rowsWord(out, 'result')}).`
        : `Each row appears exactly once: ${rowsWord(s.leftRows, L)} and ${rowsWord(s.rightRows, R)} give ${rowsWord(out, 'result')}.`;
  } else if (out === s.leftRows && pos(fl.multiple) && (pos(fl.missing) || pos(fl.kept))) {
    headline = `The result has ${count(out)} rows from ${count(s.leftRows)} ${L} rows: the same count, but different rows — ${effL.join('; ')}.`;
  } else {
    headline = `The result has ${count(out)} ${is1(out) ? 'row' : 'rows'} from ${count(s.leftRows)} ${L} ${is1(s.leftRows) ? 'row' : 'rows'}: ${effL.join('; ')}.`;
  }

  // What it means.
  const meaning: string[] = [];
  const violated = report.expectations.filter((o) => o.outcome === 'violated');
  const held = report.expectations.filter((o) => o.outcome === 'held');
  const unchecked = report.expectations.filter((o) => o.outcome === 'unchecked');
  if (violated.length) meaning.push(violated.map((o) => `Your rule “${describeExpectation(o.expectation)}” is broken: ${outcomeSentence(o, join).replace(/^Violated: /, '')}`).join(' '));
  if (pos(fl.multiple)) meaning.push(`Totals over ${L} columns (a SUM or COUNT on this result) count those ${L} rows more than once.`);
  if (pos(fr.multiple) && !pos(fl.multiple)) meaning.push(`Totals over ${R} columns count the shared ${R} rows once per matching ${L} row.`);
  if (pos(fl.missing)) meaning.push(`The missing ${L} rows are absent from every total computed from this result.`);
  if (held.length && !violated.length && !unchecked.length) meaning.push(`Your ${held.length === 1 ? 'rule held' : `${held.length} rules held`} on this data.`);
  if (unchecked.length) meaning.push(`${unchecked.length} ${unchecked.length === 1 ? 'rule was' : 'rules were'} not checked (see Expectations).`);
  if (p === 'limited') {
    meaning.unshift(report.status === 'budget-exhausted'
      ? 'Limited evidence: some checks were skipped because of the analysis limits, so these measurements are not fully confirmed and rules are not evaluated.'
      : `Limited evidence: the measurements are valid, but the result is not authoritative because ${unchecked.length ? `${unchecked.length === 1 ? 'a rule' : 'some rules'} could not be checked` : 'not every check completed'}.`);
  }

  // What to do next (at most two), concrete and conditional.
  const rightKey = join.keys.map((k) => k.right).join(', ');
  const next: string[] = [];
  if (report.status === 'budget-exhausted') next.push('Analyze smaller tables for a complete result. The limits stay in place.');
  if (pos(fl.multiple)) next.push(`If you need one row per ${L} row: reduce ${R} to one row per ${rightKey} before joining (for example GROUP BY ${rightKey} with SUM or MAX), then join.`);
  if (pos(fl.missing) && !left) next.push(`If every ${L} row should stay: use LEFT JOIN, which keeps unmatched ${L} rows with empty ${R} columns.`);
  if (violated.length) next.push('The sample keys under Witnesses show exactly which rows break the rule.');
  const declared = report.expectations.length > 0;
  if (!declared && !next.length && pos(fl.kept)) next.push(`To be told if a ${L} row is ever lost, add the rule “No row loss · Left input”.`);
  if (!declared && !next.length && !pos(fl.multiple) && !pos(fl.missing) && !pos(fl.kept)) next.push(`To keep checking that each ${L} row appears once, add the rule “No fan-out · Left input” and analyze after data changes.`);

  const suspicious = report.findings.some((f) => f.category === 'suspicious');
  // Tones follow the core's categories: a violation, a suspicious pattern (warning), otherwise informational.
  const tone: Tone = p !== 'definitive' ? 'neutral' : violated.length ? 'violation' : suspicious ? 'warning' : 'info';
  const healthy = p === 'definitive' && !violated.length && !suspicious && !pos(d.leftRowsDropped) && !pos(d.rightRowsDropped);
  if (healthy) meaning.push('No issues found in these checks. This covers only what Verdict checks (see Details); it does not show that the query is correct.');
  const kind = !effL.length && !pos(fr.multiple) && !pos(fr.missing) ? 'measured:clean' : `measured:${[pos(fl.multiple) && 'fan-out', pos(fl.missing) && 'loss', pos(fl.kept) && 'kept', pos(fr.multiple) && 'shared', pos(fr.missing) && 'right-unmatched'].filter(Boolean).join('+') || 'other'}`;
  return { kind, tone, headline, meaning: meaning.slice(0, 3), next: next.slice(0, 2), effects: why, also: [], measured: true, healthy, presentation: p, fate: [fl, fr] };
}

// ---------------------------------------------------------------------------------------------

/** The answer for a report as currently shown (P-106). Historical reports keep their earlier answer, labelled. */
export function answerFor(report: VerdictReport, current: boolean, historicalReason?: string): Answer {
  const p = presentation(report, current);
  const base =
    (report.status === 'analyzed' || report.status === 'partially-analyzed' || report.status === 'budget-exhausted') && report.join?.stats && report.join.derived ? measuredAnswer(report, p)
    : report.status === 'unsupported' ? unsupportedAnswer(report, p)
    : report.status === 'query-failed' ? queryFailedAnswer(report, p)
    : report.status === 'cancelled' || report.status === 'stale' ? interruptedAnswer(report, p)
    : incompleteAnswer(report, p);
  if (p !== 'historical') return base;
  return {
    ...base,
    kind: `historical:${base.kind}`,
    tone: 'neutral',
    headline: `Historical: ${historicalText(historicalReason).replace(/\.$/, '')}.`,
    meaning: [`Earlier result: ${base.headline}`, 'It describes an earlier state and is not current.'],
    next: ['Analyze again for current evidence.'],
    healthy: false,
  };
}

/** The status-region sentence when an analysis settles: the headline, prefixed for limited evidence. */
export function announcementFor(report: VerdictReport, view: { report: VerdictReport | null; current: boolean; historicalReason?: string }): string {
  const shown = view.report?.id === report.id;
  if (!shown) return 'Analysis finished; its report is not the one shown.';
  const a = answerFor(report, view.current, view.historicalReason);
  if (a.presentation === 'historical') return `Analysis finished, but its report is already historical (${view.historicalReason ?? 'the workspace changed'}). Analyze again for current evidence.`;
  return `Verdict: ${a.headline}${a.presentation === 'limited' && a.measured ? ' Limited evidence: not authoritative.' : ''}`;
}
