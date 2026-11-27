import type { RefObject } from 'react';
import type { BoundedResult } from '../../core/results/types';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import type { DetailRequest } from './ResultGrid';

export interface CellDetailProps {
  readonly result: BoundedResult;
  readonly target: DetailRequest | null;
  onClose(): void;
  readonly returnFocus: RefObject<HTMLElement | null>;
}

/**
 * Bounded cell detail (M06; UI_SPECIFICATION §4: "A detail viewer shows only bounded content
 * already available"). Shows the value exactly as it was read — at most the profile's
 * characters per cell — as plain text. It never reads the full value again from the engine,
 * writes to the clipboard or interprets markup.
 */
export function CellDetail({ result, target, onClose, returnFocus }: CellDetailProps) {
  const column = target ? result.columns[target.column] : undefined;
  const cell = target ? result.rows[target.row]?.[target.column] : undefined;
  const title = column && target ? `${column.name} · row ${target.row + 1}` : 'Value';
  const chars = cell?.kind === 'text' ? Array.from(cell.text).length : 0;
  return (
    <Dialog open={target !== null} title={title} onClose={onClose} returnFocus={returnFocus} wide>
      {cell ? (
        <>
          <p className="dialog-text muted">
            <span className="mono">{column?.type}</span> · {chars.toLocaleString('en-US')} {chars === 1 ? 'character' : 'characters'} shown
          </p>
          {cell.kind === 'text' && cell.truncated ? (
            <p className="state-note" data-tone="warning">
              Only the first {result.limits.cellChars.toLocaleString('en-US')} characters of this value were kept. The rest is not available here.
            </p>
          ) : null}
          {cell.kind === 'text' ? (
            <pre className="cell-detail-text" tabIndex={0} aria-label="Value">
              {cell.text}
            </pre>
          ) : cell.kind === 'null' ? (
            <p>NULL (no value)</p>
          ) : (
            <p>{cell.reason}</p>
          )}
        </>
      ) : null}
      <div className="dialog-actions">
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}
