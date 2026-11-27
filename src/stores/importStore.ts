// Import batches for the explorer (M04). A thin view over the M03 importer: every admission,
// naming and transaction decision stays in src/core/datasets; this only keeps each batch's
// per-file progress and handles so the dialog and the dataset tree can show and cancel them.
// Rows in a non-terminal stage are the "Importing" entries of the tree (the registry lists only
// tables that exist in the catalog). Batches stay until dismissed, so their outcome and Cancel
// remain reachable after the dialog is closed; a File is released as soon as its import has
// succeeded (it is kept only for a failed or cancelled file, for "Review again").
import type { DatasetEntry, ImportProgress, ImportRequest, Importer } from '../core/datasets/types';
import type { OperationHandle } from '../core/engine/types';
import { createStore, type Store } from './createStore';

export interface ImportItem {
  readonly progress: ImportProgress;
  /** Present while the file may be needed again (in progress, failed or cancelled). */
  readonly file?: File;
  readonly requestedName?: string;
}

export interface ImportBatchView {
  readonly id: number;
  readonly items: readonly ImportItem[];
  /** Every file reached done, failed or cancelled. */
  readonly settled: boolean;
}

export interface ImportStore extends Store<readonly ImportBatchView[]> {
  start(reqs: readonly ImportRequest[]): number;
  /** Cancels every unfinished import of the batch (queued ones never start). */
  cancel(batchId: number): void;
  /** Forgets a settled batch and the Files it still holds. */
  dismiss(batchId: number): void;
  dispose(): void;
}

const ACTIVE = new Set<ImportProgress['stage']>(['queued', 'checking', 'reading', 'committing']);
export const isActiveStage = (s: ImportProgress['stage']) => ACTIVE.has(s);

interface Batch {
  files: (File | undefined)[];
  readonly names: readonly (string | undefined)[];
  readonly handles: readonly OperationHandle<DatasetEntry>[];
  readonly progress: Store<readonly ImportProgress[]>;
  readonly off: () => void;
  settled: boolean;
}

export function createImportStore(importer: Importer, onSettled?: (batch: ImportBatchView) => void): ImportStore {
  const store = createStore<readonly ImportBatchView[]>([]);
  const batches = new Map<number, Batch>();
  let next = 1;
  const view = (id: number, b: Batch): ImportBatchView => {
    const progress = b.progress.getSnapshot();
    return {
      id,
      settled: b.settled,
      items: b.names.map((requestedName, i) => {
        const p = progress.find((x) => x.id === `import-${i}`) ?? { id: `import-${i}`, fileName: b.files[i]?.name ?? '', stage: 'queued' as const };
        const file = b.files[i];
        return { progress: p, ...(file ? { file } : {}), ...(requestedName ? { requestedName } : {}) };
      }),
    };
  };
  const publish = () => store.set([...batches.entries()].map(([id, b]) => view(id, b)));
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    start(reqs) {
      const id = next++;
      const { handles, progress } = importer.import(reqs);
      const off = progress.subscribe(publish);
      const b: Batch = { files: reqs.map((r) => r.file), names: reqs.map((r) => r.requestedName), handles, progress, off, settled: false };
      batches.set(id, b);
      publish();
      void Promise.all(handles.map((h) => h.result)).then(() => {
        b.settled = true;
        // Release Files that are no longer needed (imported ones); keep failed or cancelled ones for "Review again".
        const p = b.progress.getSnapshot();
        b.files = b.files.map((f, i) => (p.find((x) => x.id === `import-${i}`)?.stage === 'done' ? undefined : f));
        publish();
        if (batches.has(id)) onSettled?.(view(id, b));
      });
      return id;
    },
    cancel(batchId) {
      for (const h of batches.get(batchId)?.handles ?? []) h.cancel();
    },
    dismiss(batchId) {
      const b = batches.get(batchId);
      if (!b || !b.settled) return;
      b.off();
      batches.delete(batchId);
      publish();
    },
    dispose() {
      for (const b of batches.values()) b.off();
      batches.clear();
    },
  };
}
