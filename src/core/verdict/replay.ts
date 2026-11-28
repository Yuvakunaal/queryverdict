// Replay bundle (ARCHITECTURE §18.2; SPEC_AMENDMENTS AM-019; IMPLEMENTATION_PLAN M12). A curated,
// version-stamped diagnostic script that reproduces the labelled counts of ONE validated report on
// a matching snapshot of its two input tables. It is NOT the analyser's statement log:
//
// - no key-multiset fingerprints (`hash()` output is not guaranteed stable across DuckDB versions),
// - no catalog probes (relation and column resolution, table identities, memory settings),
// - no transaction control (the analyser ran inside a transaction it always rolled back),
// - no parse, render or bind statements, and no `/*qv:…*/` probe tags,
// - stable, quoted temporary-table names chosen so they never equal an input table or alias.
//
// Every expected value is copied from the report's own validated evidence (stats, derived values,
// witnesses); nothing is recomputed from the live workspace. The SEMI JOIN, executed-count and
// witness-join statements are the exact SQL the engine rendered from the query's own parse tree
// during the analysis. Building a bundle is pure; it never runs anything. Whether a report may
// carry one is decided at publication (report.ts): only an authoritative report does.
import { frequencySql, keyLiteral, matchedSelect, quoteIdent, statisticExpressions, witnessCtes, witnessSelectionSql, WITNESS_LEFT, WITNESS_RIGHT, type SideSql } from './probes';
import { STAT_FIELDS } from './stats';
import type { JoinEvidence, JoinStats, ReplayBundle, ReplayStatement, Witness, WitnessKind } from './types';

export interface ReplaySide {
  /** Catalog name of the table (resolved unambiguously by the analysis). */
  readonly relation: string;
  /** The query's reference to it (alias, or the name). */
  readonly ref: string;
  readonly temporary: boolean;
}

export interface ReplayInput {
  /** The session's boot information for the generation the analysis ran on; null if unknown. */
  readonly engine: { readonly duckdb: string; readonly package: string } | null;
  readonly join: JoinEvidence;
  readonly left: ReplaySide;
  readonly right: ReplaySide;
  /** Engine-rendered statements from the analysis (exact text it sent, without probe tags). */
  readonly rendered: {
    readonly semiLeft: string;
    readonly semiRight: string;
    /** The executed count of the join; null when it did not run (no replay is built then). */
    readonly executed: string | null;
    /** The join count over the witness CTEs; null when there are no witnesses. */
    readonly witnessJoin: string | null;
  };
}

export type ReplayOutcome = { readonly ok: true; readonly bundle: ReplayBundle } | { readonly ok: false; readonly reason: string };

/** Plain-language labels of the 18 frequency-derived statistics, in statisticExpressions order. */
const STAT_LABELS: Readonly<Partial<Record<keyof JoinStats, string>>> = {
  leftKeyedRows: 'Left rows with a non-NULL key (sum of key frequencies)',
  rightKeyedRows: 'Right rows with a non-NULL key (sum of key frequencies)',
  leftDistinctKeys: 'Distinct non-NULL keys on the left',
  rightDistinctKeys: 'Distinct non-NULL keys on the right',
  leftDuplicateKeys: 'Left keys that occur more than once',
  rightDuplicateKeys: 'Right keys that occur more than once',
  leftMaxMultiplicity: 'Most left rows sharing one key',
  rightMaxMultiplicity: 'Most right rows sharing one key',
  leftMaxMultiplicityMatched: 'Most left rows sharing one matched key',
  rightMaxMultiplicityMatched: 'Most right rows sharing one matched key',
  matchedKeys: 'Keys present on both sides',
  matchedPairs: 'Matched row pairs (sum of L(k) × R(k))',
  leftRowsMatched: 'Left rows with at least one match (from frequencies)',
  rightRowsMatched: 'Right rows with at least one match (from frequencies)',
  leftRowsMultiplied: 'Left rows that match more than one right row',
  leftExcessCopies: 'Extra copies of left rows in the output',
  rightRowsMultiplied: 'Right rows that match more than one left row',
  rightExcessCopies: 'Extra copies of right rows in the output',
};

const WITNESS_LABEL: Record<WitnessKind, string> = {
  'fan-out': 'Fan-out witness keys (at most five): key…, left rows, right rows',
  'unmatched-left': 'Unmatched left witness keys (at most five): key…, left rows, right rows',
  'unmatched-right': 'Unmatched right witness keys (at most five): key…, left rows, right rows',
};

export const REPLAY_TABLE_BASES = { left: 'qv_replay_left_freq', right: 'qv_replay_right_freq', matched: 'qv_replay_matched' } as const;

/**
 * Largest script offered for preview and copy (characters). The script repeats engine-rendered
 * SQL (SEMI JOIN, executed count, witness recounts), so a very long query makes a long script; a
 * script over this size is not offered at all, rather than shown or copied in part (M12, Codex).
 */
export const MAX_REPLAY_SCRIPT_CHARS = 1_000_000;

/**
 * Stable temporary names: the base name, or the first `_2`, `_3`, … suffix that equals no input
 * table name or query alias (DuckDB compares identifiers case-insensitively).
 */
export function replayTableNames(taken: readonly string[]): { left: string; right: string; matched: string } {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  const pick = (base: string) => {
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}_${i}`;
    used.add(name.toLowerCase());
    return name;
  };
  return { left: pick(REPLAY_TABLE_BASES.left), right: pick(REPLAY_TABLE_BASES.right), matched: pick(REPLAY_TABLE_BASES.matched) };
}

const stripSemicolon = (sql: string) => sql.trim().replace(/;\s*$/, '');

/** Builds the bundle from one report's validated evidence, or says why it cannot. Pure. */
export function buildReplay(input: ReplayInput): ReplayOutcome {
  const { join, left, right, rendered } = input;
  if (!input.engine || !input.engine.duckdb || !input.engine.package) return { ok: false, reason: 'the engine version of the analysis is not known, so a version-stamped replay cannot be written' };
  if (!join.stats || !join.derived) return { ok: false, reason: 'the report holds no validated measurements to reproduce' };
  const v = join.validation;
  if (v.invariants !== 'held' || v.semiJoin !== 'agreed' || v.executedCount !== 'agreed' || v.snapshot !== 'verified' || (join.witnesses.length > 0 && v.witnesses !== 'verified')) {
    return { ok: false, reason: 'not every validation check of the report ran and agreed, so its values are not reproducible evidence' };
  }
  if (rendered.executed === null) return { ok: false, reason: 'the executed count did not run in the analysis' };
  const stats = join.stats;
  const derived = join.derived;
  const n = join.keys.length;
  const taken = [left.relation, right.relation, left.ref, right.ref];
  const names = replayTableNames(taken);
  const lf = quoteIdent(names.left);
  const rf = quoteIdent(names.right);
  const mt = quoteIdent(names.matched);
  const L: SideSql = { table: quoteIdent(left.relation), keys: join.keys.map((k) => quoteIdent(k.left)), types: join.keys.map((k) => k.type) };
  const R: SideSql = { table: quoteIdent(right.relation), keys: join.keys.map((k) => quoteIdent(k.right)), types: join.keys.map((k) => k.type) };
  const limitations: string[] = [
    'The script does not check that the tables hold the analysed snapshot. The analyser compared key-multiset fingerprints at the start and the end, but they use hash(), whose output is not guaranteed stable across DuckDB versions, so they are left out. Different data gives different results.',
    'Catalog lookups, the bind check and transaction control the analyser ran are left out. The analyser ran every probe inside one transaction it rolled back; this script runs in whatever transaction mode your session uses.',
    'Derived values are arithmetic on the statements here: unmatched rows = rows − rows with a match; INNER output = matched pairs; LEFT output = matched pairs + unmatched left rows.',
    'The expected values reproduce measurements of the analysed snapshot. They do not show that the query expresses the intended business logic.',
  ];

  const s: ReplayStatement[] = [];
  const add = (label: string, sql: string, expect?: string, measures?: string) => s.push({ label, sql: stripSemicolon(sql), ...(expect !== undefined ? { expect } : {}), ...(measures ? { measures } : {}) });
  const anyNull = (x: SideSql) => x.keys.map((k) => `${k} IS NULL`).join(' OR ');

  // Input rows and NULL-key rows (plain counts; the analyser read these with its fingerprints).
  add('Rows in the left table', `SELECT count(*)::VARCHAR FROM ${L.table}`, stats.leftRows, 'stats.leftRows');
  add('Left rows with a NULL key component (they can never match)', `SELECT count(*)::VARCHAR FROM ${L.table} WHERE ${anyNull(L)}`, stats.leftNullKeyRows, 'stats.leftNullKeyRows');
  add('Rows in the right table', `SELECT count(*)::VARCHAR FROM ${R.table}`, stats.rightRows, 'stats.rightRows');
  add('Right rows with a NULL key component (they can never match)', `SELECT count(*)::VARCHAR FROM ${R.table} WHERE ${anyNull(R)}`, stats.rightNullKeyRows, 'stats.rightNullKeyRows');

  // Key frequencies: the same statements the analyser ran, under stable names.
  add(`Setup: key frequencies of the left table, into temporary table ${lf}`, frequencySql(lf, L));
  add(`Setup: key frequencies of the right table, into temporary table ${rf}`, frequencySql(rf, R));

  // The 18 frequency-derived statistics, one labelled statement each.
  // The matched keys are computed once (the analyser's MATERIALIZED CTE `m`, as a table).
  add(`Setup: matched keys with their left and right row counts, into temporary table ${mt}`, `CREATE TEMP TABLE ${mt} AS ${matchedSelect(lf, rf, n)}`);
  const exprs = statisticExpressions(lf, rf, mt);
  STAT_FIELDS.slice(4).forEach((field, i) => {
    const e = exprs[i];
    if (!e) return;
    const sql = `SELECT (${e.sql})::VARCHAR`;
    add(STAT_LABELS[field] ?? field, sql, stats[field], `stats.${field}`);
  });

  // The join's own matching, rendered by the engine from the query's parse tree.
  add('Left rows matched by the query\'s own join condition (SEMI JOIN)', rendered.semiLeft, stats.leftRowsMatched, 'stats.leftRowsMatched');
  add('Right rows matched by the query\'s own join condition (SEMI JOIN)', rendered.semiRight, stats.rightRowsMatched, 'stats.rightRowsMatched');
  add(`Output rows of the ${join.type} JOIN (an executed count of the join; the SELECT list is not evaluated)`, rendered.executed, derived.outputRows, 'derived.outputRows');

  // Witnesses: selection from the frequency tables, then each key re-counted.
  const byKind = (k: WitnessKind) => join.witnesses.filter((w) => w.kind === k);
  const rowsText = (ws: readonly Witness[]) => (ws.length ? ws.map((w) => [...w.key, w.leftRows, w.rightRows].join(', ')).join('; ') : '(no rows)');
  for (const kind of ['fan-out', 'unmatched-left', 'unmatched-right'] as const) {
    add(WITNESS_LABEL[kind], witnessSelectionSql(kind, lf, rf, n), rowsText(byKind(kind)), `witnesses.${kind}`);
  }
  const cteTaken = taken.some((t) => [WITNESS_LEFT, WITNESS_RIGHT].includes(t.toLowerCase()));
  if (join.witnesses.length && cteTaken) {
    limitations.push(`Witness recounts through the join are left out: an input table or alias is named ${WITNESS_LEFT} or ${WITNESS_RIGHT}, the names the recount uses for its key-filtered inputs.`);
  } else if (join.witnesses.length && rendered.witnessJoin === null) {
    limitations.push('Witness recounts through the join are left out: the analysis did not record the rendered recount statement.');
  }
  join.witnesses.forEach((w, i) => {
    const keyText = w.key.join(', ');
    const match = (x: SideSql) => x.keys.map((k, j) => `${k} = ${keyLiteral(w.key[j] as string, x.types[j] as string)}`).join(' AND ');
    add(`Witness ${i + 1} (${w.kind}, key ${keyText}): rows in the left table with this key`, `SELECT count(*)::VARCHAR FROM ${L.table} WHERE ${match(L)}`, w.leftRows, `witnesses[${i}].leftRows`);
    add(`Witness ${i + 1} (${w.kind}, key ${keyText}): rows in the right table with this key`, `SELECT count(*)::VARCHAR FROM ${R.table} WHERE ${match(R)}`, w.rightRows, `witnesses[${i}].rightRows`);
    if (!cteTaken && rendered.witnessJoin !== null) {
      add(`Witness ${i + 1} (${w.kind}, key ${keyText}): output rows of the query's join restricted to this key`, witnessCtes(L, R, w.key) + stripSemicolon(rendered.witnessJoin), w.outputRows, `witnesses[${i}].outputRows`);
    }
  });

  const keyCols = (side: 'left' | 'right') => join.keys.map((k) => `${quoteIdent(side === 'left' ? k.left : k.right)} ${k.type}`).join(', ');
  const tableLine = (side: ReplaySide, which: 'left' | 'right') => {
    const rows = which === 'left' ? stats.leftRows : stats.rightRows;
    const nulls = which === 'left' ? stats.leftNullKeyRows : stats.rightNullKeyRows;
    const alias = side.ref.toLowerCase() !== side.relation.toLowerCase() ? `, referenced as ${quoteIdent(side.ref)}` : '';
    return `${which === 'left' ? 'Left' : 'Right'} table ${quoteIdent(side.relation)}${alias}: key column(s) ${keyCols(which)}; the analysed snapshot had ${rows} rows, ${nulls} of them with a NULL key component.${side.temporary ? ' It was a temporary table.' : ''}`;
  };
  const prerequisites = [
    `Dialect: DuckDB SQL. Written for DuckDB ${input.engine.duckdb} (duckdb-wasm ${input.engine.package}), the engine the analysis ran on; other versions may render or evaluate statements differently.`,
    tableLine(left, 'left'),
    tableLine(right, 'right'),
    'Each table name must resolve to exactly one table, and the tables must hold exactly the analysed rows (same key values and counts). Only the key columns are read.',
    `The script creates the temporary tables ${lf}, ${rf} and ${mt}. Run it in a fresh session and stop at the first error: CREATE TEMP TABLE fails if a temporary table of that name already exists, and the later statements would then read that table, so their results mean nothing. It drops nothing and changes no other table; the temporary tables disappear when the session ends.`,
    `Running outside QueryVerdict: your DuckDB client applies none of QueryVerdict's time limits, cancellation, memory or row budgets. The executed count runs the join itself (${derived.outputRows} output rows in the analysis), each witness recount runs it again restricted to one key, and the setup statements group both tables by key. On a large table these can take long and use much memory.`,
  ].join('\n');

  return { ok: true, bundle: { engine: { duckdb: input.engine.duckdb, package: input.engine.package }, prerequisites, statements: s, temporaryTables: [names.left, names.right, names.matched], limitations } };
}

/** One line comment per line of text, so no text can end the comment early. */
function comment(text: string, prefix = '-- '): string {
  return text.split(/\r\n|[\r\n\u2028\u2029]/).map((l) => `${prefix}${l}`.trimEnd()).join('\n');
}

export interface ReplayLabel {
  /** Null while the report is current; otherwise why it is historical. */
  readonly historical: string | null;
  /** When the report was finalised, as shown in the app. */
  readonly finalised: string;
}

/** The copyable script: header (state, engine, prerequisites, limitations) and labelled statements. */
export function replayScript(bundle: ReplayBundle, label: ReplayLabel): string {
  const out: string[] = [
    '-- QueryVerdict diagnostic replay (a curated script, not the analyser\'s statement log)',
    label.historical
      ? comment(`HISTORICAL REPORT (${label.historical}). The expected values describe the snapshot analysed at ${label.finalised}, not the current workspace.`)
      : comment(`Current report, finalised at ${label.finalised}. The expected values describe the analysed snapshot.`),
    comment(`Engine: DuckDB ${bundle.engine.duckdb} · duckdb-wasm ${bundle.engine.package}`),
    '--',
    '-- Prerequisites:',
    comment(bundle.prerequisites, '--   '),
    '--',
    '-- Limitations:',
    ...bundle.limitations.map((l) => comment(l, '--   ')),
    '--',
    '-- Each statement is numbered and labelled. "expect" is the value in the report; compare it with the result.',
  ];
  bundle.statements.forEach((st, i) => {
    out.push('', comment(`[${i + 1}] ${st.label}`));
    if (st.expect !== undefined) out.push(comment(`expect: ${st.expect}`));
    out.push(`${st.sql};`);
  });
  return `${out.join('\n')}\n`;
}
