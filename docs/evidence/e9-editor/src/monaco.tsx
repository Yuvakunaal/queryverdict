import { createRoot } from 'react-dom/client';
import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/sql/register';
// Contributions for parity with the CodeMirror setup: clipboard, Tab focus toggle, comment toggling, icon CSS.
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode';
import 'monaco-editor/editor/contrib/comment/browser/comment';
import '../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { ready, sampleSql } from './doc';
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
function Editor() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ed = monaco.editor.create(host.current!, { value: sampleSql(), language: 'sql', automaticLayout: true, ariaLabel: 'SQL editor', minimap: { enabled: false } });
    const model = ed.getModel()!;
    ready({ get: () => ed.getValue(), caret: () => model.getOffsetAt(ed.getPosition()!), toEnd: () => { ed.focus(); ed.setPosition(model.getPositionAt(model.getValueLength())); } });
    return () => ed.dispose();
  }, []);
  return <div ref={host} style={{ height: 400 }} />;
}
createRoot(document.getElementById('root')!).render(<Editor />);
