// Import admission (docs/ARCHITECTURE.md §10.2): extension and actual byte sizes against the
// release profile, before any engine work. Sizes are the File's real byte length.
import type { ReleaseProfile } from '../profile/profile';
import type { DatasetFormat } from './types';

export function detectFormat(fileName: string): DatasetFormat | null {
  const n = fileName.toLowerCase();
  if (n.endsWith('.csv')) return 'csv';
  if (n.endsWith('.parquet')) return 'parquet';
  return null;
}

export type Admission = { readonly ok: true; readonly format: DatasetFormat } | { readonly ok: false; readonly reason: string };

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * Admits files in order. `alreadyImportedBytes` counts datasets already imported in this
 * session, because the combined cap applies to everything held in the engine.
 */
export function admit(files: readonly { name: string; size: number }[], limits: ReleaseProfile['imports'], alreadyImportedBytes: number): Admission[] {
  let combined = alreadyImportedBytes;
  return files.map((f) => {
    const format = detectFormat(f.name);
    if (!format || !limits.formats.includes(format)) return { ok: false, reason: `Unsupported file type. Choose a ${limits.formats.map((x) => `.${x}`).join(' or ')} file.` };
    if (!Number.isSafeInteger(f.size) || f.size <= 0) return { ok: false, reason: 'The file is empty.' };
    if (f.size > limits.maxFileBytes) return { ok: false, reason: `The file is ${mb(f.size)}, above the configured limit of ${mb(limits.maxFileBytes)} per file.` };
    if (combined + f.size > limits.maxCombinedBytes) return { ok: false, reason: `Importing it would hold ${mb(combined + f.size)} in this session, above the configured combined limit of ${mb(limits.maxCombinedBytes)}.` };
    combined += f.size;
    return { ok: true, format };
  });
}

/** False when the browser can no longer read the file (for example its access lapsed). */
export async function isReadable(file: Blob): Promise<boolean> {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}
