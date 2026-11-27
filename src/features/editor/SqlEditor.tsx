// The SQL editor (M05; IMPLEMENTATION_PLAN M05 fields 6, 10, 12; P-052 / E9: CodeMirror 6).
//
// Keyboard contract (UI_SPECIFICATION §7):
//  - Tab and Shift+Tab are not captured: they move focus out of the editor like any text field,
//    so there is no keyboard trap. Indentation uses Mod-] / Mod-[ (CodeMirror's default keymap).
//  - Mod-Enter runs SQL and Shift-Mod-Enter analyzes. Both are bound only inside the editor, at
//    the highest precedence (Mod-Enter would otherwise insert a blank line), and the two bindings
//    are distinct: CodeMirror matches modifiers exactly for non-character keys.
//  - Keys pressed during IME composition are left to the input method (CodeMirror does not run
//    key bindings while composing).
//  - The caret and selection are drawn by CodeMirror (drawSelection), so a caret at a soft-wrap
//    point is shown on the row it belongs to; the DOM selection is still kept for assistive
//    technology and copy.
//
// The document lives in CodeMirror; the store receives every change through `onChange`. A `value`
// that differs from what the editor last reported (an external change) replaces the document in
// one transaction, which keeps undo history; ordinary typing never round-trips through React.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { Annotation, Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLineGutter, keymap, lineNumbers, placeholder, type Command } from '@codemirror/view';
import { editorAppearance } from './editorTheme';
import { minimalChange } from './textDiff';

export interface CursorPosition {
  readonly line: number;
  readonly column: number;
  readonly selected: number;
}

export interface SqlEditorProps {
  readonly value: string;
  onChange(value: string): void;
  onRun(): void;
  onAnalyze(): void;
  readonly ariaLabel: string;
  readonly readOnly?: boolean;
  /** Soft-wrap long lines (session preference). */
  readonly wrap?: boolean;
  /** id of an element describing the editor (keyboard hint). */
  readonly describedBy?: string;
  /** id given to the editable element, so a skip link or label can target it. */
  readonly contentId?: string;
  readonly placeholderText?: string;
  onCursor?(position: CursorPosition): void;
}

/**
 * Soft-wrap aware Left/Right. A wrap point is one document offset shown in two places: the end of
 * one visual row (side -1) and the start of the next (side +1). CodeMirror's character motion
 * moves the offset, so it skips one of the two places: Right from the end of a row would land
 * after the next row's first character, and Left from the start of a row before the previous
 * row's last character. At a wrap point these commands first move the caret to the other place
 * (same offset, other side); the next press moves normally. Real line ends, selections and
 * multiple cursors use the default motion.
 *
 * The selection is passed as an EditorSelection: a bare range would be read as {anchor, head}
 * and lose its side.
 */
function atWrapPoint(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  if (pos === line.from || pos === line.to) return false;
  const before = view.coordsAtPos(pos, -1);
  const after = view.coordsAtPos(pos, 1);
  return !!before && !!after && after.top - before.top > 1;
}
const acrossWrap = (forward: boolean): Command => (view) => {
  const { ranges, main } = view.state.selection;
  if (ranges.length > 1 || !main.empty || !view.lineWrapping) return false;
  // Right acts only from the end of the upper row; Left only from the start of the lower row.
  if (forward ? main.assoc >= 0 : main.assoc < 0) return false;
  if (!atWrapPoint(view, main.head)) return false;
  const selection = EditorSelection.create([EditorSelection.cursor(main.head, forward ? 1 : -1)]);
  view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' });
  return true;
};

/** Marks transactions that apply an external `value`, so they are not reported back as edits. */
const external = Annotation.define<boolean>();

function attrs(p: Pick<SqlEditorProps, 'ariaLabel' | 'describedBy' | 'contentId' | 'readOnly'>): Record<string, string> {
  return {
    'aria-label': p.ariaLabel,
    ...(p.describedBy ? { 'aria-describedby': p.describedBy } : {}),
    ...(p.contentId ? { id: p.contentId } : {}),
    ...(p.readOnly ? { 'aria-readonly': 'true' } : {}),
  };
}

function cursorOf(state: EditorState): CursorPosition {
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  return { line: line.number, column: main.head - line.from + 1, selected: Math.abs(main.to - main.from) };
}

export function SqlEditor(props: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Latest props for the long-lived editor's callbacks, without reconfiguring it.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  /** The text the editor last reported or was given; `value` equal to it needs no update. */
  const known = useRef(props.value);
  const wrapC = useRef(new Compartment());
  const readOnlyC = useRef(new Compartment());
  const attrsC = useRef(new Compartment());

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const p = latest.current;
    const actions = Prec.highest(
      keymap.of([
        { key: 'Mod-Enter', preventDefault: true, run: () => (latest.current.onRun(), true) },
        { key: 'Shift-Mod-Enter', preventDefault: true, run: () => (latest.current.onAnalyze(), true) },
        { key: 'ArrowRight', run: acrossWrap(true) },
        { key: 'ArrowLeft', run: acrossWrap(false) },
      ]),
    );
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc: p.value,
        extensions: [
          actions,
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          editorAppearance(),
          ...(p.placeholderText ? [placeholder(p.placeholderText)] : []),
          wrapC.current.of(p.wrap ? EditorView.lineWrapping : []),
          readOnlyC.current.of(EditorState.readOnly.of(p.readOnly === true)),
          attrsC.current.of(EditorView.contentAttributes.of(attrs(p))),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(external))) {
              const text = u.state.doc.toString();
              known.current = text;
              latest.current.onChange(text);
            }
            if (u.docChanged || u.selectionSet) latest.current.onCursor?.(cursorOf(u.state));
          }),
        ],
      }),
    });
    view.current = v;
    known.current = p.value;
    latest.current.onCursor?.(cursorOf(v.state));
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  // External value (another component replaced the query): apply it without losing undo history.
  useEffect(() => {
    const v = view.current;
    if (!v || props.value === known.current) return;
    known.current = props.value;
    // Only the span that differs is replaced, so CodeMirror maps the selection through the change:
    // a caret in unchanged text keeps its place. Its own undo step, never merged with typing.
    v.dispatch({ changes: minimalChange(v.state.doc.toString(), props.value), annotations: [external.of(true), isolateHistory.of('full')] });
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapC.current.reconfigure(props.wrap ? EditorView.lineWrapping : []) });
  }, [props.wrap]);

  const { readOnly, ariaLabel, describedBy, contentId } = props;
  useEffect(() => {
    view.current?.dispatch({
      effects: [
        readOnlyC.current.reconfigure(EditorState.readOnly.of(readOnly === true)),
        attrsC.current.reconfigure(EditorView.contentAttributes.of(attrs({ readOnly, ariaLabel, describedBy, contentId }))),
      ],
    });
  }, [readOnly, ariaLabel, describedBy, contentId]);

  return <div ref={host} className="sql-editor" data-readonly={props.readOnly || undefined} />;
}
