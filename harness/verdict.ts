// TEST-ONLY Verdict harness (M08). Exposes the production VerdictService on a fault-injecting
// session, with the dataset registry and the report store wired as in the app, plus helpers to
// create tables from fixture rows and to read the independent statement trace recorded by the
// harness driver. Never part of the production artifact.
import { createDatasets, type Datasets } from '../src/core/datasets/registry';
import type { EngineSession } from '../src/core/engine/session';
import { DEFAULT_PROFILE, type ReleaseProfile } from '../src/core/profile/profile';
import { parseLossless, stringifyLossless } from '../src/core/util/lossless-json';
import { publish } from '../src/core/verdict/report';
import { createVerdict } from '../src/core/verdict/service';
import type { VerdictReport, VerdictService } from '../src/core/verdict/types';
import { createReportStore, type ReportStore } from '../src/stores/reportStore';
import { BOUNDS, faults, held, newSession, sql, statementLog } from './engine';

interface Ctx {
  session: EngineSession;
  datasets: Datasets;
  verdict: VerdictService;
  reports: ReportStore;
  profile: ReleaseProfile;
}
let ctx: Ctx | null = null;
const current = (): Ctx => {
  if (!ctx) throw new Error('call setup() first');
  return ctx;
};

export interface Overrides {
  executionPairRows?: string;
  maxInputRows?: string;
  groupingBytes?: string;
  maxKeyColumns?: number;
  verdictMs?: number;
}

async function setup(o: Overrides = {}): Promise<void> {
  ctx?.session.dispose();
  faults.hold = null;
  faults.injectBefore = null;
  faults.after = null;
  faults.ignoreCancel = false;
  const { session } = newSession({ faulty: true });
  await session.start();
  const v = DEFAULT_PROFILE.verdict;
  const profile: ReleaseProfile = {
    ...DEFAULT_PROFILE,
    bounds: { ...DEFAULT_PROFILE.bounds, ...(o.verdictMs ? { verdictMs: o.verdictMs } : {}) },
    verdict: {
      executionPairRows: o.executionPairRows ? BigInt(o.executionPairRows) : v.executionPairRows,
      maxInputRows: o.maxInputRows ? BigInt(o.maxInputRows) : v.maxInputRows,
      groupingBytes: o.groupingBytes ? BigInt(o.groupingBytes) : v.groupingBytes,
      maxKeyColumns: o.maxKeyColumns ?? v.maxKeyColumns,
    },
  };
  const datasets = createDatasets(session, profile);
  const reports = createReportStore(session);
  const origin = (id: { oid: string }) => datasets.registry.getSnapshot().find((e) => e.identity?.oid === id.oid)?.origin ?? 'unknown';
  ctx = { session, datasets, reports, profile, verdict: createVerdict({ session, profile, sink: reports, origin }) };
  statementLog.length = 0;
}

/** Runs statements as a user would (each its own operation); throws on the first failure. */
async function exec(...statements: string[]): Promise<void> {
  for (const q of statements) {
    const r = await sql(current().session, q, { maxRows: 10_000 });
    if (r.terminal.status !== 'ok') throw new Error(`${q}: ${JSON.stringify(r.terminal)}`);
  }
}

type Cell = string | number | null;
/** Creates a table from typed columns and rows (values as text or numbers; null is NULL). */
async function table(name: string, columns: readonly (readonly [string, string])[], rows: readonly (readonly Cell[])[]): Promise<void> {
  const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
  await exec(`CREATE OR REPLACE TABLE ${q(name)} (${columns.map(([c, t]) => `${q(c)} ${t}`).join(', ')})`);
  if (!rows.length) return;
  const lit = (v: Cell, t: string) => (v === null ? 'NULL' : `CAST('${String(v).replaceAll("'", "''")}' AS ${t})`);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await exec(`INSERT INTO ${q(name)} VALUES ${chunk.map((r) => `(${r.map((v, j) => lit(v, columns[j]![1])).join(', ')})`).join(', ')}`);
  }
}

/** Runs one analysis and returns the report and the statements the engine received meanwhile. */
async function analyze(text: string, expectations: unknown[] = []): Promise<{ report: VerdictReport; terminal: unknown; statements: string[] }> {
  const start = statementLog.length;
  const h = current().verdict.analyze(text, expectations);
  const r = await h.result;
  return { report: r.value!, terminal: r.terminal, statements: statementLog.slice(start) };
}

/** Starts an analysis without waiting (for interference and cancellation tests). */
function start(text: string, expectations: unknown[] = []) {
  const from = statementLog.length;
  const h = current().verdict.analyze(text, expectations);
  return { handle: h, done: h.result.then((r) => ({ report: r.value!, terminal: r.terminal, statements: statementLog.slice(from) })) };
}

/** Temporary analyser tables that survived an analysis (must always be none). */
async function leftovers(): Promise<string[]> {
  const r = await sql(current().session, "SELECT table_name::VARCHAR FROM duckdb_tables() WHERE table_name LIKE '\\_\\_qv\\_%' ESCAPE '\\'", { maxRows: 100 });
  return (r.rows ?? []).map((x) => x[0] ?? '');
}

/** Whether no transaction is left open: two txid reads differ only in auto-commit mode. */
async function noOpenTransaction(): Promise<boolean> {
  const s = current().session;
  const a = await sql(s, 'SELECT txid_current()::VARCHAR');
  const b = await sql(s, 'SELECT txid_current()::VARCHAR');
  return a.terminal.status === 'ok' && b.terminal.status === 'ok' && a.rows?.[0]?.[0] !== b.rows?.[0]?.[0];
}

function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => (pred() ? resolve() : Date.now() > until ? reject(new Error('waitFor timed out')) : setTimeout(tick, 5));
    tick();
  });
}

/** Parser output of the live engine, normalised losslessly (for recorded-fixture comparison). */
async function serialize(text: string): Promise<string> {
  const r = await sql(current().session, `SELECT json_serialize_sql('${text.replaceAll("'", "''")}')::VARCHAR`);
  const raw = r.rows?.[0]?.[0];
  if (raw === undefined || raw === null) throw new Error(JSON.stringify(r.terminal));
  return stringifyLossless(parseLossless(raw));
}

export const verdictHarness = { setup, current, exec, table, analyze, start, leftovers, noOpenTransaction, waitFor, serialize, faults, held, statementLog, sql, BOUNDS, publish };
export type VerdictHarness = typeof verdictHarness;

window.__qvHarness!.verdict = verdictHarness;
