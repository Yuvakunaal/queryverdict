import { useRef, useState } from 'react';
import type { DatasetEntry, DatasetRegistry } from '../../core/datasets/types';
import type { Announcer } from '../../stores/announcer';
import type { ImportStore } from '../../stores/importStore';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { copyText, isPresent } from './model';

export interface DatasetActionsProps {
  readonly entry: DatasetEntry;
  /** The name alone is shared with another relation: show and copy the qualified name. */
  readonly qualified: boolean;
  readonly registry: DatasetRegistry;
  readonly imports: ImportStore;
  readonly announcer: Announcer;
  readonly engineReady: boolean;
  onPreview(): void;
  onViewSchema(): void;
}

const outcome = (t: { status: string; reason?: string; message?: string }) => t.reason ?? t.message ?? t.status;

/**
 * Dataset actions (UI_SPECIFICATION §3): Preview, View schema, Copy table name, Remove, and
 * Re-import / Choose file again when an imported table was lost. Remove carries the exact
 * identity of the selected entry (origin, database, schema, oid) through confirmation; the
 * registry re-checks it inside the operation and refuses if the table was replaced meanwhile.
 */
export function DatasetActions({ entry, qualified, registry, imports, announcer, engineReady, onPreview, onViewSchema }: DatasetActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const present = isPresent(entry);
  const canPreview = present && entry.kind === 'table';
  const lost = entry.origin === 'imported' && (entry.state === 'needs-reimport' || entry.state === 'failed');
  const name = copyText(entry.relation, qualified && entry.identity ? entry.identity : undefined);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(name);
      announcer.announce(`Copied ${name} to the clipboard.`);
    } catch {
      announcer.announce(`Could not copy to the clipboard. The table name is ${name}.`);
    }
  };

  const remove = async () => {
    setConfirming(false);
    if (!entry.identity) return;
    setBusy('Removing…');
    const { database, schema, oid } = entry.identity;
    const r = await registry.remove(entry.relation, { origin: entry.origin, database, schema, oid }).result;
    setBusy(null);
    announcer.announce(r.terminal.status === 'ok' ? `Removed ${name}.` : `Could not remove ${name}: ${outcome(r.terminal)}`);
  };

  const reimport = async () => {
    setBusy('Re-importing…');
    const r = await registry.reimport(entry.relation).result;
    setBusy(null);
    announcer.announce(r.terminal.status === 'ok' ? `Re-imported ${entry.relation}.` : `Re-import of ${entry.relation} did not complete: ${outcome(r.terminal)}`);
  };

  const removeText = present
    ? `This drops the ${entry.kind === 'view' ? 'view' : 'table'} ${name} from this browser session. Queries that use it will fail.${entry.origin === 'imported' ? ' The imported data is discarded; import the file again to restore it.' : ''}`
    : `${name} is no longer in the engine. This removes it from the list and forgets the original file.`;

  return (
    <div className="dataset-actions" role="group" aria-label={`Actions for ${entry.relation}`}>
      <Button variant="primary" className="btn-small" onClick={onPreview} disabled={!canPreview || !engineReady || busy !== null} aria-describedby={!canPreview ? 'preview-unavailable' : undefined}>
        Preview
      </Button>
      <Button className="btn-small" onClick={onViewSchema}>View schema</Button>
      <Button className="btn-small" onClick={() => void copy()}>Copy table name</Button>
      {lost ? (
        <>
          <Button className="btn-small" onClick={() => void reimport()} disabled={!engineReady || busy !== null}>
            Re-import
          </Button>
          <Button className="btn-small" onClick={() => picker.current?.click()} disabled={!engineReady || busy !== null}>
            Choose file again
          </Button>
          <input
            ref={picker}
            type="file"
            accept=".csv,.parquet"
            hidden
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (!f) return;
              // Imported under the original name; the importer refuses it if the name is taken.
              imports.start([{ file: f, requestedName: entry.relation }]);
              announcer.announce(`Importing ${f.name} as ${entry.relation}.`);
            }}
          />
        </>
      ) : null}
      <span className="actions-spacer" />
      {busy ? <span className="action-busy">{busy}</span> : null}
      <Button ref={removeButton} variant="quiet-destructive" className="btn-small" onClick={() => setConfirming(true)} disabled={busy !== null || (present && !engineReady) || !entry.identity}>
        Remove
      </Button>
      {!canPreview ? (
        <span id="preview-unavailable" className="action-note">
          {entry.kind === 'view' ? 'Preview is available for tables. Query the view with SQL instead.' : 'Preview needs the table to be in this session.'}
        </span>
      ) : null}
      <Dialog open={confirming} title={`Remove ${name}?`} onClose={() => setConfirming(false)} initialFocus={cancelButton} returnFocus={removeButton}>
        <p className="dialog-text">{removeText}</p>
        <div className="dialog-actions">
          <Button ref={cancelButton} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void remove()}>
            Remove
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
