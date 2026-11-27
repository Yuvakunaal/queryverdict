import type { ReactNode } from 'react';
import type { EngineSnapshot } from '../../stores/engineStore';
import type { AnalysisState } from '../../stores/analysisStore';
import { Button } from '../../ui/Button';
import type { StateNotice, Tone } from './model';

/**
 * A status shape that always accompanies a text label (DESIGN_SYSTEM §3: shape or icon plus a real
 * text label; never colour alone). Decorative: hidden from assistive technology.
 */
export function StatusMark({ tone }: { tone: Tone }) {
  return (
    <svg className="vd-mark" data-tone={tone} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {tone === 'violation' ? (
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
      ) : tone === 'warning' ? (
        <path d="M8 2.2L14.4 13.6H1.6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
      ) : tone === 'info' ? (
        <>
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M8 7.2v4.3M8 4.6v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
      ) : tone === 'success' ? (
        <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="2" fill="none" />
      ) : (
        <path d="M3.5 8h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** A labelled notice: mark + title + body lines + next steps (DESIGN_SYSTEM §5 "Banner and status"). */
export function Notice({ notice, children }: { notice: StateNotice; children?: ReactNode }) {
  return (
    <div className="vd-notice" data-tone={notice.tone}>
      <p className="vd-notice-title">
        <StatusMark tone={notice.tone} />
        {notice.title}
      </p>
      {notice.body.map((b, i) => (
        <p key={i}>{b}</p>
      ))}
      {notice.next.length ? (
        <ul className="vd-next">
          {notice.next.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {children}
    </div>
  );
}

/** Nothing analysed yet (UI_SPECIFICATION §5; §2 "Getting started"). */
export function NoAnalysis({ analyzeKeys }: { analyzeKeys: string }) {
  return (
    <div className="vd-empty">
      <p className="vd-empty-title">No analysis yet</p>
      <p>
        Analyze measures what one join does to its rows: matches, row loss and fan-out, with exact counts and sample keys. It binds the query
        and runs scoped diagnostic probes; it does not run the query itself. Nothing is analyzed automatically.
      </p>
      <p className="muted">
        Write a SELECT with one INNER or LEFT JOIN of two session tables on integer key columns, then choose Analyze (<kbd>{analyzeKeys}</kbd> in the editor).
        Expectations below are optional.
      </p>
    </div>
  );
}

const ACTIVE_TEXT = { queued: 'Queued for analysis', analyzing: 'Analyzing…', cancelling: 'Cancelling…' } as const;

/**
 * The latest Analyze operation while it is queued, running or cancelling (UI_SPECIFICATION §6:
 * no percentages, no time estimates). `onCancel` is given where the editor's own Cancel is not
 * on screen (the full-width view).
 */
export function AnalysisBar({ state, onCancel }: { state: AnalysisState; onCancel?: () => void }) {
  if (state.status !== 'queued' && state.status !== 'analyzing' && state.status !== 'cancelling') return null;
  const n = state.expectations;
  return (
    <div className="vd-progress" aria-busy="true">
      <span className="vd-progress-mark" aria-hidden="true" />
      <span className="vd-progress-text">
        <strong>{ACTIVE_TEXT[state.status]}</strong>{' '}
        {state.status === 'queued'
          ? 'Waiting for the engine to finish other work.'
          : state.status === 'analyzing'
            ? `Measuring the join${n ? ` and checking ${n} ${n === 1 ? 'expectation' : 'expectations'}` : ''}. Nothing is shown until the analysis is complete.`
            : 'Stopping the analysis.'}
      </span>
      {onCancel ? (
        <Button className="btn-small" variant="destructive" onClick={onCancel} disabled={state.status === 'cancelling'}>
          {state.status === 'cancelling' ? 'Cancelling…' : 'Cancel analysis'}
        </Button>
      ) : state.status !== 'cancelling' ? (
        <span className="muted">Cancel analysis is next to Analyze.</span>
      ) : null}
    </div>
  );
}

/** The engine cannot run an analysis right now (PRD §5 state matrix: starting, recovering, failed). */
export function EngineNotice({ engine }: { engine: EngineSnapshot }) {
  const k = engine.state.kind;
  if (k === 'ready' || k === 'busy' || k === 'cancelling') return null;
  const text =
    k === 'recovering'
      ? 'The engine is recovering. Analyze waits until it is ready; any report from before the restart is historical.'
      : k === 'failed'
        ? 'The engine is unavailable, so nothing can be analyzed. Retry is in the status bar.'
        : k === 'starting' || k === 'idle'
          ? 'The engine is starting. Analyze waits until it is ready.'
          : 'The engine has stopped. Reload the page to start a new session.';
  return (
    <p className="vd-engine" data-tone="neutral">
      <StatusMark tone="neutral" />
      {text}
    </p>
  );
}

/** The report is not current (ARCHITECTURE §16.2): a persistent, unambiguous strip. */
export function HistoricalStrip({ text }: { text: string }) {
  return (
    <div className="vd-historical" role="note">
      <p className="vd-notice-title">
        <StatusMark tone="neutral" />
        Historical report
      </p>
      <p>
        {text} Its measurements, findings and outcomes describe the earlier state and are not current. Analyze the current query to refresh the
        evidence.
      </p>
    </div>
  );
}
