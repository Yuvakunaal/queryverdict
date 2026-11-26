import type { DataEpoch, Generation } from '../engine/types';

/** Identity of the engine state a result or report was produced on (docs/ARCHITECTURE.md §16). */
export interface Stamp {
  readonly generation: Generation;
  readonly epoch: DataEpoch;
}

/** A result is current only if both the engine generation and the data epoch are unchanged. */
export function isCurrent(stamp: Stamp, now: { generation: Generation | null; epoch: DataEpoch }): boolean {
  return now.generation !== null && stamp.generation === now.generation && stamp.epoch === now.epoch;
}
