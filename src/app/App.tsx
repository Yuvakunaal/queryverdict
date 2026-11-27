import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Explorer } from '../features/explorer/Explorer';
import { Button } from '../ui/Button';
import { StatusRegion } from '../ui/StatusRegion';
import type { UiPrefsStore } from '../stores/uiPrefsStore';
import { statusText } from '../stores/engineStore';
import type { EngineRuntime } from './bootstrap';
import { ErrorBoundary } from './ErrorBoundary';
import { SettingsDialog } from './SettingsDialog';

/**
 * Application shell (docs/IMPLEMENTATION_PLAN.md M01): header, skip link, main landmark and the
 * persistent status region. Workspace features arrive in later modules.
 */
export function App({ prefs, runtime }: { prefs: UiPrefsStore; runtime: EngineRuntime }) {
  const { theme, resolvedTheme } = useSyncExternalStore(prefs.subscribe, prefs.getSnapshot);
  const engine = useSyncExternalStore(runtime.engine.subscribe, runtime.engine.getSnapshot);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // One status region: it shows whichever happened last, an engine status change or an
  // announcement (import finished, table removed, name copied …).
  const announcement = useSyncExternalStore(runtime.announcer.subscribe, runtime.announcer.getSnapshot);
  const status = announcement?.message ?? statusText(engine);

  return (
    <div className="app">
      <a className="skip-link" href="#workspace" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>
        Skip to workspace
      </a>
      <header className="app-header">
        <p className="wordmark">
          QueryVerdict <span className="header-context">Local workspace</span>
        </p>
        <Button ref={settingsButton} variant="quiet" onClick={() => setSettingsOpen(true)} aria-haspopup="dialog">
          Settings
        </Button>
      </header>
      <main id="workspace" ref={main} tabIndex={-1} className="app-main">
        <ErrorBoundary label="Workspace content">
          <h1 className="visually-hidden">Workspace</h1>
          <Explorer runtime={runtime} />
        </ErrorBoundary>
      </main>
      <footer className="status-strip">
        <StatusRegion message={status} />
        {engine.state.kind === 'failed' ? (
          <Button onClick={() => runtime.start()}>Retry</Button>
        ) : null}
      </footer>
      <SettingsDialog open={settingsOpen} theme={theme} onThemeChange={prefs.setTheme} onClose={closeSettings} returnFocus={settingsButton} />
    </div>
  );
}
