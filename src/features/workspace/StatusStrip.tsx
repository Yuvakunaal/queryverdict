import type { EngineSnapshot } from '../../stores/engineStore';
import { Button } from '../../ui/Button';
import { StatusRegion } from '../../ui/StatusRegion';

export interface StatusStripProps {
  readonly engine: EngineSnapshot;
  /** The single status region's text: the latest engine change or announcement (P-082). */
  readonly message: string;
  /** A BEGIN ran in Run SQL and no COMMIT or ROLLBACK followed (a hint, ARCHITECTURE §11.2). */
  readonly transactionMayBeOpen?: boolean;
  onRetry(): void;
}

type Tone = 'ready' | 'working' | 'failed' | 'idle';

function toneOf(kind: EngineSnapshot['state']['kind']): Tone {
  if (kind === 'ready' || kind === 'busy') return 'ready';
  if (kind === 'failed') return 'failed';
  if (kind === 'starting' || kind === 'recovering' || kind === 'cancelling') return 'working';
  return 'idle';
}

/**
 * Workspace status strip (UI_SPECIFICATION §4, §6): the engine state as a glyph next to the
 * one persistent status region, Retry while the engine has failed, and the session scope. Shows no
 * resource figures: measured counters arrive with operation details in M10.
 */
export function StatusStrip({ engine, message, transactionMayBeOpen, onRetry }: StatusStripProps) {
  const tone = toneOf(engine.state.kind);
  return (
    <footer className="status-strip">
      <span className="engine-glyph" data-tone={tone} aria-hidden="true" />
      <StatusRegion message={message} />
      {engine.state.kind === 'failed' ? <Button className="btn-small" onClick={onRetry}>Retry</Button> : null}
      {transactionMayBeOpen ? (
        <span className="status-tx" title="Imports, removals and Analyze are refused while a transaction is open. Run COMMIT or ROLLBACK.">
          Transaction may be open
        </span>
      ) : null}
      <span className="status-scope">Session only · nothing is saved</span>
    </footer>
  );
}
