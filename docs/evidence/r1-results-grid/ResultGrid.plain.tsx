// R1 baseline (evidence only, not built): the plain, non-windowed results grid measured first.
// Every row of the bounded result is in the document. Replaces src/features/results/ResultGrid.tsx
// to reproduce the "plain" measurements in FEASIBILITY §16.
import { useId, type MouseEvent } from 'react';
import type { BoundedResult, CellText } from '../../core/results/types';
import { Cell, isNumericType } from '../../ui/Table';

export const GRID_CELL_CHARS = 80;

export interface DetailRequest {
  readonly row: number;
  readonly column: number;
}

export interface ResultGridProps {
  readonly result: BoundedResult;
  readonly caption: string;
  onDetail(target: DetailRequest): void;
}

const needsDetail = (c: CellText) => c.kind === 'text' && (c.truncated || c.text.length > GRID_CELL_CHARS || c.text.includes('\n'));

export function ResultGrid({ result, caption, onDetail }: ResultGridProps) {
  const id = useId();
  const { columns, rows } = result;
  const onClick = (e: MouseEvent<HTMLTableSectionElement>) => {
    const b = (e.target as Element).closest('button[data-r]');
    if (b) onDetail({ row: Number(b.getAttribute('data-r')), column: Number(b.getAttribute('data-c')) });
  };
  return (
    <div className="result-scroll" tabIndex={0} role="region" aria-labelledby={`${id}-caption`}>
      <table className="data-table result-table">
        <caption id={`${id}-caption`} className="visually-hidden">
          {caption}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="row-number">
              <span className="visually-hidden">Row</span>#
            </th>
            {columns.map((c, i) => (
              <th key={i} scope="col" data-numeric={isNumericType(c.type) || undefined}>
                <span className="col-name">{c.name}</span>
                <span className="col-type">{c.type}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody onClick={onClick}>
          {rows.map((r, ri) => (
            <tr key={ri}>
              <th scope="row" className="row-number">
                {ri + 1}
              </th>
              {r.map((c, ci) => (
                <td key={ci} data-numeric={isNumericType(columns[ci]?.type) || undefined}>
                  {needsDetail(c) ? (
                    <span className="cell-long">
                      <span className="cell-text">
                        <Cell cell={c} />
                      </span>
                      <button type="button" className="cell-detail" data-r={ri} data-c={ci} aria-label={`Show value of ${columns[ci]?.name ?? 'column'}, row ${ri + 1}`}>
                        …
                      </button>
                    </span>
                  ) : (
                    <Cell cell={c} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
