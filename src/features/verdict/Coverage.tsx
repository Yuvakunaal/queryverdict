import type { VerdictReport } from '../../core/verdict/types';
import { reasonOf } from './answer';
import { evidenceRows, findingViews } from './model';
import { count } from './model';

const time = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Coverage and authority (UI_SPECIFICATION §5 "Coverage and reproduction"; PRD QV-VER-006): what
 * was checked, what is outside the checks, why the report is or is not authoritative within the
 * supported scope, and the report's identity. The identity details are a disclosure, so they do
 * not crowd the report. Budget values are labelled limits; spent values are labelled measured.
 */
export function Coverage({ report, current, headingId, statusFindings }: { report: VerdictReport; current: boolean; headingId: string; statusFindings?: boolean }) {
  const r = report.resources;
  // Without measurements, the analyzer's own findings (every reason, with its evidence) live here.
  const status = statusFindings ? findingViews(report, current).filter((f) => f.category !== 'observed' && f.category !== 'suspicious' && f.category !== 'expectation-violation') : [];
  return (
    <details className="vd-section vd-all-details">
      <summary>
        <h3 id={headingId}>Details</h3>
        <span className="vd-details-hint">what was checked, authority and report identity</span>
      </summary>
      {status.length ? (
        <>
          <h4 className="vd-subhead">Analyzer findings</h4>
          <ul className="vd-status-findings">
            {status.map((f) => {
              const finding = report.findings.find((x, i) => `${i}-${x.code}` === f.key);
              const title = finding && finding.category === 'unsupported' ? reasonOf(finding).title : f.title;
              const ev = evidenceRows(finding?.evidence);
              return (
                <li key={f.key}>
                  <strong>{f.label}: {title}.</strong> {f.message}
                  {ev.length ? <span className="muted"> ({ev.map(([k, v]) => `${k}: ${v}`).join('; ')})</span> : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <div className="vd-coverage">
        <div>
          <h4 className="vd-subhead">What Verdict checked</h4>
          {report.coverage.checked.length ? (
            <ul>
              {report.coverage.checked.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : (
            <p className="empty-note">Nothing was checked in this run.</p>
          )}
        </div>
        <div>
          <h4 className="vd-subhead">Outside coverage</h4>
          <ul>
            {report.coverage.notChecked.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="vd-authority">
        {report.authoritative && current
          ? 'Authority: this report is authoritative within the supported join-stage checks, for the analysed snapshot of the data.'
          : report.authoritative
            ? 'Authority: this report was authoritative when it was produced; it is now historical.'
            : 'Authority: this report is not authoritative.'}
      </p>
      {report.nonAuthoritativeReasons.length ? (
        <ul className="vd-reasons" aria-label="Why the report is not authoritative">
          {report.nonAuthoritativeReasons.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      ) : null}
      <p className="vd-disclaimer">{report.disclaimer}</p>
      <details className="vd-details">
        <summary>Report identity and diagnostic work</summary>
        <dl>
          <div>
            <dt>Report</dt>
            <dd className="mono">{report.id}</dd>
          </div>
          <div>
            <dt>Query identity</dt>
            <dd className="mono">SHA-256 {report.identity.queryHash.slice(0, 16)}…</dd>
          </div>
          <div>
            <dt>Analysed SQL</dt>
            <dd>
              <pre className="vd-sql">{report.identity.sqlText}</pre>
            </dd>
          </div>
          <div>
            <dt>Dialect</dt>
            <dd>DuckDB SQL, on the engine in this tab{report.replay ? ` (DuckDB ${report.replay.engine.duckdb}, duckdb-wasm ${report.replay.engine.package})` : ''}</dd>
          </div>
          <div>
            <dt>Reproduction</dt>
            <dd>
              {report.replay
                ? `View diagnostic SQL shows a curated script of ${report.replay.statements.length} labelled statements with the expected values of this report. It needs the two input tables with the analysed rows; the probes were diagnostic statements, not the query itself. Nothing is run or copied until you choose Copy.`
                : (report.replayUnavailable ?? 'Diagnostic SQL is not available for this report.')}
            </dd>
          </div>
          {report.identity.inputs.map((x, i) => (
            <div key={x.oid}>
              <dt>{report.identity.inputs.length === 2 ? (i === 0 ? 'Left input' : 'Right input') : 'Input'}</dt>
              <dd>
                <span className="mono">
                  {x.database}.{x.schema}.{x.relation}
                </span>{' '}
                · {x.temporary ? 'temporary table' : 'base table'} · catalog id {x.oid}
              </dd>
            </div>
          ))}
          <div>
            <dt>Engine generation · data epoch</dt>
            <dd>
              {report.stamp.generation ?? 'not started'} · {report.stamp.epoch}
            </dd>
          </div>
          <div>
            <dt>Finalised</dt>
            <dd>{time(report.stamp.finalisedAt)} (this device’s clock)</dd>
          </div>
          {r ? (
            <>
              <div>
                <dt>Diagnostic statements</dt>
                <dd>
                  {r.statements} probe statements sent to the engine. Verdict bound the query and never ran it; ordinary Run SQL is separate.
                </dd>
              </div>
              <div>
                <dt>Pair rows</dt>
                <dd>
                  {count(r.spent.pairRows)} measured · limit {count(r.limits.executionPairRows)}
                </dd>
              </div>
              <div>
                <dt>Input rows</dt>
                <dd>limit {count(r.limits.maxInputRows)} per input</dd>
              </div>
              <div>
                <dt>Grouping state</dt>
                <dd>
                  {count(r.spent.groupingBytes)} bytes estimated (upper bound, not measured) · limit {count(r.limits.groupingBytes)} bytes
                </dd>
              </div>
              <div>
                <dt>Deadline</dt>
                <dd>limit {r.limits.deadlineMs.toLocaleString('en-US')} ms, including the wait in the queue</dd>
              </div>
            </>
          ) : null}
        </dl>
      </details>
    </details>
  );
}
