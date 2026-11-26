// Relation naming (docs/ARCHITECTURE.md §10.2). Names are always quoted when used in SQL; the
// normalisation only makes them convenient to type. Uniqueness is checked against the live
// catalog inside the serialized import operation, so concurrent imports cannot pick one name.

export const MAX_NAME_LENGTH = 63;
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quotes an identifier for SQL. File names never reach SQL any other way. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Deterministic, lower-case, SQL-friendly name derived from a file name. */
export function normaliseName(fileName: string, reserved: ReadonlySet<string> = new Set()): string {
  let base = fileName.replace(/\.[^.]*$/, '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'dataset';
  if (/^[0-9]/.test(base)) base = `t_${base}`;
  base = base.slice(0, MAX_NAME_LENGTH).replace(/_+$/, '') || 'dataset';
  if (reserved.has(base)) base = `${base.slice(0, MAX_NAME_LENGTH - 5)}_data`;
  return base;
}

/** Returns `base`, or `base_2`, `base_3`, … for the first name not in `taken` (lower-case set). */
export function resolveName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Why a user-requested name cannot be used, or null. Requested names are never silently changed. */
export function invalidRequestedName(name: string, reserved: ReadonlySet<string>, taken: ReadonlySet<string> = new Set()): string | null {
  if (!PLAIN.test(name)) return 'Use letters, digits and underscores, starting with a letter or underscore.';
  if (name.length > MAX_NAME_LENGTH) return `Use at most ${MAX_NAME_LENGTH} characters.`;
  if (reserved.has(name.toLowerCase())) return `"${name}" is a reserved SQL word.`;
  if (taken.has(name.toLowerCase())) return `A table or view named "${name}" already exists.`;
  return null;
}
