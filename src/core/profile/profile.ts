// Release profile: every finite limit, deadline and engine setting in one immutable object
// (docs/ARCHITECTURE.md §4, §12.1; docs/IMPLEMENTATION_PLAN.md §3). Values are provisional
// defaults pending P-020/P-036 approval and M15 qualification; they are not capacity claims.

export interface ReleaseProfile {
  readonly results: { maxRows: number; maxColumns: number; maxCellChars: number; maxDisplayChars: number; maxArrowBytes: number };
  readonly bounds: {
    queueWaitMs: number;
    verdictMs: number;
    importMs: number;
    cancelRequestMs: number;
    cancelSettleMs: number;
    cleanupMs: number;
    bootMs: number;
    recoveryMs: number;
  };
  readonly verdict: { executionPairRows: bigint; maxInputRows: bigint; groupingBytes: bigint; maxKeyColumns: number };
  readonly imports: { maxFileBytes: number; maxCombinedBytes: number; formats: readonly ('csv' | 'parquet')[] };
  readonly engine: { memoryLimit: string; threads: 1 };
}

const MIB = 1024 * 1024;

export const DEFAULT_PROFILE: ReleaseProfile = Object.freeze({
  results: Object.freeze({ maxRows: 1_000, maxColumns: 200, maxCellChars: 500, maxDisplayChars: 2_000_000, maxArrowBytes: 16 * MIB }),
  bounds: Object.freeze({
    queueWaitMs: 30_000,
    verdictMs: 30_000,
    importMs: 120_000,
    cancelRequestMs: 2_000,
    cancelSettleMs: 2_000,
    cleanupMs: 5_000,
    bootMs: 30_000,
    recoveryMs: 45_000,
  }),
  verdict: Object.freeze({ executionPairRows: 50_000_000n, maxInputRows: 50_000_000n, groupingBytes: 512n * BigInt(MIB), maxKeyColumns: 8 }),
  // Initial development cap (P-041 candidate ceiling); not a published support limit.
  imports: Object.freeze({ maxFileBytes: 50 * MIB, maxCombinedBytes: 50 * MIB, formats: Object.freeze(['csv', 'parquet'] as const) }),
  // Initial development value on the reference machine; set per browser after measurement (M15).
  engine: Object.freeze({ memoryLimit: '2GB', threads: 1 as const }),
});

/** Largest delay setTimeout honours (signed 32-bit milliseconds); longer delays fire immediately. */
export const MAX_TIMER_MS = 2_147_483_647;
/** 32-bit WebAssembly memory ceiling (docs/ARCHITECTURE.md §24 V16); the engine limit must be below it. */
export const MAX_MEMORY_LIMIT_BYTES = 4 * 1024 ** 3;

const REQUIRED = {
  results: ['maxRows', 'maxColumns', 'maxCellChars', 'maxDisplayChars', 'maxArrowBytes'],
  bounds: ['queueWaitMs', 'verdictMs', 'importMs', 'cancelRequestMs', 'cancelSettleMs', 'cleanupMs', 'bootMs', 'recoveryMs'],
  verdict: ['executionPairRows', 'maxInputRows', 'groupingBytes', 'maxKeyColumns'],
  imports: ['maxFileBytes', 'maxCombinedBytes', 'formats'],
  engine: ['memoryLimit', 'threads'],
} as const;

const UNITS: Record<string, number> = { KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3 };

/** Parses a DuckDB memory quantity such as "2GB" or "512 MiB" into bytes; null if malformed. */
export function parseMemoryLimit(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s?(KB|MB|GB|KiB|MiB|GiB)$/.exec(text);
  if (!m) return null;
  const bytes = Number(m[1]) * (UNITS[(m[2] ?? '').toUpperCase()] ?? Number.NaN);
  return Number.isFinite(bytes) ? bytes : null;
}

function positiveInteger(path: string, v: unknown, out: string[], max = Number.MAX_SAFE_INTEGER) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) out.push(`${path} must be a positive safe integer (got ${String(v)})`);
  else if (v > max) out.push(`${path} must not exceed ${max} (got ${v})`);
}

function positiveBigint(path: string, v: unknown, out: string[]) {
  if (typeof v !== 'bigint' || v <= 0n) out.push(`${path} must be a positive bigint (got ${String(v)})`);
}

/** Returns every problem with a profile; an empty array means it is valid. */
export function validateProfile(p: ReleaseProfile): string[] {
  const out: string[] = [];
  const sections = p as unknown as Record<string, Record<string, unknown> | undefined>;
  for (const [section, keys] of Object.entries(REQUIRED)) {
    const value = sections[section];
    if (!value || typeof value !== 'object') {
      out.push(`${section} is missing`);
      continue;
    }
    for (const k of keys) if (!(k in value) || value[k] === undefined) out.push(`${section}.${k} is missing`);
  }
  if (out.length) return out;
  for (const k of REQUIRED.results) positiveInteger(`results.${k}`, p.results[k], out);
  for (const k of REQUIRED.bounds) positiveInteger(`bounds.${k}`, p.bounds[k], out, MAX_TIMER_MS);
  positiveBigint('verdict.executionPairRows', p.verdict.executionPairRows, out);
  positiveBigint('verdict.maxInputRows', p.verdict.maxInputRows, out);
  positiveBigint('verdict.groupingBytes', p.verdict.groupingBytes, out);
  positiveInteger('verdict.maxKeyColumns', p.verdict.maxKeyColumns, out);
  positiveInteger('imports.maxFileBytes', p.imports.maxFileBytes, out);
  positiveInteger('imports.maxCombinedBytes', p.imports.maxCombinedBytes, out);
  if (p.imports.maxFileBytes > p.imports.maxCombinedBytes) out.push('imports.maxFileBytes must not exceed imports.maxCombinedBytes');
  if (!Array.isArray(p.imports.formats) || p.imports.formats.length === 0 || p.imports.formats.some((f) => f !== 'csv' && f !== 'parquet')) out.push('imports.formats must be a non-empty subset of csv, parquet');
  const memory = typeof p.engine.memoryLimit === 'string' ? parseMemoryLimit(p.engine.memoryLimit) : null;
  if (memory === null) out.push(`engine.memoryLimit must look like "2GB" (got ${JSON.stringify(p.engine.memoryLimit)})`);
  else if (memory <= 0) out.push(`engine.memoryLimit must be greater than zero (got ${p.engine.memoryLimit})`);
  else if (memory >= MAX_MEMORY_LIMIT_BYTES) out.push(`engine.memoryLimit must be below the 4 GiB WebAssembly ceiling (got ${p.engine.memoryLimit})`);
  if (p.engine.threads !== 1) out.push('engine.threads must be 1 (no cross-origin isolation on GitHub Pages)');
  return out;
}
