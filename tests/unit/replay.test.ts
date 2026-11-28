// M12 replay bundle and copy summary (ARCHITECTURE §18.2; AM-019; PRD QV-UI-003): the bundle is
// built from a report's validated evidence only, version-stamped from the given engine info, with
// stable collision-free names and none of the excluded statement kinds; the fence never attaches
// it to a non-authoritative report; the script's header cannot be broken out of; the default
// summary carries no SQL, identifiers, witness values, ids or free text (including indirectly,
// through finding messages, evidence or reasons). Execution of bundles is verified in
// tests/e2e/copy.spec.ts against the real engine.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { finding } from '../../src/core/verdict/findings';
import { REPLAY_NOT_AUTHORITATIVE } from '../../src/core/verdict/report';
import { buildReplay, MAX_REPLAY_SCRIPT_CHARS, REPLAY_TABLE_BASES, replayScript, replayTableNames, type ReplayInput } from '../../src/core/verdict/replay';
import { derive, exactDerived, exactStats } from '../../src/core/verdict/stats';
import type { JoinEvidence, JoinStats, VerdictReport, Witness } from '../../src/core/verdict/types';
import { CopyDialog } from '../../src/features/verdict/CopyDialog';
import { buildSummary, MAX_SUMMARY_SQL_CHARS } from '../../src/features/verdict/summary';
import { analyzedDraft, ctx, failedDraft, ILLUSTRATIVE, ILLUSTRATIVE_WITNESSES, NO_LEFT_FAN_OUT, report, unsupportedFinding, VALIDATED } from './verdict-ui/fixtures';

const ENGINE = { duckdb: 'v9.9.9-test', package: '0.0.0-test' }; // deliberately not the shipped versions
const BIG = '9007199254740993';
const RENDERED = { semiLeft: 'SELECT count_star() FROM orders AS o SEMI JOIN customers AS c ON ((o.customer_id = c.customer_id))', semiRight: 'SELECT count_star() FROM customers AS c SEMI JOIN orders AS o ON ((o.customer_id = c.customer_id))', executed: 'SELECT count_star() FROM orders AS o INNER JOIN customers AS c ON ((o.customer_id = c.customer_id));', witnessJoin: 'SELECT count_star() FROM __qv_wl AS o INNER JOIN __qv_wr AS c ON ((o.customer_id = c.customer_id))' };

function evidence(stats: JoinStats = ILLUSTRATIVE, witnesses: Witness[] = ILLUSTRATIVE_WITNESSES, over: Partial<JoinEvidence> = {}): JoinEvidence {
  return {
    type: 'INNER', left: { name: 'orders', ref: 'o' }, right: { name: 'customers', ref: 'c' }, keys: [{ left: 'customer_id', right: 'customer_id', type: 'INTEGER' }],
    stats: exactStats(stats), derived: exactDerived(derive('INNER', stats)), witnesses, validation: VALIDATED, ...over,
  };
}
function input(over: Partial<ReplayInput> = {}): ReplayInput {
  return { engine: ENGINE, join: evidence(), left: { relation: 'orders', ref: 'o', temporary: false }, right: { relation: 'customers', ref: 'c', temporary: false }, rendered: RENDERED, ...over };
}
const bundleOf = (over: Partial<ReplayInput> = {}) => {
  const r = buildReplay(input(over));
  if (!r.ok) throw new Error(r.reason);
  return r.bundle;
};

describe('buildReplay', () => {
  it('stamps the engine it is given (never a constant) and labels every measured value with the report\'s own number', () => {
    const b = bundleOf();
    expect(b.engine).toEqual(ENGINE);
    const by = (m: string) => b.statements.find((s) => s.measures === m)?.expect;
    expect(by('stats.leftRows')).toBe('8');
    expect(by('stats.leftNullKeyRows')).toBe('1');
    expect(by('stats.matchedPairs')).toBe('8');
    expect(by('stats.leftRowsMatched')).toBe('6');
    expect(by('derived.outputRows')).toBe('8');
    expect(by('witnesses.fan-out')).toBe('102, 1, 2; 105, 1, 2');
    expect(by('witnesses.unmatched-left')).toBe('107, 1, 0');
    expect(by('witnesses[0].outputRows')).toBe('2');
    // Every statistic of the report appears exactly once (SEMI JOIN re-measures the matched rows).
    const measured = b.statements.map((s) => s.measures).filter((m) => m?.startsWith('stats.'));
    expect(new Set(measured).size).toBe(22);
    for (const s of b.statements) if (s.expect !== undefined) expect(s.measures).toBeTruthy();
  });

  it('uses the engine-rendered statements verbatim (trailing semicolon removed) and stable, quoted temporary names', () => {
    const b = bundleOf();
    expect(b.statements.find((s) => s.measures === 'derived.outputRows')!.sql).toBe(RENDERED.executed.replace(/;$/, ''));
    expect(b.statements.find((s) => s.label.startsWith('Left rows matched'))!.sql).toBe(RENDERED.semiLeft);
    expect(b.temporaryTables).toEqual([REPLAY_TABLE_BASES.left, REPLAY_TABLE_BASES.right, REPLAY_TABLE_BASES.matched]);
    expect(b.statements[4]!.sql).toBe('CREATE TEMP TABLE "qv_replay_left_freq" AS SELECT "customer_id" AS k0, count(*)::HUGEINT AS c FROM "orders" WHERE "customer_id" IS NOT NULL GROUP BY ALL');
    expect(bundleOf()).toEqual(b); // deterministic
  });

  it('contains no fingerprint, catalog probe, transaction control, probe tag, random name or data change', () => {
    for (const s of bundleOf().statements) {
      expect(s.sql).not.toMatch(/\bhash\s*\(|bit_xor|duckdb_|information_schema|current_setting|\/\*qv:|__qv_[0-9a-f]{16}|\bDESCRIBE\b|json_(de)?serialize_sql/i);
      expect(s.sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START|ABORT|END)\b/i);
      expect(s.sql).not.toMatch(/\b(DROP|INSERT|UPDATE|DELETE|ALTER|TRUNCATE|COPY|ATTACH)\b|OR\s+REPLACE/i);
    }
  });

  it('keeps keys above 2^53 exact, as literals cast to the verified key type', () => {
    const w: Witness[] = [{ kind: 'unmatched-left', key: [BIG], leftRows: '1', rightRows: '0', outputRows: '0' }];
    const b = bundleOf({ join: evidence(ILLUSTRATIVE, w, { keys: [{ left: 'customer_id', right: 'customer_id', type: 'BIGINT' }] }) });
    expect(b.statements.find((s) => s.measures === 'witnesses.unmatched-left')!.expect).toBe(`${BIG}, 1, 0`);
    expect(b.statements.find((s) => s.measures === 'witnesses[0].leftRows')!.sql).toContain(`"customer_id" = CAST('${BIG}' AS BIGINT)`);
  });

  it('quotes identifiers safely, including quotes and line breaks', () => {
    const evil = 'ev"il\nDROP TABLE x; --';
    const b = bundleOf({ left: { relation: evil, ref: evil, temporary: true }, join: evidence(ILLUSTRATIVE, [], { keys: [{ left: 'k"ey', right: 'customer_id', type: 'INTEGER' }] }) });
    expect(b.statements[0]!.sql).toBe('SELECT count(*)::VARCHAR FROM "ev""il\nDROP TABLE x; --"');
    expect(b.statements[1]!.sql).toContain('"k""ey" IS NULL');
    // The script header comments every line, so no name can end a comment and start a statement.
    const script = replayScript(b, { historical: null, finalised: '12:00:00' });
    const statementLines = new Set(b.statements.flatMap((s) => `${s.sql};`.split('\n')));
    for (const line of script.split('\n')) if (line !== '' && !line.startsWith('--')) expect(statementLines.has(line), line).toBe(true);
  });

  it('chooses temporary names that equal no input table or alias, case-insensitively', () => {
    expect(replayTableNames(['orders', 'o'])).toEqual({ left: 'qv_replay_left_freq', right: 'qv_replay_right_freq', matched: 'qv_replay_matched' });
    expect(replayTableNames(['QV_REPLAY_LEFT_FREQ', 'qv_replay_left_freq_2', 'Qv_Replay_Right_Freq', 'QV_replay_matched'])).toEqual({ left: 'qv_replay_left_freq_3', right: 'qv_replay_right_freq_2', matched: 'qv_replay_matched_2' });
    const b = bundleOf({ left: { relation: 'qv_replay_left_freq', ref: 'QV_REPLAY_RIGHT_FREQ', temporary: false } });
    expect(b.temporaryTables).toEqual(['qv_replay_left_freq_2', 'qv_replay_right_freq_2', 'qv_replay_matched']);
  });

  it('leaves out the witness join recount (with a stated limitation) when an input is named like its CTEs', () => {
    const b = bundleOf({ right: { relation: '__QV_WR', ref: '__QV_WR', temporary: false } });
    expect(b.statements.some((s) => s.measures?.endsWith('.outputRows') && s.measures.startsWith('witnesses['))).toBe(false);
    expect(b.limitations.join(' ')).toMatch(/Witness recounts through the join are left out/);
  });

  it('computes the matched keys once, into one temporary table, instead of repeating the CTE (Codex M12)', () => {
    const b = bundleOf();
    expect(b.statements.filter((s) => /\bWITH m AS\b/.test(s.sql))).toEqual([]);
    const setup = b.statements.filter((s) => s.sql.startsWith('CREATE TEMP TABLE'));
    expect(setup.map((s) => s.sql.slice(0, 50))).toEqual(['CREATE TEMP TABLE "qv_replay_left_freq" AS SELECT ', 'CREATE TEMP TABLE "qv_replay_right_freq" AS SELECT', 'CREATE TEMP TABLE "qv_replay_matched" AS SELECT "q']);
    expect(setup[2]!.sql).toBe('CREATE TEMP TABLE "qv_replay_matched" AS SELECT "qv_replay_left_freq".c AS lc, "qv_replay_right_freq".c AS rc FROM "qv_replay_left_freq" JOIN "qv_replay_right_freq" ON "qv_replay_left_freq".k0 = "qv_replay_right_freq".k0');
    expect(b.statements.filter((s) => s.sql.includes('FROM "qv_replay_matched"'))).toHaveLength(10);
    expect(b.statements.find((s) => s.measures === 'stats.matchedPairs')!.sql).toBe('SELECT (SELECT coalesce(sum(lc * rc), 0) FROM "qv_replay_matched")::VARCHAR');
  });

  it('warns that an external client runs it without QueryVerdict\'s limits, and to stop at the first error (Codex M12)', () => {
    const p = bundleOf().prerequisites;
    expect(p).toMatch(/Run it in a fresh session and stop at the first error/);
    expect(p).toMatch(/applies none of QueryVerdict's time limits, cancellation, memory or row budgets/);
    expect(p).toMatch(/The executed count runs the join itself \(8 output rows in the analysis\)/);
  });

  it('states its limitations: no snapshot check (fingerprints left out), no catalog or transaction statements', () => {
    const text = bundleOf().limitations.join(' ');
    expect(text).toMatch(/does not check that the tables hold the analysed snapshot/);
    expect(text).toMatch(/hash\(\), whose output is not guaranteed stable across DuckDB versions/);
    expect(text).toMatch(/transaction/);
  });

  it.each<[string, Partial<ReplayInput>, RegExp]>([
    ['unknown engine version', { engine: null }, /engine version/],
    ['withdrawn measurements', { join: evidence(ILLUSTRATIVE, [], { stats: null, derived: null }) }, /no validated measurements/],
    ['a validation check that did not run', { join: evidence(ILLUSTRATIVE, [], { validation: { ...VALIDATED, executedCount: 'not-run' } }) }, /not every validation check/],
    ['witnesses not verified', { join: evidence(ILLUSTRATIVE, ILLUSTRATIVE_WITNESSES, { validation: { ...VALIDATED, witnesses: 'not-run' } }) }, /not every validation check/],
    ['no executed count', { rendered: { ...RENDERED, executed: null } }, /executed count did not run/],
  ])('refuses to build with %s, saying why', (_n, over, why) => {
    const r = buildReplay(input(over));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(why);
  });
});

describe('replayScript', () => {
  it('labels the report current or historical, the engine, prerequisites and every statement with its expected value', () => {
    const b = bundleOf();
    const cur = replayScript(b, { historical: null, finalised: '09:15:00' });
    expect(cur).toContain('-- Current report, finalised at 09:15:00.');
    expect(cur).toContain('-- Engine: DuckDB v9.9.9-test · duckdb-wasm 0.0.0-test');
    expect(cur).toContain('--   Dialect: DuckDB SQL. Written for DuckDB v9.9.9-test (duckdb-wasm 0.0.0-test)');
    expect(cur).toContain('--   Left table "orders", referenced as "o": key column(s) "customer_id" INTEGER; the analysed snapshot had 8 rows, 1 of them with a NULL key component.');
    b.statements.forEach((s, i) => {
      expect(cur).toContain(`-- [${i + 1}] ${s.label}\n${s.expect !== undefined ? `-- expect: ${s.expect}\n` : ''}${s.sql};\n`);
    });
    const hist = replayScript(b, { historical: 'the data may have changed', finalised: '09:15:00' });
    expect(hist).toContain('-- HISTORICAL REPORT (the data may have changed). The expected values describe the snapshot analysed at 09:15:00, not the current workspace.');
    expect(hist).not.toContain('Current report');
  });
});

describe('the publication fence attaches a replay only to an authoritative report', () => {
  const replay = buildReplay(input());
  it('keeps the replay of an authoritative report', () => {
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [], ILLUSTRATIVE_WITNESSES, { replay }));
    expect(r.authoritative).toBe(true);
    expect(r.replay).toEqual(replay.ok ? replay.bundle : null);
    expect(r.replayUnavailable).toBeUndefined();
  });
  it('drops it from a partially analysed report (never promoted), with the reason', () => {
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [{ kind: 'metric-preserved' }], ILLUSTRATIVE_WITNESSES, { replay }));
    expect(r.status).toBe('partially-analyzed');
    expect(r.replay).toBeNull();
    expect(r.replayUnavailable).toBe(REPLAY_NOT_AUTHORITATIVE);
  });
  it.each([
    ['cancelled', { cancelled: true }],
    ['data changed before publication', { session: { generation: 1 as never, epoch: 99 as never, state: { kind: 'ready' } as const } }],
  ])('drops it when %s', (_n, over) => {
    const b = analyzedDraft('INNER', ILLUSTRATIVE, [], ILLUSTRATIVE_WITNESSES, { replay });
    const r = report(b, over);
    expect(r.authoritative).toBe(false);
    expect(r.replay).toBeNull();
    expect(r.replayUnavailable).toBe(REPLAY_NOT_AUTHORITATIVE);
  });
  it('an authoritative report whose bundle could not be built says why', () => {
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [], [], { replay: buildReplay(input({ engine: null })) }));
    expect(r.authoritative).toBe(true);
    expect(r.replay).toBeNull();
    expect(r.replayUnavailable).toMatch(/^Diagnostic SQL is not available: the engine version/);
  });
});

// ---- Summary privacy ----------------------------------------------------------------------

const S = { table: 'zq_tbl', other: 'zq_other', col: 'zq_col', alias: 'zq_alias', key: '987654321987654321', sqlBit: 'zq_sql_comment', file: 'zq_file.csv', reason: 'zq_reason' };
function privateReport(unknownExpectation = false): VerdictReport {
  const w: Witness[] = [{ kind: 'fan-out', key: [S.key], leftRows: '1', rightRows: '2', outputRows: '2' }, ...ILLUSTRATIVE_WITNESSES.slice(1)];
  const b = analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT, { kind: 'row-count', min: 1, max: 100 }, ...(unknownExpectation ? [{ kind: S.reason, column: S.col }] : [])], w, {
    sqlText: `SELECT * /* ${S.sqlBit} */ FROM ${S.table} AS ${S.alias} JOIN ${S.other} ON ${S.alias}.${S.col} = ${S.other}.${S.col}`,
    inputs: [{ relation: S.table, database: 'memory', schema: 'main', oid: '777001', temporary: false, origin: 'imported' }, { relation: S.other, database: 'memory', schema: 'main', oid: '777002', temporary: false, origin: 'sql' }],
  });
  const join = { ...b.draft.join!, left: { name: S.table, ref: S.alias }, right: { name: S.other, ref: S.other }, keys: [{ left: S.col, right: S.col, type: 'BIGINT' }] };
  // Free text that quotes private values indirectly: a finding message, evidence, a reason.
  const findings = [...b.draft.findings, finding('unsupported', 'zq-unknown-code', `${S.table}.${S.col} from ${S.file} said ${S.reason}`, { file: S.file, key: S.key })];
  return report({ ...b, draft: { ...b.draft, join, findings, nonAuthoritativeReasons: [], replay: buildReplay(input({ join, left: { relation: S.table, ref: S.alias, temporary: false }, right: { relation: S.other, ref: S.other, temporary: false } })) } });
}
const ALL_SENTINELS = (r: VerdictReport) => [...Object.values(S), r.id, r.identity.queryHash, r.identity.queryHash.slice(0, 16), '777001', '777002', 'memory.main'];

describe('buildSummary privacy defaults', () => {
  it('leaves out SQL, identifiers, witness values, ids, hashes, file names and every free-text message by default', () => {
    const r = privateReport(true);
    expect(r.status).toBe('partially-analyzed');
    const text = buildSummary(r, { current: true });
    for (const s of ALL_SENTINELS(r)) expect(text, s).not.toContain(s);
    expect(text).not.toMatch(/anonym/i);
    expect(text).toContain('Report: current.');
    expect(text).toContain('INNER JOIN of the left table and the right table on 1 key column (BIGINT).');
    expect(text).toContain('- Output rows: 8.');
    expect(text).toContain('Unsupported: another finding (details are in the app).');
    expect(text).toContain('- 1. no left rows multiplied: violated.');
    expect(text).toContain('- 2. output rows between 1 and 100: held.');
    expect(text).toContain('- 3. an expectation of an unsupported kind: unchecked.');
    expect(text).toContain('- The measurements were validated; some expectations were not checked, so the report is not authoritative.');
    const authoritative = buildSummary(privateReport(), { current: true });
    for (const s of ALL_SENTINELS(privateReport())) expect(authoritative, s).not.toContain(s);
    expect(authoritative).toContain('Engine: DuckDB v9.9.9-test (duckdb-wasm 0.0.0-test), in this browser tab.');
    expect(text).toContain('Left out of this summary: the analysed SQL; table, alias and column names in the Join and Measured lines; the witness keys section. The counts and outcomes above describe the data.');
  });

  it('adds each private part only with its own option', () => {
    const r = privateReport();
    const sql = buildSummary(r, { current: true, includeSql: true });
    expect(sql).toContain(S.sqlBit);
    expect(sql).not.toContain(S.key);
    const ids = buildSummary(r, { current: true, includeIdentifiers: true });
    expect(ids).toContain(`"${S.table}" AS "${S.alias}" INNER JOIN "${S.other}" ON "${S.alias}"."${S.col}" = "${S.other}"."${S.col}"`);
    expect(ids).not.toContain(S.key);
    expect(ids).not.toContain(S.sqlBit);
    const wit = buildSummary(r, { current: true, includeWitnesses: true });
    expect(wit).toContain(`fan-out key (${S.key}): 1 left rows, 2 right rows, 2 output rows.`);
    expect(wit).not.toContain(S.table);
    // Even with every option, messages, evidence, reasons, file names and ids stay out.
    const all = buildSummary(r, { current: true, includeSql: true, includeIdentifiers: true, includeWitnesses: true });
    for (const s of [S.file, S.reason, r.id, r.identity.queryHash, '777001']) expect(all, s).not.toContain(s);
    expect(all).toContain('This summary includes the analysed SQL, table and column names and the witness keys section.');
    // SQL alone: the footer must not claim names or values are absent from the whole summary (Codex M12).
    expect(sql).toContain('Left out of this summary: table, alias and column names in the Join and Measured lines; the witness keys section. The analysed SQL is included as written, so it can contain table and column names and values even where other sections leave them out.');
    expect(sql).toContain('Analysed SQL (the query as written: it can contain table and column names and literal values):');
  });

  it('labels a historical report and its outcomes, and never echoes an unknown historical reason', () => {
    const r = privateReport();
    const text = buildSummary(r, { current: false, historicalReason: 'data may have changed' });
    expect(text).toContain('Report: historical — the data may have changed since this analysis.');
    expect(text).toContain('Authority: authoritative when it was produced, within the supported join-stage checks; now historical.');
    expect(text).toContain('Measured (exact counts, historical):');
    expect(text).toContain('- 1. no left rows multiplied: violated (historical).');
    expect(buildSummary(r, { current: false, historicalReason: S.reason })).not.toContain(S.reason);
  });

  it('a non-authoritative report says so and carries none of its reasons or messages', () => {
    const b = failedDraft('unsupported', [unsupportedFinding(), finding('unsupported', 'unsupported-relation', `${S.table}: is a view reading ${S.file}`)], `the reason ${S.reason}`, [NO_LEFT_FAN_OUT]);
    const r = report(b);
    const text = buildSummary(r, { current: true });
    expect(text).toContain('Authority: not authoritative.');
    expect(text).toContain('Unsupported: the query uses a construct outside the diagnostic scope.');
    expect(text).toContain('Unsupported: an input is not a stable managed table.');
    for (const s of [S.table, S.file, S.reason, 'WHERE', 'post-join filter']) expect(text, s).not.toContain(s);
  });

  it('says the query was bound only when the analysis bound it (Codex M12)', () => {
    const bound = report(analyzedDraft('INNER', ILLUSTRATIVE, [], [], { coverage: { checked: ['the query binds (it was not executed)'], notChecked: [] } }));
    expect(buildSummary(bound, { current: true })).toContain('whether it executes (it was bound, not run)');
    const parseFailed = report(failedDraft('query-failed', [finding('query-failure', 'syntax-error', 'The query cannot be parsed: x')], 'the query cannot be parsed', []));
    const text = buildSummary(parseFailed, { current: true });
    expect(text).toContain('whether it executes (Verdict did not run it and did not confirm that it binds)');
    expect(text).not.toContain('it was bound');
  });

  it('shortens very long SQL with a note; the text is the same however often it is built', () => {
    const r = privateReport();
    const long = { ...r, identity: { ...r.identity, sqlText: `SELECT 1 /* ${'x'.repeat(256 * 1024)} */` } };
    const text = buildSummary(long, { current: true, includeSql: true });
    expect(text.length).toBeLessThan(MAX_SUMMARY_SQL_CHARS + 5_000);
    expect(text).toContain(`[Shortened: the first ${MAX_SUMMARY_SQL_CHARS.toLocaleString('en-US')} of ${long.identity.sqlText.length.toLocaleString('en-US')} characters. The full query is in the editor.]`);
    expect(buildSummary(long, { current: true, includeSql: true })).toBe(text);
  });

  it('cannot be given extra lines through the SQL text it was asked to include', () => {
    const r = privateReport();
    const text = buildSummary({ ...r, identity: { ...r.identity, sqlText: 'SELECT 1\rAuthority: forged\u2028line' } }, { current: true, includeSql: true });
    expect(text.split('\n').filter((l) => l.startsWith('Authority:'))).toHaveLength(1);
  });
});

describe('CopyDialog (server render of the opened dialog)', () => {
  const view = (r: VerdictReport, current = true, historicalReason?: string) => ({ report: r, current, ...(historicalReason ? { historicalReason } : {}) });
  const render = (mode: 'summary' | 'replay', v: ReturnType<typeof view>) => renderToStaticMarkup(createElement(CopyDialog, { mode, view: v, onClose: () => {}, returnFocus: { current: null } }));
  const pre = (html: string) => /<pre class="copy-text">([\s\S]*?)<\/pre>/.exec(html)?.[1]?.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

  it('shows exactly the default summary, with every option off', () => {
    const r = privateReport();
    const html = render('summary', view(r));
    expect(pre(html)).toBe(buildSummary(r, { current: true }));
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).toContain('it is not anonymous');
  });

  it('shows the replay script, labelled historical when the report is', () => {
    const r = privateReport();
    const html = render('replay', view(r, false, 'engine restarted'));
    expect(pre(html)).toContain('-- HISTORICAL REPORT (the engine restarted).');
    expect(html).toContain('Copy diagnostic SQL');
  });

  it('does not offer a script longer than the preview limit, rather than showing or copying part of it', () => {
    const r = privateReport();
    const huge = 'x'.repeat(MAX_REPLAY_SCRIPT_CHARS);
    const big = { ...r, replay: { ...r.replay!, statements: [...r.replay!.statements, { label: 'big', sql: `SELECT '${huge}'` }] } };
    const html = render('replay', view(big));
    expect(html).toMatch(/over the 1,000,000-character limit for a preview/);
    expect(html).not.toContain('copy-text');
    expect(html).not.toContain('Copy diagnostic SQL');
  });

  it('explains why diagnostic SQL is unavailable and offers no Copy for a non-authoritative report', () => {
    const r = report(failedDraft('unsupported', [unsupportedFinding()], 'outside scope', []));
    const html = render('replay', view(r));
    expect(html).toContain('only for an authoritative report');
    expect(html).not.toContain('Copy diagnostic SQL');
    expect(html).not.toContain('copy-text');
  });

  it('builds with the real fixtures and their context helper', () => {
    expect(ctx(analyzedDraft('INNER', ILLUSTRATIVE, [])).terminal.status).toBe('ok');
  });
});
