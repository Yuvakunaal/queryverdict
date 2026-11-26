// Session-only UI preferences (docs/ARCHITECTURE.md §18.1, AM-021): nothing is written to
// browser storage. Theme "system" follows prefers-color-scheme live.
import { createStore, type Store } from './createStore';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export interface UiPrefs {
  readonly theme: ThemeChoice;
  readonly resolvedTheme: ResolvedTheme;
}

/** The subset of MediaQueryList the store needs (injectable for tests). */
export interface DarkSchemeQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface UiPrefsStore extends Store<UiPrefs> {
  setTheme(theme: ThemeChoice): void;
  dispose(): void;
}

export function resolveTheme(theme: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

/** `query` is null when prefers-color-scheme is unavailable; System then resolves to light. */
export function createUiPrefsStore(query: DarkSchemeQuery | null): UiPrefsStore {
  const systemDark = () => query?.matches === true;
  const store = createStore<UiPrefs>({ theme: 'system', resolvedTheme: resolveTheme('system', systemDark()) });
  const onSchemeChange = () => {
    const { theme } = store.getSnapshot();
    store.set({ theme, resolvedTheme: resolveTheme(theme, systemDark()) });
  };
  query?.addEventListener('change', onSchemeChange);
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    setTheme(theme) {
      const current = store.getSnapshot();
      const resolvedTheme = resolveTheme(theme, systemDark());
      if (current.theme === theme && current.resolvedTheme === resolvedTheme) return;
      store.set({ theme, resolvedTheme });
    },
    dispose() {
      query?.removeEventListener('change', onSchemeChange);
    },
  };
}

/** Browser default: the live prefers-color-scheme query, if supported. */
export function browserDarkSchemeQuery(): DarkSchemeQuery | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
}
