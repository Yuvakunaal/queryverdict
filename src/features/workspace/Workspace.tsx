import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MutableRefObject } from 'react';
import type { EngineRuntime } from '../../app/bootstrap';
import type { OutputView, QueryRequest, WorkspaceStore } from '../../stores/workspaceStore';
import { Button } from '../../ui/Button';
import { TabList } from '../../ui/Tabs';
import { useExplorer } from '../explorer/Explorer';
import { LANGUAGE_LABEL } from '../editor/editorTheme';
import { SqlEditor, type CursorPosition } from '../editor/SqlEditor';
import { EDITOR_PANEL_ID, EDITOR_TITLE_ID, Layout, NARROW_QUERY, OUTPUT_PANEL_ID, useMediaQuery } from './Layout';
import { detectPlatform, keyLabel, shortcutFor } from './shortcuts';
import { ResultsPanel } from '../results/ResultsPanel';
import { isActive, type QueryState } from '../../stores/queryStore';
import { splitStatements, statementAt } from '../../core/query/sqlText';

/**
 * What Analyze does with the current query. Run SQL is connected to the query runner (M06); the
 * Verdict view arrives in M09, which supplies `analyze` here. Until then the workspace says
 * plainly that nothing was analyzed.
 */
export interface QueryActions {
  analyze?(request: QueryRequest): void;
}

export const EDITOR_INPUT_ID = 'sql-editor-input';
const OUTPUT_VIEW_ID = 'ws-output-view';
const HINT_ID = 'sql-editor-hint';

type NarrowView = 'editor' | OutputView;

const OUTPUT_TABS: readonly { id: OutputView; label: string }[] = [
  { id: 'results', label: 'Results' },
  { id: 'verdict', label: 'Verdict' },
  { id: 'dataset', label: 'Dataset' },
];

export const NOT_CONNECTED = {
  analyze: 'Analyze is not available in this version yet. Nothing was analyzed.',
  empty: 'The editor is empty. Write a query first.',
} as const;

/**
 * Run SQL and Analyze chords belong to the editor only. On a focused button, Firefox treats
 * Cmd/Ctrl+Enter as activation, so a focused Analyze would run on "Run SQL" and vice versa.
 * Outside the editor these chords do nothing; plain Enter and Space still activate buttons.
 */
function blockActionChords(e: KeyboardEvent) {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
  if (e.target instanceof Element && e.target.closest('.cm-editor')) return; // the editor's own keymap
  e.preventDefault();
}

const visible = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0;

export interface WorkspaceProps {
  readonly runtime: EngineRuntime;
  readonly workspace: WorkspaceStore;
  /** Optional implementations from later modules; absent in M05. */
  readonly actions?: QueryActions;
  /** Set to a function that shows and focuses the editor (used by the skip link). */
  readonly focusEditorRef?: MutableRefObject<(() => void) | null>;
}

export function Workspace({ runtime, workspace, actions, focusEditorRef }: WorkspaceProps) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const query = useSyncExternalStore(runtime.queries.subscribe, runtime.queries.getSnapshot);
  const running = isActive(query.state);
  // When a run ends, Cancel disappears; if it had focus, focus moves to Run SQL instead of the page.
  const runButton = useRef<HTMLButtonElement>(null);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && (document.activeElement === document.body || document.activeElement === null)) runButton.current?.focus();
    wasRunning.current = running;
  }, [running]);
  // A shown result becomes historical once the editor text no longer matches its SQL.
  useEffect(() => runtime.queries.noteEditorText(state.sql), [runtime.queries, state.sql]);
  const narrow = useMediaQuery(NARROW_QUERY);
  const [narrowView, setNarrowView] = useState<NarrowView>('editor');
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1, selected: 0, from: 0, to: 0, head: 0 });
  // The editor's selection at the moment of Run (read in the action, not rendered).
  const selection = useRef<CursorPosition | null>(null);
  const onCursor = useCallback((c: CursorPosition) => {
    selection.current = c;
    setCursor(c);
  }, []);
  const platform = useMemo(() => detectPlatform(), []);
  const runKeys = shortcutFor(platform, 'Run SQL');
  const analyzeKeys = shortcutFor(platform, 'Analyze');
  const narrowBase = useId();
  const outputBase = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const { announcer } = runtime;

  // Selecting a dataset shows the Dataset view (it reads the catalog only; no SQL runs).
  const onSelect = useCallback(() => {
    workspace.setOutput('dataset');
    setNarrowView('dataset');
  }, [workspace]);
  const explorer = useExplorer(runtime, { onSelect });

  const submit = useCallback(
    (kind: 'run' | 'analyze') => {
      const sql = workspace.getSnapshot().sql;
      const request = workspace.request(kind, sql);
      // Narrow screens keep the editor (and focus) where it is; the status region reports the outcome.
      // Run SQL (Snowflake-style, P-097): a selection runs every statement in it; otherwise the
      // statement at the cursor runs. The runner refuses an empty set itself, with nothing run.
      if (kind === 'run') {
        const sel = selection.current;
        const picked = sel && sel.to > sel.from ? splitStatements(sql.slice(sel.from, sel.to)).map((x) => x.text) : [statementAt(sql, sel?.head ?? sql.length)?.text].filter((x): x is string => !!x);
        // An empty editor is reported as such (the runner refuses it with nothing run).
        const statements = picked.length || sql.trim() !== '' ? picked : [sql];
        return runtime.queries.run(statements, sql);
      }
      const impl = actions?.analyze;
      if (sql.trim() === '') announcer.announce(NOT_CONNECTED.empty);
      else if (impl) impl.call(actions, request);
      else announcer.announce(NOT_CONNECTED.analyze);
    },
    [workspace, actions, announcer, runtime.queries],
  );
  const run = useCallback(() => submit('run'), [submit]);
  const analyze = useCallback(() => submit('analyze'), [submit]);

  useEffect(() => {
    if (!focusEditorRef) return;
    focusEditorRef.current = () => {
      setNarrowView('editor');
      // The editor panel may have been hidden on narrow screens; focus after it is shown.
      requestAnimationFrame(() => document.getElementById(EDITOR_INPUT_ID)?.focus());
    };
    return () => {
      focusEditorRef.current = null;
    };
  }, [focusEditorRef]);

  // Focus continuity across the 900 px breakpoint (Codex M05): the narrow view follows the pane
  // that held focus, and a focused control that disappears hands focus to its visible equivalent.
  const lastFocus = useRef<Element | null>(null);
  useEffect(() => {
    const track = (e: FocusEvent) => {
      lastFocus.current = e.target as Element;
    };
    document.addEventListener('focusin', track);
    return () => document.removeEventListener('focusin', track);
  }, []);
  const wasNarrow = useRef(narrow);
  useLayoutEffect(() => {
    if (wasNarrow.current === narrow) return;
    wasNarrow.current = narrow;
    const prev = lastFocus.current;
    const inOutput = !!prev?.closest(`#${OUTPUT_PANEL_ID}`) || !!prev?.closest('.output-bar');
    let view: NarrowView = narrowView;
    if (narrow) {
      view = inOutput ? workspace.getSnapshot().output : 'editor';
      setNarrowView(view);
    }
    const frame = requestAnimationFrame(() => {
      if (visible(document.activeElement) && document.activeElement !== document.body) return;
      const byId = (id: string) => document.getElementById(id);
      let target: Element | null = null;
      if (prev && visible(prev)) target = prev;
      else if (prev?.closest('.view-tabs')) target = view === 'editor' ? byId(EDITOR_INPUT_ID) : byId(`${outputBase}-tab-${workspace.getSnapshot().output}`);
      else if (prev?.closest('.output-bar')) target = byId(`${narrowBase}-tab-${workspace.getSnapshot().output}`);
      else if (prev?.closest('.drawer-toggle')) target = byId('datasets-heading');
      else if (prev?.closest('#datasets-panel')) target = document.querySelector('.drawer-toggle');
      else if (prev?.closest(`#${EDITOR_PANEL_ID}`)) target = byId(EDITOR_INPUT_ID);
      if (visible(target)) target.focus();
    });
    return () => cancelAnimationFrame(frame);
    // Runs on breakpoint changes only; the other values are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);

  const outputView: OutputView = narrow && narrowView !== 'editor' ? narrowView : state.output;
  // Narrow screens keep the editor and its trigger in view, so the latest action's notice is shown
  // beside the actions instead of in a hidden output view.
  const latest = [state.lastRun, state.lastAnalyze].filter((r): r is QueryRequest => r !== null).sort((a, b) => b.seq - a.seq)[0];
  const selectOutput = (v: OutputView) => {
    workspace.setOutput(v);
    setNarrowView(v);
  };
  const selectNarrow = (v: NarrowView) => {
    setNarrowView(v);
    if (v !== 'editor') workspace.setOutput(v);
  };

  const editor = (
    <section className="panel editor-panel" aria-labelledby={EDITOR_TITLE_ID} onKeyDownCapture={blockActionChords}>
      <div className="panel-bar">
        <h2 id={EDITOR_TITLE_ID} className="panel-title">
          Query
        </h2>
        <span className="lang-label">{LANGUAGE_LABEL}</span>
        <div className="editor-actions">
        <Button className="btn-small" variant="quiet" aria-pressed={state.wrap} onClick={() => workspace.setWrap(!state.wrap)}>
          Wrap lines
        </Button>
        <Button className="btn-compact" onClick={analyze} aria-keyshortcuts={analyzeKeys.aria} title={`Analyze (${keyLabel(analyzeKeys)})`}>
          Analyze
        </Button>
        {running ? (
          <Button className="btn-compact" variant="destructive" onClick={() => runtime.queries.cancel()} disabled={query.state.status === 'cancelling'}>
            {query.state.status === 'cancelling' ? 'Cancelling…' : 'Cancel'}
          </Button>
        ) : null}
        <Button ref={runButton} className="btn-compact" variant="primary" onClick={run} aria-keyshortcuts={runKeys.aria} title={`Run SQL (${keyLabel(runKeys)})`}>
          <svg className="run-glyph" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M5.25 3.4c0-.86.94-1.39 1.67-.94l6.06 3.77c.69.43.69 1.43 0 1.86L6.92 11.86c-.73.45-1.67-.08-1.67-.94z" fill="currentColor" />
          </svg>
          Run SQL
        </Button>
        </div>
      </div>
      {narrow && latest ? (latest.kind === 'run' ? <QueryLine state={query.state} /> : <RequestNote request={latest} kind="analyze" compact />) : null}
      <div className="editor-host">
        <SqlEditor
          value={state.sql}
          onChange={workspace.setSql}
          onRun={run}
          onAnalyze={analyze}
          ariaLabel="SQL editor"
          contentId={EDITOR_INPUT_ID}
          describedBy={HINT_ID}
          wrap={state.wrap}
          placeholderText="Write a SQL query"
          onCursor={onCursor}
        />
      </div>
      <div className="panel-foot">
        <p id={HINT_ID} className="editor-hint">
          Tab leaves the editor · <kbd>{keyLabel(runKeys)}</kbd> runs the statement at the cursor, or the selection · <kbd>{keyLabel(analyzeKeys)}</kbd> Analyze
        </p>
        <p className="cursor-pos" aria-hidden="true">
          Ln {cursor.line}, Col {cursor.column}
          {cursor.selected ? ` (${cursor.selected} selected)` : ''}
        </p>
      </div>
    </section>
  );

  const labelTab = narrow ? `${narrowBase}-tab-${outputView}` : `${outputBase}-tab-${outputView}`;
  const output = (
    <section className="panel output-panel" aria-labelledby="output-heading" onKeyDownCapture={blockActionChords}>
      <h2 id="output-heading" className="visually-hidden">
        Output
      </h2>
      {narrow ? null : (
        <div className="panel-bar output-bar">
          <TabList
            label="Output"
            idBase={outputBase}
            tabs={OUTPUT_TABS.map((t) => ({ ...t, controls: OUTPUT_VIEW_ID }))}
            selected={state.output}
            onSelect={selectOutput}
          />
        </div>
      )}
      {/* Focusable, so keyboard users can always move from the tab into its panel (APG Tabs). */}
      <div role="tabpanel" id={OUTPUT_VIEW_ID} aria-labelledby={labelTab} className="output-body" tabIndex={0}>
        {outputView === 'results' ? (
          <ResultsPanel state={query.state} getStarted={explorer.getStarted} />
        ) : outputView === 'verdict' ? (
          <VerdictView request={state.lastAnalyze} />
        ) : (
          explorer.detail
        )}
      </div>
    </section>
  );

  const narrowBar = (
    <>
      {explorer.drawerToggle}
      <TabList
        label="Workspace view"
        idBase={narrowBase}
        className="view-tabs"
        tabs={[
          { id: 'editor' as NarrowView, label: 'Editor', controls: EDITOR_PANEL_ID },
          ...OUTPUT_TABS.map((t) => ({ id: t.id as NarrowView, label: t.label, controls: OUTPUT_VIEW_ID })),
        ]}
        selected={narrowView}
        onSelect={selectNarrow}
      />
    </>
  );

  return (
    <>
      <Layout
        narrow={narrow}
        sidebar={explorer.sidebar}
        narrowBar={narrowBar}
        editor={editor}
        output={output}
        showEditor={narrowView === 'editor'}
        editorTabId={`${narrowBase}-tab-editor`}
        layout={state.layout}
        onLayout={workspace.setLayout}
        rootRef={rootRef}
        stackRef={stackRef}
      />
      {explorer.dialog}
    </>
  );
}

function RequestNote({ request, compact }: { request: QueryRequest; kind: 'analyze'; compact?: boolean }) {
  const empty = request.sql.trim() === '';
  return (
    <div className={compact ? 'output-note inline-note' : 'output-note'} data-tone="neutral">
      <p className="output-note-title">{empty ? 'Nothing to analyze' : 'Not analyzed'}</p>
      <p>{empty ? NOT_CONNECTED.empty : NOT_CONNECTED.analyze}</p>
    </div>
  );
}

/** Narrow screens: the latest Run SQL outcome in one line beside the actions (the grid is in Results). */
function QueryLine({ state }: { state: QueryState }) {
  const text =
    state.status === 'idle' ? null
    : state.status === 'queued' ? 'Queued'
    : state.status === 'running' ? 'Running SQL…'
    : state.status === 'cancelling' ? 'Cancelling…'
    : state.status === 'done' ? `${state.run.statement === 'select' ? 'SQL executed' : 'Statement executed'} · ${state.run.result ? `${state.run.result.rows.length.toLocaleString('en-US')} rows` : state.run.affectedRows !== undefined ? `${state.run.affectedRows} rows affected` : 'no result set'} · open Results to see it`
    : state.message;
  if (!text) return null;
  return (
    <div className="output-note inline-note" data-tone="neutral">
      <p>{text}</p>
    </div>
  );
}

function VerdictView({ request }: { request: QueryRequest | null }) {
  return <div className="output-view">{request ? <RequestNote request={request} kind="analyze" /> : <p className="empty-note">Analyze reports appear here.</p>}</div>;
}
