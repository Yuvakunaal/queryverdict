// Workspace state (M05; IMPLEMENTATION_PLAN M05 field 10, UI_SPECIFICATION §4, §7): the one session
// query buffer, editor display options, panel sizes, the selected output view and the latest
// explicit Run SQL / Analyze request. Session only: nothing is written to browser storage, a URL
// or the engine (ARCHITECTURE §18.1, AM-021). Framework-independent.
import { createStore, type Store } from './createStore';

export type OutputView = 'results' | 'verdict' | 'dataset';

/**
 * Panel sizes. The sidebar is in CSS pixels, or null for the default of the current breakpoint
 * (264 px from 1200 px, 224 px at 900–1199 px), so the initial layout and every reset agree.
 * The editor is a fraction of the editor/output stack.
 */
export interface LayoutSizes {
  readonly sidebarPx: number | null;
  readonly editorFraction: number;
}

/** UI_SPECIFICATION §7: sidebar 200–360 px; editor and output each at least 160 px when both are visible. */
export const LAYOUT_LIMITS = {
  sidebarMinPx: 200,
  sidebarMaxPx: 360,
  /** 900–1199 px: narrower sidebar. */
  sidebarMediumMaxPx: 280,
  paneMinPx: 160,
} as const;

/** Breakpoint defaults for the sidebar (UI_SPECIFICATION §7). */
export const SIDEBAR_DEFAULT_PX = { wide: 264, medium: 224 } as const;

export const DEFAULT_LAYOUT: LayoutSizes = { sidebarPx: null, editorFraction: 0.5 };

/** Named presets offered as single-pointer and keyboard alternatives to dragging (DESIGN_SYSTEM §4–§5). */
export const LAYOUT_PRESETS: Readonly<Record<'reset' | 'editor' | 'output', Partial<LayoutSizes>>> = {
  reset: DEFAULT_LAYOUT,
  editor: { editorFraction: 0.7 },
  output: { editorFraction: 0.3 },
};

export type QueryRequestKind = 'run' | 'analyze';

/** An explicit Run SQL or Analyze action and the query text it was given. */
export interface QueryRequest {
  readonly kind: QueryRequestKind;
  readonly seq: number;
  readonly sql: string;
}

export interface WorkspaceState {
  readonly sql: string;
  readonly wrap: boolean;
  readonly layout: LayoutSizes;
  readonly output: OutputView;
  /** The most recent Run SQL request and Analyze request (null until one is made). */
  readonly lastRun: QueryRequest | null;
  readonly lastAnalyze: QueryRequest | null;
}

export interface WorkspaceStore extends Store<WorkspaceState> {
  setSql(sql: string): void;
  setWrap(wrap: boolean): void;
  setLayout(layout: Partial<LayoutSizes>): void;
  setOutput(view: OutputView): void;
  /** Records an explicit action and selects its output view (Results for Run SQL, Verdict for Analyze). */
  request(kind: QueryRequestKind, sql: string): QueryRequest;
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function createWorkspaceStore(initial: Partial<Pick<WorkspaceState, 'sql' | 'wrap'>> = {}): WorkspaceStore {
  const store = createStore<WorkspaceState>({
    sql: initial.sql ?? '',
    wrap: initial.wrap ?? false,
    layout: DEFAULT_LAYOUT,
    output: 'results',
    lastRun: null,
    lastAnalyze: null,
  });
  let seq = 0;
  const update = (patch: Partial<WorkspaceState>) => store.set({ ...store.getSnapshot(), ...patch });
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    setSql(sql) {
      if (sql !== store.getSnapshot().sql) update({ sql });
    },
    setWrap(wrap) {
      if (wrap !== store.getSnapshot().wrap) update({ wrap });
    },
    setLayout(layout) {
      const cur = store.getSnapshot().layout;
      const px = layout.sidebarPx === undefined ? cur.sidebarPx : layout.sidebarPx;
      const next: LayoutSizes = {
        sidebarPx: px === null ? null : Math.round(clamp(px, LAYOUT_LIMITS.sidebarMinPx, LAYOUT_LIMITS.sidebarMaxPx)),
        editorFraction: clamp(layout.editorFraction ?? cur.editorFraction, 0, 1),
      };
      if (next.sidebarPx !== cur.sidebarPx || next.editorFraction !== cur.editorFraction) update({ layout: next });
    },
    setOutput(output) {
      if (output !== store.getSnapshot().output) update({ output });
    },
    request(kind, sql) {
      const request: QueryRequest = { kind, seq: ++seq, sql };
      update(kind === 'run' ? { lastRun: request, output: 'results' } : { lastAnalyze: request, output: 'verdict' });
      return request;
    },
  };
}
