import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { clamp, DEFAULT_LAYOUT, LAYOUT_LIMITS, SIDEBAR_DEFAULT_PX, type LayoutSizes } from '../../stores/workspaceStore';
import { Splitter } from '../../ui/Splitter';

/** Workspace breakpoints (UI_SPECIFICATION §7). */
export const NARROW_QUERY = '(max-width: 899px)';
export const MEDIUM_QUERY = '(min-width: 900px) and (max-width: 1199px)';
/** Thickness of a divider's visible rule (its grid track). */
const DIVIDER_PX = 1;
/** Ids of the visible headings that name the dividers (the panes they resize). */
export const SIDEBAR_TITLE_ID = 'datasets-title';
export const EDITOR_TITLE_ID = 'editor-heading';

export const EDITOR_PANEL_ID = 'ws-editor-panel';
export const OUTPUT_PANEL_ID = 'ws-output-panel';
export const SIDEBAR_PANE_ID = 'ws-sidebar-pane';

/** Live result of a media query (the listener is removed on unmount). */
export function useMediaQuery(query: string): boolean {
  const subscribe = (notify: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
    const mq = window.matchMedia(query);
    mq.addEventListener('change', notify);
    return () => mq.removeEventListener('change', notify);
  };
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, get, () => false);
}

/** Border-box size of an element, kept current by a ResizeObserver (disconnected on unmount). */
function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box) setSize((s) => (s.width === box.width && s.height === box.height ? s : { width: box.width, height: box.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export interface LayoutProps {
  readonly narrow: boolean;
  /** Wide screens show the sidebar beside the stack; narrow screens use the drawer. */
  readonly sidebar: ReactNode;
  /** Narrow screens: the datasets drawer toggle and the view tabs. */
  readonly narrowBar: ReactNode;
  readonly editor: ReactNode;
  readonly output: ReactNode;
  /** Narrow screens show one view at a time; wide screens show both panes. */
  readonly showEditor: boolean;
  /** id of the narrow tab labelling the editor panel. */
  readonly editorTabId: string;
  readonly layout: LayoutSizes;
  onLayout(layout: Partial<LayoutSizes>): void;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly stackRef: RefObject<HTMLDivElement | null>;
}

/**
 * Workspace regions (UI_SPECIFICATION §4, §7): sidebar | divider | editor over output, with
 * keyboard-operable dividers. 900–1199 px uses a narrower sidebar; below 900 px (and at high zoom)
 * one column with the datasets drawer and tabs for Editor, Results, Verdict and Dataset. Both
 * panes stay mounted at every width, so the editor keeps its text, selection and undo history.
 */
export function Layout({ narrow, sidebar, narrowBar, editor, output, showEditor, editorTabId, layout, onLayout, rootRef, stackRef }: LayoutProps) {
  const root = useSize(rootRef);
  const stack = useSize(stackRef);
  const medium = useMediaQuery(MEDIUM_QUERY);
  const sidebarMax = medium ? LAYOUT_LIMITS.sidebarMediumMaxPx : LAYOUT_LIMITS.sidebarMaxPx;
  // null = the breakpoint default, used by the initial layout and by every reset.
  const sidebarPx = clamp(layout.sidebarPx ?? (medium ? SIDEBAR_DEFAULT_PX.medium : SIDEBAR_DEFAULT_PX.wide), LAYOUT_LIMITS.sidebarMinPx, sidebarMax);

  const min = LAYOUT_LIMITS.paneMinPx;
  const room = stack.height;
  // The output keeps at least `min` below the divider's own rule.
  const editorMax = Math.max(min, room - DIVIDER_PX - min);
  const editorPx = room > 0 ? Math.round(clamp(layout.editorFraction * room, min, editorMax)) : 0;

  const style = { '--sidebar-width': `${sidebarPx}px`, ...(editorPx ? { '--editor-height': `${editorPx}px` } : {}) } as CSSProperties;

  return (
    <div ref={rootRef} className="workspace" data-narrow={narrow || undefined} style={style}>
      {narrow ? <div className="workspace-bar">{narrowBar}</div> : null}
      <div id={SIDEBAR_PANE_ID} className="workspace-sidebar">
        {sidebar}
      </div>
      {narrow ? null : (
        <Splitter
          orientation="vertical"
          labelledBy={SIDEBAR_TITLE_ID}
          controls={SIDEBAR_PANE_ID}
          value={sidebarPx}
          min={LAYOUT_LIMITS.sidebarMinPx}
          max={sidebarMax}
          total={root.width}
          onChange={(px) => onLayout({ sidebarPx: px })}
          onReset={() => onLayout({ sidebarPx: null })}
        />
      )}
      <div ref={stackRef} className="workspace-stack">
        <div
          id={EDITOR_PANEL_ID}
          className="workspace-pane"
          hidden={narrow && !showEditor}
          {...(narrow ? { role: 'tabpanel', 'aria-labelledby': editorTabId } : {})}
        >
          {editor}
        </div>
        {narrow || !editorPx ? null : (
          <Splitter
            orientation="horizontal"
            labelledBy={EDITOR_TITLE_ID}
            controls={EDITOR_PANEL_ID}
            value={editorPx}
            min={min}
            max={editorMax}
            total={room}
            onChange={(px) => onLayout({ editorFraction: room > 0 ? px / room : DEFAULT_LAYOUT.editorFraction })}
            onReset={() => onLayout({ editorFraction: DEFAULT_LAYOUT.editorFraction })}
          />
        )}
        <div id={OUTPUT_PANEL_ID} className="workspace-pane" hidden={narrow && showEditor}>
          {output}
        </div>
      </div>
    </div>
  );
}
