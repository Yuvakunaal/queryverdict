// TEST-ONLY: the SqlEditor on its own (M05 contract tests). Records what the editor reports and
// lets tests change its props: external value, read-only, wrap, unmount and remount.
import { useState } from 'react';
import { SqlEditor } from '../src/features/editor/SqlEditor';

export interface EditorFixtureLog {
  changes: string[];
  runs: number;
  analyzes: number;
  /** The editor's own cursor report (line, column), updated on every change and selection. */
  cursor?: { line: number; column: number };
}

declare global {
  interface Window {
    __qvEditorFixture?: EditorFixtureLog;
  }
}

export function EditorFixture() {
  const [value, setValue] = useState('SELECT 1;');
  const [readOnly, setReadOnly] = useState(false);
  const [mounted, setMounted] = useState(true);
  const log = (window.__qvEditorFixture ??= { changes: [], runs: 0, analyzes: 0 });
  return (
    <main>
      <h1>SqlEditor fixture</h1>
      <button type="button" onClick={() => setValue('SELECT 2 AS external;')}>Set external value</button>
      <button type="button" onClick={() => setReadOnly((r) => !r)}>Toggle read-only</button>
      <button type="button" onClick={() => setMounted((m) => !m)}>Toggle mounted</button>
      <p data-testid="value">{value}</p>
      <div style={{ height: 240, display: 'flex', flexDirection: 'column' }}>
        {mounted ? (
          <SqlEditor
            value={value}
            onChange={(v) => {
              log.changes.push(v);
              setValue(v);
            }}
            onRun={() => log.runs++}
            onAnalyze={() => log.analyzes++}
            onCursor={(c) => {
              log.cursor = { line: c.line, column: c.column };
            }}
            ariaLabel="Fixture SQL editor"
            readOnly={readOnly}
          />
        ) : null}
      </div>
      <button type="button">After editor</button>
    </main>
  );
}
