import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TreeItem {
  readonly id: string;
  /** Accessible name of the item (plain text). */
  readonly name: string;
  /** Visible content of the item button (defaults to `name`). */
  readonly label?: ReactNode;
  /** Secondary text shown after the label (for example a row count or state). */
  readonly meta?: ReactNode;
  readonly selected: boolean;
  readonly expanded: boolean;
  /** Disclosed content; when absent the item has no disclosure control. */
  readonly children?: ReactNode;
}

export interface TreeProps {
  readonly label: string;
  readonly items: readonly TreeItem[];
  onSelect(id: string): void;
  onToggle(id: string): void;
}

/**
 * Accessible disclosure list (DESIGN_SYSTEM §5 "Tree or nested list"): each item is a button that
 * selects it (aria-current marks the selection) and, when it has details, a disclosure button
 * with aria-expanded. The normal Tab path reaches every control; Up/Down move between items and
 * Right/Left open and close the focused item's details.
 */
export function Tree({ label, items, onSelect, onToggle }: TreeProps) {
  const list = useRef<HTMLUListElement>(null);
  const base = useId();
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, item: TreeItem) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button[data-tree-item]') ?? [])];
    const at = buttons.indexOf(e.currentTarget);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[Math.min(buttons.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      buttons[e.key === 'Home' ? 0 : buttons.length - 1]?.focus();
    } else if (item.children !== undefined && ((e.key === 'ArrowRight' && !item.expanded) || (e.key === 'ArrowLeft' && item.expanded))) {
      e.preventDefault();
      onToggle(item.id);
    }
  };
  return (
    <ul className="tree" aria-label={label} ref={list}>
      {items.map((item, i) => {
        const details = `${base}-${i}`;
        return (
          <li key={item.id} className="tree-item" data-selected={item.selected || undefined}>
            <div className="tree-row">
              {item.children !== undefined ? (
                <button
                  type="button"
                  className="tree-toggle"
                  aria-expanded={item.expanded}
                  aria-controls={details}
                  aria-label={`${item.expanded ? 'Hide' : 'Show'} columns of ${item.name}`}
                  onClick={() => onToggle(item.id)}
                >
                  <svg className="chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                    <path d="M4.5 2.75 7.75 6 4.5 9.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ) : (
                <span className="tree-toggle-spacer" />
              )}
              <button type="button" data-tree-item className="tree-select" aria-current={item.selected ? 'true' : undefined} onClick={() => onSelect(item.id)} onKeyDown={(e) => onKey(e, item)}>
                <span className="tree-label">{item.label ?? item.name}</span>
                {item.meta ? <span className="tree-meta">{item.meta}</span> : null}
              </button>
            </div>
            {item.children !== undefined && item.expanded ? (
              <div id={details} className="tree-details">
                {item.children}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
