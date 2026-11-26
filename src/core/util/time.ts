/** Marker returned by within() when the bound expires first. */
export const TIMEOUT: unique symbol = Symbol('timeout');

/** Resolves with the promise's value, or TIMEOUT after `ms` (the promise keeps running). */
export function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<typeof TIMEOUT>((r) => { timer = setTimeout(() => r(TIMEOUT), Math.max(0, ms)); })]).finally(() => clearTimeout(timer));
}
