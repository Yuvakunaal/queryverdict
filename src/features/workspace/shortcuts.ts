// Keyboard shortcuts that the workspace actually supports (UI_SPECIFICATION §7), with
// platform-specific key names. Only bindings implemented and tested in M05 are listed here; the
// shortcuts dialog and the buttons' aria-keyshortcuts read from this one table.

export type Platform = 'apple' | 'other';

/**
 * Platform for key names. Uses `navigator.platform`, the same signal CodeMirror uses to map its
 * Mod key, so the labels always match the real binding (a browser can report a Mac user agent on
 * another platform). The user agent is consulted only when the platform is empty.
 */
export function detectPlatform(nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === 'undefined' ? undefined : navigator): Platform {
  const s = nav?.platform ? nav.platform : (nav?.userAgent ?? '');
  return /Mac|iPhone|iPad|iPod/i.test(s) ? 'apple' : 'other';
}

export interface Shortcut {
  readonly action: string;
  /** Where the keys work. */
  readonly scope: string;
  /** Key names as shown, one entry per key (rendered as separate <kbd> elements). */
  readonly keys: readonly string[];
  /** Alternative key sequence, if any (for example Redo). */
  readonly alt?: readonly string[];
  /** Value for aria-keyshortcuts on the matching button, when there is one. */
  readonly aria?: string;
}

export function shortcuts(p: Platform): readonly Shortcut[] {
  const mod = p === 'apple' ? '⌘' : 'Ctrl';
  const modAria = p === 'apple' ? 'Meta' : 'Control';
  const enter = p === 'apple' ? 'Return' : 'Enter';
  return [
    { action: 'Run SQL', scope: 'SQL editor: the statement at the cursor, or every statement in the selection', keys: [mod, enter], aria: `${modAria}+Enter` },
    { action: 'Analyze', scope: 'SQL editor', keys: [mod, 'Shift', enter], aria: `${modAria}+Shift+Enter` },
    { action: 'Leave the editor', scope: 'SQL editor', keys: ['Tab'], alt: ['Shift', 'Tab'] },
    { action: 'Undo', scope: 'SQL editor', keys: [mod, 'Z'] },
    { action: 'Redo', scope: 'SQL editor', keys: p === 'apple' ? [mod, 'Shift', 'Z'] : [mod, 'Y'] },
    { action: 'Resize panels', scope: 'Focused divider', keys: ['Arrow keys'], alt: ['Shift', 'Arrow keys'] },
    { action: 'Smallest or largest panel', scope: 'Focused divider', keys: ['Home'], alt: ['End'] },
    { action: 'Switch tabs', scope: 'Tab list', keys: ['←'], alt: ['→'] },
    { action: 'Close dialog', scope: 'Dialog', keys: ['Esc'] },
  ];
}

/** Compact label for a shortcut (for example "⌘ Return"), used in visible hints. */
export const keyLabel = (s: Shortcut) => s.keys.join(' ');

export function shortcutFor(p: Platform, action: 'Run SQL' | 'Analyze'): Shortcut {
  return shortcuts(p).find((s) => s.action === action) as Shortcut;
}
