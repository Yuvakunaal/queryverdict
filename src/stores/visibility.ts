// Background-tab reconciliation (ARCHITECTURE §12.5; M10). Browsers delay timers in hidden tabs,
// so time limits are enforced in the foreground only. When the page becomes visible again the
// session applies every overdue limit at once; this reports, once, exactly what that call did:
// queued operations it refused, and a running operation whose deadline it applied (a stop is then
// requested; whether and how it stopped is reported by that operation's own status). No elapsed
// time or progress is invented for the hidden period.
import type { EngineSession } from '../core/engine/session';
import type { Announcer } from './announcer';

/** Applies overdue limits now and returns a sentence about what this did (or null). */
export function reconcileVisible(session: EngineSession): string | null {
  if (session.state.kind === 'disposed') return null;
  const { expired, deadline } = session.reconcile();
  const parts: string[] = [];
  if (expired.length) parts.push(`${expired.length} queued ${expired.length === 1 ? 'operation was' : 'operations were'} not started because ${expired.length === 1 ? 'its' : 'their'} wait limit passed while the tab was in the background`);
  if (deadline) parts.push('the running operation reached its time limit while the tab was in the background, so a stop was requested');
  if (!parts.length) return null;
  return `Back in this tab: ${parts.join('; ')}. Time limits apply while the tab is visible.`;
}

/** Wires reconciliation to visibility changes; returns a function that removes the listener. */
export function followVisibility(doc: Document, session: EngineSession, announcer: Announcer): () => void {
  const onChange = () => {
    if (doc.visibilityState !== 'visible') return;
    const message = reconcileVisible(session);
    if (message) announcer.announce(message);
  };
  doc.addEventListener('visibilitychange', onChange);
  return () => doc.removeEventListener('visibilitychange', onChange);
}
