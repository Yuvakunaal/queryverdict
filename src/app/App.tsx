import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { StatusStrip } from '../features/workspace/StatusStrip';
import { OperationDetails } from '../features/workspace/OperationDetails';
import { RecoveryNotice } from '../features/workspace/RecoveryNotice';
import { useNow } from '../features/workspace/useNow';
import { verdictOutcome } from '../features/workspace/operationModel';
import type { OperationEntry } from '../stores/operationStore';
import { Dialog } from '../ui/Dialog';
import type { OperationId } from '../core/engine/types';
import { ShortcutsDialog } from '../features/workspace/ShortcutsDialog';
import { detectPlatform } from '../features/workspace/shortcuts';
import { Workspace } from '../features/workspace/Workspace';
import { Button } from '../ui/Button';
import type { UiPrefsStore } from '../stores/uiPrefsStore';
import { statusText } from '../stores/engineStore';
import { LAYOUT_PRESETS, type WorkspaceStore } from '../stores/workspaceStore';
import type { EngineRuntime } from './bootstrap';
import { ErrorBoundary } from './ErrorBoundary';
import { SettingsDialog } from './SettingsDialog';

/**
 * Application shell (M01, workspace from M05): skip link, header with Shortcuts and Settings, the
 * SQL workspace (UI_SPECIFICATION §4) and the status strip with the one persistent status region.
 */
export function App({ prefs, runtime, workspace }: { prefs: UiPrefsStore; runtime: EngineRuntime; workspace: WorkspaceStore }) {
  const { theme, resolvedTheme } = useSyncExternalStore(prefs.subscribe, prefs.getSnapshot);
  const engine = useSyncExternalStore(runtime.engine.subscribe, runtime.engine.getSnapshot);
  const query = useSyncExternalStore(runtime.queries.subscribe, runtime.queries.getSnapshot);
  const ops = useSyncExternalStore(runtime.operations.subscribe, runtime.operations.getSnapshot);
  const recovery = useSyncExternalStore(runtime.recovery.subscribe, runtime.recovery.getSnapshot);
  const entries = useSyncExternalStore(runtime.datasets.registry.subscribe, runtime.datasets.registry.getSnapshot);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const pending = ops.some((o) => o.phase !== 'settled');
  const analysis = useSyncExternalStore(runtime.analyses.subscribe, runtime.analyses.getSnapshot);
  const reportView = useSyncExternalStore(runtime.reports.subscribe, runtime.reports.getSnapshot);
  // The latest analysis's operation shows the outcome the user got (its report), not only the engine terminal.
  const outcomeOf = useCallback(
    (o: OperationEntry) => (o.kind === 'verdict' && analysis.status === 'settled' && analysis.opId === o.id && reportView.report?.id === analysis.reportId && reportView.report ? verdictOutcome(reportView.report.status) : undefined),
    [analysis, reportView],
  );
  const now = useNow(pending || detailsOpen);
  // One cancellation path for every operation: the session's own (same as the handle's cancel).
  const cancelOperation = useCallback((id: OperationId) => void runtime.session.cancel(id), [runtime.session]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const shortcutsButton = useRef<HTMLButtonElement>(null);
  const focusEditor = useRef<(() => void) | null>(null);
  const platform = useMemo(() => detectPlatform(), []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);

  // One status region: it shows whichever happened last, an engine status change or an
  // announcement (import finished, table removed, name copied …).
  const announcement = useSyncExternalStore(runtime.announcer.subscribe, runtime.announcer.getSnapshot);
  const status = announcement?.message ?? statusText(engine);

  return (
    <div className="app">
      <a
        className="skip-link"
        href="#sql-editor-input"
        onClick={(e) => {
          e.preventDefault();
          focusEditor.current?.();
        }}
      >
        Skip to SQL editor
      </a>
      <header className="app-header">
        <p className="wordmark">
          QueryVerdict <span className="header-context">Local workspace</span>
        </p>
        <div className="header-actions">
          <Button ref={shortcutsButton} className="btn-small" variant="quiet" onClick={() => setShortcutsOpen(true)} aria-haspopup="dialog">
            Shortcuts
          </Button>
          <Button ref={settingsButton} className="btn-small" variant="quiet" onClick={() => setSettingsOpen(true)} aria-haspopup="dialog">
            Settings
          </Button>
        </div>
      </header>
      <RecoveryNotice view={recovery} engine={engine.state} entries={entries} registry={runtime.datasets.registry} recovery={runtime.recovery} announcer={runtime.announcer} onRetry={() => runtime.start()} />
      <main id="workspace" tabIndex={-1} className="app-main">
        <ErrorBoundary label="Workspace content">
          <h1 className="visually-hidden">SQL workspace</h1>
          <Workspace runtime={runtime} workspace={workspace} focusEditorRef={focusEditor} />
        </ErrorBoundary>
      </main>
      <StatusStrip
        engine={engine}
        message={status}
        ops={ops}
        now={now}
        onCancel={cancelOperation}
        transactionMayBeOpen={query.transactionMayBeOpen}
        onDetails={() => setDetailsOpen(true)}
        detailsRef={detailsButton}
      />
      <Dialog open={detailsOpen} title="Operation details" onClose={() => setDetailsOpen(false)} returnFocus={detailsButton} wide focusTitle>
        <OperationDetails
          ops={ops}
          engine={engine.state}
          info={engine.info}
          profile={runtime.profile}
          now={now}
          importedBytes={runtime.datasets.registry.importedBytes()}
          transactionMayBeOpen={query.transactionMayBeOpen}
          onCancel={cancelOperation}
          focusFallback={() => document.getElementById('opd-ops')}
          outcomeOf={outcomeOf}
        />
        <div className="dialog-actions">
          <Button variant="primary" onClick={() => setDetailsOpen(false)}>
            Close
          </Button>
        </div>
      </Dialog>
      <SettingsDialog
        open={settingsOpen}
        theme={theme}
        onThemeChange={prefs.setTheme}
        onLayoutPreset={(p) => workspace.setLayout(LAYOUT_PRESETS[p])}
        onClose={closeSettings}
        returnFocus={settingsButton}
      />
      <ShortcutsDialog open={shortcutsOpen} onClose={closeShortcuts} returnFocus={shortcutsButton} platform={platform} />
    </div>
  );
}
