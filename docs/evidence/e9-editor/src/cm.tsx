import { createRoot } from 'react-dom/client';
import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { ready, sampleSql } from './doc';
let view: EditorView | null = null;
function Editor() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: sampleSql(), extensions: [lineNumbers(), history(), drawSelection(), highlightActiveLine(), keymap.of([...defaultKeymap, ...historyKeymap]), syntaxHighlighting(defaultHighlightStyle), sql({ dialect: PostgreSQL }), EditorView.contentAttributes.of({ 'aria-label': 'SQL editor' }), EditorView.theme({ '&': { height: '400px' }, '.cm-scroller': { overflow: 'auto' } })] }),
    });
    ready({ get: () => view!.state.doc.toString(), caret: () => view!.state.selection.main.head, toEnd: () => { view!.focus(); view!.dispatch({ selection: { anchor: view!.state.doc.length } }); } });
    return () => view?.destroy();
  }, []);
  return <div ref={host} />;
}
createRoot(document.getElementById('root')!).render(<Editor />);
