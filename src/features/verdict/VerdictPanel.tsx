import { useId, useRef, useState, type Ref } from 'react';
import type { AnalysisState } from '../../stores/analysisStore';
import type { EngineSnapshot } from '../../stores/engineStore';
import type { ExpectationStore } from '../../stores/expectationStore';
import type { ReportView } from '../../stores/reportStore';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { CopyDialog, type CopyMode } from './CopyDialog';
import { Coverage } from './Coverage';
import { ExpectationOutcomes, ExpectationsEditor, type DeclarationState } from './ExpectationsEditor';
import { Findings } from './Findings';
import { JoinOverview } from './JoinOverview';
import { answerFor, type Answer, type RowFate } from './answer';
import { count, evidenceBadge, hasValidatedJoin, relationLabel } from './model';
import { AnalysisBar, EngineNotice, NoAnalysis, StatusMark } from './VerdictStates';
import { Witnesses } from './Witnesses';

export interface VerdictPanelProps {
  readonly view: ReportView;
  readonly analysis: AnalysisState;
  readonly engine: EngineSnapshot;
  readonly expectations: ExpectationStore;
  /** Platform label of the Analyze shortcut, for the empty state. */
  readonly analyzeKeys: string;
  /** Full-width detail view: shows Back to SQL. */
  readonly detail: boolean;
  /** The editor's Cancel analysis is not on screen (full view, or the narrow Verdict view): show one here. */
  readonly cancelHere: boolean;
  /** Wide layouts only: open the full-width view (absent on narrow screens, which are already full width). */
  onOpenDetail?(): void;
  onBack?(): void;
  onCancel(): void;
  /** The app's status region, for the expectation editor. */
  announce?(message: string): void;
  readonly headingRef?: Ref<HTMLHeadingElement>;
}

/**
 * The Visual Verdict (UI_SPECIFICATION §5): report identity and coverage state → measured join →
 * findings and expectations → witnesses → checked and outside scope. Everything shown comes from
 * the report store's latest published report and its currency; the panel computes no evidence and
 * decides no authority. Switching to this view never starts an analysis.
 */
export function VerdictPanel({ view, analysis, engine, expectations, analyzeKeys, detail, cancelHere, onOpenDetail, onBack, onCancel, announce, headingRef }: VerdictPanelProps) {
  const id = useId();
  const h = (s: string) => `${id}-${s}`;
  const { report, current } = view;
  const evidence = report ? evidenceBadge(report) : null;
  const join = report?.join ?? null;
  const declarations: DeclarationState = !report || !current ? 'pending' : hasValidatedJoin(report) ? 'evaluated' : 'not-evaluated';

  const answer = report ? answerFor(report, current, view.historicalReason) : null;
  // Copy previews (M12): opened only by these buttons; nothing is copied until Copy in the dialog.
  const [copyMode, setCopyMode] = useState<CopyMode | null>(null);
  // The control that opened the dialog, kept after closing so focus returns to it on every kind of close (Codex M12).
  const [opener, setOpener] = useState<CopyMode>('summary');
  const openCopy = (m: CopyMode) => {
    setOpener(m);
    setCopyMode(m);
  };
  const summaryBtn = useRef<HTMLButtonElement>(null);
  const replayBtn = useRef<HTMLButtonElement>(null);

  return (
    <article className="verdict" data-detail={detail || undefined} data-presentation={answer?.presentation} aria-labelledby={h('title')}>
      <header className="vd-head">
        <div className="vd-head-main">
          <h2 id={h('title')} className="vd-title" ref={headingRef} tabIndex={-1}>
            Visual Verdict
          </h2>
          {report ? (
            <p className="vd-identity">
              {join ? (
                <>
                  <span className="mono">{relationLabel(join.left)}</span> × <span className="mono">{relationLabel(join.right)}</span> · {join.type} JOIN
                </>
              ) : (
                <span className="mono vd-sql-line">{report.identity.sqlText.trim().split('\n')[0]}</span>
              )}
            </p>
          ) : null}
        </div>
        {report && evidence ? (
          <p className="vd-tags">
            <span className="visually-hidden">Report state: </span>
            <Badge tone={current ? 'info' : 'neutral'}>{current ? 'Current' : 'Historical'}</Badge>
            <Badge tone={current ? evidence.tone : 'neutral'}>{evidence.label}</Badge>
          </p>
        ) : null}
        <div className="vd-actions">
          {report ? (
            <>
              <Button ref={summaryBtn} className="btn-small" variant="quiet" onClick={() => openCopy('summary')} aria-haspopup="dialog">
                Copy summary…
              </Button>
              <Button ref={replayBtn} className="btn-small" variant="quiet" onClick={() => openCopy('replay')} aria-haspopup="dialog">
                View diagnostic SQL
              </Button>
            </>
          ) : null}
          {detail ? (
            <Button className="btn-small" onClick={onBack}>
              Back to SQL
            </Button>
          ) : onOpenDetail ? (
            <Button className="btn-small" variant="quiet" onClick={onOpenDetail}>
              Open full view
            </Button>
          ) : null}
        </div>
      </header>

      <EngineNotice engine={engine} />
      <AnalysisBar state={analysis} {...(cancelHere ? { onCancel } : {})} />

      {!report ? <NoAnalysis analyzeKeys={analyzeKeys} /> : null}
      {report && answer ? <AnswerBlock answer={answer} /> : null}

      {report && join && answer?.measured ? (
        <JoinOverview
          join={join}
          evidence={current ? (evidence ?? { label: '', tone: 'neutral' }) : { label: `${evidence?.label ?? ''} · historical`, tone: 'neutral' }}
          headingId={h('overview')}
        />
      ) : null}

      {report && answer?.measured ? <Findings report={report} current={current} headingId={h('findings')} /> : null}

      {!report || join || report.expectations.length ? (
        <section className="vd-section" aria-labelledby={h('expectations')}>
          <div className="vd-section-head">
            <h3 id={h('expectations')}>Expectations</h3>
          </div>
          {report && report.expectations.length ? (
            <>
              <h4 className="vd-subhead">Outcomes in this report{current ? '' : ' (historical)'}</h4>
              <ExpectationOutcomes report={report} current={current} />
            </>
          ) : null}
          {!report || join ? (
            <ExpectationsEditor store={expectations} state={declarations} {...(announce ? { announce } : {})} />
          ) : (
            <p className="empty-note">Expectations apply when the query has a join that Verdict can analyze.</p>
          )}
        </section>
      ) : (
        <p className="empty-note vd-expect-note">Expectations apply when the query has a join that Verdict can analyze.</p>
      )}

      {report && join && answer?.measured ? <Witnesses join={join} current={current} headingId={h('witnesses')} /> : null}

      {report ? <Coverage report={report} current={current} headingId={h('coverage')} statusFindings={!answer?.measured} /> : null}
      <CopyDialog mode={copyMode} view={view} onClose={() => setCopyMode(null)} returnFocus={opener === 'replay' ? replayBtn : summaryBtn} />
    </article>
  );
}

/** What happened to each table's rows (exact counts from the report). */
function FateTable({ fate }: { fate: readonly RowFate[] }) {
  const keptCol = fate.some((f) => f.kept !== '0');
  const cell = (v: string, extra?: string) => (
    <td className="num" data-zero={v === '0' || undefined}>
      {count(v)}
      {extra && v !== '0' ? <span className="cell-note"> (+{count(extra)} extra)</span> : null}
    </td>
  );
  return (
    <div className="vd-table-wrap vd-fate" tabIndex={0} role="region" aria-label="What happened to each row">
      <table className="vd-table">
        <caption className="visually-hidden">What happened to the rows of each table in this join</caption>
        <thead>
          <tr>
            <th scope="col">Table</th>
            <th scope="col" className="num">Rows</th>
            <th scope="col" className="num">In the result once</th>
            <th scope="col" className="num">More than once</th>
            {keptCol ? <th scope="col" className="num">Kept with empty columns</th> : null}
            <th scope="col" className="num">Not in the result</th>
          </tr>
        </thead>
        <tbody>
          {fate.map((f) => (
            <tr key={f.side}>
              <th scope="row">
                <span className="mono">{f.table}</span> <span className="muted">({f.side})</span>
              </th>
              {cell(f.rows)}
              {cell(f.once)}
              {cell(f.multiple, f.extra)}
              {keptCol ? cell(f.kept) : null}
              {cell(f.missing)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The answer (P-106): headline, what happened to each row, why, what it means, what to do next. */
function AnswerBlock({ answer }: { answer: Answer }) {
  const historical = answer.presentation === 'historical';
  const meaning = historical ? answer.meaning.slice(1) : answer.meaning;
  return (
    <section className="vd-answer" data-tone={answer.tone} data-kind={answer.kind} aria-label="Answer">
      <p className="vd-answer-headline">
        <StatusMark tone={answer.tone} />
        <span>{answer.headline}</span>
      </p>
      {/* A historical answer reads "Earlier result: …" before the details it lists. */}
      {historical && answer.meaning[0] ? <p className="vd-answer-meaning">{answer.meaning[0]}</p> : null}
      {answer.fate ? <FateTable fate={answer.fate} /> : null}
      {answer.effects.length ? (
        <div className="vd-answer-why">
          <p className="vd-answer-label">Why</p>
          <ul className="vd-answer-effects">
            {answer.effects.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {meaning.length ? (
        <div className="vd-answer-means">
          {meaning.some((m) => !m.startsWith('No issues found')) ? <p className="vd-answer-label">What this means for your result</p> : null}
          {meaning.map((m) => (
            <p key={m} className={m.startsWith('No issues found in these checks') ? 'vd-healthy' : 'vd-answer-meaning'}>
              {m}
            </p>
          ))}
        </div>
      ) : null}
      {answer.next.length ? (
        <div className="vd-answer-next">
          <p className="vd-answer-label">What to do next</p>
          <ul>
            {answer.next.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {answer.also.length ? <p className="vd-answer-also">Also outside the checks: {answer.also.join(' · ')}</p> : null}
    </section>
  );
}
