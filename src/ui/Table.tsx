import { useId, type ReactNode } from 'react';
import type { CellText } from '../core/results/types';

export interface TableColumn {
  readonly name: string;
  readonly type?: string;
}

export interface TableProps {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly (readonly CellText[])[];
  readonly caption: string;
  /** Visible notes about what was cut (each cause separately). */
  readonly truncation?: readonly string[];
  /** Number rows from 1 in a row-header column. */
  readonly rowNumbers?: boolean;
  /** Keep the caption for assistive technology only (a visible summary is shown elsewhere). */
  readonly captionHidden?: boolean;
  /** 'schema' styles a column list (names emphasised, types and flags muted). */
  readonly variant?: 'data' | 'schema';
}

/** Numeric DuckDB types are right-aligned with tabular figures. */
const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL(\(.*\))?|NUMERIC(\(.*\))?)$/;
export const isNumericType = (t: string | undefined) => (t ? NUMERIC.test(t) : false);

/** One cell: SQL NULL and the empty string have distinct, labelled tokens; cut text is marked. */
export function Cell({ cell }: { cell: CellText }): ReactNode {
  if (cell.kind === 'null') {
    return (
      <span className="token" data-token="null">
        NULL<span className="visually-hidden"> (no value)</span>
      </span>
    );
  }
  if (cell.text === '') {
    return (
      <span className="token" data-token="empty">
        empty<span className="visually-hidden"> string</span>
      </span>
    );
  }
  return (
    <>
      {cell.text}
      {cell.truncated ? (
        <span className="token" data-token="cut">
          …<span className="visually-hidden"> (text cut)</span>
        </span>
      ) : null}
    </>
  );
}

/**
 * Bounded data table (DESIGN_SYSTEM §5 "Table"): caption, column headers with types, optional row
 * numbers as row headers, sticky headings, monospace values rendered as text. The scrolling
 * region is focusable and named so keyboard users can scroll it.
 */
export function Table({ columns, rows, caption, truncation, rowNumbers, captionHidden, variant = 'data' }: TableProps) {
  const id = useId();
  return (
    <div className="table-block">
      <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={`${id}-caption`}>
        <table className="data-table" data-variant={variant}>
          <caption id={`${id}-caption`} className={captionHidden ? 'visually-hidden' : undefined}>
            {caption}
          </caption>
          <thead>
            <tr>
              {rowNumbers ? (
                <th scope="col" className="row-number">
                  Row
                </th>
              ) : null}
              {columns.map((c, i) => (
                <th key={`${i}-${c.name}`} scope="col" data-numeric={isNumericType(c.type) || undefined}>
                  <span className="col-name">{c.name}</span>
                  {c.type ? <span className="col-type">{c.type}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {rowNumbers ? (
                  <th scope="row" className="row-number">
                    {ri + 1}
                  </th>
                ) : null}
                {r.map((c, ci) => (
                  <td key={ci} data-numeric={isNumericType(columns[ci]?.type) || undefined}>
                    <Cell cell={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncation?.length ? (
        <ul className="table-notes">
          {truncation.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
