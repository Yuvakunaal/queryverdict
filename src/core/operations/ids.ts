import type { OperationId } from '../engine/types';

let counter = 0;

/** Unique, opaque operation id (contains no user data). */
export function newOperationId(): OperationId {
  counter += 1;
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `op-${counter}-${random}` as OperationId;
}
