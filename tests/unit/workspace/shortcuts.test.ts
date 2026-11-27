import { describe, expect, it } from 'vitest';
import { detectPlatform, keyLabel, shortcutFor, shortcuts } from '../../../src/features/workspace/shortcuts';

describe('workspace shortcuts (M05)', () => {
  it('detects Apple platforms from navigator.platform (user agent only when the platform is empty)', () => {
    expect(detectPlatform({ platform: 'MacIntel' })).toBe('apple');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' })).toBe('apple');
    expect(detectPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe('other');
    expect(detectPlatform({})).toBe('other');
    // A Mac user agent on Linux (Playwright WebKit on CI): the platform decides, like CodeMirror's Mod key.
    expect(detectPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe('other');
  });

  it('uses platform key names and matching aria-keyshortcuts', () => {
    expect(keyLabel(shortcutFor('apple', 'Run SQL'))).toBe('⌘ Return');
    expect(shortcutFor('apple', 'Run SQL').aria).toBe('Meta+Enter');
    expect(keyLabel(shortcutFor('other', 'Analyze'))).toBe('Ctrl Shift Enter');
    expect(shortcutFor('other', 'Analyze').aria).toBe('Control+Shift+Enter');
  });

  it('Run and Analyze differ only by Shift; Redo follows the platform', () => {
    for (const p of ['apple', 'other'] as const) {
      const run = shortcutFor(p, 'Run SQL').keys;
      const analyze = shortcutFor(p, 'Analyze').keys;
      expect(analyze.filter((k) => k !== 'Shift')).toEqual(run);
      expect(run).not.toContain('Shift');
    }
    expect(shortcuts('apple').find((s) => s.action === 'Redo')?.keys).toEqual(['⌘', 'Shift', 'Z']);
    expect(shortcuts('other').find((s) => s.action === 'Redo')?.keys).toEqual(['Ctrl', 'Y']);
  });

  it('lists no single-character global shortcut (UI_SPECIFICATION §7)', () => {
    for (const s of shortcuts('other')) expect(s.keys.length > 1 || ['Tab', 'Esc', 'Home', '←', 'Arrow keys'].includes(s.keys[0] as string)).toBe(true);
  });
});
