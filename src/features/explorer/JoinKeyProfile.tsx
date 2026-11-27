import type { DatasetEntry } from '../../core/datasets/types';
import type { ReportView } from '../../stores/reportStore';
import { count, hasValidatedJoin, historicalText, relationLabel } from '../verdict/model';

type Side = 'left' | 'right';

/**
 * Join-key profile (UI_SPECIFICATION §3 "Profiling"; ARCHITECTURE §17): validated key evidence for
 * this table, taken only from the CURRENT Verdict report, and only when this exact table (catalog
 * identity) was one of its inputs. It never starts work: no profiling query, no scan. A historical,
 * incomplete or unrelated report shows why there is no profile instead.
 */
export function JoinKeyProfile({ entry, view }: { entry: DatasetEntry; view: ReportView }) {
  const report = view.report;
  if (!report) return <p className="empty-note">Analyze a supported join to inspect its keys.</p>;
  const sides: Side[] = report.identity.inputs.flatMap((x, i): Side[] => (entry.identity && x.oid === entry.identity.oid && x.relation === entry.relation ? [i === 0 ? 'left' : 'right'] : []));
  if (!sides.length) return <p className="empty-note">This table is not an input of the latest Verdict report. Analyze a supported join that reads it to inspect its keys.</p>;
  if (!view.current) return <p className="empty-note">No current key profile: the latest report for this table is historical. {historicalText(view.historicalReason)} Analyze again to refresh it.</p>;
  if (!hasValidatedJoin(report) || !report.join?.stats || !report.join.derived) {
    return <p className="empty-note">No key profile: the latest report did not produce validated join evidence ({report.status}). See the Verdict tab for the reason.</p>;
  }
  const join = report.join;
  const s = join.stats!;
  const d = join.derived!;
  return (
    <div className="key-profile">
      <p className="key-profile-scope">
        From the current Verdict report: <span className="mono">{relationLabel(join.left)}</span> {join.type} JOIN <span className="mono">{relationLabel(join.right)}</span>. Exact counts over every
        row of the analysed snapshot, not a sample.
      </p>
      {sides.map((side) => {
        const L = side === 'left';
        const keys = join.keys.map((k) => ({ column: L ? k.left : k.right, type: k.type }));
        const rows: [string, string][] = [
          ['Input rows', L ? s.leftRows : s.rightRows],
          ['Distinct non-NULL key groups', L ? s.leftDistinctKeys : s.rightDistinctKeys],
          ['Duplicate key groups', L ? s.leftDuplicateKeys : s.rightDuplicateKeys],
          ['Most rows for one key', L ? s.leftMaxMultiplicity : s.rightMaxMultiplicity],
          ['NULL-key input rows', L ? s.leftNullKeyRows : s.rightNullKeyRows],
          ['Matched input rows', L ? s.leftRowsMatched : s.rightRowsMatched],
          ['Unmatched input rows', L ? d.leftUnmatchedRows : d.rightUnmatchedRows],
        ];
        return (
          <section key={side} className="key-profile-side" aria-label={`Join-key profile, ${side} input`}>
            <p className="key-profile-head">
              <strong>{L ? 'Left input' : 'Right input'}</strong> · key{' '}
              {keys.map((k, i) => (
                <span key={i}>
                  {i ? ', ' : ''}
                  <span className="mono">{k.column}</span> <span className="muted">{k.type}</span>
                </span>
              ))}
            </p>
            <div className="table-scroll" tabIndex={0} role="region" aria-label={`Key measures, ${side} input`}>
              <table className="data-table">
                <caption className="visually-hidden">Join-key measures of {entry.relation} as the {side} input</caption>
                <thead>
                  <tr>
                    <th scope="col">Measure</th>
                    <th scope="col" data-numeric>
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([k, v]) => (
                    <tr key={k}>
                      <th scope="row">{k}</th>
                      <td data-numeric>{count(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
