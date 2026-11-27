import { useSyncExternalStore } from 'react';
import type { DatasetEntry, DatasetRegistry } from '../../core/datasets/types';
import type { ReleaseProfile } from '../../core/profile/profile';
import { planLimits } from '../../core/results/bounds';
import type { BoundedResult, CellText } from '../../core/results/types';
import type { Announcer } from '../../stores/announcer';
import type { ImportStore } from '../../stores/importStore';
import type { PreviewStore } from '../../stores/previewStore';
import type { ReportView } from '../../stores/reportStore';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Table } from '../../ui/Table';
import { Tabs } from '../../ui/Tabs';
import { DatasetActions } from './DatasetActions';
import { JoinKeyProfile } from './JoinKeyProfile';
import { formatBytes, groupDigits, isPresent, ORIGIN, rowCountText, STATE } from './model';

export type InspectorTab = 'schema' | 'preview' | 'keys';

export interface InspectorProps {
  readonly entry: DatasetEntry;
  /** The name is shared with another relation (shown and copied qualified). */
  readonly qualified: boolean;
  readonly tab: InspectorTab;
  onTab(tab: InspectorTab): void;
  readonly registry: DatasetRegistry;
  readonly imports: ImportStore;
  readonly preview: PreviewStore;
  readonly announcer: Announcer;
  readonly profile: ReleaseProfile;
  readonly engineReady: boolean;
  /** The latest Verdict report and its currency (M09: join-key profile). */
  readonly report: ReportView;
}

const text = (s: string): CellText => ({ kind: 'text', text: s, truncated: false });

/** Explains what a preview showed and what was cut, each cause separately (QV-RES-001). */
export function previewNotes(r: BoundedResult): string[] {
  const n: string[] = [];
  if (r.truncation.rows) n.push(`Only the first ${r.limits.rows} rows are shown; the table has more.`);
  if (r.truncation.display) n.push(`Rows were withheld to keep the preview within ${groupDigits(String(r.limits.displayChars))} characters.`);
  if (r.truncation.columns) n.push(`${r.truncation.columns.shown} of ${r.truncation.columns.total} columns are shown.`);
  if (r.truncation.cells) n.push(`${r.truncation.cells} ${r.truncation.cells === 1 ? 'value was' : 'values were'} cut at ${r.limits.cellChars} characters (marked …).`);
  return n;
}

/**
 * The dataset inspector (UI_SPECIFICATION §3): schema first; sample rows only after an explicit
 * Preview. Selecting a dataset or switching tabs never starts engine work.
 */
export function Inspector({ entry, qualified, tab, onTab, registry, imports, preview, announcer, profile, engineReady, report }: InspectorProps) {
  const p = useSyncExternalStore(preview.subscribe, preview.getSnapshot);
  const state = STATE[entry.state];
  const cols = entry.columns ?? [];
  const present = isPresent(entry);
  // A preview belongs to this exact table (relation and identity), never to a replacement.
  const mine = p.status !== 'idle' && p.relation === entry.relation && p.oid === entry.identity?.oid;
  const startPreview = () => {
    if (!entry.identity || !present || entry.kind !== 'table') return;
    onTab('preview');
    preview.start({ relation: entry.relation, identity: entry.identity });
  };
  const limits = planLimits(cols.length || 1, profile.results);
  const hasNullability = cols.some((c) => c.nullable !== null);
  const meta: string[] = [];
  if (entry.source) meta.push(`From ${entry.source.fileName} · ${entry.source.format.toUpperCase()} · ${formatBytes(entry.source.bytes)}`);
  meta.push(cols.length ? `${groupDigits(String(cols.length))} ${cols.length === 1 ? 'column' : 'columns'}` : 'Columns unknown');
  meta.push(
    entry.rowCount !== undefined && entry.state === 'ready'
      ? rowCountText(entry.rowCount)
      : entry.origin === 'imported' && entry.state === 'ready'
        ? 'Row count hidden: data may have changed since import'
        : 'Row count not measured',
  );

  return (
    <section className="inspector" aria-labelledby="inspector-title">
      <header className="inspector-head">
        <div className="inspector-titlebar">
          <h2 id="inspector-title" className="inspector-title" tabIndex={-1}>
            {entry.relation}
          </h2>
          <span className="inspector-badges">
            <Badge>{ORIGIN[entry.origin]}</Badge>
            <Badge tone={state.tone}>{state.label}</Badge>
            {entry.kind === 'view' ? <Badge>View</Badge> : null}
          </span>
        </div>
        <p className="inspector-meta">
          {meta.map((m) => (
            <span key={m}>{m}</span>
          ))}
          {entry.identity ? <span className="mono">{entry.identity.database}.{entry.identity.schema}</span> : null}
        </p>
        <p className="inspector-eligibility">{entry.verdictEligible ? 'Eligible as a Verdict input.' : `Not a Verdict input: ${entry.eligibilityReason ?? 'not available'}`}</p>
        {entry.state !== 'ready' ? (
          <p className="state-note" data-tone={state.tone}>
            <strong>{state.label}.</strong> {entry.reason ?? state.description}
            {entry.origin === 'sql' && !present ? ' Tables created by SQL must be recreated with SQL.' : ''}
          </p>
        ) : null}
        <DatasetActions entry={entry} qualified={qualified} registry={registry} imports={imports} announcer={announcer} engineReady={engineReady} onPreview={startPreview} onViewSchema={() => onTab('schema')} />
      </header>
      <Tabs label={`Details of ${entry.relation}`} tabs={[{ id: 'schema', label: 'Schema' }, { id: 'preview', label: 'Preview' }, { id: 'keys', label: 'Join keys' }]} selected={tab} onSelect={onTab}>
        {tab === 'keys' ? (
          <JoinKeyProfile entry={entry} view={report} />
        ) : tab === 'schema' ? (
          cols.length ? (
            <Table
              caption={`Schema of ${entry.relation}: ${cols.length} ${cols.length === 1 ? 'column' : 'columns'}`}
              columns={[{ name: 'Column' }, { name: 'Type' }, ...(hasNullability ? [{ name: 'Nullable' }] : [])]}
              rows={cols.map((c) => [text(c.name), text(c.type), ...(hasNullability ? [text(c.nullable === null ? 'Not reported' : c.nullable ? 'Yes' : 'No')] : [])])}
              captionHidden
              variant="schema"
            />
          ) : (
            <p className="empty-note">{present ? 'This relation has no columns.' : 'The schema is not available because the table is not in this session.'}</p>
          )
        ) : (
          <div className="preview">
            {!present || entry.kind !== 'table' ? (
              <p className="empty-note">{entry.kind === 'view' ? 'Preview is available for tables. Query the view with SQL instead.' : 'Preview needs the table to be in this session.'}</p>
            ) : !mine ? (
              <div className="preview-idle">
                <p className="empty-note">
                  A preview shows up to {limits.rows} rows and {limits.columns} columns in the order the engine returns them (unordered), with values cut at {limits.cellChars} characters. It runs only when you ask.
                </p>
                <Button variant="primary" className="btn-small" onClick={startPreview} disabled={!engineReady}>
                  Preview first rows
                </Button>
              </div>
            ) : p.status === 'running' ? (
              <p className="preview-bar" aria-busy="true">
                <span>Previewing {entry.relation}…</span>
                <Button className="btn-small" onClick={() => preview.cancel()}>Cancel preview</Button>
              </p>
            ) : p.status === 'done' ? (
              <>
                <p className="preview-bar">
                  <span>
                    {p.result.rows.length === 0 && !p.result.truncation.display
                      ? p.result.columns.length ? 'This table has no rows. Its columns are listed in the Schema tab.' : 'This table has no columns.'
                      : `${p.result.rows.length} ${p.result.rows.length === 1 ? 'row' : 'rows'} · unordered preview`}
                  </span>
                  <Button variant="quiet" className="btn-small" onClick={startPreview} disabled={!engineReady}>Refresh</Button>
                </p>
                {p.result.rows.length ? (
                  <Table
                    rowNumbers
                    caption={`Preview of ${entry.relation}: first ${p.result.rows.length} ${p.result.rows.length === 1 ? 'row' : 'rows'}${p.result.truncation.columns ? `, ${p.result.columns.length} columns` : ''}`}
                    captionHidden
                    columns={p.result.columns}
                    rows={p.result.rows}
                    truncation={previewNotes(p.result)}
                  />
                ) : null}
              </>
            ) : (
              <p className="preview-bar" data-tone={p.status === 'error' ? 'violation' : 'neutral'}>
                <span>{p.status === 'stale' ? `Preview out of date. ${p.message}` : p.message}</span>
                <Button variant="quiet" className="btn-small" onClick={startPreview} disabled={!engineReady}>
                  {p.status === 'error' ? 'Try again' : 'Preview again'}
                </Button>
              </p>
            )}
          </div>
        )}
      </Tabs>
    </section>
  );
}
