import { useEffect, useRef, type Ref } from 'react';
import type { OperationId, SessionState } from '../../core/engine/types';
import type { OperationEntry } from '../../stores/operationStore';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { ACTIVE_TEXT, CANCELLABLE, elapsed, entryState, entryTone, isUserFacing, NOUN, queuedReason, runningFor } from './operationModel';

export interface OperationListProps {
  readonly ops: readonly OperationEntry[];
  readonly engine: SessionState;
  /** Page-clock "now", refreshed by the caller while something runs (never announced). */
  readonly now: number;
  /** Cancels a queued or active operation through the session (same path as its own handle). */
  onCancel(id: OperationId): void;
  /** Compact single line for the status strip; otherwise the full list for Operation details. */
  readonly compact?: boolean;
  /** Settled operations to keep in the full list. */
  readonly recent?: number;
  /** Where focus goes when a focused Cancel disappears and no other Cancel remains. */
  focusFallback?(): HTMLElement | null;
  /** The outcome the user got, when it differs from the engine terminal (the latest analysis). */
  outcomeOf?(o: OperationEntry): string | undefined;
}

const cancelLabel = (o: OperationEntry) => `Cancel operation: ${ACTIVE_TEXT[o.kind]}${o.label ? ` (${o.label})` : ''}`;

function CancelButton({ o, engine, onCancel }: { o: OperationEntry; engine: SessionState; onCancel(id: OperationId): void }) {
  if (!CANCELLABLE.has(o.kind) || o.phase === 'settled') return null;
  const cancelling = engine.kind === 'cancelling' && engine.op === o.id;
  return (
    <Button className="btn-small op-cancel" variant="quiet-destructive" onClick={() => onCancel(o.id)} disabled={cancelling} aria-label={cancelling ? `Cancelling: ${NOUN[o.kind]}` : cancelLabel(o)}>
      {cancelling ? 'Cancelling…' : 'Cancel'}
    </Button>
  );
}

/**
 * Operations (UI_SPECIFICATION §6; PRD §5): queued and active work with its state, what it is about,
 * elapsed time on this tab's clock (labelled), the reason a queued operation waits, and Cancel. The
 * full list also shows how recent operations ended. Everything comes from the operation store; no
 * progress or completion time is shown, because none is measured.
 */
export function OperationList({ ops, engine, now, onCancel, compact, recent = 8, focusFallback, outcomeOf }: OperationListProps) {
  // Keyboard focus after Cancel (Codex M10): when the focused Cancel disappears or is disabled,
  // focus moves to the next Cancel in this list, else to a stable fallback — never to the page.
  const root = useRef<HTMLElement>(null);
  const cancelled = useRef(false);
  const cancel = (id: OperationId) => {
    cancelled.current = true;
    onCancel(id);
  };
  useEffect(() => {
    if (!cancelled.current) return;
    const a = document.activeElement;
    const kept = a instanceof HTMLElement && a !== document.body && a.isConnected && !(a instanceof HTMLButtonElement && a.disabled);
    if (kept && !root.current?.contains(a)) {
      cancelled.current = false; // the user moved on
      return;
    }
    if (kept) return;
    const next = root.current?.querySelector<HTMLButtonElement>('.op-cancel:not(:disabled)') ?? focusFallback?.() ?? null;
    next?.focus();
    cancelled.current = false;
  });
  const pending = ops.filter((o) => o.phase !== 'settled' && (compact ? isUserFacing(o) : true));
  if (compact) {
    const active = pending.find((o) => o.phase === 'active') ?? pending[0];
    if (!active) return <span ref={root as Ref<HTMLSpanElement>} className="op-line-empty" />;
    const queued = pending.filter((o) => o.phase === 'queued' && o !== active).length;
    return (
      <span className="op-line" data-phase={active.phase} ref={root as Ref<HTMLSpanElement>}>
        <span className="op-state">{entryState(active, engine)}</span>
        {active.label ? <span className="op-label mono">{active.label}</span> : null}
        <span className="op-time">{elapsed(runningFor(active, now))} elapsed</span>
        {queued ? <span className="op-more">+{queued} queued</span> : null}
        <CancelButton o={active} engine={engine} onCancel={cancel} />
      </span>
    );
  }
  const finished = ops.filter((o) => o.phase === 'settled' && isUserFacing(o)).slice(-recent).reverse();
  return (
    <div className="op-list" ref={root as Ref<HTMLDivElement>}>
      {pending.length ? (
        <ul className="op-items" aria-label="Queued and running operations">
          {[...pending].sort((a, b) => Number(b.phase === 'active') - Number(a.phase === 'active') || a.seq - b.seq).map((o) => (
            <li key={o.id} className="op-item" data-phase={o.phase}>
              <span className="op-item-main">
                <Badge tone={o.phase === 'active' ? 'info' : 'neutral'}>{entryState(o, engine)}</Badge>
                {o.label ? <span className="mono">{o.label}</span> : null}
                <span className="muted">
                  {o.phase === 'queued' ? 'queued for' : 'running for'} {elapsed(runningFor(o, now))} (elapsed, this tab’s clock)
                </span>
                <CancelButton o={o} engine={engine} onCancel={cancel} />
              </span>
              {o.phase === 'queued' ? <span className="op-reason">{queuedReason(o, ops, engine)}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-note">Nothing is queued or running.</p>
      )}
      {finished.length ? (
        <>
          <h4 className="op-subhead">Recent operations</h4>
          <ul className="op-items" aria-label="Recent operations">
            {finished.map((o) => (
              <li key={o.id} className="op-item" data-phase="settled">
                <span className="op-item-main">
                  <Badge tone={entryTone(o)}>{NOUN[o.kind].replace(/^./, (c) => c.toUpperCase())}</Badge>
                  {o.label ? <span className="mono">{o.label}</span> : null}
                  <span className="muted">{elapsed(runningFor(o, now))}</span>
                </span>
                <span className="op-reason">{entryState(o, engine, outcomeOf?.(o))}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
