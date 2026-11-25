// Engine configuration lockdown (feasibility E2).
//
// Order matters: extensions needed for CSV/JSON/Parquet are loaded from the app's own origin
// first, then external access and extension loading are switched off, then the configuration
// is locked so SQL cannot switch them back on.

/** Virtual directory for user files registered with the engine. */
export const LOCAL_FILE_DIR = '/qv-local/';

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

/** Extensions that must be loaded after lockdown, and no others. */
export const REQUIRED_LOADED_EXTENSIONS = ['core_functions', 'json', 'parquet'];

/**
 * Effective settings that must hold before the session accepts SQL or files. Verified from
 * duckdb_settings() after the statements run, independently of which statements were used, so a
 * failed, skipped or altered statement cannot result in a session that reports lockdown.
 */
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

/** Minimal query interface so verification can be unit-tested without an engine. */
export interface QueryFn {
  (sql: string): Promise<{ toArray(): { toJSON(): Record<string, unknown> }[] }>;
}

export interface LockdownVerification {
  ok: boolean;
  failures: string[];
  observed: Record<string, string | null>;
  loadedExtensions: string[];
}

/** Reads the effective engine state and checks every mandatory control. Never throws on mismatch. */
export async function verifyLockdown(query: QueryFn, extensionRepository: string): Promise<LockdownVerification> {
  const required = requiredSettings(extensionRepository);
  const failures: string[] = [];
  const observed: Record<string, string | null> = {};
  const names = Object.keys(required).map(sqlString).join(', ');
  const rows = (await query(`SELECT name, value::VARCHAR AS value FROM duckdb_settings() WHERE name IN (${names})`)).toArray().map((r) => r.toJSON());
  for (const [name, want] of Object.entries(required)) {
    const got = rows.find((r) => r.name === name)?.value;
    observed[name] = got === undefined || got === null ? null : String(got);
    if (observed[name] !== want) failures.push(`${name}: expected ${JSON.stringify(want)}, observed ${JSON.stringify(observed[name])}`);
  }
  const loadedExtensions = (await query('SELECT extension_name FROM duckdb_extensions() WHERE loaded ORDER BY 1')).toArray().map((r) => String(r.toJSON().extension_name));
  if (JSON.stringify(loadedExtensions) !== JSON.stringify(REQUIRED_LOADED_EXTENSIONS)) {
    failures.push(`loaded extensions: expected ${REQUIRED_LOADED_EXTENSIONS.join(',')}, observed ${loadedExtensions.join(',')}`);
  }
  // Active check: the lock must reject a configuration change. If it does not, this statement
  // succeeds and the session is rejected (the candidate engine is then terminated by the caller).
  let lockRejected = false;
  try {
    await query('SET autoload_known_extensions = true');
  } catch {
    lockRejected = true;
  }
  if (!lockRejected) failures.push('lock_configuration did not reject a configuration change');
  return { ok: failures.length === 0, failures, observed, loadedExtensions };
}

/**
 * Statements that must FAIL after lockdown. `target` is an http(s) URL; tests point it at a
 * local-only listener so a leak would be observable without contacting a real third party.
 */
export interface EscalationProbe {
  name: string;
  sql: string;
  /**
   * Observed in DuckDB-WASM v1.5.4: INSTALL returns without error under lockdown but fetches
   * nothing (the download would happen at LOAD, which is blocked). These probes may succeed
   * only if they cause no network request and the extension never becomes loaded; the tests
   * check both.
   */
  mayReturnWithoutEffect?: true;
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

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqlIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
