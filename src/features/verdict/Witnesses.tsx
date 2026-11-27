import { useId, useState } from 'react';
import type { JoinEvidence, WitnessKind } from '../../core/verdict/types';
import { Badge } from '../../ui/Badge';
import { TabList, type TabSpec } from '../../ui/Tabs';
import { count, emptyWitnessText, keyHeadings, WITNESS_FILTER_LABEL, WITNESS_KINDS, WITNESS_LABEL, witnessCheckText, witnessRows } from './model';

type Filter = WitnessKind | 'all';

/**
 * Bounded witness keys (UI_SPECIFICATION §5 "Witness table"; PRD QV-VER-002): fan-out and
 * unmatched keys from the report only, at most five per kind, in the report's deterministic order,
 * exact key tuples and counts as text. Filters only change the view: nothing is read again, and no
 * SQL runs. NULL-key rows are never witness keys; their totals are shown separately. An empty
 * kind says so with the validated count, and is never presented as proof that nothing is wrong.
 */
export function Witnesses({ join, current, headingId }: { join: JoinEvidence; current: boolean; headingId: string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const base = useId();
  const panel = `${base}-panel`;
  const s = join.stats;
  const rows = witnessRows(join.witnesses, filter);
  const counts = Object.fromEntries(WITNESS_KINDS.map((k) => [k, witnessRows(join.witnesses, k).length])) as Record<WitnessKind, number>;
  const heads = keyHeadings(join);
  const kinds = filter === 'all' ? WITNESS_KINDS : [filter];
  const empty = kinds.filter((k) => counts[k] === 0);
  const tabs: TabSpec<Filter>[] = [
    { id: 'all', label: `All (${WITNESS_KINDS.reduce((a, k) => a + counts[k], 0)})`, controls: panel },
    ...WITNESS_KINDS.map((k) => ({ id: k, label: `${WITNESS_FILTER_LABEL[k]} (${counts[k]})`, controls: panel })),
  ];
  return (
    <section className="vd-section" aria-labelledby={headingId}>
      <div className="vd-section-head">
        <h3 id={headingId}>Witnesses</h3>
        <Badge>Bounded samples</Badge>
        {current ? null : <Badge>Historical</Badge>}
      </div>
      <p className="vd-foot">
        Example keys chosen deterministically by the analysis: at most five per kind. They are examples, not a list of every affected row. {witnessCheckText[join.validation.witnesses]}
      </p>
      {s ? (
        <>
          <TabList<Filter> label="Witness kind" idBase={base} tabs={tabs} selected={filter} onSelect={setFilter} className="vd-filter" />
          {/* Focusable when it holds only text, so Tab reaches the empty-state explanation (APG Tabs). */}
          <div role="tabpanel" id={panel} aria-labelledby={`${base}-tab-${filter}`} className="vd-witness-panel" {...(rows.length ? {} : { tabIndex: 0 })}>
            {rows.length ? (
              <div className="vd-table-wrap" tabIndex={0} role="region" aria-labelledby={`${base}-caption`}>
                <table className="vd-table witnesses">
                  <caption id={`${base}-caption`} className="visually-hidden">
                    Witness keys{filter === 'all' ? '' : `: ${WITNESS_FILTER_LABEL[filter]}`}. {rows.length} {rows.length === 1 ? 'row' : 'rows'}.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Evidence</th>
                      {heads.map((h, i) => (
                        <th key={i} scope="col" className="num mono">
                          {h}
                        </th>
                      ))}
                      <th scope="col" className="num">
                        Left rows
                      </th>
                      <th scope="col" className="num">
                        Right rows
                      </th>
                      <th scope="col" className="num">
                        Join output
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((w, i) => (
                      <tr key={`${w.kind}-${i}`} data-kind={w.kind}>
                        <th scope="row">{WITNESS_LABEL[w.kind]}</th>
                        {heads.map((_, k) => (
                          <td key={k} className="num mono">
                            {w.key[k] ?? ''}
                          </td>
                        ))}
                        <td className="num">{count(w.leftRows)}</td>
                        <td className="num">{count(w.rightRows)}</td>
                        <td className="num">
                          {count(w.outputRows)}
                          {w.kind === 'unmatched-left' && join.type === 'LEFT' ? <span className="cell-note"> kept</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {empty.length ? (
              <ul className="vd-empty-kinds">
                {empty.map((k) => (
                  <li key={k}>
                    <strong>{WITNESS_LABEL[k]}:</strong> {emptyWitnessText(k, join)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <p className="vd-foot">
            NULL-key rows are counted separately and are never sample keys: {count(s.leftNullKeyRows)} left, {count(s.rightNullKeyRows)} right.
            {join.type === 'LEFT' ? ' In a LEFT JOIN, an unmatched left key’s rows are kept once each, so its join output is its left row count.' : ''}
          </p>
        </>
      ) : (
        <p className="empty-note">{emptyWitnessText('fan-out', join)}</p>
      )}
    </section>
  );
}
