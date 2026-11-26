#!/usr/bin/env python3
"""Deterministic Verdict fixtures with INDEPENDENT expected results (TESTING_STRATEGY §5.1–§5.2).

Each case: two tables (typed columns, rows), one INNER or LEFT join query, expectations, and the
expected statistics, witnesses, finding codes and expectation outcomes computed by the brute-force
oracle in tests/oracle/oracle.py (nested loops, Python integers; never the frequency formula).
Values are written as decimal TEXT so integers beyond 2^53 stay exact in JSON.

Ported from the spike's make_analysis_fixtures.py (seed 20261125), restricted to the P0 scope.
Usage: python3 scripts/fixtures/make_verdict_fixtures.py   (output must be byte-identical on rerun)
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests" / "oracle"))
from oracle import brute_join, expectation_outcome, finding_codes, valid_expectation  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "verdict" / "cases.json"
SEED = 20261125


def q(name: str) -> str:
    return name if name.replace("_", "a").isalnum() and name == name.lower() and not name[0].isdigit() else '"' + name.replace('"', '""') + '"'


def case(name, desc, left, right, jtype, keys, *, lalias=None, ralias=None, using=False, select="*", expectations=(), reversed_on=False, unqualified=False):
    """left/right: (table name, [(column, type)], rows). keys: [(left column, right column)]."""
    lname, lcols, lrows = left
    rname, rcols, rrows = right
    lref, rref = lalias or lname, ralias or rname
    lidx = [[c for c, _ in lcols].index(k[0]) for k in keys]
    ridx = [[c for c, _ in rcols].index(k[1]) for k in keys]
    rel = lambda n, a: f"{q(n)} {q(a)}" if a and a != n else q(n)
    kw = "JOIN" if jtype == "INNER" else "LEFT JOIN"
    if using:
        cond = f"USING ({', '.join(q(l) for l, _ in keys)})"
    else:
        parts = []
        for l, r in keys:
            lc, rc = (q(l), q(r)) if unqualified else (f"{q(lref)}.{q(l)}", f"{q(rref)}.{q(r)}")
            parts.append(f"{rc} = {lc}" if reversed_on else f"{lc} = {rc}")
        cond = "ON " + " AND ".join(parts)
    sql = f"SELECT {select} FROM {rel(lname, lalias)} {kw} {rel(rname, ralias)} {cond}"
    res = brute_join(lrows, rrows, lidx, ridx, jtype)
    s, d = res["stats"], res["derived"]
    outcomes = [expectation_outcome(e, jtype, s, d) for e in expectations]
    exp_codes = [f"{e['kind']}-violated" for e, o in zip(expectations, outcomes) if o == "violated"]
    exp_codes += ["expectation-unchecked" for o in outcomes if o == "unchecked"]
    status = "analyzed" if all(valid_expectation(e) for e in expectations) else "partially-analyzed"
    txt = lambda rows: [[None if v is None else str(v) for v in r] for r in rows]
    tables = {lname: {"columns": [list(c) for c in lcols], "rows": txt(lrows)}}
    if rname != lname:
        tables[rname] = {"columns": [list(c) for c in rcols], "rows": txt(rrows)}
    return {
        "name": name, "description": desc, "sql": sql, "joinType": jtype, "tables": tables, "expectations": list(expectations),
        "expected": {
            "status": status, "authoritative": status == "analyzed",
            "stats": {k: str(v) for k, v in s.items()}, "derived": {k: str(v) if isinstance(v, int) else v for k, v in d.items()},
            "witnesses": res["witnesses"], "findingCodes": finding_codes(s, d) + exp_codes, "expectationOutcomes": outcomes,
        },
    }


INT, BIG = "INTEGER", "BIGINT"


def kv(name, col, typ, keys, extra=None):
    return (name, [(col, typ)] + ([("v", INT)] if extra else []), [(k, i) if extra else (k,) for i, k in enumerate(keys)])


def named():
    cs = []
    cust_u = ("customers", [("cid", INT), ("name_id", INT)], [(1, 10), (2, 20), (3, 30)])
    cust_d = ("customers", [("cid", INT), ("name_id", INT)], [(1, 10), (2, 20), (2, 21), (3, 30), (3, 31), (3, 32)])
    orders = ("orders", [("oid", INT), ("cid", INT)], [(100, 1), (101, 2), (102, 2), (103, 3), (104, 4), (105, None)])
    cs.append(case("one_to_one", "Unique keys on both sides.", kv("a", "k", INT, [1, 2, 3]), kv("b", "k", INT, [1, 2, 4]), "INNER", [("k", "k")],
                   expectations=[{"kind": "relationship", "join": 0, "expected": "one-to-one"}, {"kind": "no-fan-out", "join": 0, "side": "left"}]))
    cs.append(case("one_to_many_legitimate", "Customers LEFT JOIN orders: legitimate expansion declared one-to-many.", cust_u, orders, "LEFT", [("cid", "cid")], lalias="c", ralias="o",
                   expectations=[{"kind": "relationship", "join": 0, "expected": "one-to-many"}, {"kind": "no-row-loss", "join": 0, "side": "left"}]))
    cs.append(case("many_to_one", "Orders JOIN unique customers.", orders, cust_u, "INNER", [("cid", "cid")], lalias="o", ralias="c",
                   expectations=[{"kind": "relationship", "join": 0, "expected": "many-to-one"}, {"kind": "no-fan-out", "join": 0, "side": "left"}, {"kind": "no-row-loss", "join": 0, "side": "left"}]))
    cs.append(case("many_to_one_violated", "Declared many-to-one but customers has duplicated keys.", orders, cust_d, "LEFT", [("cid", "cid")], lalias="o", ralias="c",
                   expectations=[{"kind": "relationship", "join": 0, "expected": "many-to-one"}, {"kind": "no-fan-out", "join": 0, "side": "left"}, {"kind": "row-count", "min": 6, "max": 6}]))
    cs.append(case("many_to_many", "Duplicated matched keys on both sides.", kv("a", "k", INT, [1, 1, 2, 2, 2, 3]), kv("b", "k", INT, [1, 1, 1, 2, 2, 5]), "INNER", [("k", "k")]))
    cs.append(case("duplicates_only_unmatched", "Right duplicates only for keys the left never uses: no expansion.", kv("a", "k", INT, [1, 2]), kv("b", "k", INT, [1, 2, 9, 9, 9]), "INNER", [("k", "k")],
                   expectations=[{"kind": "no-fan-out", "join": 0, "side": "left"}, {"kind": "relationship", "join": 0, "expected": "one-to-many"}]))
    comp = [("k1", INT), ("k2", INT), ("v", INT)]
    cs.append(case("composite_partial_nulls", "Two-column key with partial NULL components.",
                   ("a", comp, [(1, 1, 0), (1, 2, 1), (2, 1, 2), (2, None, 3), (None, 1, 4), (None, None, 5)]),
                   ("b", comp, [(1, 1, 0), (1, 1, 1), (2, 1, 2), (2, None, 3), (None, 1, 4), (3, 3, 5)]), "LEFT", [("k1", "k1"), ("k2", "k2")]))
    cs.append(case("all_null_keys", "Only NULL keys on both sides.", kv("a", "k", INT, [None, None]), kv("b", "k", INT, [None, None, None]), "LEFT", [("k", "k")],
                   expectations=[{"kind": "no-row-loss", "join": 0, "side": "left"}, {"kind": "no-row-loss", "join": 0, "side": "right"}]))
    for jt in ("INNER", "LEFT"):
        cs.append(case(f"empty_left_{jt.lower()}", "Empty left table.", kv("a", "k", INT, []), kv("b", "k", INT, [1, 2]), jt, [("k", "k")], expectations=[{"kind": "row-count", "max": 0}]))
        cs.append(case(f"empty_right_{jt.lower()}", "Empty right table.", kv("a", "k", INT, [1, 1, None]), kv("b", "k", INT, []), jt, [("k", "k")], expectations=[{"kind": "row-count", "min": 1}]))
        cs.append(case(f"unmatched_{jt.lower()}", "Unmatched keys on both sides with duplicates.", orders, cust_d, jt, [("cid", "cid")], lalias="o", ralias="c",
                       expectations=[{"kind": "no-row-loss", "join": 0, "side": "left"}, {"kind": "no-row-loss", "join": 0, "side": "right"}]))
    cs.append(case("both_empty", "Both tables empty.", kv("a", "k", INT, []), kv("b", "k", INT, []), "LEFT", [("k", "k")], expectations=[{"kind": "row-count", "min": 0, "max": 0}]))
    cs.append(case("offsetting_fan_out_and_loss", "One key doubles a row, another is lost: output count equals input count.", kv("a", "k", INT, [1, 2]), kv("b", "k", INT, [1, 1]), "INNER", [("k", "k")],
                   expectations=[{"kind": "row-count", "min": 2, "max": 2}, {"kind": "no-row-loss", "join": 0, "side": "left"}, {"kind": "no-fan-out", "join": 0, "side": "left"}]))
    cs.append(case("skewed_key", "One hot key (60 × 3) plus a long tail.", kv("a", "k", INT, [1] * 60 + list(range(2, 40))), kv("b", "k", INT, [1, 1, 1] + list(range(2, 60, 2))), "LEFT", [("k", "k")]))
    big = [9007199254740992, 9007199254740993, -9223372036854775808, 9223372036854775807]
    cs.append(case("bigint_beyond_2_53", "BIGINT keys that collapse as doubles stay distinct.", kv("a", "k", BIG, big + [9007199254740993]), kv("b", "k", BIG, [9007199254740993, 9223372036854775807, 9223372036854775807]), "INNER", [("k", "k")],
                   expectations=[{"kind": "row-count", "min": 4, "max": 4}]))
    cs.append(case("ubigint_max", "UBIGINT keys at the top of the range.", kv("a", "k", "UBIGINT", [18446744073709551615, 18446744073709551614, 0]), kv("b", "k", "UBIGINT", [18446744073709551615, 18446744073709551615]), "LEFT", [("k", "k")]))
    hmax, hmin, uhmax = 2 ** 127 - 1, -(2 ** 127), 2 ** 128 - 1
    cs.append(case("hugeint_extremes", "HUGEINT keys at both ends of the range.", kv("a", "k", "HUGEINT", [hmax, hmin, hmin, 0]), kv("b", "k", "HUGEINT", [hmin, hmax, 1]), "INNER", [("k", "k")]))
    cs.append(case("uhugeint_max", "UHUGEINT maximum.", kv("a", "k", "UHUGEINT", [uhmax, uhmax]), kv("b", "k", "UHUGEINT", [uhmax, 5]), "INNER", [("k", "k")]))
    for t, vals in (("TINYINT", [-128, 127, 0, 0]), ("SMALLINT", [-32768, 32767, 1]), ("UTINYINT", [0, 255, 255]), ("USMALLINT", [65535, 1]), ("UINTEGER", [4294967295, 0])):
        cs.append(case(f"{t.lower()}_keys", f"{t} keys.", kv("a", "k", t, vals), kv("b", "k", t, vals[:2] + vals[:1]), "LEFT", [("k", "k")]))
    cs.append(case("quoted_identifiers", "Quoted table, alias and column names with dots, spaces and quotes.",
                   ('my "orders"', [("cust.id", INT), ("v", INT)], [(1, 0), (2, 1), (2, 2)]), ("Customer Table", [("cust.id", INT)], [(2,), (3,)]), "INNER", [("cust.id", "cust.id")],
                   lalias="o.x", ralias="c c"))
    cs.append(case("using_join", "JOIN … USING (cid).", orders, cust_d, "INNER", [("cid", "cid")], using=True))
    cs.append(case("using_composite_left", "LEFT JOIN … USING (k1, k2).", ("a", comp, [(1, 1, 0), (1, 2, 1), (None, 2, 2)]), ("b", comp, [(1, 1, 0), (1, 1, 1), (1, 2, 2)]), "LEFT", [("k1", "k1"), ("k2", "k2")], using=True))
    cs.append(case("reversed_condition", "ON right = left.", orders, cust_u, "INNER", [("cid", "cid")], lalias="o", ralias="c", reversed_on=True))
    cs.append(case("unqualified_distinct_columns", "Unqualified key columns with distinct names.", ("a", [("ka", INT)], [(1,), (2,), (2,)]), ("b", [("kb", INT)], [(2,), (3,)]), "INNER", [("ka", "kb")], unqualified=True))
    cs.append(case("three_key_columns", "Three-column key.", ("a", [("x", INT), ("y", INT), ("z", INT)], [(1, 1, 1), (1, 1, 2), (1, 1, 1)]), ("b", [("x", INT), ("y", INT), ("z", INT)], [(1, 1, 1), (1, 1, 1), (1, 2, 1)]), "INNER", [("x", "x"), ("y", "y"), ("z", "z")]))
    cs.append(case("projection_columns", "Projection of plain columns only.", orders, cust_u, "LEFT", [("cid", "cid")], lalias="o", ralias="c", select="o.oid, c.name_id"))
    cs.append(case("row_count_boundaries", "Inclusive row-count bounds, plus invalid declarations.", kv("a", "k", INT, [1, 2, 3]), kv("b", "k", INT, [1, 1, 2]), "INNER", [("k", "k")],
                   expectations=[{"kind": "row-count", "min": 3, "max": 3}, {"kind": "row-count", "max": 2}, {"kind": "row-count", "min": 4}, {"kind": "bogus"}, {"kind": "no-fan-out", "join": 0}, {"kind": "metric-preserved", "column": "k"}]))
    return cs


def self_join():
    rows = [(1, 1), (2, 1), (3, 2), (4, None)]
    return case("self_join_aliases", "Self-join of one table with distinct aliases.", ("emp", [("id", INT), ("mgr", INT)], rows), ("emp", [("id", INT), ("mgr", INT)], rows), "LEFT", [("mgr", "id")], lalias="e", ralias="m")


def random_cases(n, seed):
    rng = random.Random(seed)
    out = []
    types = [INT, BIG, "SMALLINT", "UBIGINT", "HUGEINT"]
    for i in range(n):
        typ = rng.choice(types)
        two = rng.random() < 0.3
        offset = {INT: 0, BIG: 9007199254740990, "SMALLINT": 0, "UBIGINT": 18446744073709551600, "HUGEINT": -(2 ** 100)}[typ]

        def mk(nrows, space, nulls):
            rows = []
            for _ in range(nrows):
                k1 = None if rng.random() < nulls else offset + rng.randint(1, space)
                k2 = (None if rng.random() < nulls / 2 else rng.randint(1, 2)) if two else None
                rows.append((k1, k2, rng.randint(-5, 5)))
            return rows

        cols = [("k1", typ), ("k2", INT), ("v", INT)]
        left = ("a", cols, mk(rng.choice([0, 1, 3, 8, 15, 25]), rng.randint(1, 8), rng.choice([0, 0.1, 0.3])))
        right = ("b", cols, mk(rng.choice([0, 1, 3, 8, 15, 25]), rng.randint(1, 8), rng.choice([0, 0.1, 0.3])))
        keys = [("k1", "k1")] + ([("k2", "k2")] if two else [])
        exps = []
        for _ in range(rng.randint(0, 3)):
            k = rng.choice(["relationship", "no-row-loss", "no-fan-out", "row-count"])
            if k == "relationship":
                exps.append({"kind": k, "join": 0, "expected": rng.choice(["one-to-one", "one-to-many", "many-to-one", "many-to-many"])})
            elif k == "row-count":
                lo = rng.randint(0, 20)
                exps.append({"kind": k, "min": lo, "max": lo + rng.randint(0, 20)})
            else:
                exps.append({"kind": k, "join": 0, "side": rng.choice(["left", "right"])})
        out.append(case(f"random_{i:03d}", "seeded random case", left, right, rng.choice(["INNER", "LEFT"]), keys, lalias="l", ralias="r", using=rng.random() < 0.2, expectations=exps))
    return out


def main():
    doc = {"generator": "scripts/fixtures/make_verdict_fixtures.py", "oracle": "tests/oracle/oracle.py", "seed": SEED, "cases": named() + [self_join()] + random_cases(120, SEED)}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, separators=(",", ":"), sort_keys=False) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(doc['cases'])} cases")


if __name__ == "__main__":
    main()
