// Production driver: DuckDB-WASM in a dedicated worker, single-threaded, in-memory database,
// 64-bit integers kept exact (castBigIntToDouble: false). Lockdown and verification are the
// session's job (lockdown.ts); this file only creates and wraps the engine.
import * as duckdb from '@duckdb/duckdb-wasm';
import { BUNDLES, DUCKDB_WASM_PACKAGE_VERSION, bundleName, extensionRepositoryUrl } from './bundles';
import { ShapeError, StreamStopError, type EngineDriver, type EngineInstance } from './driver';
import type { BatchConsumer, Cell, QueryShape, Rows } from './types';
import { utf8Text, type ArrowData } from '../results/arrow';

/** Database open configuration shared by the driver and the engine-semantics suite. */
export const DUCKDB_OPEN_CONFIG: duckdb.DuckDBConfig = { path: ':memory:', query: { castBigIntToDouble: false }, allowUnsignedExtensions: false };

/** Converts an engine value to exact text. Engine-internal statements must cast non-primitive values. */
function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) && Number.isInteger(v)) throw new ShapeError('integer value beyond 2^53 arrived as a JavaScript number; cast it to VARCHAR');
    return String(v);
  }
  throw new ShapeError('non-text value in an engine-internal result; cast it to VARCHAR');
}

/** UTF-8 byte length of a JavaScript string, without allocating an encoded copy. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

class DuckDBInstance implements EngineInstance {
  constructor(
    private readonly worker: Worker,
    private readonly db: duckdb.AsyncDuckDB,
    private readonly conn: duckdb.AsyncDuckDBConnection,
    readonly bundle: 'eh' | 'mvp',
    readonly duckdbVersion: string,
  ) {}

  async run(sql: string, shape: QueryShape): Promise<Rows> {
    const reader = await this.conn.send(sql, true);
    const rows: Cell[][] = [];
    let columns: number | null = null;
    let arrowBytes = 0;
    let textBytes = 0;
    const overBudget = async (what: string) => {
      await this.conn.cancelSent().catch(() => false);
      return new ShapeError(`result exceeds its byte budget of ${shape.maxBytes} bytes (${what}); truncated results are not used`);
    };
    for await (const batch of reader) {
      columns ??= batch.numCols;
      if (shape.maxBytes !== undefined) {
        // Before converting anything from this batch: the batch the engine already sent.
        arrowBytes += batch.data.byteLength;
        if (arrowBytes > shape.maxBytes) throw await overBudget('Arrow buffers');
      }
      if (shape.columns !== undefined && batch.numCols !== shape.columns) {
        await this.conn.cancelSent().catch(() => false);
        throw new ShapeError(`expected ${shape.columns} columns, got ${batch.numCols}`);
      }
      for (let r = 0; r < batch.numRows; r++) {
        if (rows.length >= shape.maxRows) {
          await this.conn.cancelSent().catch(() => false);
          throw new ShapeError(`result exceeds ${shape.maxRows} rows; truncated results are not used`);
        }
        const row: Cell[] = [];
        for (let c = 0; c < batch.numCols; c++) {
          // Strings are decoded here, not by Arrow's reader, so a leading U+FEFF is kept.
          const data = batch.data.children[c] as unknown as ArrowData | undefined;
          const isText = data !== undefined && (data.type.typeId === 5 || data.type.typeId === 20) && data.offset === 0;
          const cell = isText ? (data.getValid(r) ? (utf8Text(data, r) ?? toCell(batch.getChildAt(c)?.get(r))) : null) : toCell(batch.getChildAt(c)?.get(r));
          if (shape.maxBytes !== undefined && cell !== null) {
            textBytes += utf8Bytes(cell);
            if (textBytes > shape.maxBytes) throw await overBudget('converted text');
          }
          row.push(cell);
        }
        rows.push(row);
      }
    }
    if (shape.exactRows !== undefined && rows.length !== shape.exactRows) throw new ShapeError(`expected ${shape.exactRows} rows, got ${rows.length}`);
    return rows;
  }

  async stream(sql: string, consume: BatchConsumer): Promise<void> {
    const reader = await this.conn.send(sql, true);
    for await (const batch of reader) {
      // The batch is already on the page (DuckDB-WASM transfers whole batches; P-020). Its size
      // is reported before any value in it is converted.
      if (!consume(batch, batch.data.byteLength)) {
        // Stop the rest of the result in the engine. `false` means nothing was pending (the
        // result was already complete); a rejected request leaves the connection's state unknown.
        // The lease bounds how long this may take (P-094).
        const stopped = await this.conn.cancelSent().then(() => true, () => false);
        if (!stopped) throw new StreamStopError('the engine did not confirm that the result stream stopped');
        return;
      }
    }
  }

  cancel(): Promise<boolean> {
    return this.conn.cancelSent();
  }

  async prepareCheck(sql: string): Promise<void> {
    const stmt = await this.conn.prepare(sql);
    await stmt.close();
  }

  registerFile(name: string, file: File): Promise<void> {
    return this.db.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
  }

  async dropFile(name: string): Promise<void> {
    await this.db.dropFile(name);
  }

  terminate(): void {
    this.worker.terminate();
  }
}

export class DuckDBDriver implements EngineDriver {
  readonly packageVersion = DUCKDB_WASM_PACKAGE_VERSION;
  constructor(readonly extensionRepository: string = extensionRepositoryUrl()) {}

  async boot(signal: AbortSignal): Promise<EngineInstance> {
    const bundle = await abortable(duckdb.selectBundle(BUNDLES), signal);
    if (!bundle.mainWorker) throw new Error('Selected DuckDB bundle has no worker');
    const worker = new Worker(bundle.mainWorker);
    const kill = () => worker.terminate();
    signal.addEventListener('abort', kill, { once: true });
    try {
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await abortable(db.instantiate(bundle.mainModule, bundle.pthreadWorker), signal);
      await abortable(db.open(DUCKDB_OPEN_CONFIG), signal);
      const conn = await abortable(db.connect(), signal);
      const version = await abortable(db.getVersion(), signal);
      signal.removeEventListener('abort', kill);
      return new DuckDBInstance(worker, db, conn, bundleName(bundle.mainModule), version);
    } catch (e) {
      worker.terminate();
      throw e;
    }
  }
}
