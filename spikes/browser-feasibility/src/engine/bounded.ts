// Collects a bounded display result from a streamed Arrow result.
//
// What the application CAN bound (enforced here, before display conversion):
// - rows kept (maxRows), columns converted (maxColumns), characters per cell (maxCellChars),
//   total display characters (maxDisplayChars);
// - Arrow bytes accepted from the engine: once maxArrowBytes is exceeded no further batch is
//   requested and the engine-side query is cancelled by the caller.
// What it CANNOT bound (documented limitation, docs/FEASIBILITY.md §10):
// - the size of a single batch. DuckDB-WASM produces batches of up to 2,048 rows and posts each
//   one from the worker to the page in full before this code sees it. One batch with very large
//   cells is therefore fully allocated (in the worker, during transfer, and as an Arrow buffer
//   on the page) even though only a bounded prefix of each cell is converted for display;
// - engine-side memory used to compute the result (governed by DuckDB's memory_limit).
import { makeVector, type Data, type DataType, type RecordBatch } from 'apache-arrow';
import { formatCell, type DisplayRow } from './format';

export interface Limits {
  maxRows: number;
  /** Arrow bytes accepted before no further batches are requested. */
  maxArrowBytes: number;
  /** Total characters of formatted output kept for display. */
  maxDisplayChars: number;
  maxColumns: number;
  maxCellChars: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxRows: 1000,
  maxArrowBytes: 16 * 1024 * 1024,
  maxDisplayChars: 2_000_000,
  maxColumns: 200,
  maxCellChars: 500,
};

export function limits(partial: Partial<Limits> = {}): Limits {
  return { ...DEFAULT_LIMITS, ...partial };
}

export interface Truncation {
  /** More rows existed than maxRows. */
  rows: boolean;
  /** Stopped requesting batches because maxArrowBytes was exceeded. */
  arrowBytes: boolean;
  /** Stopped converting rows because maxDisplayChars would be exceeded. */
  displayChars: boolean;
  /** The result had more columns than maxColumns; extra columns were not converted. */
  columns: boolean;
  /** Number of cells shortened to maxCellChars. */
  cellsShortened: number;
}

export interface BoundedResult {
  columns: { name: string; type: string }[];
  totalColumns: number;
  rows: DisplayRow[];
  /** True if any truncation happened (rows, bytes, display, columns or shortened cells). */
  truncated: boolean;
  truncation: Truncation;
  /** Rows received from the engine before stopping (>= rows.length). */
  rowsSeen: number;
  /** Arrow bytes received from the engine before stopping (approximate: sum of buffer sizes). */
  arrowBytesSeen: number;
  /** Largest single batch received, in Arrow bytes. */
  maxBatchBytes: number;
  displayChars: number;
  batches: number;
  firstBatchMs: number | null;
}

export function batchBytes(batch: RecordBatch): number {
  let total = 0;
  type D = { buffers?: unknown[]; children?: unknown[]; dictionary?: { data?: unknown[] } };
  const visit = (d: D) => {
    for (const b of d.buffers ?? []) if (b && ArrayBuffer.isView(b)) total += b.byteLength;
    for (const c of d.children ?? []) visit(c as D);
    // Dictionary-encoded columns keep their values in a separate vector.
    for (const dd of d.dictionary?.data ?? []) visit(dd as D);
  };
  visit(batch.data as unknown as D);
  return total;
}

const mk = (d: Data<DataType>) => makeVector(d) as unknown as { get(i: number): unknown };

/**
 * Reads batches until the stream ends or a budget is hit. When the result is truncated by rows,
 * Arrow bytes or display characters the iterator is left unread (the caller must cancel the
 * engine-side query to free it).
 */
export async function collectBounded(
  stream: AsyncIterable<RecordBatch>,
  lim: Limits,
  now: () => number = () => performance.now(),
): Promise<BoundedResult> {
  const t0 = now();
  const tr: Truncation = { rows: false, arrowBytes: false, displayChars: false, columns: false, cellsShortened: 0 };
  const result: BoundedResult = {
    columns: [], totalColumns: 0, rows: [], truncated: false, truncation: tr,
    rowsSeen: 0, arrowBytesSeen: 0, maxBatchBytes: 0, displayChars: 0, batches: 0, firstBatchMs: null,
  };
  for await (const batch of stream) {
    if (result.batches === 0) {
      result.firstBatchMs = now() - t0;
      const fields = batch.schema.fields;
      result.totalColumns = fields.length;
      tr.columns = fields.length > lim.maxColumns;
      result.columns = fields.slice(0, lim.maxColumns).map((f) => ({ name: f.name, type: String(f.type) }));
    }
    result.batches++;
    result.rowsSeen += batch.numRows;
    const bytes = batchBytes(batch);
    result.arrowBytesSeen += bytes;
    result.maxBatchBytes = Math.max(result.maxBatchBytes, bytes);

    if (!tr.displayChars) {
      const fields = batch.schema.fields.slice(0, lim.maxColumns);
      const datas = fields.map((_, i) => batch.data.children[i] as Data<DataType>);
      for (let r = 0; r < batch.numRows && result.rows.length < lim.maxRows; r++) {
        const row: string[] = [];
        let rowChars = 0;
        let shortened = 0;
        for (let c = 0; c < fields.length; c++) {
          const cell = formatCell(datas[c]!, r, fields[c]!, lim.maxCellChars, mk);
          row.push(cell.text);
          rowChars += cell.text.length;
          if (cell.shortened) shortened++;
        }
        if (result.displayChars + rowChars > lim.maxDisplayChars) {
          tr.displayChars = true;
          break;
        }
        result.displayChars += rowChars;
        tr.cellsShortened += shortened;
        result.rows.push(row);
      }
    }
    if (result.rowsSeen > lim.maxRows) tr.rows = true;
    if (result.arrowBytesSeen > lim.maxArrowBytes) tr.arrowBytes = true;
    if (tr.rows || tr.arrowBytes || tr.displayChars) break; // remainder is never requested
  }
  result.truncated = tr.rows || tr.arrowBytes || tr.displayChars || tr.columns || tr.cellsShortened > 0;
  return result;
}

/** True when the engine-side stream was left unread and must be cancelled. */
export function streamLeftUnread(r: BoundedResult): boolean {
  return r.truncation.rows || r.truncation.arrowBytes || r.truncation.displayChars;
}
