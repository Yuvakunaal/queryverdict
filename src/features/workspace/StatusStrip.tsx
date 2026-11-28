import type { Ref } from 'react';
import type { OperationId } from '../../core/engine/types';
import type { EngineSnapshot } from '../../stores/engineStore';
import type { OperationEntry } from '../../stores/operationStore';
import { Button } from '../../ui/Button';
import { StatusRegion } from '../../ui/StatusRegion';
import { OperationList } from './OperationList';

export interface StatusStripProps {
  readonly engine: EngineSnapshot;
  /** The single status region's text: the latest engine change or announcement (P-082). */
  readonly message: string;
  readonly ops: readonly OperationEntry[];
  /** Page-clock now, refreshed while something runs. */
  readonly now: number;
  onCancel(id: OperationId): void;
  /** A BEGIN ran in Run SQL and no COMMIT or ROLLBACK followed (a hint, ARCHITECTURE §11.2). */
  readonly transactionMayBeOpen?: boolean;
  onDetails(): void;
  readonly detailsRef?: Ref<HTMLButtonElement>;
}

type Tone = 'ready' | 'working' | 'failed' | 'idle';

function toneOf(kind: EngineSnapshot['state']['kind']): Tone {
  if (kind === 'ready' || kind === 'busy') return 'ready';
  if (kind === 'failed') return 'failed';
  if (kind === 'starting' || kind === 'recovering' || kind === 'cancelling') return 'working';
  return 'idle';
}

/**
 * Workspace status strip (UI_SPECIFICATION §4, §6; M10): the engine state as a glyph next to the
 * one persistent status region, the operation that is running or queued with its elapsed time and
 * Cancel (outside the live region, so the ticking time is never announced), the transaction hint,
 * and Operation details. Retry for a failed engine is in the recovery notice, with its explanation.
 */
export function StatusStrip({ engine, message, ops, now, onCancel, transactionMayBeOpen, onDetails, detailsRef }: StatusStripProps) {
  const tone = toneOf(engine.state.kind);
  return (
    <footer className="status-strip">
      <span className="engine-glyph" data-tone={tone} aria-hidden="true" />
      <StatusRegion message={message} />
      <OperationList ops={ops} engine={engine.state} now={now} onCancel={onCancel} compact focusFallback={() => document.querySelector<HTMLElement>('footer.status-strip .status-details')} />
      {transactionMayBeOpen ? (
        <Button className="status-tx btn-small" variant="quiet" onClick={onDetails} aria-haspopup="dialog" aria-label="Transaction may be open: imports, removals and Analyze are refused until COMMIT or ROLLBACK. Show details.">
          Transaction may be open
        </Button>
      ) : null}
      <Button ref={detailsRef} className="btn-small status-details" variant="quiet" onClick={onDetails} aria-haspopup="dialog">
        Operation details
      </Button>
      <span className="status-scope">Session only · nothing is saved</span>
    </footer>
  );
}
