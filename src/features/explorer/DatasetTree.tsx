import type { DatasetEntry } from '../../core/datasets/types';
import type { ImportItem } from '../../stores/importStore';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Tree, type TreeItem } from '../../ui/Tree';
import { entryKey, isAmbiguous, ORIGIN, rowCountText, STAGE, STATE } from './model';

/** Columns listed in the sidebar per dataset; the inspector's schema view shows all of them. */
const SIDEBAR_COLUMNS = 100;

export interface DatasetTreeProps {
  readonly entries: readonly DatasetEntry[];
  readonly importing: readonly ImportItem[];
  readonly selected: string | null;
  readonly expanded: ReadonlySet<string>;
  onSelect(key: string): void;
  onToggle(key: string): void;
  onShowImports(): void;
}

/** One line of secondary text: origin, format or kind, and the location when the name is shared. */
function subline(e: DatasetEntry, shared: boolean): string {
  const parts: string[] = [ORIGIN[e.origin]];
  if (e.source) parts.push(e.source.format.toUpperCase());
  if (e.kind === 'view') parts.push('View');
  if (shared && e.identity) parts.push(`${e.identity.database}.${e.identity.schema}`);
  return parts.join(' · ');
}

/** The datasets sidebar list (UI_SPECIFICATION §3): every entry comes from the registry snapshot. */
export function DatasetTree({ entries, importing, selected, expanded, onSelect, onToggle, onShowImports }: DatasetTreeProps) {
  const items: TreeItem[] = entries.map((e) => {
    const key = entryKey(e);
    const state = STATE[e.state];
    const cols = e.columns ?? [];
    return {
      id: key,
      name: e.relation,
      selected: key === selected,
      expanded: expanded.has(key),
      label: (
        <>
          <span className="dataset-name">{e.relation}</span>
          <span className="dataset-sub">
            {subline(e, isAmbiguous(e, entries))}
            {e.state !== 'ready' ? <> <Badge tone={state.tone}>{state.label}</Badge></> : <span className="visually-hidden"> · {state.label}</span>}
          </span>
        </>
      ),
      meta: e.rowCount !== undefined && e.state === 'ready' ? rowCountText(e.rowCount) : undefined,
      children: cols.length ? (
        <ul className="column-list" aria-label={`Columns of ${e.relation}`}>
          {cols.slice(0, SIDEBAR_COLUMNS).map((c, i) => (
            <li key={`${i}-${c.name}`}>
              <span className="column-name">{c.name}</span>
              <span className="column-type">{c.type}</span>
            </li>
          ))}
          {cols.length > SIDEBAR_COLUMNS ? <li className="column-more">{cols.length - SIDEBAR_COLUMNS} more columns in the inspector</li> : null}
        </ul>
      ) : undefined,
    };
  });
  return (
    <>
      {importing.length ? (
        <section className="import-strip" aria-label="Imports in progress">
          <ul className="import-list">
            {importing.map((i) => (
              <li key={`${i.progress.fileName}-${i.progress.id}`}>
                <span className="dataset-name">{i.progress.relation ?? i.progress.fileName}</span>
                <span className="dataset-sub">
                  <Badge tone="info">{STATE.importing.label}</Badge> {STAGE[i.progress.stage]}
                </span>
              </li>
            ))}
          </ul>
          <Button variant="quiet" className="btn-small" onClick={onShowImports}>
            Show import progress
          </Button>
        </section>
      ) : null}
      {items.length ? <Tree label="Datasets" items={items} onSelect={onSelect} onToggle={onToggle} /> : null}
    </>
  );
}
