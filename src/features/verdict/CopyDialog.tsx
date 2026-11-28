import { useEffect, useRef, useState, type RefObject } from 'react';
import { MAX_REPLAY_SCRIPT_CHARS, replayScript } from '../../core/verdict/replay';
import type { VerdictReport } from '../../core/verdict/types';
import type { ReportView } from '../../stores/reportStore';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { StatusRegion } from '../../ui/StatusRegion';
import { buildSummary } from './summary';

export type CopyMode = 'summary' | 'replay';

/** The part of the Clipboard API this dialog uses (injectable for tests). */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export interface CopyDialogProps {
  /** Which preview is open; null when closed. */
  readonly mode: CopyMode | null;
  /** The live report view (the dialog keeps the report it opened with). */
  readonly view: ReportView;
  onClose(): void;
  readonly returnFocus: RefObject<HTMLElement | null>;
  /** Defaults to `navigator.clipboard` (absent in insecure contexts and some browsers). */
  readonly clipboard?: ClipboardWriter | null;
}

interface Opened {
  readonly mode: CopyMode;
  readonly report: VerdictReport;
  /** Currency when the dialog opened (or when the user last switched report). */
  readonly stateKey: string;
  /** Identity of this open (a new one each time the dialog opens). */
  readonly seq: number;
}
let openSeq = 0;

interface Options {
  readonly sql: boolean;
  readonly ids: boolean;
  readonly witnesses: boolean;
}
const NO_OPTIONS: Options = { sql: false, ids: false, witnesses: false };

const finalised = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The opened report's currency now: a newer report makes it historical. */
function currencyOf(report: VerdictReport, view: ReportView): { current: boolean; reason?: string } {
  if (view.report?.id !== report.id) return { current: false, reason: 'newer report' };
  return { current: view.current, ...(view.historicalReason ? { reason: view.historicalReason } : {}) };
}
const keyOf = (c: { current: boolean; reason?: string }) => `${c.current}|${c.reason ?? ''}`;

const REASON_TEXT: Readonly<Record<string, string>> = {
  'newer report': 'a newer analysis replaced it',
  'engine restarted': 'the engine restarted',
  'data may have changed': 'the data may have changed',
  'query changed': 'the query in the editor changed',
  'expectations changed': 'the declared expectations changed',
  'session ended': 'the session ended',
};
const reasonText = (r?: string) => (r ? (REASON_TEXT[r] ?? r) : 'the workspace changed');

interface Preview {
  readonly text: string | null;
  /** Length of a replay script over the preview limit (then `text` is null). */
  readonly tooLong?: number;
}
/** The last preview built, so re-renders that change nothing do not rebuild long text. */
let lastPreview: { key: readonly unknown[]; value: Preview } | null = null;

/** The exact text Copy writes for these inputs (pure; cached for identical inputs). */
function previewOf(report: VerdictReport | null, kind: CopyMode | null, current: boolean, why: string | undefined, options: Options): Preview {
  const key = [report, kind, current, why, options];
  if (lastPreview && lastPreview.key.every((k, i) => k === key[i])) return lastPreview.value;
  let value: Preview = { text: null };
  if (report && kind === 'summary') {
    value = { text: buildSummary(report, { current, ...(why ? { historicalReason: why } : {}), includeSql: options.sql, includeIdentifiers: options.ids, includeWitnesses: options.witnesses }) };
  } else if (report && kind === 'replay' && report.replay) {
    const script = replayScript(report.replay, { historical: current ? null : reasonText(why), finalised: finalised(report.stamp.finalisedAt) });
    // Size policy: a script too long to show in full is not offered (never shown or copied in part).
    value = script.length > MAX_REPLAY_SCRIPT_CHARS ? { text: null, tooLong: script.length } : { text: script };
  }
  lastPreview = { key, value };
  return value;
}

/**
 * Copy preview (PRD QV-UI-003; UI_SPECIFICATION §5; M12). Shows exactly the text that Copy writes:
 * the neutral summary (SQL, names and witness values only when the user adds them; the choices are
 * not kept) or the replay bundle's script. The clipboard is written only by the Copy button: never
 * on open, option change, report arrival or close. The report shown is the one the dialog opened
 * with; if a newer report arrives or its state changes, the labels and text update and a notice
 * says so. Success and failure are announced by the dialog's status region; focus stays put.
 */
export function CopyDialog({ mode, view, onClose, returnFocus, clipboard }: CopyDialogProps) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [options, setOptions] = useState<Options>(NO_OPTIONS);
  const [status, setStatus] = useState('');
  /** The open (its `seq`) whose clipboard write is pending; null when none (Codex M12). */
  const [pending, setPending] = useState<number | null>(null);
  /** What is on screen now, for writes that settle later: the open and the exact preview text. */
  const live = useRef<{ seq: number; text: string | null }>({ seq: -1, text: null });
  const previewRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const focusAfterSwitch = useRef(false);

  // Open and close (state adjusted during render, so the first open frame already shows the text).
  // Each open is a new `seq`: a write started in an earlier open never changes this one.
  if (mode && view.report && (!opened || opened.mode !== mode)) {
    setOpened({ mode, report: view.report, stateKey: keyOf(currencyOf(view.report, view)), seq: ++openSeq });
    setOptions(NO_OPTIONS);
    setStatus('');
    setPending(null);
  } else if (!mode && opened) {
    setOpened(null);
    setOptions(NO_OPTIONS);
    setStatus('');
    setPending(null);
  }

  const report = opened?.report ?? null;
  const c = report ? currencyOf(report, view) : { current: false };
  const changed = opened !== null && keyOf(c) !== opened.stateKey;
  const newer = report !== null && view.report !== null && view.report.id !== report.id;
  const kind = opened?.mode ?? null;

  // The exact text Copy writes, rebuilt only when what it depends on changes.
  const isCurrent = c.current;
  const why = c.reason;
  const built = previewOf(report, kind, isCurrent, why, options);
  const text = built.text;
  const busy = opened !== null && pending === opened.seq;

  useEffect(() => {
    live.current = { seq: opened?.seq ?? -1, text };
  });
  useEffect(() => {
    if (!focusAfterSwitch.current) return;
    focusAfterSwitch.current = false;
    (previewRef.current ?? rootRef.current?.closest('dialog')?.querySelector<HTMLElement>('.dialog-title'))?.focus();
  });

  const copy = async () => {
    if (text === null || busy || !opened) return;
    const value = text; // exactly what the preview shows now
    const seq = opened.seq;
    const writer = clipboard === undefined ? (typeof navigator !== 'undefined' ? (navigator.clipboard as ClipboardWriter | undefined) : undefined) : clipboard;
    const noun = opened.mode === 'summary' ? 'Summary' : 'Diagnostic SQL';
    if (!writer || typeof writer.writeText !== 'function') {
      setStatus(`${noun} was not copied: this browser does not offer clipboard access on this page. Select the text in the preview and copy it with the keyboard.`);
      return;
    }
    setPending(seq);
    try {
      await writer.writeText(value);
      if (live.current.seq !== seq) return; // closed meanwhile: this open's state is gone
      const lines = value.split('\n').length - 1;
      setStatus(live.current.text === value
        ? `${noun} copied to the clipboard: ${lines} lines, exactly as shown.`
        : `${noun} copied as the preview was when you chose Copy (${lines} lines). The preview has changed since then, so the clipboard does not hold what is shown now. Choose Copy again to copy it.`);
    } catch (e) {
      if (live.current.seq !== seq) return;
      const denied = e instanceof Error && e.name === 'NotAllowedError';
      setStatus(`${noun} was not copied: ${denied ? 'the browser denied clipboard permission' : 'the browser could not write to the clipboard'}. Nothing was copied. Select the text in the preview and copy it with the keyboard.`);
    } finally {
      setPending((p) => (p === seq ? null : p));
    }
  };

  const showNewer = () => {
    if (!view.report || !opened) return;
    setOpened({ ...opened, report: view.report, stateKey: keyOf(currencyOf(view.report, view)) });
    // Choices made for the previous report do not carry over to a different report.
    setOptions(NO_OPTIONS);
    setStatus(`Showing the newer report.${opened.mode === 'summary' ? ' The added sections were reset to off.' : ''}`);
    focusAfterSwitch.current = true; // the button disappears: focus the updated preview
  };

  const option = (key: keyof Options, label: string) => (
    <label className="copy-option">
      <input type="checkbox" checked={options[key]} onChange={(e) => setOptions((o) => ({ ...o, [key]: e.target.checked }))} />
      {label}
    </label>
  );

  const title = mode === 'replay' ? 'Diagnostic SQL' : 'Copy summary';
  return (
    <Dialog open={mode !== null && report !== null} title={title} onClose={onClose} returnFocus={returnFocus} wide focusTitle>
      {report && opened ? (
        <div className="copy-dialog" data-mode={opened.mode} ref={rootRef}>
          <p className="copy-state">
            <Badge tone={c.current ? 'info' : 'neutral'}>{c.current ? 'Current' : 'Historical'}</Badge>{' '}
            <Badge tone="neutral">{report.authoritative ? 'Authoritative' : 'Not authoritative'}</Badge>{' '}
            <span className="muted">
              {c.current ? 'This report is the current answer for the editor.' : `This report is historical: ${reasonText(c.reason)}. It describes an earlier state.`} Finalised {finalised(report.stamp.finalisedAt)} (this device’s clock).
            </span>
          </p>
          {newer ? (
            <div className="copy-notice" data-kind="newer">
              <p>A newer Verdict report arrived while this was open. The preview still shows the report you opened, now labelled historical.</p>
              <Button className="btn-small" variant="quiet" onClick={showNewer}>
                Show the newer report
              </Button>
            </div>
          ) : changed ? (
            <p className="copy-notice" data-kind="changed">
              The report’s state changed while this was open ({c.current ? 'it is current again' : `now historical: ${reasonText(c.reason)}`}). The preview below has been updated; check it before copying.
            </p>
          ) : null}

          {opened.mode === 'summary' ? (
            <>
              <p className="copy-disclosure">
                Shows exactly what Copy writes. By default the summary leaves out the analysed SQL, table and column names and the witness keys. It still contains the counts and outcomes, so it is not anonymous.
              </p>
              <fieldset className="copy-options">
                <legend>Add to the summary (off by default, not kept after this dialog closes)</legend>
                {option('sql', 'SQL text')}
                {option('ids', 'Table and column names')}
                {option('witnesses', 'Witness key values')}
              </fieldset>
              <p className="copy-disclosure">
                SQL text adds the query as written, which can itself contain table and column names and values. Table and column names adds the names to the Join and Measured lines. Witness key values adds a section listing the witness keys.
              </p>
            </>
          ) : report.replay && text !== null ? (
            <p className="copy-disclosure">
              A curated script of the diagnostic statements behind this report’s counts, each with its expected value. It contains table and column names, the query’s join condition and witness key values. Nothing runs here: Copy only copies it. To reproduce the counts, run it in DuckDB {report.replay.engine.duckdb} on tables holding the analysed rows (see Prerequisites in the script).
            </p>
          ) : (
            <div className="copy-unavailable">
              <p>
                {built.tooLong !== undefined
                  ? `The diagnostic script for this report would be ${built.tooLong.toLocaleString('en-US')} characters, over the ${MAX_REPLAY_SCRIPT_CHARS.toLocaleString('en-US')}-character limit for a preview. It is not offered, because only text shown in full can be copied.`
                  : (report.replayUnavailable ?? 'Diagnostic SQL is not available for this report.')}
              </p>
              {!report.authoritative && report.nonAuthoritativeReasons.length ? (
                <ul aria-label="Why the report is not authoritative">
                  {report.nonAuthoritativeReasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}

          {text !== null ? (
            <div className="copy-preview" ref={previewRef} tabIndex={0} role="region" aria-label={opened.mode === 'summary' ? 'Summary preview: the exact text Copy writes' : 'Diagnostic SQL preview: the exact text Copy writes'}>
              <pre className="copy-text">{text}</pre>
            </div>
          ) : null}

          <StatusRegion message={status} />
          <div className="dialog-actions">
            {text !== null ? (
              <Button variant="primary" onClick={() => void copy()} aria-disabled={busy}>
                {busy ? 'Copying…' : opened.mode === 'summary' ? 'Copy summary' : 'Copy diagnostic SQL'}
              </Button>
            ) : null}
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
