import { useEffect, useRef, useState } from 'react';
import type { DatasetEntry, DatasetRegistry } from '../../core/datasets/types';
import type { SessionState } from '../../core/engine/types';
import type { Announcer } from '../../stores/announcer';
import type { RecoveryStore, RecoveryView } from '../../stores/recoveryStore';
import { Button } from '../../ui/Button';

export interface RecoveryNoticeProps {
  readonly view: RecoveryView;
  readonly engine: SessionState;
  readonly entries: readonly DatasetEntry[];
  readonly registry: DatasetRegistry;
  readonly recovery: RecoveryStore;
  readonly announcer: Announcer;
  onRetry(): void;
}

/** Browser capabilities the engine needs that this browser does not provide (Codex M10). */
export function missingCapabilities(reason?: string): string[] {
  const g = globalThis as { WebAssembly?: unknown; Worker?: unknown };
  const out: string[] = [];
  if (typeof g.WebAssembly === 'undefined' || /WebAssembly is not defined/i.test(reason ?? '')) out.push('WebAssembly');
  if (typeof g.Worker === 'undefined' || /Worker is not defined/i.test(reason ?? '')) out.push('Web Workers');
  return out;
}

/** The session's recovery reason in plain words (the reason text itself stays visible). */
function why(reason: string | undefined): string {
  if (!reason) return 'The engine had to be replaced.';
  if (/could not be stopped|did not stop/.test(reason)) return 'An operation did not stop within its cancel time, so the engine running it was stopped.';
  if (/cleanup could not be confirmed/.test(reason)) return 'Clean-up after an operation could not be confirmed, so the engine was replaced to be safe.';
  if (/result stream/.test(reason)) return 'A result stream could not be confirmed stopped, so the engine was replaced.';
  return 'The engine was replaced.';
}

/**
 * Engine recovery and failure (UI_SPECIFICATION §6; ARCHITECTURE §12.4; M10): why it happened,
 * that the old worker was stopped and its in-memory tables are gone, which imported tables can be
 * re-imported (one explicit action each; nothing happens automatically), which tables created by
 * SQL must be recreated, and Retry when the engine failed. It never moves focus.
 */
export function RecoveryNotice({ view, engine, entries, registry, recovery, announcer, onRetry }: RecoveryNoticeProps) {
  const [busy, setBusy] = useState<string | null>(null);
  // Focus after Retry (Codex M10): when the focused Retry disappears (the engine started, or the
  // notice changed), focus moves to the notice heading, or to the workspace if the notice is gone.
  const retried = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!retried.current) return;
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== document.body && a.isConnected && !(a instanceof HTMLButtonElement && a.disabled)) return;
    if (engine.kind === 'starting') return; // Retrying…: wait for the outcome
    retried.current = false;
    (heading.current ?? document.getElementById('workspace'))?.focus();
  });
  const retry = () => {
    retried.current = true;
    onRetry();
  };
  const lostImports = entries.filter((e) => e.origin === 'imported' && (e.state === 'needs-reimport' || e.state === 'failed'));
  if (view.phase === 'none') return null;
  const reimport = async (relation: string) => {
    setBusy(relation);
    const r = await registry.reimport(relation).result;
    setBusy(null);
    announcer.announce(r.terminal.status === 'ok' ? `Re-imported ${relation}.` : `Re-import of ${relation} did not complete.`);
  };

  if (view.phase === 'recovering') {
    return (
      <section className="recovery-notice" data-tone="warning" aria-labelledby="recovery-title">
        <h2 id="recovery-title" className="recovery-title" ref={heading} tabIndex={-1}>Recovering engine…</h2>
        <p>{why(view.reason)} A new engine is starting and its security settings are checked before it accepts SQL.</p>
        <p>The tables in the old engine’s memory are lost. Nothing is re-imported or re-run automatically; your SQL text stays as it is.</p>
        <p className="recovery-reason">Reason reported by the engine: {view.reason}</p>
      </section>
    );
  }

  if (view.phase === 'recovery-failed' || view.phase === 'start-failed') {
    const missing = missingCapabilities(view.failure ?? view.reason);
    if (missing.length) {
      // Not recoverable by retrying: say what is missing and what to use instead.
      return (
        <section className="recovery-notice" data-tone="violation" aria-labelledby="recovery-title">
          <h2 id="recovery-title" className="recovery-title" ref={heading} tabIndex={-1}>This browser cannot run the QueryVerdict engine</h2>
          <p>
            The engine needs {missing.join(' and ')}, which this browser does not provide or has turned off. SQL, import and Analyze are unavailable. Use a current version of Chrome, Edge, Firefox or Safari, with {missing.join(' and ')} enabled.
          </p>
          <p className="muted">Nothing was loaded and nothing left this device.</p>
        </section>
      );
    }
    const starting = engine.kind === 'starting';
    return (
      <section className="recovery-notice" data-tone="violation" aria-labelledby="recovery-title">
        <h2 id="recovery-title" className="recovery-title" ref={heading} tabIndex={-1}>{view.phase === 'recovery-failed' ? 'Engine recovery failed' : 'The engine could not start'}</h2>
        <p>SQL, import and Analyze are unavailable until an engine starts with its security settings verified.{view.phase === 'recovery-failed' ? ' The tables in the old engine’s memory are lost.' : ''}</p>
        <p className="recovery-reason">Reason: {view.failure ?? view.reason}</p>
        <p className="recovery-actions">
          <Button className="btn-small" onClick={retry} disabled={starting} aria-disabled={starting}>
            {starting ? 'Retrying…' : 'Retry'}
          </Button>
          <span className="muted">If it keeps failing, reload the page. Reloading clears this workspace.</span>
        </p>
      </section>
    );
  }

  // Recovered.
  return (
    <section className="recovery-notice" data-tone="neutral" aria-labelledby="recovery-title">
      <h2 id="recovery-title" className="recovery-title" ref={heading} tabIndex={-1}>The engine was restarted</h2>
      <p>
        {why(view.reason)} Its in-memory tables were lost. Results, previews and Verdict reports from before are marked historical; nothing was re-run. Your SQL text is unchanged.
      </p>
      {lostImports.length ? (
        <div className="recovery-group">
          <p>
            <strong>Imported files to re-import:</strong> this tab kept each file, so Re-import reads it again. If a file was moved or changed, use Choose file again in Datasets.
          </p>
          <ul className="recovery-list">
            {lostImports.map((e) => (
              <li key={e.relation}>
                <span className="mono">{e.relation}</span>
                {e.state === 'failed' ? <span className="muted"> — the last re-import failed: {e.reason}</span> : null}
                <Button className="btn-small" variant="quiet" onClick={() => void reimport(e.relation)} disabled={busy !== null || engine.kind !== 'ready'}>
                  {busy === e.relation ? `Re-importing ${e.relation}…` : `Re-import ${e.relation}`}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.lostSqlTables.length ? (
        <p>
          Tables created by SQL were lost and must be recreated: <span className="mono">{view.lostSqlTables.join(', ')}</span>. Run their CREATE statements again.
        </p>
      ) : null}
      {view.lostSqlIncomplete ? (
        <p>
          {view.lostSqlTables.length ? 'This list may be incomplete: ' : ''}data changed after the dataset list was last read, so tables created by SQL since then may also have been lost and need to be recreated.
        </p>
      ) : null}
      <p className="recovery-actions">
        <Button className="btn-small" variant="quiet" onClick={() => recovery.dismiss()}>
          Dismiss
        </Button>
      </p>
    </section>
  );
}
