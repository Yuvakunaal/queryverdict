// E9 browser measurements (revised after the Codex M05 review).
// Every trial uses a fresh browser context and the identical 1,000-line document. Within a trial:
//   1. load and readiness time (two animation frames after the editor exists);
//   2. requests and CSP violations during load;
//   3. keyboard entry/exit (once per candidate, in a separate context before the trials);
//   4. typing: caret placed at the document end through the editor's own API and its offset
//      asserted, then 62 keystrokes; latency keydown → second animation frame; the resulting text
//      is asserted to be exactly document + typed text;
//   5. one real clipboard paste of 200 KB at the asserted document end, timed to the second frame
//      after the text arrives, and the result validated (length and suffix).
// The textarea baseline runs the same steps.
import { chromium, firefox, webkit } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const RUNS = Number(process.env.RUNS ?? 7);
const TYPED = 'SELECT o.order_id FROM orders AS o WHERE o.amount > 10; -- x';
const PASTE = "SELECT 2 AS a, 'y' AS b FROM t;\n".repeat(6400); // 204,800 characters
const cands = [['baseline', 4201], ['cm', 4202], ['monaco', 4203]];
const servers = cands.map(([n, port]) => spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { env: { ...process.env, E9_ENTRY: n }, stdio: 'ignore' }));
await new Promise((r) => setTimeout(r, 2500));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)].toFixed(1) : null; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(1) : null; };
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const out = { method: 'revised-2026-11-27', runs: RUNS };
try {
  for (const [bname, bt, opts] of [['chromium', chromium, { channel: 'chrome' }], ['firefox', firefox, {}], ['webkit', webkit, {}]]) {
    const browser = await bt.launch(opts);
    out[bname] = { version: browser.version() };
    const mod = 'Meta'; // macOS reference machine
    for (const [n, port] of cands) {
      const url = `http://127.0.0.1:${port}/queryverdict/${n}.html`;
      const r = { ready: [], typing: [], paste: [], external: new Set(), startup: new Set(), csp: [], errors: [], failures: [] };
      // Keyboard entry and exit, in a separate context so measured trials start from the identical document.
      {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        await page.goto(url);
        await page.waitForFunction(() => window.__e9, null, { timeout: 30000 });
          const TAB = bname === 'webkit' ? 'Alt+Tab' : 'Tab';
          await page.focus('#before');
          await page.keyboard.press(TAB);
          await page.waitForTimeout(100);
          const inEditor = await page.evaluate(() => { const a = document.activeElement; return { tag: a.tagName, role: a.getAttribute('role'), label: a.getAttribute('aria-label'), multiline: a.getAttribute('aria-multiline'), inRoot: !!a.closest('#root') }; });
          await page.keyboard.press(TAB);
          await page.waitForTimeout(100);
          const afterTab = await page.evaluate(() => ({ id: document.activeElement.id, inRoot: !!document.activeElement.closest('#root') }));
          let escape = null;
          if (afterTab.inRoot) {
            await page.keyboard.press(n === 'monaco' ? 'Control+Shift+M' : 'Escape');
            await page.keyboard.press(TAB);
            await page.waitForTimeout(100);
            escape = await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
          }
          await page.focus('#after');
          await page.keyboard.press(bname === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
          await page.waitForTimeout(100);
          const reverse = await page.evaluate(() => !!document.activeElement.closest('#root'));
          r.keyboard = { inEditor, afterTab, escape, reverse };
        await ctx.close();
      }

      for (let i = 0; i < RUNS; i++) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        if (bname === 'chromium') await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
        const page = await ctx.newPage();
        await page.addInitScript(() => {
          window.__csp = [];
          document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
        });
        page.on('request', (rq) => {
          const u = new URL(rq.url());
          if (u.protocol === 'data:' || u.protocol === 'blob:') return;
          if (u.origin !== `http://127.0.0.1:${port}`) r.external.add(rq.url());
          else r.startup.add(u.pathname.replace(/-[\w-]{8}\./, '-*.'));
        });
        page.on('pageerror', (e) => r.errors.push(String(e).slice(0, 160)));
        log(bname, n, 'run', i);
        await page.goto(url);
        await page.waitForFunction(() => window.__e9, null, { timeout: 30000 });
        r.ready.push(await page.evaluate(() => window.__e9.ready));
        await page.waitForTimeout(300);
        r.csp.push(...(await page.evaluate(() => window.__csp)));
        const doc0 = await page.evaluate(() => window.__e9.get());

        // Typing at the asserted document end.
        await page.evaluate(() => window.__e9.toEnd());
        await frames(page);
        const caret = await page.evaluate(() => window.__e9.caret());
        if (caret !== doc0.length) { r.failures.push(`run ${i}: caret ${caret} ≠ end ${doc0.length}`); await ctx.close(); continue; }
        await page.evaluate(() => {
          window.__lat = [];
          document.addEventListener('keydown', () => { const t = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.__lat.push(performance.now() - t))); }, true);
        });
        for (const ch of TYPED) await page.keyboard.type(ch);
        await page.waitForTimeout(300);
        r.typing.push(...(await page.evaluate(() => window.__lat)));
        const afterTyping = await page.evaluate(() => window.__e9.get());
        if (afterTyping !== doc0 + TYPED) r.failures.push(`run ${i}: typed text not exact (${afterTyping.length - doc0.length} chars added)`);

        // One real clipboard paste at the asserted document end.
        try {
          await page.evaluate((t) => navigator.clipboard.writeText(t), PASTE);
          await page.evaluate(() => window.__e9.toEnd());
          await frames(page);
          const before = await page.evaluate(() => window.__e9.get().length);
          const at = await page.evaluate(() => window.__e9.caret());
          if (at !== before) throw new Error(`caret ${at} ≠ end ${before} before paste`);
          const t = Date.now();
          await page.keyboard.press(`${mod}+V`);
          await page.waitForFunction((b) => window.__e9.get().length > b, before, { timeout: 15000 });
          await frames(page);
          const ms = Date.now() - t;
          const ok = await page.evaluate(({ b, p }) => { const v = window.__e9.get(); return v.length === b + p.length && v.endsWith(p); }, { b: before, p: PASTE });
          if (!ok) r.failures.push(`run ${i}: pasted content not exact`);
          else r.paste.push(ms);
        } catch (e) {
          r.failures.push(`run ${i}: paste ${String(e).split('\n')[0].slice(0, 100)}`);
        }

        if (i === 0) {
          const axe = await new AxeBuilder({ page }).analyze();
          r.axe = axe.violations.map((v) => `${v.id}(${v.nodes.length})`);
        }
        await ctx.close();
      }
      out[bname][n] = {
        readyMedianMs: med(r.ready), readyAll: r.ready.map((x) => +x.toFixed(0)),
        typing: { samples: r.typing.length, median: med(r.typing), p95: q(r.typing, 0.95) },
        paste: { samples: r.paste.length, median: med(r.paste), all: r.paste },
        external: [...r.external], startupFetches: [...r.startup].sort(), csp: [...new Set(r.csp)], errors: [...new Set(r.errors)],
        keyboard: r.keyboard, axe: r.axe, failures: r.failures,
      };
      console.log(bname, n, JSON.stringify(out[bname][n]));
    }
    await browser.close();
  }
} finally {
  servers.forEach((s) => s.kill());
}
writeFileSync('results.json', JSON.stringify(out, null, 2));
