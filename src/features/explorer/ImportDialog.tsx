import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { DatasetEntry } from '../../core/datasets/types';
import type { ReleaseProfile } from '../../core/profile/profile';
import type { ImportStore } from '../../stores/importStore';
import { isActiveStage } from '../../stores/importStore';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { FileInput } from '../../ui/FileInput';
import { formatBytes, friendlyReason, importedBytes, reviewFiles, STAGE } from './model';

export interface ImportDialogProps {
  readonly open: boolean;
  onClose(): void;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly imports: ImportStore;
  readonly entries: readonly DatasetEntry[];
  readonly limits: ReleaseProfile['imports'];
  readonly engineReady: boolean;
}

const MIB = 1024 * 1024;

/**
 * Import dialog (UI_SPECIFICATION §3). Opens on the progress and outcome of every import that has
 * not been dismissed (so Cancel and the per-file results stay reachable after closing), or on the
 * file review when there is none. Admission and naming are previewed with the M03 rules; the
 * importer re-checks everything inside its operation and its per-file outcome is what is shown.
 */
export function ImportDialog({ open, onClose, returnFocus, imports, entries, limits, engineReady }: ImportDialogProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [edits, setEdits] = useState<(string | undefined)[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const progressHeading = useRef<HTMLHeadingElement>(null);
  const batches = useSyncExternalStore(imports.subscribe, imports.getSnapshot);
  const base = useId();
  const showProgress = !reviewing && batches.length > 0;

  // Keep keyboard focus inside the dialog when it changes phase (review → progress).
  const wasProgress = useRef(showProgress);
  useEffect(() => {
    if (open && showProgress && !wasProgress.current) progressHeading.current?.focus();
    wasProgress.current = showProgress;
  }, [open, showProgress]);

  const taken = useMemo(() => new Set(entries.filter((e) => e.state === 'ready' || e.state === 'changed').map((e) => e.relation)), [entries]);
  const review = useMemo(() => reviewFiles(files, edits, taken, limits, importedBytes(entries)), [files, edits, taken, limits, entries]);
  const importable = review.filter((r) => r.importable);
  const blocking = review.some((r) => r.nameError);
  const items = batches.flatMap((b) => b.items.map((i) => ({ ...i, batch: b.id })));
  const active = batches.filter((b) => b.items.some((i) => isActiveStage(i.progress.stage)));
  const count = (stage: string) => items.filter((i) => i.progress.stage === stage).length;

  const reason = !engineReady ? 'Import is available when the engine is ready.'
    : !files.length ? 'Choose at least one CSV or Parquet file.'
    : blocking ? 'Correct the highlighted table names to continue.'
    : !importable.length ? 'None of the chosen files can be imported.'
    : null;

  const addFiles = (more: File[]) => {
    setFiles((f) => [...f, ...more]);
    setEdits((e) => [...e, ...more.map(() => undefined)]);
  };
  const removeAt = (i: number) => {
    setFiles((f) => f.filter((_, j) => j !== i));
    setEdits((e) => e.filter((_, j) => j !== i));
    picker.current?.focus();
  };
  const start = () => {
    if (reason) return;
    const reqs = review.map((r, i) => (r.importable ? { file: files[i] as File, ...(r.requested ? { requestedName: r.requested } : {}) } : null)).filter((x) => x !== null);
    imports.start(reqs);
    setFiles([]);
    setEdits([]);
    setReviewing(false);
  };
  const close = () => {
    for (const b of batches) if (b.settled) imports.dismiss(b.id);
    setReviewing(false);
    setFiles([]);
    setEdits([]);
    onClose();
  };
  const reviewAgain = (batchId: number, file: File, requestedName?: string) => {
    imports.dismiss(batchId);
    setFiles([file]);
    setEdits([requestedName]);
    setReviewing(true);
  };

  return (
    <Dialog open={open} title="Import data" onClose={close} initialFocus={showProgress ? progressHeading : picker} returnFocus={returnFocus} wide>
      {showProgress ? (
        <div className="import-progress">
          <h3 className="dialog-subtitle" ref={progressHeading} tabIndex={-1}>
            Import progress
          </h3>
          <p className="dialog-text muted">
            {active.length ? 'Importing. You can close this dialog; imports continue and their results stay here.' : `Finished: ${count('done')} imported, ${count('failed')} failed, ${count('cancelled')} cancelled.`}
          </p>
          <ul className="file-list" aria-label="Import progress">
            {items.map((i) => (
              <li key={`${i.batch}-${i.progress.id}`} className="file-row" data-stage={i.progress.stage}>
                <div className="file-head">
                  <span className="file-name">{i.progress.fileName}</span>
                  <span className="file-status">
                    {i.progress.stage === 'done' ? (
                      <>
                        <Badge tone="success">Imported</Badge> as <span className="mono">{i.progress.relation}</span>
                      </>
                    ) : i.progress.stage === 'failed' ? (
                      <Badge tone="violation">Failed</Badge>
                    ) : i.progress.stage === 'cancelled' ? (
                      <Badge>Cancelled</Badge>
                    ) : (
                      <>
                        <Badge tone="info">{STAGE[i.progress.stage]}</Badge>
                        {i.progress.relation ? <> as <span className="mono">{i.progress.relation}</span></> : null}
                      </>
                    )}
                  </span>
                </div>
                {i.progress.stage === 'failed' ? <p className="field-error">{friendlyReason(i.progress.reason)}</p> : null}
                {(i.progress.stage === 'failed' || i.progress.stage === 'cancelled') && i.file && batches.find((b) => b.id === i.batch)?.settled ? (
                  <Button variant="quiet" className="btn-small" onClick={() => reviewAgain(i.batch, i.file as File, i.requestedName)}>
                    Review again<span className="visually-hidden"> {i.progress.fileName}</span>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="dialog-footer">
            <Button variant="quiet" onClick={() => setReviewing(true)} disabled={!engineReady}>
              Import more files
            </Button>
            <span className="actions-spacer" />
            {active.length ? (
              <Button variant="destructive" onClick={() => { for (const b of active) imports.cancel(b.id); }}>
                Cancel import
              </Button>
            ) : null}
            <Button variant={active.length ? 'secondary' : 'primary'} onClick={close}>
              {active.length ? 'Close' : 'Done'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="dialog-text muted">CSV or Parquet, imported as session tables. Files stay in this browser session; nothing is uploaded.</p>
          <FileInput
            ref={picker}
            label="Choose local files"
            accept=".csv,.parquet"
            hint={`Configured limits for this build: ${(limits.maxFileBytes / MIB).toFixed(0)} MiB per file, ${(limits.maxCombinedBytes / MIB).toFixed(0)} MiB in total. These are development limits, not a measured browser capacity.`}
            dropLabel="or drop files here"
            disabled={!engineReady}
            onFiles={addFiles}
          />
          {review.length ? (
            <ul className="file-list" aria-label="Files to import">
              {review.map((r, i) => {
                const id = `${base}-name-${i}`;
                return (
                  <li key={`${i}-${r.fileName}`} className="file-row" data-invalid={r.refusal || r.nameError ? true : undefined}>
                    <div className="file-head">
                      <span className="file-name">{r.fileName}</span>
                      <span className="file-meta">{formatBytes(r.bytes)}{r.format ? ` · ${r.format.toUpperCase()}` : ''}</span>
                      <Button variant="quiet" className="btn-small" onClick={() => removeAt(i)}>
                        Remove<span className="visually-hidden"> {r.fileName} from the list</span>
                      </Button>
                    </div>
                    {r.refusal ? (
                      <p className="field-error" id={`${id}-msg`}>
                        Not imported: {r.refusal}
                      </p>
                    ) : (
                      <div className="field field-inline">
                        <label htmlFor={id} className="field-label">
                          Table name<span className="visually-hidden"> for {r.fileName}</span>
                        </label>
                        <div className="field-body">
                          <input
                            id={id}
                            className="text-input mono"
                            value={edits[i] ?? r.proposed}
                            spellCheck={false}
                            autoComplete="off"
                            aria-invalid={r.nameError ? true : undefined}
                            aria-describedby={`${id}-msg`}
                            onChange={(e) => {
                              const v = e.currentTarget.value;
                              setEdits((all) => all.map((x, j) => (j === i ? v : x)));
                            }}
                          />
                          <p id={`${id}-msg`} className={r.nameError ? 'field-error' : 'field-hint'}>
                            {r.nameError ?? (r.requested ? 'Checked again when the import runs; it is never changed silently.' : 'Proposed name. If it is taken when the import runs, a number is added and the final name is shown.')}
                          </p>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div className="dialog-footer">
            <p className="footer-note" id={`${base}-reason`}>
              {reason ?? `${importable.length} ${importable.length === 1 ? 'file' : 'files'} ready to import.`}
            </p>
            <span className="actions-spacer" />
            <Button onClick={batches.length ? () => setReviewing(false) : close}>{batches.length ? 'Back to progress' : 'Cancel'}</Button>
            <Button variant="primary" onClick={start} disabled={reason !== null} aria-describedby={`${base}-reason`}>
              Import
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
