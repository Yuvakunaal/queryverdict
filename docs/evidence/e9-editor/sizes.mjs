import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const res = {};
for (const n of ['baseline', 'cm', 'monaco', 'monaco-full']) {
  const t = {};
  for (const f of walk(`dist-${n}`)) {
    const b = readFileSync(f); const k = extname(f).slice(1) + (/worker/i.test(f) ? '-worker' : '');
    const g = gzipSync(b, { level: 9 }).length, br = brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
    t[k] ??= { files: 0, raw: 0, gzip: 0, brotli: 0 }; t[k].files++; t[k].raw += b.length; t[k].gzip += g; t[k].brotli += br;
    t.total ??= { files: 0, raw: 0, gzip: 0, brotli: 0 }; t.total.files++; t.total.raw += b.length; t.total.gzip += g; t.total.brotli += br;
  }
  res[n] = t;
}
for (const [n, t] of Object.entries(res)) { console.log(n); for (const [k, v] of Object.entries(t)) console.log(`  ${k.padEnd(12)} files=${v.files} raw=${v.raw} gzip=${v.gzip} brotli=${v.brotli}`); }
for (const n of ['cm', 'monaco', 'monaco-full']) console.log(`incremental ${n}: raw=${res[n].total.raw - res.baseline.total.raw} gzip=${res[n].total.gzip - res.baseline.total.gzip} brotli=${res[n].total.brotli - res.baseline.total.brotli}`);
