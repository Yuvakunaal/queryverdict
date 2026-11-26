import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../../src/stores/createStore';
import { createUiPrefsStore, resolveTheme, type DarkSchemeQuery } from '../../src/stores/uiPrefsStore';

function fakeQuery(initial: boolean) {
  let listener: (() => void) | null = null;
  const q: DarkSchemeQuery & { set(v: boolean): void; listeners(): number } = {
    matches: initial,
    addEventListener: (_t, l) => { listener = l; },
    removeEventListener: (_t, l) => { if (listener === l) listener = null; },
    set(v) { (q as { matches: boolean }).matches = v; listener?.(); },
    listeners: () => (listener ? 1 : 0),
  };
  return q;
}

describe('createStore', () => {
  it('notifies subscribers only when the snapshot changes, and unsubscribes', () => {
    const s = createStore(1);
    const l = vi.fn();
    const off = s.subscribe(l);
    s.set(1);
    expect(l).not.toHaveBeenCalled();
    s.set(2);
    expect(l).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot()).toBe(2);
    off();
    s.set(3);
    expect(l).toHaveBeenCalledTimes(1);
  });
});

describe('theme preferences (session only)', () => {
  it('resolves system from the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('defaults to System and follows OS changes live', () => {
    const q = fakeQuery(false);
    const s = createUiPrefsStore(q);
    expect(s.getSnapshot()).toEqual({ theme: 'system', resolvedTheme: 'light' });
    q.set(true);
    expect(s.getSnapshot()).toEqual({ theme: 'system', resolvedTheme: 'dark' });
  });

  it('a manual choice overrides the OS until System is chosen again', () => {
    const q = fakeQuery(true);
    const s = createUiPrefsStore(q);
    s.setTheme('light');
    q.set(true);
    expect(s.getSnapshot()).toEqual({ theme: 'light', resolvedTheme: 'light' });
    s.setTheme('system');
    expect(s.getSnapshot().resolvedTheme).toBe('dark');
  });

  it('works without prefers-color-scheme (light) and detaches its listener on dispose', () => {
    expect(createUiPrefsStore(null).getSnapshot()).toEqual({ theme: 'system', resolvedTheme: 'light' });
    const q = fakeQuery(false);
    const s = createUiPrefsStore(q);
    expect(q.listeners()).toBe(1);
    s.dispose();
    expect(q.listeners()).toBe(0);
  });
});
