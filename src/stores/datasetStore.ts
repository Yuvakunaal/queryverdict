// Dataset inventory for React (docs/ARCHITECTURE.md §6.2). The registry itself is the store: its
// snapshot is derived from the engine catalog (src/core/datasets/reconcile.ts).
import type { DatasetEntry } from '../core/datasets/types';
import type { Store } from './createStore';

export type DatasetStore = Store<readonly DatasetEntry[]>;
