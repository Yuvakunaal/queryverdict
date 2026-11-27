import type { JoinEvidence } from '../../core/verdict/types';
import { Badge } from '../../ui/Badge';
import { capitalise, count, keyCondition, plural, relationLabel, relationshipText, type Tone } from './model';

export interface JoinOverviewProps {
  readonly join: JoinEvidence;
  /** The report's evidence badge (Validated evidence, Limited evidence …). */
  readonly evidence: { label: string; tone: Tone };
  /** Why the measurements are missing, when they were withheld. */
  readonly withheld?: string;
  readonly headingId: string;
}

function Arrow() {
  return (
    <svg className="join-arrow" width="20" height="14" viewBox="0 0 20 14" aria-hidden="true" focusable="false">
      <path d="M1 7h16M12 2l5 5-5 5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One accounting row: label and the left and right exact values (or "–" where not applicable). */
function Row({ label, left, right, note }: { label: string; left?: string; right?: string; note?: string }) {
  const cell = (v: string | undefined) =>
    v === undefined ? (
      <td className="num na">
        –<span className="visually-hidden">not applicable</span>
      </td>
    ) : (
      <td className="num">{count(v)}</td>
    );
  return (
    <tr>
      <th scope="row">
        {label}
        {note ? <span className="row-note">{note}</span> : null}
      </th>
      {cell(left)}
      {cell(right)}
    </tr>
  );
}

/**
 * The measured join (UI_SPECIFICATION §5 "Join diagram"; PRD QV-VER-002): Left and Right inputs →
 * the join (type, key condition, relationships with their scope) → output rows and matched pairs,
 * then a row-accounting table that separates input rows, NULL-key rows, key groups, matched rows,
 * multiplied rows, excess copies, and unmatched rows kept or dropped. Every number is an exact
 * value from the report; nothing is proportional or estimated. The list order is the reading
 * order, so the text alone describes the diagram.
 */
export function JoinOverview({ join, evidence, withheld, headingId }: JoinOverviewProps) {
  const s = join.stats;
  const d = join.derived;
  const left = join.type === 'LEFT';
  const conditions = keyCondition(join);
  const keyType = [...new Set(join.keys.map((k) => k.type))].join(', ');
  return (
    <section className="vd-section" aria-labelledby={headingId}>
      <div className="vd-section-head">
        <h3 id={headingId}>Join overview</h3>
        <Badge tone={evidence.tone}>{evidence.label}</Badge>
      </div>
      <ol className="join-flow">
        <li className="join-inputs">
          {(['left', 'right'] as const).map((side) => {
            const rel = side === 'left' ? join.left : join.right;
            return (
              <div key={side} className="join-node" data-side={side}>
                <p className="node-kicker">{side === 'left' ? 'Left input' : 'Right input'}</p>
                <p className="node-name">{relationLabel(rel)}</p>
                {s ? (
                  <p className="node-meta">
                    <span className="node-count">{plural(side === 'left' ? s.leftRows : s.rightRows, 'row', 'rows')}</span>
                    <span>{plural(side === 'left' ? s.leftNullKeyRows : s.rightNullKeyRows, 'NULL-key row', 'NULL-key rows')}</span>
                    <span>{plural(side === 'left' ? s.leftDuplicateKeys : s.rightDuplicateKeys, 'duplicate key group', 'duplicate key groups')}</span>
                  </p>
                ) : null}
                {s && d ? (
                  <p className="node-meta node-flow">
                    <span>{count(side === 'left' ? s.leftRowsMatched : s.rightRowsMatched)} matched</span>
                    {side === 'left' && left ? (
                      <span>{count(d.leftRowsPreserved)} unmatched, kept</span>
                    ) : (
                      <span data-attention={(side === 'left' ? d.leftRowsDropped : d.rightRowsDropped) !== '0' || undefined}>
                        {count(side === 'left' ? d.leftRowsDropped : d.rightRowsDropped)} unmatched, dropped
                      </span>
                    )}
                    <span data-attention={(side === 'left' ? s.leftExcessCopies : s.rightExcessCopies) !== '0' || undefined}>
                      {count(side === 'left' ? s.leftRowsMultiplied : s.rightRowsMultiplied)} multiplied (+{count(side === 'left' ? s.leftExcessCopies : s.rightExcessCopies)} copies)
                    </span>
                  </p>
                ) : null}
              </div>
            );
          })}
        </li>
        <li className="join-op">
          <Arrow />
          <div className="join-node" data-kind="join">
            <p className="node-kicker">Join</p>
            <p className="node-name">{join.type} JOIN</p>
            <p className="node-keys">
              {conditions.map((c, i) => (
                <span key={c}>
                  {i ? <span className="node-and">AND </span> : null}
                  {c}
                </span>
              ))}
            </p>
            <p className="node-meta">
              <span>Key type {keyType}</span>
              {s ? <span>{plural(s.matchedKeys, 'matching key group', 'matching key groups')}</span> : null}
            </p>
            {d ? (
              <dl className="node-rel">
                <div>
                  <dt>Whole inputs</dt>
                  <dd>{capitalise(relationshipText(d.relationship))}</dd>
                </div>
                <div>
                  <dt>Matched keys</dt>
                  <dd>{capitalise(relationshipText(d.matchedRelationship))}</dd>
                </div>
              </dl>
            ) : null}
          </div>
        </li>
        <li className="join-out">
          <Arrow />
          <div className="join-node" data-kind="output">
            <p className="node-kicker">Join output</p>
            {s && d ? (
              <>
                <p className="node-total">{plural(d.outputRows, 'row', 'rows')}</p>
                <p className="node-meta">
                  <span>{plural(s.matchedPairs, 'matched pair', 'matched pairs')}</span>
                  {left ? <span>{plural(d.leftRowsPreserved, 'unmatched left row kept', 'unmatched left rows kept')}</span> : null}
                </p>
              </>
            ) : (
              <p className="node-meta">Not measured</p>
            )}
          </div>
        </li>
      </ol>
      {withheld ? <p className="vd-withheld">Measurements withheld: {withheld}</p> : null}
      {s && d ? (
        <details className="vd-accounting">
          <summary>Row accounting by input</summary>
        <div className="vd-table-wrap" tabIndex={0} role="region" aria-labelledby={`${headingId}-acc`}>
          <table className="vd-table accounting">
            <caption id={`${headingId}-acc`}>Row accounting by input · exact counts from the analysed snapshot</caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col" className="num">
                  Left <span className="th-sub">{join.left.ref}</span>
                </th>
                <th scope="col" className="num">
                  Right <span className="th-sub">{join.right.ref}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <Row label="Input rows" left={s.leftRows} right={s.rightRows} />
              <Row label="Rows with a NULL key" note="never match; counted separately" left={s.leftNullKeyRows} right={s.rightNullKeyRows} />
              <Row label="Distinct non-NULL keys" left={s.leftDistinctKeys} right={s.rightDistinctKeys} />
              <Row label="Duplicate key groups" left={s.leftDuplicateKeys} right={s.rightDuplicateKeys} />
              <Row label="Matched input rows" left={s.leftRowsMatched} right={s.rightRowsMatched} />
              <Row label="Rows multiplied" note="appear more than once in the output" left={s.leftRowsMultiplied} right={s.rightRowsMultiplied} />
              <Row label="Excess copies" note="copies past the first" left={s.leftExcessCopies} right={s.rightExcessCopies} />
              <Row label="Unmatched rows" left={d.leftUnmatchedRows} right={d.rightUnmatchedRows} />
              <Row label="· kept, with NULL right columns" left={left ? d.leftRowsPreserved : undefined} />
              <Row label="· dropped, no output" left={d.leftRowsDropped} right={d.rightRowsDropped} />
            </tbody>
          </table>
        </div>
        </details>
      ) : null}
      {s && d && left ? (
        <p className="vd-foot">In a LEFT JOIN, unmatched left rows are kept once each with NULL right columns; they are preserved, not dropped. Unmatched right rows contribute no output.</p>
      ) : s && d ? (
        <p className="vd-foot">In an INNER JOIN, unmatched rows on either side contribute no output.</p>
      ) : null}
    </section>
  );
}
