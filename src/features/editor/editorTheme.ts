// CodeMirror theme and SQL highlighting mapped onto the design tokens (DESIGN_SYSTEM §3–§4,
// IMPLEMENTATION_PLAN M05 field 11). Every colour is a CSS variable from tokens.css, so a theme
// change (Light, Dark, System) restyles the editor without reconfiguring it, and forced-colours
// mode replaces the colours like any other text. The caret and selection are drawn by CodeMirror
// in the text colour and the action colour; forced-colours rules are in workspace.css.
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { PostgreSQL, SQLDialect } from '@codemirror/lang-sql';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/** DuckDB additions to the PostgreSQL keyword and type lists (highlighting only; no completion). */
const DUCKDB_KEYWORDS =
  'anti asof attach columns describe detach exclude glob ilike install load macro pivot pivot_longer pivot_wider positional pragma qualify replace sample semi summarize unpivot using';
const DUCKDB_TYPES =
  'blob hugeint uhugeint utinyint usmallint uinteger ubigint tinyint list struct map union enum varint timestamp_s timestamp_ms timestamp_ns uuid';

export const DuckDBDialect = SQLDialect.define({
  ...PostgreSQL.spec,
  keywords: `${PostgreSQL.spec.keywords ?? ''} ${DUCKDB_KEYWORDS}`,
  types: `${PostgreSQL.spec.types ?? ''} ${DUCKDB_TYPES}`,
});

/** The language label shown next to the editor (UI_SPECIFICATION §4). */
export const LANGUAGE_LABEL = 'DuckDB SQL';

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--sql-keyword)', fontWeight: '600' },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--sql-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--sql-string)' },
  { tag: [t.number, t.bool, t.null, t.literal], color: 'var(--sql-literal)' },
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--sql-comment)', fontStyle: 'italic' },
  { tag: t.special(t.name), color: 'var(--text)' },
  { tag: t.invalid, color: 'var(--violation-text)' },
]);

const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text)',
    backgroundColor: 'var(--surface)',
    fontSize: 'var(--text-ui)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.375rem', // 22 px at the default size; scales with browser zoom (DESIGN_SYSTEM §4)
    overflow: 'auto',
  },
  '.cm-content': { padding: 'var(--space-2) 0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 var(--space-4) 0 var(--space-3)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: 'var(--rule) solid var(--border)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '2.5rem',
    padding: '0 var(--space-2) 0 var(--space-3)',
    fontVariantNumeric: 'tabular-nums',
  },
  '&.cm-focused .cm-activeLineGutter': { backgroundColor: 'var(--surface-raised)', color: 'var(--text)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--text)', marginLeft: '-1px' },
  // Same specificity as CodeMirror's base theme, so these win over its defaults. The strengths
  // keep every SQL token at 4.5:1 or more over the selection in both themes (computed: lowest
  // 4.55:1, comments in the light theme); the active line is marked in the gutter only, so the
  // selection is always over the plain surface.
  '& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'color-mix(in srgb, var(--text-muted) 16%, transparent)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'color-mix(in srgb, var(--action) 20%, transparent)',
  },
});

/** Language, highlighting and theme for the SQL editor. */
export function editorAppearance(): Extension {
  // The dialect's language alone (parser, comment tokens, indentation); not `sql()`, which also
  // registers completion sources. No autocomplete in P0.
  return [new LanguageSupport(DuckDBDialect.language), syntaxHighlighting(highlight), theme];
}
