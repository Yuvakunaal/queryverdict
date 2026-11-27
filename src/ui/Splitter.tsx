import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

export interface SplitterProps {
  /**
   * Orientation of the separator itself: a `vertical` separator divides left and right panes and
   * moves with Left/Right; a `horizontal` one divides top and bottom panes and moves with Up/Down.
   */
  readonly orientation: 'vertical' | 'horizontal';
  /** id of the visible heading of the pane this separator resizes (its accessible name). */
  readonly labelledBy: string;
  /** id of the pane this separator resizes (the pane before it). */
  readonly controls: string;
  /** Size of the controlled pane in CSS pixels, and its bounds. */
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** Size of the whole split along the same axis, so the value is reported as a percentage. */
  readonly total: number;
  /** Arrow-key step in pixels; Shift multiplies it by 4. */
  readonly step?: number;
  onChange(px: number): void;
  /** Double-click restores the default size. */
  onReset(): void;
}

const pct = (px: number, total: number) => (total > 0 ? Math.round((px / total) * 100) : 0);

/**
 * Resizable split (DESIGN_SYSTEM §5, WAI-ARIA window splitter pattern): a focusable `separator`
 * with its value, bounds and orientation, operated by pointer drag, arrow keys (Shift for larger
 * steps) and Home/End. Values are announced as percentages of the split (UI_SPECIFICATION §7).
 * A double-click resets; named presets live in Settings so no size needs a drag. The accessible
 * name is the visible heading of the pane it resizes (APG window splitter). A drag belongs to the
 * pointer that started it.
 */
export function Splitter({ orientation, labelledBy, controls, value, min, max, total, step = 16, onChange, onReset }: SplitterProps) {
  /** The drag in progress and the pointer that owns it; other contacts are ignored. */
  const drag = useRef<{ pointerId: number; start: number; from: number } | null>(null);
  const vertical = orientation === 'vertical';
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const coord = (e: PointerEvent) => (vertical ? e.clientX : e.clientY);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey ? 4 : 1;
    const less = vertical ? 'ArrowLeft' : 'ArrowUp';
    const more = vertical ? 'ArrowRight' : 'ArrowDown';
    let next: number | null = null;
    if (e.key === less) next = value - step * big;
    else if (e.key === more) next = value + step * big;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    onChange(clamp(next));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return; // a second contact never takes over a drag
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    drag.current = { pointerId: e.pointerId, start: coord(e), from: value };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && d.pointerId === e.pointerId) onChange(clamp(d.from + coord(e) - d.start));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-labelledby={labelledBy}
      aria-controls={controls}
      aria-orientation={orientation}
      aria-valuenow={pct(value, total)}
      aria-valuemin={pct(min, total)}
      aria-valuemax={pct(max, total)}
      className="splitter"
      data-orientation={orientation}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={(e) => {
        if (drag.current?.pointerId === e.pointerId) drag.current = null;
      }}
      onDoubleClick={onReset}
    />
  );
}
