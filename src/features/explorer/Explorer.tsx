import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { EngineRuntime } from '../../app/bootstrap';
import { isActiveStage } from '../../stores/importStore';
import { Button } from '../../ui/Button';
import { DatasetTree } from './DatasetTree';
import { ImportDialog } from './ImportDialog';
import { Inspector, type InspectorTab } from './Inspector';
import { entryKey, isAmbiguous } from './model';

/** The explorer's parts, placed by the workspace layout (M05). */
export interface ExplorerParts {
  /** The datasets sidebar (a drawer below 900 px). */
  readonly sidebar: ReactNode;
  /** Opens and closes the datasets drawer (shown only below 900 px). */
  readonly drawerToggle: ReactNode;
  /** The inspector for the selected dataset, or a prompt to select one. */
  readonly detail: ReactNode;
  /** The getting-started block while the workspace has no datasets (null otherwise). */
  readonly getStarted: ReactNode;
  /** The import dialog (rendered once, wherever the layout puts it). */
  readonly dialog: ReactNode;
  /** Name of the selected dataset, if any. */
  readonly selectedName: string | null;
}

export interface ExplorerOptions {
  /** Called when the user selects a dataset (the workspace shows the Dataset view). */
  onSelect?(): void;
}

/**
 * Dataset explorer (M04, placed in the M05 workspace): the datasets sidebar, the import dialog and
 * the inspector. All dataset state comes from the registry; import progress from the importer.
 */
export function useExplorer(runtime: EngineRuntime, options: ExplorerOptions = {}): ExplorerParts {
  const { datasets, imports, preview, announcer, profile } = runtime;
  const entries = useSyncExternalStore(datasets.registry.subscribe, datasets.registry.getSnapshot);
  const batches = useSyncExternalStore(imports.subscribe, imports.getSnapshot);
  const engine = useSyncExternalStore(runtime.engine.subscribe, runtime.engine.getSnapshot);
  const report = useSyncExternalStore(runtime.reports.subscribe, runtime.reports.getSnapshot);
  const engineReady = engine.state.kind === 'ready' || engine.state.kind === 'busy';
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<InspectorTab>('schema');
  const [importOpen, setImportOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const sidebarImport = useRef<HTMLButtonElement>(null);
  const datasetsHeading = useRef<HTMLHeadingElement>(null);
  const lostSql = useRef<{ generation: number | null; names: string[] }>({ generation: engine.generation, names: [] });
  const [sqlLost, setSqlLost] = useState<string[]>([]);

  const entry = entries.find((e) => entryKey(e) === selected) ?? null;
  const importing = batches.flatMap((b) => b.items.filter((i) => isActiveStage(i.progress.stage)));

  // Tables created by SQL are not tracked across a restart; tell the user which ones were lost.
  useEffect(() => {
    const prev = lostSql.current;
    if (engine.generation !== prev.generation && prev.generation !== null && engine.generation !== null && prev.names.length) {
      setSqlLost(prev.names);
      announcer.announce(`The engine restarted. ${prev.names.length} ${prev.names.length === 1 ? 'table' : 'tables'} created by SQL must be recreated.`);
    }
    if (engine.state.kind === 'ready') lostSql.current = { generation: engine.generation, names: entries.filter((e) => e.origin === 'sql').map((e) => e.relation) };
  }, [engine.generation, engine.state.kind, entries, announcer]);

  // A removed or vanished selection: drop its preview and keep keyboard focus in the explorer
  // (focus would otherwise fall back to the page when the inspector disappears).
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current && !entry) {
      preview.clear();
      const a = document.activeElement;
      const kept = a instanceof HTMLElement && a.isConnected && (a.closest('#datasets-panel') !== null || a.closest('dialog[open]') !== null);
      if (!kept) datasetsHeading.current?.focus();
    }
    shown.current = entry !== null;
  }, [entry, preview]);

  // After choosing a dataset in the narrow drawer (which then closes), focus moves to the inspector
  // heading so keyboard users continue from what they selected instead of the page.
  const focusInspector = useRef(false);
  useEffect(() => {
    if (focusInspector.current && entry) {
      focusInspector.current = false;
      document.getElementById('inspector-title')?.focus();
    }
  }, [entry, drawerOpen]);

  const onSelect = options.onSelect;
  const select = useCallback((key: string) => {
    if (key !== selected) {
      preview.clear(); // selecting never starts work; any previous preview is discarded
      setTab('schema');
    }
    setSelected(key);
    onSelect?.();
    if (drawerOpen) {
      focusInspector.current = true;
      setDrawerOpen(false);
    }
  }, [selected, preview, drawerOpen, onSelect]);

  const toggle = useCallback((key: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }, []);

  // Focus returns to the control that opened the dialog, or to "+ Import" when that control is gone
  // (the empty state is replaced once datasets exist).
  const returnFocus = useMemo(() => ({
    get current(): HTMLElement | null {
      return opener.current?.isConnected ? opener.current : sidebarImport.current;
    },
  }), []);

  const openImport = (from: HTMLElement | null) => {
    opener.current = from ?? sidebarImport.current;
    setImportOpen(true);
  };

  const drawerToggle = (
    <Button className="drawer-toggle" aria-expanded={drawerOpen} aria-controls="datasets-panel" onClick={() => setDrawerOpen((o) => !o)}>
      Datasets ({entries.length})
    </Button>
  );

  const sidebar = (
    <aside id="datasets-panel" className="sidebar" data-open={drawerOpen || undefined} aria-labelledby="datasets-heading">
      <div className="sidebar-head">
        <h2 id="datasets-heading" ref={datasetsHeading} tabIndex={-1}>
          <span id="datasets-title">Datasets</span> {entries.length ? <span className="count">{entries.length}</span> : null}
        </h2>
        <Button ref={sidebarImport} className="btn-small" onClick={(e) => openImport(e.currentTarget)} disabled={!engineReady}>
          + Import
        </Button>
      </div>
      {!engineReady ? <p className="sidebar-note">Import is available when the engine is ready.</p> : null}
      {sqlLost.length ? (
        <p className="sidebar-note" data-tone="warning">
          The engine restarted. Tables created by SQL were lost and must be recreated: <span className="mono">{sqlLost.join(', ')}</span>.{' '}
          <Button variant="quiet" onClick={() => setSqlLost([])}>Dismiss</Button>
        </p>
      ) : null}
      <div className="sidebar-list">
        {entries.length || importing.length ? (
          <DatasetTree entries={entries} importing={importing} selected={selected} expanded={expanded} onSelect={select} onToggle={toggle} onShowImports={() => openImport(null)} />
        ) : (
          <p className="sidebar-note">No datasets yet.</p>
        )}
      </div>
      <div className="sidebar-foot">
        <strong>Session tables</strong>
        <p>Reloading clears this workspace.</p>
      </div>
    </aside>
  );

  const detail = (
    <div className="explorer-main">
      {entry ? (
        <Inspector entry={entry} qualified={isAmbiguous(entry, entries)} tab={tab} onTab={setTab} registry={datasets.registry} imports={imports} preview={preview} announcer={announcer} profile={profile} engineReady={engineReady} report={report} />
      ) : (
        <section className="empty-state" aria-labelledby="explorer-empty">
          <h2 id="explorer-empty">Select a dataset</h2>
          <p className="muted">
            {entries.length
              ? 'Choose a dataset in the list to see its schema. Sample rows are read only when you ask for a preview.'
              : 'Import a CSV or Parquet file, then choose it in the Datasets list to see its schema.'}
          </p>
        </section>
      )}
    </div>
  );

  const getStarted = entries.length ? null : (
    <section className="empty-state" aria-labelledby="get-started">
      <h2 id="get-started">Get started</h2>
      <p>Files stay in this browser session.</p>
      <Button variant="primary" onClick={(e) => openImport(e.currentTarget)} disabled={!engineReady}>
        Import CSV or Parquet
      </Button>
      <ol className="next-steps">
        <li>Import one or more CSV or Parquet files as session tables.</li>
        <li>Select a dataset to see its columns and types.</li>
        <li>Preview its first rows when you need them.</li>
      </ol>
    </section>
  );

  const dialog = <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} returnFocus={returnFocus} imports={imports} entries={entries} limits={profile.imports} engineReady={engineReady} />;

  return { sidebar, drawerToggle, detail, getStarted, dialog, selectedName: entry?.relation ?? null };
}
