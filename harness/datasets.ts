// TEST-ONLY datasets harness (M03). Exposes the production importer and registry, created on a
// fault-injecting session, plus helpers to build Files from fixture bytes sent by the test.
// Never part of the production artifact.
import { createDatasets, type Datasets } from '../src/core/datasets/registry';
import { CSV_OPTIONS } from '../src/core/datasets/importer';
import type { EngineSession } from '../src/core/engine/session';
import { DEFAULT_PROFILE, type ReleaseProfile } from '../src/core/profile/profile';
import { BOUNDS, faults, held, newSession, registeredFiles, registrationLog, sql } from './engine';

export interface Ctx {
  session: EngineSession;
  datasets: Datasets;
}

/** One fault-injecting session with its importer and registry; stored for later page.evaluate calls. */
async function setup(imports: Partial<ReleaseProfile['imports']> = {}, bounds: Partial<ReleaseProfile['bounds']> = {}): Promise<void> {
  const { session } = newSession({ faulty: true });
  await session.start();
  const profile: ReleaseProfile = { ...DEFAULT_PROFILE, imports: { ...DEFAULT_PROFILE.imports, ...imports }, bounds: { ...DEFAULT_PROFILE.bounds, ...bounds } };
  ctx = { session, datasets: createDatasets(session, profile) };
}
let ctx: Ctx | null = null;
function current(): Ctx {
  if (!ctx) throw new Error('call setup() first');
  return ctx;
}

/** Builds a File from base64 bytes (fixtures are read by the test runner and sent in). */
function file(name: string, base64: string): File {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name);
}

/** Column names, DuckDB types and every value as text (NULL stays null), ordered by rowid. */
async function dump(relation: string) {
  const { session } = current();
  const q = `"${relation.replaceAll('"', '""')}"`;
  const cols = await sql(session, `SELECT column_name::VARCHAR, data_type::VARCHAR FROM duckdb_columns() WHERE table_name = '${relation.replaceAll("'", "''")}' ORDER BY column_index`);
  const names = (cols.rows ?? []).map((r) => r[0] ?? '');
  const select = names.map((n) => `"${n.replaceAll('"', '""')}"::VARCHAR`).join(', ');
  const rows = await sql(session, `SELECT ${select} FROM ${q} ORDER BY rowid`);
  return { columns: names, types: (cols.rows ?? []).map((r) => r[1] ?? ''), rows: rows.rows, terminal: rows.terminal };
}

async function tables(): Promise<string[]> {
  const r = await sql(current().session, 'SELECT table_name::VARCHAR FROM duckdb_tables() WHERE NOT internal ORDER BY 1');
  return (r.rows ?? []).map((x) => x[0] ?? '');
}

/** Independent engine evidence: can a virtual path still be read? */
async function readable(path: string): Promise<boolean> {
  // read_blob is a glob: an unregistered path matches nothing (0 rows), a registered one gives 1.
  const r = await sql(current().session, `SELECT count(*)::VARCHAR FROM read_blob('${path.replaceAll("'", "''")}')`);
  return r.terminal.status !== 'ok' || r.rows?.[0]?.[0] !== '0';
}

/** True when no transaction is left open: BEGIN succeeds (and is rolled back). */
async function noOpenTransaction(): Promise<boolean> {
  const { session } = current();
  const b = await sql(session, 'BEGIN TRANSACTION');
  if (b.terminal.status !== 'ok') return false;
  await sql(session, 'ROLLBACK');
  return true;
}

function waitFor(pred: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => (pred() ? resolve() : Date.now() > until ? reject(new Error('waitFor timed out')) : setTimeout(tick, 10));
    tick();
  });
}

export const datasetsHarness = { setup, current, file, dump, tables, readable, noOpenTransaction, waitFor, faults, held, registeredFiles, registrationLog, sql, BOUNDS, CSV_OPTIONS };
export type DatasetsHarness = typeof datasetsHarness;

window.__qvHarness!.datasets = datasetsHarness;
