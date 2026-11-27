import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceStore, DEFAULT_LAYOUT, LAYOUT_LIMITS, LAYOUT_PRESETS } from '../../../src/stores/workspaceStore';

describe('workspaceStore (M05, session only)', () => {
  it('starts empty, results selected, default layout, no requests', () => {
    const s = createWorkspaceStore().getSnapshot();
    expect(s).toEqual({ sql: '', wrap: false, layout: DEFAULT_LAYOUT, output: 'results', lastRun: null, lastAnalyze: null, verdictDetail: false });
  });

  it('notifies only on real changes', () => {
    const w = createWorkspaceStore();
    const fn = vi.fn();
    w.subscribe(fn);
    w.setSql('SELECT 1');
    w.setSql('SELECT 1');
    w.setWrap(false);
    w.setOutput('results');
    w.setLayout({ sidebarPx: DEFAULT_LAYOUT.sidebarPx });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clamps the sidebar to 200–360 px and the editor fraction to 0–1', () => {
    const w = createWorkspaceStore();
    w.setLayout({ sidebarPx: 10 });
    expect(w.getSnapshot().layout.sidebarPx).toBe(LAYOUT_LIMITS.sidebarMinPx);
    w.setLayout({ sidebarPx: 9999 });
    expect(w.getSnapshot().layout.sidebarPx).toBe(LAYOUT_LIMITS.sidebarMaxPx);
    w.setLayout({ editorFraction: 1.7 });
    expect(w.getSnapshot().layout.editorFraction).toBe(1);
    w.setLayout({ editorFraction: -1 });
    expect(w.getSnapshot().layout.editorFraction).toBe(0);
    w.setLayout(LAYOUT_PRESETS.reset);
    expect(w.getSnapshot().layout).toEqual(DEFAULT_LAYOUT);
  });

  it('Run and Analyze are separate requests: each records its own query text and selects its own view', () => {
    const w = createWorkspaceStore({ sql: 'SELECT 1' });
    const run = w.request('run', 'SELECT 1');
    expect(w.getSnapshot()).toMatchObject({ output: 'results', lastRun: run, lastAnalyze: null });
    const analyze = w.request('analyze', 'SELECT 2');
    expect(analyze.seq).toBeGreaterThan(run.seq);
    expect(w.getSnapshot()).toMatchObject({ output: 'verdict', lastRun: run, lastAnalyze: { kind: 'analyze', sql: 'SELECT 2' } });
    expect(w.getSnapshot().sql).toBe('SELECT 1'); // submitting never clears the editor (UI_SPECIFICATION §4)
  });

  it('never touches browser storage', () => {
    const storage = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    const w = createWorkspaceStore();
    w.setSql('SELECT secret');
    w.setLayout({ sidebarPx: 300 });
    w.request('run', 'SELECT secret');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
