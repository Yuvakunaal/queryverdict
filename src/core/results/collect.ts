// Bounded collection of a streamed result (M06; ARCHITECTURE §11.1; P-020). Each batch is
// accepted or refused on its byte size before any of its values is converted; then at most
// `maxRows` rows of at most `maxColumns` columns are converted, each cell cut to `maxCellChars`
// and the total kept within `maxDisplayChars`. Every cause is recorded separately. The stream is
// stopped as soon as nothing more can be shown (one extra row tells whether more rows exist).
//
// Not bounded here, by the engine's design (documented, P-020): DuckDB-WASM transfers whole
// batches (up to 2,048 rows) from its worker, so a batch is fully allocated on the page before
// its size can be checked; the engine's own memory is governed by its memory_limit.
import { arrowCell, type ArrowBatch } from './arrow';
import type { BoundedResult, CellText, ResultColumn, ResultLimits } from './types';
import type { DataEpoch, Generation } from '../engine/types';

export interface CollectLimits {
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCellChars: number;
  readonly maxDisplayChars: number;
  readonly maxArrowBytes: number;
}

export class ResultCollector {
  private columns: ResultColumn[] | null = null;
  private totalColumns = 0;
  private readonly rows: CellText[][] = [];
  private bytes = 0;
  private chars = 0;
  private cells = 0;
  private moreRows = false;
  private display = false;
  private overBytes = false;
  /** Rows received from the engine (whether or not shown). */
  rowsSeen = 0;
  batches = 0;

  constructor(
    private readonly limits: CollectLimits,
    /** Column names and types to show instead of the stream's own (for example from DESCRIBE). */
    private readonly declared?: readonly ResultColumn[],
  ) {}

  /** Once false was returned nothing more is kept (a drained stream keeps arriving). */
  private stopped = false;

  /** Consumes one batch; returns false when nothing more will be kept (stop the stream). */
  consume(input: unknown, batchBytes: number): boolean {
    const batch = input as ArrowBatch;
    this.batches++;
    if (this.stopped) {
      this.rowsSeen += batch.numRows;
      if (this.rows.length >= this.limits.maxRows && batch.numRows > 0) this.moreRows = true;
      return false;
    }
    const more = this.take(batch, batchBytes);
    if (!more) this.stopped = true;
    return more;
  }

  private take(batch: ArrowBatch, batchBytes: number): boolean {
    if (!this.columns) {
      const fields = batch.schema.fields;
      this.totalColumns = this.declared?.length ?? fields.length;
      const shown = Math.min(fields.length, this.limits.maxColumns);
      this.columns = fields.slice(0, shown).map((f, i) => this.declared?.[i] ?? { name: f.name, type: String(f.type) });
    }
    // Byte budget first: a batch that would exceed it is not read at all.
    if (this.bytes + batchBytes > this.limits.maxArrowBytes) {
      this.overBytes = true;
      return false;
    }
    this.bytes += batchBytes;
    const cols = this.columns.length;
    const data = batch.data.children;
    for (let r = 0; r < batch.numRows; r++) {
      this.rowsSeen++;
      if (this.rows.length >= this.limits.maxRows) {
        this.moreRows = true;
        return false;
      }
      const row: CellText[] = [];
      let size = 0;
      let cut = 0;
      for (let c = 0; c < cols; c++) {
        const column = data[c];
        const cell = column ? arrowCell(column, r, this.limits.maxCellChars) : ({ kind: 'null' } as const);
        if (cell.kind === 'text') {
          size += cell.text.length;
          if (cell.truncated) cut++;
        }
        row.push(cell);
      }
      if (this.chars + size > this.limits.maxDisplayChars) {
        this.display = true;
        return false;
      }
      this.chars += size;
      this.cells += cut;
      this.rows.push(row);
    }
    return true;
  }

  finish(stamp: { generation: Generation; epoch: DataEpoch }): BoundedResult {
    const columns = this.columns ?? this.declared?.slice(0, this.limits.maxColumns) ?? [];
    const total = this.columns ? this.totalColumns : (this.declared?.length ?? 0);
    const limits: ResultLimits = {
      rows: this.limits.maxRows,
      columns: this.limits.maxColumns,
      cellChars: this.limits.maxCellChars,
      displayChars: this.limits.maxDisplayChars,
      bytes: this.limits.maxArrowBytes,
      rowsBoundBy: 'query',
    };
    return {
      columns,
      rows: this.rows,
      truncation: {
        rows: this.moreRows,
        columns: total > columns.length ? { shown: columns.length, total } : null,
        cells: this.cells,
        display: this.display,
        bytes: this.overBytes,
      },
      limits,
      stamp,
    };
  }
}
