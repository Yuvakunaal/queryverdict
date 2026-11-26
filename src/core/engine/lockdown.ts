// Mandatory engine lockdown (P-013, P-017; docs/ARCHITECTURE.md §7, §19).
//
// Order matters: the required extensions are installed and loaded from the app's own origin
// first, then external access and extension acquisition are switched off, then the configuration
// is locked so SQL cannot switch them back on. Verification then reads the EFFECTIVE state, so a
// skipped, failed or ineffective statement can never yield a session that reports lockdown.
// A page <meta> CSP does not govern the DuckDB worker (§24 V3): this lockdown is the primary
// network control for the engine.
import type { Rows } from './types';

/** Virtual directory for user files registered with the engine (M03). */
export const LOCAL_FILE_DIR = '/qv-local/';

/** Extensions that must be loaded after lockdown, and no others. `json` is required by Verdict. */
export const REQUIRED_LOADED_EXTENSIONS = ['core_functions', 'json', 'parquet'] as const;

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function lockdownStatements(extensionRepository: string): string[] {
  const repo = sqlString(extensionRepository);
  return [
    `SET custom_extension_repository = ${repo}`,
    `SET autoinstall_extension_repository = ${repo}`,
    'SET autoinstall_known_extensions = false',
    'SET autoload_known_extensions = false',
    'SET allow_community_extensions = false',
    'INSTALL parquet',
    'LOAD parquet',
    'INSTALL json',
    'LOAD json',
    `SET allowed_directories = [${sqlString(LOCAL_FILE_DIR)}]`,
    'SET enable_external_access = false',
    'SET lock_configuration = true',
  ];
}

/** Effective settings required before the session accepts any work. */
export function requiredSettings(extensionRepository: string): Record<string, string> {
  return {
    enable_external_access: 'false',
    autoload_known_extensions: 'false',
    autoinstall_known_extensions: 'false',
    allow_community_extensions: 'false',
    allow_unsigned_extensions: 'false',
    allowed_directories: `[${LOCAL_FILE_DIR}]`,
    allowed_paths: '[]',
    custom_extension_repository: extensionRepository,
    autoinstall_extension_repository: extensionRepository,
    lock_configuration: 'true',
  };
}

/** Runs one statement and returns text rows; rejects on engine error. */
export type RunText = (sql: string) => Promise<Rows>;

export interface LockdownVerification {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly observed: Readonly<Record<string, string | null>>;
  readonly loadedExtensions: readonly string[];
}

/** Reads the effective engine state and checks every mandatory control. Never throws on mismatch. */
export async function verifyLockdown(run: RunText, extensionRepository: string): Promise<LockdownVerification> {
  const required = requiredSettings(extensionRepository);
  const failures: string[] = [];
  const observed: Record<string, string | null> = {};
  const names = Object.keys(required).map(sqlString).join(', ');
  const rows = await run(`SELECT name::VARCHAR, value::VARCHAR FROM duckdb_settings() WHERE name IN (${names})`);
  for (const [name, want] of Object.entries(required)) {
    const got = rows.find((r) => r[0] === name)?.[1] ?? null;
    observed[name] = got;
    if (got !== want) failures.push(`${name}: expected ${JSON.stringify(want)}, observed ${JSON.stringify(got)}`);
  }
  const loadedExtensions = (await run('SELECT extension_name::VARCHAR FROM duckdb_extensions() WHERE loaded ORDER BY 1')).map((r) => r[0] ?? '');
  if (JSON.stringify(loadedExtensions) !== JSON.stringify(REQUIRED_LOADED_EXTENSIONS)) {
    failures.push(`loaded extensions: expected ${REQUIRED_LOADED_EXTENSIONS.join(',')}, observed ${loadedExtensions.join(',')}`);
  }
  // Active check: the lock must reject a configuration change.
  let lockRejected = false;
  try {
    await run('SET autoload_known_extensions = true');
  } catch {
    lockRejected = true;
  }
  if (!lockRejected) failures.push('lock_configuration did not reject a configuration change');
  return { ok: failures.length === 0, failures, observed, loadedExtensions };
}

/**
 * Statements that must FAIL (or have no effect) after lockdown. `target` is an http(s) URL;
 * tests point it at a local listener so any leak is observable without a real third party.
 */
export interface EscalationProbe {
  readonly name: string;
  readonly sql: string;
  /** INSTALL may return without error under lockdown (v1.5.4) while fetching nothing; tests check no request and no load. */
  readonly mayReturnWithoutEffect?: true;
}

export function escalationProbes(target: string): EscalationProbe[] {
  const t = (p: string) => sqlString(`${target}${p}`);
  return [
    { name: 'remote read_csv', sql: `SELECT * FROM read_csv(${t('/probe.csv')})` },
    { name: 'remote read_parquet', sql: `SELECT * FROM read_parquet(${t('/probe.parquet')})` },
    { name: 'remote read_json', sql: `SELECT * FROM read_json(${t('/probe.json')})` },
    { name: 'remote read_text', sql: `SELECT * FROM read_text(${t('/probe.txt')})` },
    { name: 'remote read_blob', sql: `SELECT * FROM read_blob(${t('/probe.bin')})` },
    { name: 'remote glob', sql: `SELECT * FROM glob(${t('/*')})` },
    { name: 'remote replacement scan', sql: `SELECT * FROM ${t('/probe2.csv')}` },
    { name: 'remote ATTACH', sql: `ATTACH ${t('/probe.duckdb')} AS remote_db` },
    { name: 'EXPORT DATABASE remote', sql: `EXPORT DATABASE ${t('/export')}` },
    { name: 'COPY TO remote', sql: `COPY (SELECT 42 AS x) TO ${t('/probe-out.csv')}` },
    { name: 'INSTALL httpfs', sql: 'INSTALL httpfs', mayReturnWithoutEffect: true },
    { name: 'LOAD httpfs', sql: 'LOAD httpfs' },
    { name: 'INSTALL from URL', sql: `INSTALL ${t('/evil.duckdb_extension.wasm')}`, mayReturnWithoutEffect: true },
    { name: 'LOAD from URL', sql: `LOAD ${t('/evil.duckdb_extension.wasm')}` },
    { name: 're-enable external access', sql: 'SET enable_external_access = true' },
    { name: 're-enable autoload', sql: 'SET autoload_known_extensions = true' },
    { name: 'change extension repository', sql: `SET custom_extension_repository = ${t('')}` },
    { name: 'widen allowed_directories', sql: "SET allowed_directories = ['/']" },
    { name: 'unlock configuration', sql: 'SET lock_configuration = false' },
    { name: 'RESET lock', sql: 'RESET lock_configuration' },
    { name: 'read outside allowed dir', sql: "SELECT * FROM read_csv('/etc/passwd')" },
  ];
}
