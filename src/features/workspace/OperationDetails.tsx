import type { BootInfo, OperationId, SessionState } from '../../core/engine/types';
import type { ReleaseProfile } from '../../core/profile/profile';
import type { OperationEntry } from '../../stores/operationStore';
import { groupDigits } from '../explorer/model';
import { bytesText as formatBytes } from '../results/ResultsPanel';
import { OperationList } from './OperationList';
import { limitText } from './operationModel';

export interface OperationDetailsProps {
  readonly ops: readonly OperationEntry[];
  readonly engine: SessionState;
  readonly info: BootInfo | null;
  readonly profile: ReleaseProfile;
  readonly now: number;
  /** Bytes of imported files on the current engine (sum of file sizes; the combined limit counts these). */
  readonly importedBytes: number;
  readonly transactionMayBeOpen: boolean;
  onCancel(id: OperationId): void;
  /** Where focus goes when a focused Cancel disappears and no other Cancel remains. */
  focusFallback?(): HTMLElement | null;
  outcomeOf?(o: OperationEntry): string | undefined;
}

const ENGINE_TEXT: Record<SessionState['kind'], string> = {
  idle: 'Not started',
  starting: 'Starting',
  ready: 'Ready',
  busy: 'Ready (working)',
  cancelling: 'Cancelling',
  recovering: 'Recovering',
  failed: 'Failed',
  disposed: 'Stopped',
};

const n = (v: number | bigint) => groupDigits(String(v));

/**
 * Operation details (UI_SPECIFICATION §6; M10): the engine as it reported itself at start, the
 * operation list with Cancel, and the configured limits of this build, each labelled "limit".
 * Only two things are measured, each with its source: elapsed times (this tab's clock) and the
 * size of imported files. No memory figure, progress or completion time is shown: none is
 * measured, and the limits are provisional development values, not tested capacity.
 */
export function OperationDetails({ ops, engine, info, profile, now, importedBytes, transactionMayBeOpen, onCancel, focusFallback, outcomeOf }: OperationDetailsProps) {
  const r = profile.results;
  const b = profile.bounds;
  const v = profile.verdict;
  const i = profile.imports;
  const rows: [string, string, string][] = [
    ['Imports', 'File size', `${formatBytes(i.maxFileBytes)} per file`],
    ['Imports', 'Combined size', `${formatBytes(i.maxCombinedBytes)} across imported files`],
    ['Imports', 'Time limit', `${limitText(b.importMs)} per file`],
    ['Results', 'Rows shown', `${n(r.maxRows)} per result`],
    ['Results', 'Columns shown', `${n(r.maxColumns)} per result`],
    ['Results', 'Characters per value', n(r.maxCellChars)],
    ['Results', 'Characters shown in total', n(r.maxDisplayChars)],
    ['Results', 'Result data collected', `${formatBytes(r.maxArrowBytes)} (checked as each batch of rows arrives; a batch is received in full before it is checked)`],
    ['Run SQL', 'Time limit', 'None: a statement runs until it finishes or you cancel it'],
    ['Analyze', 'Time limit', `${limitText(b.verdictMs)}, including the wait in the queue`],
    ['Analyze', 'Row pairs built by checks', n(v.executionPairRows)],
    ['Analyze', 'Rows per input table', n(v.maxInputRows)],
    ['Analyze', 'Key-counting memory (estimate)', formatBytes(Number(v.groupingBytes))],
    ['Analyze', 'Key columns', n(v.maxKeyColumns)],
    ['Preview', 'Time limit', limitText(b.queueWaitMs)],
    ['Queue', 'Wait before Run SQL, an import, a preview or a removal starts', `${limitText(b.queueWaitMs)} (Analyze: its own time limit above includes the wait)`],
    ['Cancel', 'Stop request, then stop', `Up to ${limitText(b.cancelRequestMs)} to request the stop, then up to ${limitText(b.cancelRequestMs)} for the work to stop; after that the engine is restarted`],
    ['Cancel', 'Clean-up after an operation', `Up to ${limitText(b.cleanupMs)} for each clean-up step (for example the final ROLLBACK); if one does not finish, the engine is restarted`],
    ['Engine', 'Start', limitText(b.bootMs)],
    ['Engine', 'Recovery', limitText(b.recoveryMs)],
    ['Engine', 'DuckDB memory setting', `${profile.engine.memoryLimit} (DuckDB’s own buffer limit, not a limit on the browser tab)`],
  ];
  return (
    <div className="op-details">
      <section aria-labelledby="opd-engine">
        <h3 id="opd-engine" className="op-subhead">Engine</h3>
        <dl className="op-dl">
          <div>
            <dt>State</dt>
            <dd>{ENGINE_TEXT[engine.kind]}{engine.kind === 'recovering' || engine.kind === 'failed' ? ` — ${engine.reason}` : ''}</dd>
          </div>
          {info ? (
            <div>
              <dt>Engine</dt>
              <dd>
                DuckDB {info.duckdb} ({info.bundle === 'eh' ? 'exception-handling' : 'baseline'} build), started in {n(Math.round(info.bootMs))} ms with its security settings verified; engine instance {info.generation} in this tab (reported by the engine at start)
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Imported files</dt>
            <dd>
              {formatBytes(importedBytes)} of the {formatBytes(i.maxCombinedBytes)} combined limit (sum of the source file sizes on this engine)
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="opd-ops">
        <h3 id="opd-ops" className="op-subhead" tabIndex={-1}>Operations</h3>
        <p className="op-note">Operations run one at a time, in order. Times are elapsed times on this tab’s clock; no completion time is predicted.</p>
        <OperationList ops={ops} engine={engine} now={now} onCancel={onCancel} {...(focusFallback ? { focusFallback } : {})} {...(outcomeOf ? { outcomeOf } : {})} />
      </section>

      <section aria-labelledby="opd-tx">
        <h3 id="opd-tx" className="op-subhead">Transactions</h3>
        <p className="op-note" data-tone={transactionMayBeOpen ? 'warning' : undefined}>
          {transactionMayBeOpen
            ? 'A BEGIN ran in Run SQL with no COMMIT or ROLLBACK after it, so a transaction may be open. While it is, imports, removals and Analyze are refused, because each needs a transaction of its own. Run COMMIT or ROLLBACK yourself; QueryVerdict never ends your transaction.'
            : 'No transaction was started in Run SQL. If you run BEGIN, imports, removals and Analyze wait for your COMMIT or ROLLBACK.'}
        </p>
      </section>

      <section aria-labelledby="opd-limits">
        <h3 id="opd-limits" className="op-subhead">Limits of this build</h3>
        <p className="op-note">
          Configured limits, not measurements. They are provisional development values, not tested capacity: release limits are set after qualification on the reference machine. Usage is not measured against them while operations run.
        </p>
        <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="opd-limits">
          <table className="data-table op-limits">
            <caption className="visually-hidden">Configured limits</caption>
            <thead>
              <tr>
                <th scope="col">Area</th>
                <th scope="col">Limit</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([area, what, value]) => (
                <tr key={`${area}-${what}`}>
                  <td>{area}</td>
                  <th scope="row">{what}</th>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="opd-bg">
        <h3 id="opd-bg" className="op-subhead">Background tabs</h3>
        <p className="op-note">
          Browsers slow down timers in tabs you are not looking at, so time limits are applied while this tab is visible. When you come back, any limit that passed meanwhile is applied at once and reported.
        </p>
      </section>
    </div>
  );
}
