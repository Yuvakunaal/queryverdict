#!/usr/bin/env node
// E1: engine boot time (cold = fresh profile/empty cache, warm = reload with HTTP cache) and asset
// sizes. Serves dist/ with `vite preview` at /queryverdict/ (no COOP/COEP/CSP, no compression).
//   node scripts/measure-boot.mjs [--runs 5]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const ROOT = join(import.meta.dirname, '..');
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1] || 5);
const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
const base = 'http://127.0.0.1:4173/queryverdict/';
for (let i = 0; ; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
  if (i > 60) throw new Error('preview did not start');
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const cold = [];
const warm = [];
let loaded = [];
for (let i = 0; i < runs; i++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const reqs = [];
  page.on('requestfinished', (r) => reqs.push(r));
  const t0 = Date.now();
  await page.goto(base);
  const info = await page.evaluate(() => window.__qv.ready);
  cold.push({ bootMs: Math.round(info.bootMs), pageToReadyMs: Date.now() - t0 });
  loaded = await Promise.all(reqs.map(async (r) => ({ url: r.url().replace(base, ''), bytes: (await r.sizes()).responseBodySize })));
  await page.reload();
  const t1 = Date.now();
  const w = await page.evaluate(() => window.__qv.ready);
  warm.push({ bootMs: Math.round(w.bootMs), pageToReadyMs: Date.now() - t1 });
  await ctx.close();
}
await browser.close();
server.kill();

const files = [];
const walk = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); });
walk(join(ROOT, 'dist'));
const sizes = files.filter((f) => /\.(wasm|js|css|html)$/.test(f)).map((f) => {
  const buf = readFileSync(f);
  return {
    file: f.replace(join(ROOT, 'dist') + '/', ''),
    bytes: buf.length,
    gzip9Estimate: gzipSync(buf, { level: 9 }).length,
    brotli11Estimate: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
});
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(JSON.stringify({
  browser: browser.version?.() ?? 'chrome',
  runs,
  cold: { medianBootMs: med(cold.map((c) => c.bootMs)), medianPageToReadyMs: med(cold.map((c) => c.pageToReadyMs)), all: cold },
  warm: { medianBootMs: med(warm.map((c) => c.bootMs)), medianPageToReadyMs: med(warm.map((c) => c.pageToReadyMs)), all: warm },
  requestsOnFirstLoad: loaded,
  assetSizes: sizes,
  note: 'Local preview serves uncompressed. gzip/brotli columns are local compression estimates, not measured transfers; GitHub Pages compression of .wasm is unverified.',
}, null, 1));
