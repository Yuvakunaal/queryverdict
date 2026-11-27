// Pure bounding helpers for results (P-020). The limits are applied before data leaves the engine
// where possible (row LIMIT, per-cell left()), and again here, so a result can never exceed them.
import type { ReleaseProfile } from '../profile/profile';
import type { CellText, ResultLimits } from './types';

/** Rows a preview requests at most (a preview is a look at the first rows, not a result set). */
export const PREVIEW_ROWS = 100;
/** Worst-case UTF-8 bytes per character. */
const MAX_BYTES_PER_CHAR = 4;
/** Arrow overhead per string cell (32-bit offset plus validity, rounded up). */
export const CELL_OVERHEAD_BYTES = 8;
/** Allowance for per-batch Arrow metadata and buffer alignment. */
export const BATCH_OVERHEAD_BYTES = 4096;

/**
 * Plans a bounded read so that its worst case fits the profile by construction: every cell is at
 * most `cellChars + 1` characters (cut by the engine), each costing up to 4 bytes plus Arrow
 * overhead, and one extra "are there more rows?" sentinel row is counted. Columns are reduced
 * when even one row would not fit, and the plan can be zero rows (the caller then refuses:
 * nothing is read). The display budget also limits rows × columns × cellChars.
 */
export function planLimits(columnCount: number, results: ReleaseProfile['results'], preview = true): ResultLimits {
  const cellBytes = (results.maxCellChars + 1) * MAX_BYTES_PER_CHAR + CELL_OVERHEAD_BYTES;
  const budget = Math.max(0, results.maxArrowBytes - BATCH_OVERHEAD_BYTES);
  const wanted = Math.max(0, Math.min(columnCount, results.maxColumns));
  const columns = Math.min(wanted, Math.floor(budget / (2 * cellBytes))); // room for one row + the sentinel
  if (columns === 0) {
    return { rows: 0, columns: 0, cellChars: results.maxCellChars, displayChars: results.maxDisplayChars, bytes: 0, rowsBoundBy: 'bytes' };
  }
  const byBytes = Math.floor(budget / (columns * cellBytes)) - 1;
  const byDisplay = Math.floor(results.maxDisplayChars / (columns * results.maxCellChars));
  const candidates: [number, ResultLimits['rowsBoundBy']][] = [[results.maxRows, 'profile'], [byBytes, 'bytes'], [byDisplay, 'display']];
  if (preview) candidates.unshift([PREVIEW_ROWS, 'preview']);
  let [rows, rowsBoundBy] = candidates[0] as [number, ResultLimits['rowsBoundBy']];
  for (const [n, why] of candidates) if (n < rows) [rows, rowsBoundBy] = [n, why];
  rows = Math.max(0, rows);
  return { rows, columns, cellChars: results.maxCellChars, displayChars: results.maxDisplayChars, bytes: (rows + 1) * columns * cellBytes + BATCH_OVERHEAD_BYTES, rowsBoundBy };
}

/** Converts one engine cell (exact text, or null for SQL NULL) to a bounded display cell. */
export function toCellText(raw: string | null, cellChars: number): CellText {
  if (raw === null) return { kind: 'null' };
  // Count code points, not UTF-16 units, so a cut never splits a character.
  const chars = Array.from(raw);
  if (chars.length <= cellChars) return { kind: 'text', text: raw, truncated: false };
  return { kind: 'text', text: chars.slice(0, cellChars).join(''), truncated: true };
}

export const cellLength = (c: CellText) => (c.kind === 'text' ? c.text.length : 0);
