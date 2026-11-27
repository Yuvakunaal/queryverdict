import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { BoundedResult, CellText } from '../../core/results/types';
import { Cell, isNumericType } from '../../ui/Table';

/** Widest column, in characters; longer values are ellipsised and offer the detail viewer. */
export const COLUMN_CHARS = 40;
/** Rows rendered beyond the visible ones, above and below. */
const OVERSCAN = 12;
/** Columns rendered beyond the visible ones, left and right. */
const COLUMN_OVERSCAN = 3;
/** Rows and columns rendered before the first measurement (enough to fill a tall, wide panel). */
// Kept to about one screen: the first render is redone in pixels right after it is measured.
const INITIAL_ROWS = 36;
const INITIAL_COLUMNS = 16;

export interface DetailRequest {
  readonly row: number;
  readonly column: number;
}

export interface ResultGridProps {
  readonly result: BoundedResult;
  /** Accessible name of the result (for example "Result of Run SQL: 8 rows, 3 columns"). */
  readonly caption: string;
  onDetail(target: DetailRequest): void;
}

const textLength = (c: CellText) => (c.kind === 'text' ? c.text.length : c.kind === 'null' ? 4 : 12);
const needsDetail = (c: CellText) => c.kind === 'text' && (c.truncated || c.text.length > COLUMN_CHARS || c.text.includes('\n'));

/**
 * Column widths in characters from every bounded value (and the header), capped at
 * COLUMN_CHARS: fixed for the whole result, so columns never shift as rows are windowed.
 */
export function columnWidths(result: BoundedResult): number[] {
  return result.columns.map((col, ci) => {
    let w = Math.max(col.name.length, col.type.length, 4);
    for (const row of result.rows) {
      const c = row[ci];
      if (c) w = Math.max(w, Math.min(COLUMN_CHARS + 2, textLength(c) + (needsDetail(c) ? 3 : 0)));
      if (w >= COLUMN_CHARS + 2) break;
    }
    return Math.min(w, COLUMN_CHARS + 2);
  });
}

/**
 * The bounded result as a semantic table (UI_SPECIFICATION §4; P-051, R1 in FEASIBILITY §16):
 * sticky column headers with DuckDB types, display-index row headers, monospace values as text,
 * NULL and empty strings as labelled tokens, cut values marked.
 *
 * Rows and columns are windowed: only the cells in view (plus an overscan margin) are in the
 * document, between spacer rows of the remaining height and spanning spacer cells of the
 * remaining width, because R1 measured main-thread tasks of 0.7–1.3 s when all 200,000 cells of
 * a 1,000 × 200 result were rendered (FEASIBILITY §16). The table keeps its full size for
 * assistive technology through aria-rowcount/aria-colcount and aria-rowindex/aria-colindex;
 * cells outside the window are reached by scrolling the region (it is focusable). Rows have one
 * fixed height (values stay on one line) and columns fixed widths per result, so the window
 * arithmetic is exact; long, multi-line or cut values open the bounded detail viewer.
 */
export function ResultGrid({ result, caption, onDetail }: ResultGridProps) {
  const id = useId();
  const { columns, rows } = result;
  const widths = useMemo(() => columnWidths(result), [result]);
  const scroller = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  // The window: rows start..end and columns cStart..cEnd, with the measured row height (0 until
  // measured). A new result remounts the grid (the parent keys it by run), so it starts at the top.
  const initialCols = Math.min(columns.length, INITIAL_COLUMNS);
  const [view, setView] = useState({ start: 0, end: Math.min(rows.length, INITIAL_ROWS), h: 0, cStart: 0, cEnd: initialCols, ch: 0, pad: 0 });

  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // Measure one rendered row and one character: both follow zoom and font size.
    const row = el.querySelector('tbody tr[data-row]');
    const h = row ? row.getBoundingClientRect().height : 0;
    const ch = (measure.current?.getBoundingClientRect().width ?? 0) / 100;
    if (h <= 0 || ch <= 0) return;
    const head = el.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    const first = Math.max(0, Math.floor((el.scrollTop - head) / h) - OVERSCAN);
    const visible = Math.ceil(el.clientHeight / h) + 2 * OVERSCAN;
    const start = Math.min(first, Math.max(0, rows.length - visible));
    // Columns: their widths are fixed per result (character widths plus cell padding).
    const firstHead = el.querySelector('thead th:not(.row-number):not(.spacer)');
    // Each column's width beyond its characters: both paddings and its right border (a rule
    // per column adds up across 200 columns, so it must be counted).
    const cs = firstHead ? getComputedStyle(firstHead) : null;
    const pad = cs ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth) : 0;
    const numberWidth = el.querySelector('thead .row-number')?.getBoundingClientRect().width ?? 0;
    const left = el.scrollLeft;
    const right = left + el.clientWidth - numberWidth;
    let x = 0;
    let cStart = -1;
    let cEnd = widths.length;
    for (let i = 0; i < widths.length; i++) {
      const w = (widths[i] ?? 0) * ch + pad;
      if (cStart < 0 && x + w > left) cStart = i;
      if (x > right) {
        cEnd = i;
        break;
      }
      x += w;
    }
    cStart = Math.max(0, (cStart < 0 ? widths.length : cStart) - COLUMN_OVERSCAN);
    cEnd = Math.min(widths.length, cEnd + COLUMN_OVERSCAN);
    const next = { start, end: Math.min(rows.length, start + visible), h, cStart, cEnd, ch, pad };
    // A focused detail button about to leave the window hands focus to the scroll region, so
    // keyboard focus is never dropped to the page.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && el.contains(focused) && focused.dataset.r !== undefined) {
      const r = Number(focused.dataset.r);
      const c = Number(focused.dataset.c);
      if (r < next.start || r >= next.end || c < next.cStart || c >= next.cEnd) el.focus({ preventScroll: true });
    }
    setView((v) => (v.start === next.start && v.end === next.end && v.h === next.h && v.cStart === next.cStart && v.cEnd === next.cEnd && v.ch === next.ch && v.pad === next.pad ? v : next));
  }, [rows.length, widths]);

  // The observer reports the initial size once observed, and every resize after it.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [update]);

  // One delegated handler for every detail button (no per-cell closures).
  const onClick = (e: MouseEvent<HTMLTableSectionElement>) => {
    const b = (e.target as Element).closest('button[data-r]');
    if (b) onDetail({ row: Number(b.getAttribute('data-r')), column: Number(b.getAttribute('data-c')) });
  };

  // Column widths: before the first measurement in `ch` units, then in pixels. `pad` counts both
  // paddings and the column's rule; a <col> width excludes the rule, which the cell adds.
  const colWidth = (i: number) => (view.ch ? `${((widths[i] ?? 0) * view.ch + view.pad - 1).toFixed(3)}px` : `calc(${widths[i] ?? 0}ch + 2 * var(--space-3))`);
  const hiddenWidth = (from: number, to: number) => {
    let w = 0;
    for (let i = from; i < to; i++) w += (widths[i] ?? 0) * view.ch + view.pad;
    return w;
  };
  const above = view.h ? view.start * view.h : 0;
  const below = view.h ? (rows.length - view.end) * view.h : 0;
  const { cStart, cEnd } = view;
  const leftSpan = cStart;
  const rightSpan = columns.length - cEnd;
  // Rendered columns: row numbers, a left spacer, the window, a right spacer.
  const span = 1 + (leftSpan > 0 ? 1 : 0) + (cEnd - cStart) + (rightSpan > 0 ? 1 : 0);
  const shownColumns = columns.slice(cStart, cEnd);
  return (
    <div ref={scroller} className="result-scroll" tabIndex={0} role="region" aria-labelledby={`${id}-caption`} onScroll={update}>
      <span ref={measure} className="result-measure" aria-hidden="true">
        {'0'.repeat(100)}
      </span>
      <table className="data-table result-table" aria-rowcount={rows.length + 1} aria-colcount={columns.length + 1}>
        <caption id={`${id}-caption`} className="visually-hidden">
          {caption}
        </caption>
        {/* Columns are sized in pixels from the measured character width (the same numbers the
            window arithmetic uses). Hidden columns on either side of the window are one spacer
            column each, as wide as all of them together; no cell spans columns, because WebKit's
            fixed table layout does not honour <col> widths across spanning cells. */}
        <colgroup>
          <col className="row-number-col" />
          {leftSpan > 0 ? <col style={{ width: `${hiddenWidth(0, cStart).toFixed(3)}px` }} /> : null}
          {shownColumns.map((_, k) => (
            <col key={cStart + k} style={{ width: colWidth(cStart + k) }} />
          ))}
          {rightSpan > 0 ? <col style={{ width: `${hiddenWidth(cEnd, columns.length).toFixed(3)}px` }} /> : null}
        </colgroup>
        <thead>
          <tr aria-rowindex={1}>
            <th scope="col" className="row-number" aria-colindex={1}>
              <span className="visually-hidden">Row</span>#
            </th>
            {leftSpan > 0 ? <th aria-hidden="true" className="spacer" /> : null}
            {shownColumns.map((c, k) => {
              const i = cStart + k;
              return (
                <th key={i} scope="col" aria-colindex={i + 2} data-numeric={isNumericType(c.type) || undefined}>
                  <span className="col-name">{c.name}</span>
                  <span className="col-type">{c.type}</span>
                </th>
              );
            })}
            {rightSpan > 0 ? <th aria-hidden="true" className="spacer" /> : null}
          </tr>
        </thead>
        <tbody onClick={onClick}>
          {above > 0 ? (
            <tr aria-hidden="true" className="spacer">
              <td colSpan={span} style={{ height: above }} />
            </tr>
          ) : null}
          {rows.slice(view.start, view.end).map((r, k) => {
            const ri = view.start + k;
            return (
              <tr key={ri} data-row={ri} aria-rowindex={ri + 2}>
                <th scope="row" className="row-number" aria-colindex={1}>
                  {ri + 1}
                </th>
                {leftSpan > 0 ? <td aria-hidden="true" className="spacer" /> : null}
                {r.slice(cStart, cEnd).map((c, kc) => {
                  const ci = cStart + kc;
                  return (
                    <td key={ci} aria-colindex={ci + 2} data-numeric={isNumericType(columns[ci]?.type) || undefined}>
                      {needsDetail(c) ? (
                        <span className="cell-long">
                          <span className="cell-text">
                            <Cell cell={c} />
                          </span>
                          <button type="button" className="cell-detail" data-r={ri} data-c={ci} aria-label={`Show value of ${columns[ci]?.name ?? 'column'}, row ${ri + 1}`}>
                            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                              <path d="M2 4.5V2h2.5M10 7.5V10H7.5M2 2l3.25 3.25M10 10 6.75 6.75" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        </span>
                      ) : (
                        <Cell cell={c} />
                      )}
                    </td>
                  );
                })}
                {rightSpan > 0 ? <td aria-hidden="true" className="spacer" /> : null}
              </tr>
            );
          })}
          {below > 0 ? (
            <tr aria-hidden="true" className="spacer">
              <td colSpan={span} style={{ height: below }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
