import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabSpec<T extends string> {
  readonly id: T;
  readonly label: string;
  /** id of the tab panel this tab controls (TabList only; Tabs controls its own panel). */
  readonly controls?: string;
}

export interface TabListProps<T extends string> {
  readonly label: string;
  readonly tabs: readonly TabSpec<T>[];
  readonly selected: T;
  onSelect(id: T): void;
  /** Prefix for tab element ids (`${idBase}-tab-${id}`), so panels can be labelled by them. */
  readonly idBase: string;
  readonly className?: string;
}

/**
 * Tab list (DESIGN_SYSTEM §5): arrow keys move between tabs and select them, Home/End jump.
 * Switching tabs only changes the view; it never starts engine work.
 */
export function TabList<T extends string>({ label, tabs, selected, onSelect, idBase, className }: TabListProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = tabs.length;
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onSelect((tabs[to] as TabSpec<T>).id);
    refs.current[to]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={className ? `tab-list ${className}` : 'tab-list'}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${t.id}`}
          aria-selected={t.id === selected}
          aria-controls={t.controls}
          tabIndex={t.id === selected ? 0 : -1}
          className="tab"
          onClick={() => onSelect(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export interface TabsProps<T extends string> {
  readonly label: string;
  readonly tabs: readonly { readonly id: T; readonly label: string }[];
  readonly selected: T;
  onSelect(id: T): void;
  readonly children: ReactNode;
}

/** A tab list with one panel showing the selected tab's content. */
export function Tabs<T extends string>({ label, tabs, selected, onSelect, children }: TabsProps<T>) {
  const base = useId();
  const panel = `${base}-panel`;
  return (
    <div className="tabs">
      <TabList label={label} tabs={tabs.map((t) => ({ ...t, controls: panel }))} selected={selected} onSelect={onSelect} idBase={base} />
      <div role="tabpanel" id={panel} aria-labelledby={`${base}-tab-${selected}`} className="tab-panel">
        {children}
      </div>
    </div>
  );
}
