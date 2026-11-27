// R1 rendering measurement (M06): the production build, the real Run SQL path, at the P-020 bounds.
import { chromium, firefox, webkit } from '@playwright/test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const RUNS = Number(process.env.RUNS ?? 3);
const cols = (n, f) => Array.from({ length: n }, (_, k) => f(k)).join(', ');
const FIX = {
  F1_1000x10_short: `SELECT ${cols(10, (k) => `i + ${k} AS c${k}`)} FROM range(1000) t(i)`,
  F2_1000x200_short: `SELECT ${cols(200, (k) => `i + ${k} AS c${k}`)} FROM range(1000) t(i)`,
  F3_1000x4_500chars: `SELECT ${cols(4, (k) => `repeat(chr(${97 + k}), 600) AS c${k}`)} FROM range(1000) t(i)`,
  F4_1000x200_10chars: `SELECT ${cols(200, (k) => `lpad(CAST(i + ${k} AS VARCHAR), 10, '0') AS c${k}`)} FROM range(1000) t(i)`,
};
const srv = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: process.cwd(), stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const out = { machine: 'Apple M2 MacBook Air, 8 GB RAM', viewport: '1440x900', runs: RUNS };
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
try {
  for (const [bname, bt, opts] of [['chromium', chromium, { channel: 'chrome' }], ['firefox', firefox, {}], ['webkit', webkit, {}]]) {
    const browser = await bt.launch(opts);
    out[bname] = { version: browser.version() };
    for (const [fname, sql] of Object.entries(FIX)) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const p = await ctx.newPage();
        await p.addInitScript(() => {
          const w = window;
          w.__lt = []; w.__gaps = []; w.__mark = null;
          w.__ltSupported = (PerformanceObserver.supportedEntryTypes || []).includes('longtask'); if (w.__ltSupported) new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__lt.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true });
          let last = performance.now();
          const tick = (t) => { const g = t - last; if (g > 50) w.__gaps.push({ at: last, gap: g }); last = t; requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        });
        await p.goto('http://127.0.0.1:4173/queryverdict/');
        await p.getByText('Engine ready').first().waitFor({ timeout: 30000 });
        const ed = p.getByRole('textbox', { name: 'SQL editor' });
        await ed.click();
        await p.keyboard.insertText(sql);
        await p.waitForTimeout(500);
        await p.evaluate(() => { window.__lt = []; window.__gaps = []; window.__t0 = performance.now(); });
        await p.keyboard.press('ControlOrMeta+Enter');
        await p.locator('.result-scroll').waitFor({ timeout: 60000 });
        // Painted: two frames after the grid exists.
        const painted = await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - window.__t0)))));
        await p.waitForTimeout(800);
        const render = await p.evaluate(() => ({ lt: window.__lt.map((e) => Math.round(e.dur)), ltSupported: window.__ltSupported, gaps: window.__gaps.map((g) => Math.round(g.gap)), cells: document.querySelectorAll('.result-table td').length, buttons: document.querySelectorAll('.cell-detail').length, domNodes: document.getElementsByTagName('*').length }));
        // Scrolling: 20 vertical then 20 horizontal steps, 40 ms apart; frame gaps recorded.
        await p.evaluate(() => { window.__lt = []; window.__gaps = []; });
        const sc = p.locator('.result-scroll');
        for (let s = 1; s <= 20; s++) { await sc.evaluate((el, s) => { el.scrollTop = (el.scrollHeight * s) / 20; }, s); await p.waitForTimeout(40); }
        for (let s = 1; s <= 20; s++) { await sc.evaluate((el, s) => { el.scrollLeft = (el.scrollWidth * s) / 20; }, s); await p.waitForTimeout(40); }
        await p.waitForTimeout(300);
        const scroll = await p.evaluate(() => ({ lt: window.__lt.map((e) => Math.round(e.dur)), gaps: window.__gaps.map((g) => Math.round(g.gap)) }));
        // Interaction: typing in the editor while the grid is shown (keydown → next frame).
        await ed.click();
        await p.evaluate(() => { window.__typ = []; document.addEventListener('keydown', () => { const t = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.__typ.push(performance.now() - t))); }, true); });
        await p.keyboard.type(' -- typing probe');
        await p.waitForTimeout(300);
        const typingLat = await p.evaluate(() => window.__typ);
        runs.push({ painted: Math.round(painted), render, scroll, typing: typingLat.map((x) => Math.round(x)) });
        await ctx.close();
      }
      const maxLt = (k) => Math.max(0, ...runs.flatMap((r) => r[k].lt));
      const maxGap = (k) => Math.max(0, ...runs.flatMap((r) => r[k].gaps));
      out[bname][fname] = {
        cells: runs[0].render.cells, detailButtons: runs[0].render.buttons, domNodes: runs[0].render.domNodes,
        paintedMs: runs.map((r) => r.painted), paintedMedian: med(runs.map((r) => r.painted)),
        longTaskSupported: runs[0].render.ltSupported, renderMaxLongTask: maxLt('render'), renderLongTasks: runs.map((r) => r.render.lt),
        renderMaxFrameGap: maxGap('render'), scrollMaxLongTask: maxLt('scroll'), scrollMaxFrameGap: maxGap('scroll'),
        typingMaxMs: Math.max(0, ...runs.flatMap((r) => r.typing)),
      };
      console.log(bname, fname, JSON.stringify(out[bname][fname]));
    }
    await browser.close();
  }
} finally { srv.kill(); }
writeFileSync(new URL('./r1-results.json', import.meta.url), JSON.stringify(out, null, 2));
