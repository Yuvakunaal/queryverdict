import { useRef, useState, type ReactNode } from 'react';
import type { QueryRun } from '../../core/query/runner';
import type { BoundedResult } from '../../core/results/types';
import type { QueryState } from '../../stores/queryStore';
import type { RunProgress } from '../../core/query/runner';
import { Badge } from '../../ui/Badge';
import { CellDetail } from './CellDetail';
import { ResultGrid, type DetailRequest } from './ResultGrid';

const n = (v: number) => v.toLocaleString('en-US');
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

/** Elapsed time on the page clock, from Run to settlement (UI_SPECIFICATION §6: labelled). */
export function elapsedText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** A byte quantity in the unit that keeps it readable (a small limit is not "0 MiB"). */
export function bytesText(b: number): string {
  if (b >= 1024 * 1024 && b % (1024 * 1024) === 0) return `${n(b / 1024 / 1024)} MiB`;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(b % 1024 === 0 ? 0 : 1)} KiB`;
  return `${n(b)} bytes`;
}

/** Integer text with digit grouping, without converting it to a JavaScript number. */
const groupDigits = (t: string) => t.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Every truncation cause, separately and in plain words (QV-RES-001; P-020). */
export function truncationNotes(r: BoundedResult, ordered: boolean): string[] {
  const t = r.truncation;
  const l = r.limits;
  const notes: string[] = [];
  if (t.rows) {
    notes.push(
      ordered
        ? `Showing the first ${n(r.rows.length)} rows (ORDER BY). The result has more rows; the row limit is ${n(l.rows)}.`
        : `${n(r.rows.length)} rows shown in display order. The result has more rows; the row limit is ${n(l.rows)}.`,
    );
  }
  if (t.columns) notes.push(`${n(t.columns.shown)} of ${n(t.columns.total)} columns are shown (column limit ${n(l.columns)}).`);
  if (t.cells) notes.push(`${plural(t.cells, 'value was', 'values were')} cut at ${n(l.cellChars)} characters; only those characters were kept.`);
  if (t.display) notes.push(`Further rows were withheld to keep the displayed text within ${n(l.displayChars)} characters.`);
  if (t.bytes) notes.push(`${r.rows.length ? 'Further rows were' : 'Rows were'} withheld because the result data reached the transfer limit of ${bytesText(l.bytes)}.`);
  return notes;
}

/** What reached the engine before an error, in words that never overstate or hide effects. */
export function errorOutcome(p: Readonly<RunProgress>, phase: 'parse' | 'bind' | 'execute' | 'engine'): string {
  const parts: string[] = [];
  // Parse and bind errors before anything was sent come from DuckDB's parser or DESCRIBE.
  if (p.completed === 0 && !p.mutationSent) parts.push(phase === 'parse' || phase === 'bind' ? 'Nothing was run.' : 'No data was changed.');
  if (p.total > 1 && p.completed > 0) parts.push(`${p.completed} of ${p.total} statements completed before this error; their changes were applied.`);
  if (p.mutationInFlight) parts.push('The failing statement had been sent; DuckDB undoes a failed statement, unless an open transaction keeps earlier changes.');
  return parts.join(' ');
}

function hasUnsupported(r: BoundedResult): boolean {
  return r.rows.some((row) => row.some((c) => c.kind === 'unsupported'));
}

const ERROR_LABEL: Record<'parse' | 'bind' | 'execute' | 'engine', string> = {
  parse: 'Syntax error',
  bind: 'Binding error',
  execute: 'Runtime error',
  engine: 'Engine error',
};

function Summary({ run, elapsedMs }: { run: QueryRun; elapsedMs: number }) {
  const r = run.result;
  const label = run.statement === 'select' ? 'SQL executed' : 'Statement executed';
  let detail: string;
  if (r) detail = `${plural(r.rows.length, 'row', 'rows')} · ${plural(r.columns.length, 'column', 'columns')}`;
  else if (run.affectedRows !== undefined) detail = `${groupDigits(run.affectedRows)} ${run.affectedRows === '1' ? 'row' : 'rows'} affected (reported by DuckDB)`;
  else detail = 'no result set';
  return (
    <div className="result-summary">
      <Badge tone="success">{label}</Badge>
      <span className="result-counts">{detail}</span>
      {run.statements && run.statements > 1 ? <span className="result-meta">Ran {run.statements} statements · showing the result of the last</span> : null}
      <span className="result-meta">Elapsed {elapsedText(elapsedMs)} · page clock, Run to result</span>
    </div>
  );
}

export interface ResultsPanelProps {
  readonly state: QueryState;
  /** Getting-started block while the workspace has no datasets and nothing ran. */
  readonly getStarted: ReactNode;
}

/**
 * The Results view (M06; UI_SPECIFICATION §4): status, the bounded grid, every truncation cause,
 * display order without ORDER BY, statement outcomes, errors by phase, and nothing fabricated.
 */
export function ResultsPanel({ state, getStarted }: ResultsPanelProps) {
  const [detail, setDetail] = useState<DetailRequest | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  if (state.status === 'idle') {
    return <div className="output-view">{getStarted ?? <p className="empty-note">Results of Run SQL appear here.</p>}</div>;
  }
  if (state.status === 'queued' || state.status === 'running' || state.status === 'cancelling') {
    const text = state.status === 'queued' ? 'Queued' : state.status === 'running' ? 'Running SQL…' : 'Cancelling…';
    return (
      <div className="output-view">
        <div className="result-summary">
          <Badge tone="info">{text}</Badge>
          <span className="result-meta">{state.status === 'queued' ? 'Waiting for the engine to finish other work.' : 'Cancel is next to Run SQL.'}</span>
        </div>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="output-view">
        <div className="result-error" data-phase={state.phase}>
          <p className="result-error-title">
            <Badge tone="violation">{ERROR_LABEL[state.phase]}</Badge>
          </p>
          <pre className="result-error-message">{state.message}</pre>
          <p className="muted">{errorOutcome(state.progress, state.phase)}</p>
        </div>
      </div>
    );
  }
  if (state.status === 'refused' || state.status === 'cancelled' || state.status === 'stale') {
    const title = state.status === 'refused' ? 'Not run' : state.status === 'cancelled' ? 'Cancelled' : 'No result';
    return (
      <div className="output-view">
        <div className="output-note" data-tone="neutral">
          <p className="output-note-title">{title}</p>
          <p>{state.message}</p>
        </div>
      </div>
    );
  }

  const { run } = state;
  const r = run.result;
  const notes = r ? truncationNotes(r, run.ordered) : [];
  return (
    <div className="result-view">
      <div className="result-bar">
        <Summary run={run} elapsedMs={state.elapsedMs} />
        {state.historical ? (
          <p className="result-historical">
            <Badge tone="neutral">Historical</Badge> {state.historical}
          </p>
        ) : null}
        {r && r.rows.length > 0 && !run.ordered && !r.truncation.rows ? <p className="result-meta">Rows are numbered in display order; without ORDER BY the order is not guaranteed.</p> : null}
        {notes.length ? (
          <ul className="result-notes">
            {notes.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : null}
        {r && hasUnsupported(r) ? <p className="result-meta">Some values of this statement are not shown: their exact text is available only in SELECT results.</p> : null}
      </div>
      {r ? (
        r.rows.length === 0 && r.columns.length && !r.truncation.bytes && !r.truncation.display && !r.truncation.rows ? (
          <div className="output-view">
            <p className="empty-note">
              <strong>SQL executed · 0 rows.</strong> Columns: <span className="mono">{r.columns.map((c) => c.name).join(', ')}</span>
            </p>
          </div>
        ) : (
          <>
            <ResultGrid
              key={state.seq}
              result={r}
              caption={`Result of Run SQL: ${plural(r.rows.length, 'row', 'rows')}, ${plural(r.columns.length, 'column', 'columns')}`}
              onDetail={(t) => {
                opener.current = document.activeElement as HTMLElement | null;
                setDetail(t);
              }}
            />
            <CellDetail result={r} target={detail} onClose={() => setDetail(null)} returnFocus={opener} />
          </>
        )
      ) : null}
    </div>
  );
}
