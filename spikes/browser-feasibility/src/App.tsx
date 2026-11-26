// Minimal, functional spike UI. Not a design proposal.
// The engine lockdown is mandatory: there is no switch to disable it in this build. The
// negative-control (unlocked) engine exists only in the test harness build (harness/).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoundedResult } from './engine/bounded';
import { EngineSession, type AttachMode, type EngineEvent, type RegisteredFile, type RunOutcome, type StartInfo } from './engine/session';
import { runBenchmark, type BenchProgress, type Manifest } from './bench/runner';
import { checkBenchInputs, type BenchGuardResult } from './bench/guards';

const LOG_CAP = 200;

export interface BenchStartOptions {
  manifest: Manifest;
  mode: AttachMode;
  reps: number;
  cancelReps: number;
  workloadTimeoutMs: number;
  cancelAfterMs: number;
  memoryLimit: string | null;
  only?: string[];
  stress?: boolean;
  expectBoundaryErrors?: boolean;
  /** Explicit confirmation for inputs above the conservative limit (CLI: --confirm-large). */
  confirmedLarge?: boolean;
  /** Set by the CLI, which hashes the inputs itself before starting. */
  inputsHashedByCaller?: boolean;
}

declare global {
  interface Window {
    __qv?: {
      session: EngineSession;
      ready: Promise<StartInfo>;
      registerText: (name: string, text: string, mode?: AttachMode) => Promise<RegisteredFile>;
    };
    __qvBench?: {
      start: (opts: BenchStartOptions) => void;
      progress: BenchProgress | null;
      result: unknown;
      guard: BenchGuardResult | null;
    };
  }
}

export function App() {
  const sessionRef = useRef<EngineSession | null>(null);
  const benchRunning = useRef(false);
  const [info, setInfo] = useState<StartInfo | null>(null);
  const [state, setState] = useState('idle');
  const [startError, setStartError] = useState<string | null>(null);
  const [files, setFiles] = useState<RegisteredFile[]>([]);
  const [log, setLog] = useState<EngineEvent[]>([]);
  const [sql, setSql] = useState('SELECT 42 AS answer');
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [schema, setSchema] = useState<{ relation: string; outcome: RunOutcome } | null>(null);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<AttachMode>('view');
  const [benchJson, setBenchJson] = useState<string>('');
  const [confirmLarge, setConfirmLarge] = useState(false);

  const pushLog = useCallback((e: EngineEvent) => {
    setLog((l) => [...l.slice(-(LOG_CAP - 1)), e]);
    if (e.kind.startsWith('state:')) setState(e.kind.slice(6) + (e.detail ? ` (${e.detail})` : ''));
  }, []);

  const refreshFiles = useCallback(() => setFiles([...(sessionRef.current?.files.values() ?? [])].map((f) => ({ ...f }))), []);

  useEffect(() => {
    // React StrictMode (dev only) mounts, unmounts and remounts: the first session is disposed
    // during startup and rejects later. A disposed session must not update the UI, or its stale
    // rejection would mark the live session as failed.
    let active = true;
    const log = (e: EngineEvent) => {
      if (active) pushLog(e);
      else setLog((l) => [...l.slice(-(LOG_CAP - 1)), { ...e, detail: `[disposed session] ${e.detail ?? ''}`.trim() }]);
    };
    const session = new EngineSession({ memoryLimit: '2GB', cancelDeadlineMs: 2000, log });
    sessionRef.current = session;
    setInfo(null);
    setStartError(null);
    const ready = session.start().then(
      (i) => {
        if (active) setInfo(i);
        return i;
      },
      (e: unknown) => {
        // Fail-closed: no SQL or file input is enabled when startup or verification fails.
        if (active) setStartError(String(e));
        throw e;
      },
    );
    ready.catch(() => undefined);
    window.__qv = {
      session,
      ready,
      registerText: async (name, text, m = 'view') => (await session.registerFile(new File([text], name), m)).file,
    };
    window.__qvBench = { start: (o) => void startBench(o), progress: null, result: null, guard: null };
    return () => {
      active = false;
      void session.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushLog]);

  const ready = info !== null && startError === null;

  async function onFiles(list: FileList | null) {
    const s = sessionRef.current;
    if (!s || !list || !ready) return;
    await Promise.all(
      Array.from(list).map((f) =>
        s.registerFile(f, mode).catch((e: unknown) => pushLog({ t: performance.now(), kind: 'register-failed', detail: `${f.name}: ${String(e)}` })),
      ),
    );
    refreshFiles();
  }

  async function run(text: string) {
    const s = sessionRef.current;
    if (!s || !ready) return;
    setRunning(true);
    setOutcome(null);
    const r = await s.run(text);
    setOutcome(r);
    setRunning(false);
    refreshFiles();
  }

  async function cancel() {
    const s = sessionRef.current;
    if (!s) return;
    const r = await s.cancel();
    pushLog({ t: performance.now(), kind: 'cancel-report', detail: JSON.stringify(r) });
    if (s.info) setInfo({ ...s.info });
    refreshFiles();
  }

  async function showSchema(rf: RegisteredFile) {
    const s = sessionRef.current;
    if (!s) return;
    setSchema({ relation: rf.relation, outcome: await s.describe(rf.relation) });
  }

  async function startBench(o: BenchStartOptions) {
    const orders = (document.getElementById('bench-orders') as HTMLInputElement | null)?.files?.[0];
    const customers = (document.getElementById('bench-customers') as HTMLInputElement | null)?.files?.[0];
    const progress: BenchProgress = { schemaVersion: 2, phase: 'init', planned: [], records: [], registration: [], done: false };
    window.__qvBench!.progress = progress;
    const fail = (msg: string) => {
      progress.error = msg;
      progress.phase = 'refused';
      progress.done = true;
      setBenchJson(`refused: ${msg}`);
    };
    if (benchRunning.current) return fail('A benchmark is already running in this tab');
    if (!orders || !customers) return fail('Select orders and customers files first');
    const guard = await checkBenchInputs([orders, customers], o.manifest, { confirmedLarge: o.confirmedLarge === true, skipHash: o.inputsHashedByCaller === true });
    window.__qvBench!.guard = guard;
    if (!guard.ok) return fail(guard.reasons.join('; '));
    // Web Locks: refuse if another tab of this origin is running a benchmark.
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    const runIt = async () => {
      benchRunning.current = true;
      try {
        const result = await runBenchmark({ orders, customers, ...o }, progress, () => setBenchJson(`phase: ${progress.phase}, records: ${progress.records.length}`));
        window.__qvBench!.result = { ...result, inputGuard: guard };
        setBenchJson(JSON.stringify(window.__qvBench!.result, null, 1));
      } catch (e) {
        progress.error = String(e);
        progress.done = true;
        setBenchJson(`failed: ${String(e)}`);
      } finally {
        benchRunning.current = false;
      }
    };
    if (locks) {
      await locks.request('queryverdict-benchmark', { ifAvailable: true }, async (lock) => {
        if (!lock) return fail('Another benchmark is running in another tab');
        await runIt();
      });
    } else {
      await runIt();
    }
  }

  async function benchFromUi() {
    const m = (document.getElementById('bench-manifest') as HTMLInputElement | null)?.files?.[0];
    if (!m) return setBenchJson('Select manifest.json');
    const manifest = JSON.parse(await m.text()) as Manifest;
    if (confirmLarge && !window.confirm('Inputs above 50 MB combined can exhaust memory on this device. The browser cannot measure host memory pressure. Close other heavy applications. Continue?')) return;
    await startBench({ manifest, mode, reps: 3, cancelReps: 5, workloadTimeoutMs: 300_000, cancelAfterMs: 1000, memoryLimit: '2GB', confirmedLarge: confirmLarge });
  }

  function downloadBench() {
    const url = URL.createObjectURL(new Blob([benchJson], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `bench-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main>
      <h1>QueryVerdict — browser feasibility spike</h1>
      <p className="muted">Throwaway prototype. Data stays in this tab. See docs/FEASIBILITY.md.</p>

      <section aria-label="Engine status">
        <h2>Engine</h2>
        <p data-testid="session-state">State: {state}</p>
        {startError && <p className="danger" role="alert" data-testid="start-error">Engine not started (fail-closed): {startError}</p>}
        {info && (
          <dl data-testid="engine-info">
            <dt>DuckDB</dt><dd>{info.duckdbVersion} (package {info.packageVersion}, bundle {info.bundle}, generation {info.generation})</dd>
            <dt>crossOriginIsolated</dt><dd>{String(info.crossOriginIsolated)}</dd>
            <dt>Lockdown</dt><dd>verified ({Object.keys(info.verification.observed).length} settings, extensions {info.verification.loadedExtensions.join(', ')})</dd>
            <dt>Boot</dt><dd>{Math.round(info.bootMs)} ms</dd>
          </dl>
        )}
      </section>

      <section aria-label="Datasets">
        <h2>Datasets</h2>
        <label>
          Attach as{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as AttachMode)}>
            <option value="view">view over file (no import)</option>
            <option value="table">imported table</option>
          </select>
        </label>{' '}
        <label>
          Add files (.csv, .json/.ndjson, .parquet){' '}
          <input type="file" data-testid="file-input" disabled={!ready} multiple accept=".csv,.tsv,.json,.ndjson,.jsonl,.parquet" onChange={(e) => void onFiles(e.target.files)} />
        </label>
        <ul data-testid="file-list">
          {files.map((f) => (
            <li key={f.id}>
              <code>{f.relation}</code> — {f.name} ({f.format}, {f.mode}, {f.bytes.toLocaleString()} bytes, {f.status}){f.error ? ` — ${f.error}` : ''}{' '}
              <button disabled={f.status !== 'attached'} onClick={() => void showSchema(f)}>Schema</button>{' '}
              <button disabled={f.status !== 'attached'} onClick={() => void run(`SELECT * FROM "${f.relation.replaceAll('"', '""')}" LIMIT 100`)}>Preview</button>{' '}
              {f.status === 'needs-reimport' && <button onClick={() => void sessionRef.current?.reimport(f.id).then(refreshFiles, refreshFiles)}>Re-import</button>}{' '}
              <button onClick={() => void sessionRef.current?.dropFile(f.id).then(refreshFiles)}>Remove</button>
            </li>
          ))}
        </ul>
        {schema && <ResultView title={`Schema: ${schema.relation}`} outcome={schema.outcome} testId="schema" />}
      </section>

      <section aria-label="SQL">
        <h2>SQL</h2>
        <textarea aria-label="SQL" data-testid="sql" rows={5} cols={100} value={sql} onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void run(sql); }} />
        <div>
          <button data-testid="run" disabled={running || !ready} onClick={() => void run(sql)}>Run (⌘/Ctrl+Enter)</button>{' '}
          <button data-testid="cancel" disabled={!running} onClick={() => void cancel()}>Cancel</button>
        </div>
        {running && <p role="status">Running…</p>}
        {outcome && <ResultView title="Result" outcome={outcome} testId="result" />}
      </section>

      <section aria-label="Benchmark">
        <h2>Benchmark (manual runs, e.g. Safari)</h2>
        <p className="muted">
          The browser cannot measure host memory pressure. Inputs are checked against the manifest (sizes always; SHA-256 up to 50 MB combined).
          Above 50 MB combined an explicit confirmation is required; above 1.1 GB the run is refused. One benchmark at a time.
        </p>
        <label>orders <input id="bench-orders" type="file" accept=".csv,.parquet,.json,.ndjson" /></label>{' '}
        <label>customers <input id="bench-customers" type="file" accept=".csv,.parquet,.json,.ndjson" /></label>{' '}
        <label>manifest.json <input id="bench-manifest" type="file" accept=".json" /></label>{' '}
        <label><input type="checkbox" checked={confirmLarge} onChange={(e) => setConfirmLarge(e.target.checked)} /> I confirm a run above 50 MB combined</label>{' '}
        <button disabled={!ready} onClick={() => void benchFromUi()}>Run benchmark</button>{' '}
        <button disabled={!benchJson} onClick={downloadBench}>Download results</button>
        <pre data-testid="bench-output" className="log">{benchJson.slice(0, 20000)}</pre>
      </section>

      <section aria-label="Event log">
        <h2>Event log</h2>
        <ol className="log" data-testid="log">
          {log.map((e, i) => (
            <li key={i}>{Math.round(e.t)} ms {e.kind} {e.detail ?? ''}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}

function describeTruncation(r: BoundedResult): string {
  const t = r.truncation;
  const parts: string[] = [];
  if (t.rows) parts.push(`row limit reached (more rows exist; ${r.rowsSeen} received before stopping)`);
  if (t.arrowBytes) parts.push(`byte limit reached (${r.arrowBytesSeen} Arrow bytes received before stopping)`);
  if (t.displayChars) parts.push('display size limit reached');
  if (t.columns) parts.push(`showing ${r.columns.length} of ${r.totalColumns} columns`);
  if (t.cellsShortened) parts.push(`${t.cellsShortened} cells shortened`);
  return parts.length ? ` — truncated: ${parts.join('; ')}` : '';
}

function ResultView({ title, outcome, testId }: { title: string; outcome: RunOutcome; testId: string }) {
  if (outcome.status === 'error') return <p className="danger" role="alert" data-testid={`${testId}-error`}>Error: {outcome.error}</p>;
  if (outcome.status !== 'ok') return <p data-testid={`${testId}-status`}>Query {outcome.status} after {Math.round(outcome.ms)} ms</p>;
  const r: BoundedResult = outcome.result;
  return (
    <div data-testid={testId}>
      <h3>{title}</h3>
      <p className="muted" data-testid={`${testId}-meta`}>
        {r.rows.length} rows shown{describeTruncation(r)} · {Math.round(outcome.ms)} ms
      </p>
      <div className="grid">
        <table>
          <thead><tr>{r.columns.map((c, i) => <th key={i} title={c.type}>{c.name}</th>)}</tr></thead>
          <tbody>{r.rows.map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
