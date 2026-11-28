import { useEffect, useState } from 'react';

/**
 * Page-clock "now" for elapsed-time display. While `active` (some operation is queued or running)
 * a once-a-second tick re-renders the caller; the interval is cleared when nothing runs or on
 * unmount. The value is only rendered outside live regions, so it is never announced.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(performance.now());
    const first = setTimeout(tick, 0); // take a fresh reading as soon as something runs
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [active]);
  return now;
}
