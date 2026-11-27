// Bounded result contracts (ARCHITECTURE §11, §17; P-020; QV-RES-001). Shared by the M04 dataset
// preview and, later, the M06 results grid. Values are exact text produced by the engine (a
// VARCHAR cast), never JavaScript numbers. Every truncation cause is reported separately.
import type { DataEpoch, Generation } from '../engine/types';

/** One displayed cell: SQL NULL, or text (possibly the empty string, possibly cut). */
export type CellText =
  | { readonly kind: 'null' }
  | { readonly kind: 'text'; readonly text: string; readonly truncated: boolean };

export interface ResultColumn {
  readonly name: string;
  /** DuckDB type as reported by the catalog or the result. */
  readonly type: string;
}

export interface Truncation {
  /** More rows exist beyond those shown. */
  readonly rows: boolean;
  /** Columns shown out of the total (null when every column is shown). */
  readonly columns: { readonly shown: number; readonly total: number } | null;
  /** Number of cells whose text was cut at `limits.cellChars`. */
  readonly cells: number;
  /** Rows were withheld to keep the total displayed text within `limits.displayChars`. */
  readonly display: boolean;
}

export interface ResultLimits {
  /** Rows requested; derived from the profile and the byte and display budgets. */
  readonly rows: number;
  readonly columns: number;
  readonly cellChars: number;
  readonly displayChars: number;
  /** Worst-case result bytes of the planned read (≤ the profile's Arrow byte budget by construction). */
  readonly bytes: number;
  /** Which budget set the row count (profile row limit, preview size, byte or display budget). */
  readonly rowsBoundBy: 'preview' | 'profile' | 'bytes' | 'display';
}

export interface BoundedResult {
  readonly columns: readonly ResultColumn[];
  readonly rows: readonly (readonly CellText[])[];
  readonly truncation: Truncation;
  readonly limits: ResultLimits;
  /** The engine generation and data epoch the rows were read on. */
  readonly stamp: { readonly generation: Generation; readonly epoch: DataEpoch };
}
