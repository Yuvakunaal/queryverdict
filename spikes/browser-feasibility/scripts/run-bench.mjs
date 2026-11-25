#!/usr/bin/env node
// Automated benchmark run in the locally installed Google Chrome (Playwright, no browser download).
//
//   node scripts/run-bench.mjs --size 50MB --format csv [--mode view|table] [--reps 3] [--cancel-reps 20]
//                              [--memory-limit 2GB] [--timeout-ms 300000] [--headed] [--confirm-large]
//
// Requires a production build (npm run build). Serves dist/ from the /queryverdict/ subpath with
// `vite preview` (no COOP/COEP/CSP headers, like GitHub Pages).
//
// Safety: refuses to start when the macOS memory-free level is below 25 % or free disk is below
// 2 GB; aborts the run if the level drops below 10 % while running; one renderer crash ends the run.
// Input guards use the RESOLVED files and their ACTUAL sizes (not the size label): combined input
// above 50 MB needs --confirm-large; above 250 MB it also needs --maintainer-approval "<who/when>".
// Inputs are SHA-256-checked against the manifest. One benchmark at a time (results/.bench.lock).
// Exit code 0 only when the run is ACCEPTED (scripts/lib/acceptance.mjs), not merely completed.
// Memory numbers are labelled: OS-reported RSS of the Chrome process tree (actual), engine-reported
// DuckDB buffer memory, and Chromium performance.memory (main-thread JS heap only).
import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { evaluateRun } from './lib/acceptance.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = join(import.meta.dirname, '..');
const { values: a } = parseArgs({
  options: {
    size: { type: 'string', default: '50MB' },
    format: { type: 'string', default: 'csv' },
    mode: { type: 'string', default: 'view' },
    reps: { type: 'string', default: '3' },
    'cancel-reps': { type: 'string', default: '5' },
    'memory-limit': { type: 'string', default: '2GB' },
    'timeout-ms': { type: 'string', default: '300000' },
    'cancel-after-ms': { type: 'string', default: '1000' },
    only: { type: 'string' },
    headed: { type: 'boolean', default: false },
    stress: { type: 'boolean', default: false },
    'confirm-large': { type: 'boolean', default: false },
    'maintainer-approval': { type: 'string' },
    'expect-boundary-errors': { type: 'boolean', default: false },
  },
});
const UNCONFIRMED_LIMIT = 50_000_000;
const APPROVAL_LIMIT = 250_000_000;
const EXT = { csv: 'csv', parquet: 'parquet', json: 'ndjson' }[a.format];
if (!EXT) throw new Error(`--format must be csv, parquet or json`);
const dataDir = join(ROOT, 'data', a.size);
const manifestPath = join(dataDir, 'manifest.json');
if (!existsSync(manifestPath)) throw new Error(`No dataset at ${dataDir}. Run: python3 scripts/generate_datasets.py --size ${a.size}`);
const ordersPath = join(dataDir, `orders.${EXT}`);
// customers is always joined from the same format when available, else CSV
const customersPath = [join(dataDir, `customers.${EXT}`), join(dataDir, 'customers.csv')].find(existsSync);
if (!existsSync(ordersPath)) throw new Error(`Missing ${ordersPath} (generate with --formats including ${a.format})`);
if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Error('No build. Run: npm run build');

// ---- input guards on the resolved files
const dataRoot = realpathSync(join(ROOT, 'data'));
const inputs = [ordersPath, customersPath].map((p) => {
  const real = realpathSync(p);
  if (!real.startsWith(dataRoot + '/')) throw new Error(`Refusing input outside ${dataRoot}: ${real}`);
  const st = statSync(real);
  if (!st.isFile()) throw new Error(`Not a regular file: ${real}`);
  return { path: real, name: real.split('/').pop(), bytes: st.size };
});
const combinedBytes = inputs.reduce((s, f) => s + f.bytes, 0);
if (combinedBytes > UNCONFIRMED_LIMIT && !a['confirm-large']) throw new Error(`Combined input is ${combinedBytes} bytes (> ${UNCONFIRMED_LIMIT}); pass --confirm-large`);
if (combinedBytes > APPROVAL_LIMIT && !a['maintainer-approval']) throw new Error(`Combined input is ${combinedBytes} bytes (> ${APPROVAL_LIMIT}); requires --maintainer-approval "<who, when>"`);

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const memLevel = () => Number(sh('sysctl', ['-n', 'kern.memorystatus_level']));
const swap = () => sh('sysctl', ['-n', 'vm.swapusage']);
const diskFreeGB = () => {
  const s = statfsSync(ROOT);
  return (s.bavail * s.bsize) / 1e9;
};

function systemInfo() {
  const hw = sh('system_profiler', ['SPHardwareDataType']);
  const pick = (k) => hw.match(new RegExp(`${k}: (.+)`))?.[1]?.trim() ?? null;
  return {
    model: pick('Model Name'), modelId: pick('Model Identifier'), chip: pick('Chip'), memory: pick('Memory'),
    macos: `${sh('sw_vers', ['-productVersion'])} (${sh('sw_vers', ['-buildVersion'])})`,
    node: process.version,
  };
}

function preflight() {
  const state = { memoryFreeLevelPct: memLevel(), swap: swap(), diskFreeGB: Number(diskFreeGB().toFixed(1)) };
  if (state.memoryFreeLevelPct < 25) throw new Error(`Refusing to run: memory free level ${state.memoryFreeLevelPct}% < 25%. Close apps and retry.`);
  if (state.diskFreeGB < 2) throw new Error(`Refusing to run: ${state.diskFreeGB} GB disk free < 2 GB.`);
  return state;
}

/** RSS (KB) of every process descending from the Chrome instance using `profileDir`. */
function sampleRss(profileDir) {
  const out = sh('ps', ['-axo', 'pid=,ppid=,rss=,command=']);
  const procs = out.split('\n').map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] } : null;
  }).filter(Boolean);
  const root = procs.find((p) => p.cmd.includes(`--user-data-dir=${profileDir}`) && !p.cmd.includes('--type='));
  if (!root) return null;
  const tree = new Set([root.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of procs) if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); changed = true; }
  }
  const members = procs.filter((p) => tree.has(p.pid));
  const renderers = members.filter((p) => p.cmd.includes('--type=renderer'));
  return {
    totalKB: members.reduce((s, p) => s + p.rss, 0),
    maxRendererKB: Math.max(0, ...renderers.map((p) => p.rss)),
    processes: members.length,
  };
}

const sha256File = (p) => new Promise((res, rej) => {
  const h = createHash('sha256');
  createReadStream(p).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
});
const sha256Text = (t) => createHash('sha256').update(t).digest('hex');
const git = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } };

function provenance() {
  const porcelain = git(['status', '--porcelain', '--', '.']);
  const distFiles = [];
  const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : distFiles.push(join(d, e.name))));
  walk(join(ROOT, 'dist'));
  const dist = Object.fromEntries(distFiles.sort().map((f) => [f.replace(join(ROOT, 'dist') + '/', ''), sha256Text(readFileSync(f))]));
  return {
    gitHead: git(['rev-parse', 'HEAD']),
    gitBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    workingTreeDirty: porcelain === null ? null : porcelain.length > 0,
    dirtyPaths: porcelain === null ? null : porcelain.split('\n').filter(Boolean).length,
    packageLockSha256: sha256Text(readFileSync(join(ROOT, 'package-lock.json'))),
    extensionsLockSha256: sha256Text(readFileSync(join(ROOT, 'extensions.lock.json'))),
    runnerSha256: sha256Text(readFileSync(new URL(import.meta.url))),
    generatorSha256: sha256Text(readFileSync(join(ROOT, 'scripts', 'generate_datasets.py'))),
    distSha256: sha256Text(JSON.stringify(dist)),
    distFiles: dist,
  };
}

// ---- one benchmark at a time
const lockPath = join(ROOT, 'results', '.bench.lock');
mkdirSync(join(ROOT, 'results'), { recursive: true });
if (existsSync(lockPath)) {
  const pid = Number(readFileSync(lockPath, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
  if (alive) throw new Error(`Another benchmark is running (pid ${pid}); refusing to start`);
}
writeFileSync(lockPath, String(process.pid));
const releaseLock = () => { try { if (readFileSync(lockPath, 'utf8') === String(process.pid)) rmSync(lockPath); } catch { /* gone */ } };
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });

const startedAt = new Date();
const pre = preflight();
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
console.log(`preflight ok: ${JSON.stringify(pre)}`);

// ---- validate the selected inputs against the manifest (size and SHA-256)
const inputValidation = { ok: true, combinedBytes, files: [] };
for (const f of inputs) {
  const entry = manifest.files?.[f.name];
  const sha256 = await sha256File(f.path);
  const ok = !!entry && entry.bytes === f.bytes && entry.sha256 === sha256;
  inputValidation.files.push({ name: f.name, path: f.path.replace(ROOT + '/', ''), bytes: f.bytes, sha256, manifestBytes: entry?.bytes ?? null, manifestSha256: entry?.sha256 ?? null, ok });
  if (!ok) inputValidation.ok = false;
}
if (!inputValidation.ok) {
  console.error(`Input validation failed: ${JSON.stringify(inputValidation.files.filter((f) => !f.ok))}`);
  process.exit(2);
}
const prov = provenance();
console.log(`inputs ok (${combinedBytes} bytes); git ${prov.gitHead?.slice(0, 12) ?? 'n/a'}${prov.workingTreeDirty ? ' (dirty)' : ''}`);

const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
const base = 'http://127.0.0.1:4173/queryverdict/';
for (let i = 0; ; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
  if (i > 60) throw new Error('preview server did not start');
  await new Promise((r) => setTimeout(r, 250));
}

const profileDir = mkdtempSync(join(tmpdir(), 'qv-bench-profile-'));
const context = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: !a.headed, viewport: { width: 1200, height: 900 } });
const browserVersion = context.browser()?.version() ?? null;
const page = context.pages()[0] ?? (await context.newPage());
const outcome = { status: 'running', reason: null };
page.on('crash', () => { outcome.status = 'renderer-crash'; outcome.reason = 'page crashed (renderer process died)'; });

const samples = [];
let phase = 'boot';
let peak = { totalKB: 0, maxRendererKB: 0 };
const phasePeaks = {};
const sampler = setInterval(() => {
  const s = sampleRss(profileDir);
  if (!s) return;
  samples.push({ t: Date.now() - startedAt.getTime(), phase, ...s });
  peak = { totalKB: Math.max(peak.totalKB, s.totalKB), maxRendererKB: Math.max(peak.maxRendererKB, s.maxRendererKB) };
  const p = (phasePeaks[phase] ??= { totalKB: 0, maxRendererKB: 0 });
  p.totalKB = Math.max(p.totalKB, s.totalKB);
  p.maxRendererKB = Math.max(p.maxRendererKB, s.maxRendererKB);
}, 250);
const guard = setInterval(() => {
  const lvl = memLevel();
  if (lvl < 10 && outcome.status === 'running') {
    outcome.status = 'aborted-memory-guard';
    outcome.reason = `macOS memory free level fell to ${lvl}% during ${phase}`;
    void context.close();
  }
}, 2000);

let result = null;
let progress = null;
try {
  await page.goto(base);
  await page.evaluate(() => window.__qv.ready);
  await page.locator('#bench-orders').setInputFiles(ordersPath);
  await page.locator('#bench-customers').setInputFiles(customersPath);
  await page.evaluate((o) => window.__qvBench.start(o), {
    manifest, mode: a.mode, reps: Number(a.reps), cancelReps: Number(a['cancel-reps']),
    workloadTimeoutMs: Number(a['timeout-ms']), cancelAfterMs: Number(a['cancel-after-ms']),
    memoryLimit: a['memory-limit'] === 'none' ? null : a['memory-limit'],
    ...(a.only ? { only: a.only.split(',') } : {}),
    stress: a.stress,
    expectBoundaryErrors: a['expect-boundary-errors'],
    confirmedLarge: a['confirm-large'],
    inputsHashedByCaller: true,
  });
  const hardDeadline = Date.now() + 45 * 60_000;
  while (outcome.status === 'running') {
    await new Promise((r) => setTimeout(r, 500));
    progress = await page.evaluate(() => JSON.parse(JSON.stringify(window.__qvBench.progress)));
    phase = progress?.phase ?? phase;
    if (progress?.done) { outcome.status = progress.error ? 'error' : 'completed'; outcome.reason = progress.error ?? null; break; }
    if (Date.now() > hardDeadline) { outcome.status = 'aborted-deadline'; outcome.reason = '45 minute run limit'; }
  }
  if (outcome.status === 'completed') result = await page.evaluate(() => window.__qvBench.result);
  if (progress?.phase === 'refused') { outcome.status = 'refused'; outcome.reason = progress.error ?? 'refused by page guard'; }
} catch (e) {
  if (outcome.status === 'running') { outcome.status = 'error'; outcome.reason = String(e).split('\n')[0]; }
} finally {
  clearInterval(sampler);
  clearInterval(guard);
  await context.close().catch(() => {});
  server.kill();
  rmSync(profileDir, { recursive: true, force: true });
}

const record = {
  kind: 'queryverdict-browser-bench',
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  outcome,
  args: a,
  system: systemInfo(),
  browser: { name: 'Google Chrome (Playwright channel "chrome")', version: browserVersion, headless: !a.headed },
  preflight: pre,
  postflight: { memoryFreeLevelPct: memLevel(), swap: swap() },
  dataset: { size: a.size, format: a.format, orders: ordersPath.replace(ROOT + '/', ''), customers: customersPath.replace(ROOT + '/', ''), physicalInputBytes: combinedBytes, manifest },
  inputValidation,
  provenance: prov,
  maintainerApproval: a['maintainer-approval'] ?? null,
  osMemory: {
    source: 'ps RSS of the Chrome process tree, sampled every 250 ms (actual OS measurement; RSS counts shared pages in each process, so the total over-counts; compressed/swapped pages are excluded)',
    peakTotalMB: Math.round(peak.totalKB / 1024),
    peakRendererMB: Math.round(peak.maxRendererKB / 1024),
    phasePeaksMB: Object.fromEntries(Object.entries(phasePeaks).map(([k, v]) => [k, { totalMB: Math.round(v.totalKB / 1024), rendererMB: Math.round(v.maxRendererKB / 1024) }])),
    samples: samples.length,
  },
  page: result ?? { partialProgress: progress },
};
mkdirSync(join(ROOT, 'results', 'raw'), { recursive: true });
const file = join(ROOT, 'results', 'raw', `${startedAt.toISOString().replace(/[:.]/g, '-')}_${a.size}_${a.format}_${a.mode}_chrome.json`);
record.evaluation = evaluateRun(record);
writeFileSync(file, JSON.stringify(record, null, 1));
console.log(`harness ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''} -> ${file.replace(ROOT + '/', '')}`);
const ev = record.evaluation;
console.log(`acceptance: ${ev.acceptance.toUpperCase()}${ev.reasons.length ? ` — ${ev.reasons.join('; ')}` : ''}`);
console.log(`records ${ev.counts.records}: assertions ${ev.counts.passed}/${ev.counts.assertions} passed, ${ev.counts.failed} failed; cancel ${ev.counts.cancelExercised} exercised / ${ev.counts.cancelNotExercised} not exercised / ${ev.counts.cancelRecoveryFailed} recovery failed; stress ${ev.counts.stressCompleted}; expected boundary ${ev.counts.expectedBoundaryFailures}; unexpected errors ${ev.counts.unexpectedErrors}; timeouts ${ev.counts.timeouts}; frame-gap missing ${ev.counts.frameGapMissing}`);
console.log(`peak RSS: total ${record.osMemory.peakTotalMB} MB, renderer ${record.osMemory.peakRendererMB} MB`);
const recs = (result?.progress ?? progress)?.records ?? [];
const reg = (result?.progress ?? progress)?.registration ?? [];
for (const r of reg) console.log(`register ${r.file}: ${Math.round(r.ms)} ms (${r.mode})`);
const by = {};
for (const r of recs) (by[r.workload] ??= []).push(r);
for (const [w, rs] of Object.entries(by)) {
  const ms = rs.map((r) => Math.round(r.ms)).join('/');
  const checks = rs.map((r) => r.verdict ?? r.status).join('/');
  const extra = rs[0]?.cancel ? ` cancel=${rs.map((r) => r.cancel?.report?.method + ':' + Math.round(r.cancel?.report?.stopMs ?? -1)).join(',')}` : '';
  const gaps = rs.map((r) => r.responsiveness.maxFrameGapMs).filter((g) => g !== null && g !== undefined);
  console.log(`${w.padEnd(26)} ${ms.padEnd(24)} ${checks}  maxFrameGap=${gaps.length ? `${Math.max(...gaps).toFixed(0)}ms` : 'not measured'} (${gaps.length}/${rs.length} measured)${extra}`);
}
if (ev.acceptance !== 'accepted') process.exitCode = 1;
