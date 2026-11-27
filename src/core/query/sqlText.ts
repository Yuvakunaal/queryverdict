// Removing the statement terminator from one SQL statement (M06). A SELECT is read through an
// outer projection — SELECT … FROM (\n<statement>\n) — so a trailing `;` (and any comment after
// it) must go. This is not a statement splitter: it is applied only to text DuckDB already
// classified as exactly one statement, and the runner uses the result only if DuckDB's parser
// gives the identical tree for it (json_serialize_sql of both must be equal).
//
// The lexer knows DuckDB's quoting: '…' strings (with '' escapes), E'…' strings (backslash
// escapes), "…" identifiers, $tag$…$tag$ dollar quotes, -- line comments and nested /* */
// comments. It records where the last significant (non-space, non-comment, non-`;`) character
// ends; everything after it is removed.

export function trimTerminator(sql: string): string {
  let end = 0; // index after the last significant character
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (ch === ';' || /\s/.test(ch)) {
      i++;
      continue;
    }
    // A significant token starts here.
    if (ch === "'" || ((ch === 'E' || ch === 'e') && next === "'")) {
      const escapes = ch !== "'";
      i += escapes ? 2 : 1;
      while (i < n) {
        if (escapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      end = i;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      end = i;
      continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close < 0 ? n : close + tag.length;
        end = i;
        continue;
      }
    }
    i++;
    end = i;
  }
  return sql.slice(0, end);
}

export interface StatementSpan {
  /** The statement's text, without its terminator and surrounding comments or whitespace. */
  readonly text: string;
  /** Offsets in the input: first significant character, end of the last one. */
  readonly start: number;
  readonly end: number;
  /** Offset just after its `;` terminator, or `end` when it has none. */
  readonly through: number;
}

/**
 * Splits SQL text into statements at top-level `;` (never inside strings, quoted identifiers,
 * dollar quotes or comments), for running the statement at the cursor or a selection of several
 * (maintainer request, P-097). Pieces holding only comments are dropped. The runner does not trust
 * this split on its own: DuckDB's parser must accept every piece as exactly one statement before
 * any of them runs.
 */
export function splitStatements(sql: string): StatementSpan[] {
  const out: StatementSpan[] = [];
  let start = -1; // first significant character of the current statement
  let end = 0;
  let i = 0;
  const n = sql.length;
  const close = (through: number) => {
    if (start >= 0) out.push({ text: sql.slice(start, end), start, end, through });
    start = -1;
  };
  const mark = (from: number, to: number) => {
    if (start < 0) start = from;
    end = to;
  };
  while (i < n) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (ch === ';') {
      close(i + 1);
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const from = i;
    if (ch === "'" || ((ch === 'E' || ch === 'e') && next === "'")) {
      const escapes = ch !== "'";
      i += escapes ? 2 : 1;
      while (i < n) {
        if (escapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      mark(from, i);
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      mark(from, i);
      continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const closeAt = sql.indexOf(tag, i + tag.length);
        i = closeAt < 0 ? n : closeAt + tag.length;
        mark(from, i);
        continue;
      }
    }
    i++;
    mark(from, i);
  }
  close(end);
  return out;
}

/**
 * The statement to run for a caret at `offset` (Snowflake-style "run the current statement").
 * Each statement owns the text from the previous terminator up to and including its own, so a
 * caret in its leading comment or blank lines runs it; a caret after a terminator on the same
 * line (with nothing but spaces or a comment between) runs the statement that just ended; a
 * caret after the last terminator runs the last statement.
 */
export function statementAt(sql: string, offset: number): StatementSpan | null {
  const all = splitStatements(sql);
  if (!all.length) return null;
  const i = all.findIndex((s) => offset <= s.through);
  if (i < 0) return all.at(-1) ?? null;
  const prev = all[i - 1];
  const cur = all[i] as StatementSpan;
  if (prev && offset < cur.start && !sql.slice(prev.through, offset).includes('\n')) return prev;
  return cur;
}

/** First keyword of a statement after leading comments and parentheses (upper case), or ''. */
export function leadingKeyword(sql: string): string {
  const m = /^[\s(]*([A-Za-z]+)/.exec(stripComments(sql));
  return m ? (m[1] as string).toUpperCase() : '';
}

function stripComments(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('--')) {
      const nl = t.indexOf('\n');
      s = nl < 0 ? '' : t.slice(nl + 1);
    } else if (t.startsWith('/*')) {
      const end = t.indexOf('*/');
      s = end < 0 ? '' : t.slice(end + 2);
    } else return t;
  }
}
