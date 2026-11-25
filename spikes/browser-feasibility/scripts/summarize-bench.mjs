#!/usr/bin/env node
// Summarises results/raw/*_chrome.json into Markdown (stdout) and results/summary.json.
// Every run is classified by scripts/lib/acceptance.mjs. Historical (v1) runs are reported as
// `historical-unvalidated`: their measurements are preserved as recorded, their verdicts are
// derived, and they are never shown as accepted experiments.
//   node scripts/summarize-bench.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateRun, verdictOf } from './lib/acceptance.mjs';

const ROOT = join(import.meta.dirname, '..');
const RAW = join(ROOT, 'results', 'raw');
const runs = readdirSync(RAW).filter((f) => f.endsWith('_chrome.json')).sort().map((f) => ({ f, ...JSON.parse(readFileSync(join(RAW, f), 'utf8')) }));
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const fmt = (ms) => (ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const base = (p) => p.split('/').pop();

const summary = [];
for (const r of runs) {
  const ev = evaluateRun(r);
  const prog = r.page?.progress ?? r.page?.partialProgress ?? { records: [], registration: [] };
  const manifestFiles = r.dataset.manifest.files;
  const inputFiles = [base(r.dataset.orders), base(r.dataset.customers)];
  const physical = Object.fromEntries(inputFiles.map((n) => [n, manifestFiles[n]?.bytes ?? null]));
  const byW = {};
  for (const rec of prog.records ?? []) (byW[rec.workload] ??= []).push(rec);
  const workloads = Object.fromEntries(Object.entries(byW).map(([w, rs]) => {
    const verdicts = rs.map((x) => verdictOf(x, r).verdict);
    const cancelReports = rs.map((x) => x.cancel?.report).filter(Boolean);
    const gaps = rs.map((x) => x.responsiveness?.maxFrameGapMs).filter((g) => g !== null && g !== undefined);
    return [w, {
      n: rs.length,
      verdicts: Object.fromEntries([...new Set(verdicts)].map((v) => [v, verdicts.filter((x) => x === v).length])),
      medianMs: median(rs.map((x) => x.ms)),
      maxMs: Math.max(...rs.map((x) => x.ms)),
      frameGap: { measured: gaps.length, of: rs.length, maxMs: gaps.length ? Math.max(...gaps) : null },
      ...(cancelReports.length ? { cancel: { methods: [...new Set(cancelReports.map((c) => c.method))], maxStopMs: Math.max(...cancelReports.map((c) => c.stopMs)) } } : {}),
      errors: [...new Set(rs.map((x) => x.error).filter(Boolean))],
    }];
  }));
  summary.push({
    file: r.f,
    schema: ev.schema,
    acceptance: ev.acceptance,
    acceptanceReasons: ev.reasons,
    harness: ev.harness,
    counts: ev.counts,
    missing: ev.missing,
    verdictsDerived: ev.derivedVerdicts,
    size: r.args.size, format: r.args.format, mode: r.args.mode, stress: !!r.args.stress, memoryLimit: r.args['memory-limit'], only: r.args.only ?? null,
    browser: r.browser.version, headless: r.browser.headless,
    system: r.system, preflight: r.preflight,
    rows: r.dataset.manifest.expected.orders_rows,
    physicalInputBytes: physical,
    physicalInputBytesTotal: Object.values(physical).reduce((s, b) => s + (b ?? 0), 0),
    inputValidation: r.inputValidation ?? 'not recorded (historical run)',
    provenance: r.provenance ? { gitHead: r.provenance.gitHead, workingTreeDirty: r.provenance.workingTreeDirty, distSha256: r.provenance.distSha256 } : 'not recorded (historical run)',
    registration: (prog.registration ?? []).map((x) => ({ file: x.file, ms: Math.round(x.ms) })),
    engine: r.page?.environment?.engine ? { bundle: r.page.environment.engine.bundle, duckdbVersion: r.page.environment.engine.duckdbVersion, packageVersion: r.page.environment.engine.packageVersion } : null,
    osPeakMB: { total: r.osMemory.peakTotalMB, renderer: r.osMemory.peakRendererMB },
    workloads,
  });
}
writeFileSync(join(ROOT, 'results', 'summary.json'), JSON.stringify(summary, null, 1) + '\n');

const tot = {};
for (const s of summary) for (const [k, v] of Object.entries(s.counts)) tot[k] = (tot[k] ?? 0) + v;
const acc = {};
for (const s of summary) acc[s.acceptance] = (acc[s.acceptance] ?? 0) + 1;
console.log(`Runs: ${summary.length} (${Object.entries(acc).map(([k, v]) => `${v} ${k}`).join(', ')})\n`);
console.log('| Category | Count |\n|---|---:|');
for (const [k, label] of [
  ['records', 'Workload records'], ['assertions', 'Answer-check assertions'], ['passed', '— passed'], ['failed', '— failed'],
  ['cancelTests', 'Cancellation tests'], ['cancelExercised', '— cancel exercised (stopped, follow-up OK)'], ['cancelNotExercised', '— finished before cancel fired'], ['cancelRecoveryFailed', '— follow-up failed'],
  ['stressCompleted', 'Stress workloads completed (no answer check)'], ['expectedBoundaryFailures', 'Expected boundary failures (OOM)'],
  ['unexpectedErrors', 'Unexpected errors'], ['timeouts', 'Timeouts'], ['frameGapMissing', 'Records without a frame-gap sample'],
]) console.log(`| ${label} | ${tot[k] ?? 0} |`);
console.log('\nPer run:');
for (const s of summary) {
  const c = s.counts;
  console.log(`- ${s.file}: ${s.acceptance}; harness ${s.harness}; ${c.passed}/${c.assertions} checks, cancel ${c.cancelExercised}+${c.cancelNotExercised} not exercised, stress ${c.stressCompleted}, boundary ${c.expectedBoundaryFailures}, unexpected ${c.unexpectedErrors}, frame-gap missing ${c.frameGapMissing}/${c.records}; physical input ${(s.physicalInputBytesTotal / 1e6).toFixed(1)} MB${s.acceptanceReasons.filter((x) => !x.startsWith('historical')).length ? `; REASONS: ${s.acceptanceReasons.filter((x) => !x.startsWith('historical')).join('; ')}` : ''}`);
}
