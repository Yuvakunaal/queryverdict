// Bounded, unordered preview of one table (M04; ARCHITECTURE §17; UI_SPECIFICATION §3). Runs only
// on an explicit user action, as one `preview` operation through the session queue and revocable
// lease. Inside the lease it re-reads the table's identity and columns from the catalog (the
// registry snapshot is not trusted), then reads at most `limits.rows + 1` rows (no ORDER BY: the
// first rows the engine returns) of at most `limits.columns` columns, each value cast to VARCHAR
// and cut to `cellChars + 1` characters by `left()`. The result transferred to the page is bounded
// by the plan (worst case ≤ maxArrowBytes) and enforced by the driver's byte check.
//
// What is NOT bounded here (documented, P-080): the engine evaluates CAST(value AS VARCHAR) before
// left(), so a single very large value is materialised inside the engine (WASM heap, bounded by
// memory_limit) before it is cut; and the engine allocates its first result batch before the page
// sees it. Whole-table work is avoided by LIMIT on a plain scan, not guaranteed for every plan.
//
// The result is published only if the engine generation and data epoch are unchanged at hand-off;
// otherwise it is stale and never shown.
import type { EngineSession } from '../engine/session';
import type { Lease, OperationBounds, OperationHandle, OperationResult } from '../engine/types';
import type { ReleaseProfile } from '../profile/profile';
import { RefusedError } from '../util/errors';
import { cellLength, planLimits, toCellText } from './bounds';
import type { BoundedResult, CellText, ResultColumn } from './types';

export interface PreviewTarget {
  readonly relation: string;
  readonly identity: { readonly database: string; readonly schema: string; readonly oid: string };
}

const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

async function body(lease: Lease, session: EngineSession, target: PreviewTarget, profile: ReleaseProfile): Promise<BoundedResult> {
  const stamp = { generation: lease.generation, epoch: session.epoch };
  const { database, schema, oid } = target.identity;
  const ids = await lease.query(
    `SELECT table_oid::VARCHAR FROM duckdb_tables() WHERE database_name = ${lit(database)} AND schema_name = ${lit(schema)} AND table_name = ${lit(target.relation)}`,
    { columns: 1, maxRows: 2 },
  );
  if (ids.length !== 1 || ids[0]?.[0] !== oid) throw new RefusedError(`"${target.relation}" is no longer the table that was selected (it was removed or replaced). Refresh the dataset list.`);
  const cols = await lease.query(
    `SELECT column_name::VARCHAR, data_type::VARCHAR FROM duckdb_columns() WHERE table_oid = ${lit(oid)}::BIGINT ORDER BY column_index`,
    { columns: 2, maxRows: 100_000 },
  );
  const all: ResultColumn[] = cols.map((r) => ({ name: r[0] ?? '', type: r[1] ?? '' }));
  const limits = planLimits(all.length, profile.results);
  if (!all.length) {
    return { columns: [], rows: [], truncation: { rows: false, columns: null, cells: 0, display: false, bytes: false }, limits, stamp };
  }
  if (limits.rows === 0 || limits.columns === 0) {
    throw new RefusedError(`The configured preview byte budget (${profile.results.maxArrowBytes} bytes) is too small to show one row of this table. Nothing was read.`);
  }
  const shown = all.slice(0, limits.columns);
  const select = shown.map((c) => `left(CAST(${q(c.name)} AS VARCHAR), ${limits.cellChars + 1})`).join(', ');
  const raw = await lease.query(`SELECT ${select} FROM ${q(database)}.${q(schema)}.${q(target.relation)} LIMIT ${limits.rows + 1}`, { columns: shown.length, maxRows: limits.rows + 1, maxBytes: profile.results.maxArrowBytes });
  const rows: CellText[][] = [];
  let cells = 0;
  let chars = 0;
  let display = false;
  for (const r of raw.slice(0, limits.rows)) {
    const row = r.map((v) => toCellText(v, limits.cellChars));
    const size = row.reduce((s, c) => s + cellLength(c), 0);
    if (chars + size > limits.displayChars) {
      display = true;
      break;
    }
    chars += size;
    cells += row.filter((c) => c.kind === 'text' && c.truncated).length;
    rows.push(row);
  }
  return {
    columns: shown,
    rows,
    truncation: { rows: raw.length > limits.rows, columns: all.length > shown.length ? { shown: shown.length, total: all.length } : null, cells, display, bytes: false },
    limits,
    stamp,
  };
}

/** Starts a bounded preview. The handle settles `stale` if the engine or data changed before hand-off. */
export function previewTable(session: EngineSession, target: PreviewTarget, profile: ReleaseProfile): OperationHandle<BoundedResult> {
  const b = profile.bounds;
  const bounds: OperationBounds = { queueWaitMs: b.queueWaitMs, runMs: b.queueWaitMs, cancelGraceMs: b.cancelRequestMs, cleanupMs: b.cleanupMs };
  const inner = session.submit<BoundedResult>('preview', (lease) => body(lease, session, target, profile), bounds);
  const result = inner.result.then((r): OperationResult<BoundedResult> => {
    if (r.terminal.status !== 'ok' || !r.value) return r;
    const v = r.value;
    // Stale-result rejection at hand-off: a result from a replaced engine or older data is dropped.
    if (v.stamp.generation !== session.generation || r.generation !== v.stamp.generation) return { terminal: { status: 'stale', reason: 'generation-changed' }, generation: r.generation };
    if (v.stamp.epoch !== session.epoch) return { terminal: { status: 'refused', reason: 'The data changed while the preview was running. Preview again.' }, generation: r.generation };
    return r;
  });
  return { id: inner.id, kind: inner.kind, get generation() { return inner.generation; }, result, cancel: () => inner.cancel() };
}
