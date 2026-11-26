// Join keys and resource qualification (ARCHITECTURE §13–§14.1, P-032). Keys must be direct column
// references, one on each input, of the same integer type on both sides (no implicit coercion),
// at most `maxKeyColumns`. Input sizes are measured with a bounded scan and the grouping state of
// both frequency tables is estimated BEFORE any grouping statement runs. Unknown or over-limit
// values refuse the analysis (fail closed); no `DISTINCT … LIMIT` pre-check is used, because it
// would run the full grouping it is meant to avoid (ES-11).
import { groupingEstimate } from './budget';
import { INTEGER_WIDTH, quoteIdent } from './probes';
import { displayIdent, type ColumnRefIR, type RecognisedJoin } from './recognise';
import type { ResolvedRelation } from './relations';

export interface KeyPair {
  readonly left: { readonly column: string; readonly type: string };
  readonly right: { readonly column: string; readonly type: string };
}

type Columns = Map<string, { name: string; type: string }>;

export type KeyOutcome = { readonly ok: true; readonly pairs: readonly KeyPair[] } | { readonly ok: false; readonly kind: 'unsupported' | 'query-failed'; readonly reason: string };

/** Resolves the join condition to (left column, right column) pairs and checks their types. */
export function resolveKeys(join: RecognisedJoin, left: ResolvedRelation, right: ResolvedRelation, lcols: Columns, rcols: Columns, maxKeyColumns: number): KeyOutcome {
  const pairs: KeyPair[] = [];
  const sameRef = left.ref.ref.toLowerCase() === right.ref.ref.toLowerCase();
  if (sameRef) return { ok: false, kind: 'query-failed', reason: `both inputs are referred to as ${displayIdent(left.ref.ref)}; give them distinct aliases` };
  const side = (c: ColumnRefIR): { side: 'left' | 'right'; column: { name: string; type: string } } | string => {
    const parts = c.parts;
    if (parts.length === 2) {
      const rel = (parts[0] as string).toLowerCase();
      const col = (parts[1] as string).toLowerCase();
      if (rel === left.ref.ref.toLowerCase()) {
        const hit = lcols.get(col);
        return hit ? { side: 'left', column: hit } : `column ${parts.map(displayIdent).join('.')} does not exist`;
      }
      if (rel === right.ref.ref.toLowerCase()) {
        const hit = rcols.get(col);
        return hit ? { side: 'right', column: hit } : `column ${parts.map(displayIdent).join('.')} does not exist`;
      }
      return `${displayIdent(parts[0] as string)} does not name either join input`;
    }
    const col = (parts[0] as string).toLowerCase();
    const l = lcols.get(col);
    const r = rcols.get(col);
    if (l && r) return `column ${displayIdent(parts[0] as string)} is ambiguous (it exists in both inputs)`;
    if (l) return { side: 'left', column: l };
    if (r) return { side: 'right', column: r };
    return `column ${displayIdent(parts[0] as string)} does not exist`;
  };
  if (join.condition.kind === 'using') {
    for (const c of join.condition.columns) {
      const l = lcols.get(c.toLowerCase());
      const r = rcols.get(c.toLowerCase());
      if (!l || !r) return { ok: false, kind: 'query-failed', reason: `USING column ${displayIdent(c)} is not in both inputs` };
      pairs.push({ left: { column: l.name, type: l.type }, right: { column: r.name, type: r.type } });
    }
  } else {
    for (const [a, b] of join.condition.pairs) {
      const x = side(a);
      const y = side(b);
      if (typeof x === 'string') return { ok: false, kind: 'query-failed', reason: x };
      if (typeof y === 'string') return { ok: false, kind: 'query-failed', reason: y };
      if (x.side === y.side) return { ok: false, kind: 'unsupported', reason: `the condition ${[...a.parts, '=', ...b.parts].map((p) => (p === '=' ? p : displayIdent(p))).join(' ')} compares two columns of the same input; each equality must compare a left column with a right column` };
      const [l, r] = x.side === 'left' ? [x.column, y.column] : [y.column, x.column];
      pairs.push({ left: { column: l.name, type: l.type }, right: { column: r.name, type: r.type } });
    }
  }
  if (pairs.length > maxKeyColumns) return { ok: false, kind: 'unsupported', reason: `${pairs.length} key columns exceed the limit of ${maxKeyColumns}` };
  for (const p of pairs) {
    if (p.left.type !== p.right.type) return { ok: false, kind: 'unsupported', reason: `key types differ (${displayIdent(p.left.column)} ${p.left.type} vs ${displayIdent(p.right.column)} ${p.right.type}); implicit casts change matching, so only same-type keys are analysed` };
    if (!(p.left.type in INTEGER_WIDTH)) return { ok: false, kind: 'unsupported', reason: `key ${displayIdent(p.left.column)} has type ${p.left.type}; only same-type integer keys are analysed (text keys may use collations that change equality)` };
  }
  return { ok: true, pairs };
}

export const keyBytes = (pairs: readonly KeyPair[]): bigint => pairs.reduce((s, p) => s + BigInt(INTEGER_WIDTH[p.left.type] as number), 0n);

export interface Qualification {
  readonly ok: boolean;
  readonly reason?: string;
  readonly perSide: { readonly left: bigint; readonly right: bigint };
}

/**
 * Grouping-state estimate: both frequency tables stay resident, and the statistics and SEMI JOIN
 * probes each build one transient hash table no larger than the smaller side. All of it must fit
 * the budget before any grouping runs.
 */
export function qualifyGrouping(leftRows: bigint, rightRows: bigint, pairs: readonly KeyPair[], groupingLimit: bigint): Qualification & { readonly transient: bigint } {
  const kb = keyBytes(pairs);
  const perSide = { left: groupingEstimate(leftRows, kb), right: groupingEstimate(rightRows, kb) };
  const transient = perSide.left < perSide.right ? perSide.left : perSide.right;
  const total = perSide.left + perSide.right + transient;
  if (total > groupingLimit) {
    return { ok: false, perSide, transient, reason: `the estimated grouping state (${total} bytes: key-frequency tables for ${leftRows} + ${rightRows} rows plus one transient hash table) exceeds the budget of ${groupingLimit} bytes; no grouping was run` };
  }
  return { ok: true, perSide, transient };
}

export const quotedKeys = (pairs: readonly KeyPair[], side: 'left' | 'right') => pairs.map((p) => quoteIdent(p[side].column));
