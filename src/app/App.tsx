import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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

  return (
    <div className="app">
      <a className="skip-link" href="#workspace" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>
        Skip to workspace
      </a>
      <header className="app-header">
        <p className="wordmark">QueryVerdict</p>
        <Button ref={settingsButton} variant="quiet" onClick={() => setSettingsOpen(true)} aria-haspopup="dialog">
          Settings
        </Button>
      </header>
      <main id="workspace" ref={main} tabIndex={-1} className="app-main">
        <ErrorBoundary label="Workspace content">
          <h1>Workspace</h1>
          <p className="muted">The workspace is being built. Datasets, the SQL editor and Verdict arrive in later modules.</p>
        </ErrorBoundary>
      </main>
      <footer className="status-strip">
        <StatusRegion message={statusText(engine)} />
        {engine.state.kind === 'failed' ? (
          <Button onClick={() => runtime.start()}>Retry</Button>
        ) : null}
      </footer>
      <SettingsDialog open={settingsOpen} theme={theme} onThemeChange={prefs.setTheme} onClose={closeSettings} returnFocus={settingsButton} />
    </div>
  );
}
