// Benchmark input guards shared by the manual panel and the CLI-driven page entry point.
// The browser cannot observe host memory pressure, so these are conservative input limits plus
// explicit confirmation. No host metric is estimated or invented here.
import type { Manifest } from './runner';

/** Combined input size that runs without confirmation (the proposed qualification ceiling). */
export const UNCONFIRMED_LIMIT_BYTES = 50_000_000;
/** Combined input size that is always refused from the browser entry points. */
export const HARD_LIMIT_BYTES = 1_100_000_000;
/** In-browser hashing reads whole files into memory; only done up to this combined size. */
export const HASH_LIMIT_BYTES = 50_000_000;

export interface BenchGuardResult {
  ok: boolean;
  reasons: string[];
  combinedBytes: number;
  files: { name: string; bytes: number; manifestBytes: number | null; sha256: string | null; hashVerified: boolean | 'skipped' }[];
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function checkBenchInputs(
  inputs: File[],
  manifest: Manifest,
  opts: { confirmedLarge: boolean; skipHash: boolean },
): Promise<BenchGuardResult> {
  const reasons: string[] = [];
  const combinedBytes = inputs.reduce((s, f) => s + f.size, 0);
  if (combinedBytes > HARD_LIMIT_BYTES) reasons.push(`combined input ${combinedBytes} bytes exceeds the hard limit of ${HARD_LIMIT_BYTES} bytes`);
  if (combinedBytes > UNCONFIRMED_LIMIT_BYTES && !opts.confirmedLarge) {
    reasons.push(`combined input ${combinedBytes} bytes exceeds ${UNCONFIRMED_LIMIT_BYTES} bytes and was not explicitly confirmed`);
  }
  const hash = !opts.skipHash && combinedBytes <= HASH_LIMIT_BYTES;
  const files: BenchGuardResult['files'] = [];
  for (const f of inputs) {
    const entry = manifest.files?.[f.name];
    const rec: BenchGuardResult['files'][number] = { name: f.name, bytes: f.size, manifestBytes: entry?.bytes ?? null, sha256: null, hashVerified: 'skipped' };
    if (!entry) reasons.push(`${f.name} is not listed in the selected manifest`);
    else if (entry.bytes !== f.size) reasons.push(`${f.name} is ${f.size} bytes but the manifest says ${entry.bytes}`);
    else if (hash) {
      rec.sha256 = await sha256Hex(f);
      rec.hashVerified = rec.sha256 === entry.sha256;
      if (!rec.hashVerified) reasons.push(`${f.name} SHA-256 does not match the manifest`);
    }
    files.push(rec);
  }
  return { ok: reasons.length === 0, reasons, combinedBytes, files };
}
