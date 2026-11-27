// Bounded result planning and cell conversion (P-020, QV-RES-001).
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE } from '../../../src/core/profile/profile';
import { BATCH_OVERHEAD_BYTES, CELL_OVERHEAD_BYTES, planLimits, PREVIEW_ROWS, toCellText } from '../../../src/core/results/bounds';

const R = DEFAULT_PROFILE.results;

describe('planLimits', () => {
  it('a narrow table gets the preview row count', () => {
    expect(planLimits(4, R)).toMatchObject({ rows: PREVIEW_ROWS, columns: 4, rowsBoundBy: 'preview' });
  });

  it('with the default profile, 200+ columns are bounded by the display budget (20 rows)', () => {
    expect(planLimits(500, R)).toMatchObject({ rows: 20, columns: 200, rowsBoundBy: 'display' });
  });

  it('a wide table is bounded by the byte budget, by construction (sentinel row and Arrow overhead included)', () => {
    const l = planLimits(500, { ...R, maxDisplayChars: 100_000_000 });
    expect(l.columns).toBe(R.maxColumns);
    expect(l.rowsBoundBy).toBe('bytes');
    const cell = (l.cellChars + 1) * 4 + CELL_OVERHEAD_BYTES;
    expect((l.rows + 1) * l.columns * cell + BATCH_OVERHEAD_BYTES).toBe(l.bytes);
    expect(l.bytes).toBeLessThanOrEqual(R.maxArrowBytes);
    expect((l.rows + 2) * l.columns * cell + BATCH_OVERHEAD_BYTES).toBeGreaterThan(R.maxArrowBytes); // one more row would not fit
  });

  it('Codex reproduction: a 32-byte budget plans zero rows and zero columns (nothing is read)', () => {
    expect(planLimits(1, { ...R, maxArrowBytes: 32 })).toMatchObject({ rows: 0, columns: 0, bytes: 0, rowsBoundBy: 'bytes' });
  });

  it('columns are reduced when even one row of all columns would not fit', () => {
    const cell = (R.maxCellChars + 1) * 4 + CELL_OVERHEAD_BYTES;
    const l = planLimits(10, { ...R, maxArrowBytes: BATCH_OVERHEAD_BYTES + 2 * 3 * cell });
    expect([l.columns, l.rows]).toEqual([3, 1]);
    expect(l.bytes).toBeLessThanOrEqual(BATCH_OVERHEAD_BYTES + 2 * 3 * cell);
  });

  it('the display budget bounds rows when it is the tightest', () => {
    const l = planLimits(10, { ...R, maxDisplayChars: 10 * 500 * 3 });
    expect([l.rows, l.rowsBoundBy]).toEqual([3, 'display']);
  });

  it('never forces a row that does not fit', () => {
    expect(planLimits(10, { ...R, maxArrowBytes: 1 }).rows).toBe(0);
  });
});

describe('toCellText', () => {
  it('keeps NULL and the empty string distinct', () => {
    expect(toCellText(null, 5)).toEqual({ kind: 'null' });
    expect(toCellText('', 5)).toEqual({ kind: 'text', text: '', truncated: false });
    expect(toCellText('NULL', 5)).toEqual({ kind: 'text', text: 'NULL', truncated: false });
  });
  it('cuts by characters without splitting a surrogate pair, and marks the cut', () => {
    expect(toCellText('abcdef', 5)).toEqual({ kind: 'text', text: 'abcde', truncated: true });
    expect(toCellText('ab😀😀😀', 3)).toEqual({ kind: 'text', text: 'ab😀', truncated: true });
    expect(toCellText('9007199254740993', 500)).toEqual({ kind: 'text', text: '9007199254740993', truncated: false });
  });
});
