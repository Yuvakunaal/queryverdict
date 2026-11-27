import type { VerdictReport } from '../../core/verdict/types';
import { findingViews, measuredLoss, type FindingView } from './model';
import { StatusMark } from './VerdictStates';

function Evidence({ rows }: { rows: readonly [string, string][] }) {
  if (!rows.length) return null;
  return (
    <details className="vd-evidence">
      <summary>Evidence ({rows.length} {rows.length === 1 ? 'value' : 'values'})</summary>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function Card({ f }: { f: FindingView }) {
  return (
    <li className="vd-finding" data-tone={f.tone} data-category={f.category}>
      <p className="vd-finding-head">
        <StatusMark tone={f.tone} />
        <span className="vd-finding-label">{f.label}</span>
        <span className="vd-finding-title">{f.title}</span>
      </p>
      <p className="vd-finding-text">{f.message}</p>
      <p className="vd-finding-meta">
        <span>Side: {f.side}</span>
        <span>Stage: {f.stage}</span>
        <span>Evidence: {f.confidence}</span>
      </p>
      <Evidence rows={f.evidence} />
    </li>
  );
}

/**
 * Findings (UI_SPECIFICATION §5; PRD §4 labels). Persistent text and a shape for every category;
 * each names its side, stage and evidence. Expectation violations and suspicious patterns come
 * first; measured observations follow in a disclosure. Labels, severities and confidence are the
 * core's (findings.ts); natural fan-out stays an observation. Unchecked expectations are listed
 * once, in Expectations.
 */
export function Findings({ report, current, headingId }: { report: VerdictReport; current: boolean; headingId: string }) {
  // Measurement findings only; status findings (reasons, limits) are explained by the answer and listed under Details.
  const all = findingViews(report, current).filter((f) => f.category === 'observed' || f.category === 'suspicious' || f.category === 'expectation-violation');
  // Measured row loss stays visible (it is not folded into Observations), whatever its category.
  const loss = measuredLoss(report);
  const keep = (f: FindingView) => f.category !== 'observed' || (loss !== null && f.key.endsWith('-unmatched-rows-dropped'));
  const main = all.filter(keep);
  const observed = all.filter((f) => !keep(f));
  const unchecked = report.expectations.filter((o) => o.outcome === 'unchecked').length;
  return (
    <section className="vd-section" aria-labelledby={headingId}>
      <div className="vd-section-head">
        <h3 id={headingId}>Findings</h3>
      </div>
      {main.length ? (
        <ul className="vd-findings">
          {main.map((f) => (
            <Card key={f.key} f={f} />
          ))}
        </ul>
      ) : null}
      {unchecked ? (
        <p className="vd-foot">
          {unchecked} {unchecked === 1 ? 'expectation was' : 'expectations were'} not checked; see Expectations for the {unchecked === 1 ? 'reason' : 'reasons'}.
        </p>
      ) : null}
      {observed.length ? (
        <details className="vd-observations">
          <summary>
            Observations: {observed.length} measured {observed.length === 1 ? 'fact' : 'facts'}
            {current ? '' : ' (historical)'}
          </summary>
          <ul className="vd-findings">
            {observed.map((f) => (
              <Card key={f.key} f={f} />
            ))}
          </ul>
        </details>
      ) : null}
      {!main.length && !observed.length ? <p className="empty-note">No findings were produced.</p> : null}
    </section>
  );
}
