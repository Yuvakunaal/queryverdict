#!/usr/bin/env python3
"""Deterministic fixtures for the SQL correctness analysis engine, with INDEPENDENT expected results.

Each case is a structured plan (tables, a left-deep join chain, optional WHERE / GROUP BY).
The SQL text is rendered from the plan, and every expected number is computed here by
brute force: nested loops over materialised rows with SQL NULL semantics (NULL never equals
NULL; comparisons with NULL are unknown). This deliberately does NOT use the frequency
formula that the TypeScript engine uses, so the two implementations check each other.

Output: tests/fixtures/analysis/cases.json (small; committed as a test fixture).
Usage:  python3 scripts/make_analysis_fixtures.py [--random 200] [--seed 20261125]
"""
from __future__ import annotations

import argparse
import json
import random
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "analysis" / "cases.json"

# ---------------------------------------------------------------- SQL 3-valued helpers


def cmp(a, op, b):
    if a is None or b is None:
        return None
    return {"=": a == b, "<>": a != b, ">": a > b, "<": a < b, ">=": a >= b}[op]


def truthy(v):
    return v is True


# ---------------------------------------------------------------- tables

def table(cols, rows):
    """cols: [(name, sqltype)], rows: list of tuples (None = NULL; Decimal for DECIMAL)."""
    return {"columns": cols, "rows": [list(r) for r in rows]}


def lit(v, typ):
    if v is None:
        return "NULL"
    if typ.startswith("VARCHAR"):
        return "'" + str(v).replace("'", "''") + "'"
    return str(v)


# ---------------------------------------------------------------- brute force engine

def rows_of(tables, name, alias):
    t = tables[name]
    names = [c[0] for c in t["columns"]]
    return [{f"{alias}.{n}": (Decimal(v) if isinstance(v, str) and t["columns"][i][1].startswith("DECIMAL") and v is not None else v)
             for i, (n, v) in enumerate(zip(names, r))} for r in t["rows"]], [f"{alias}.{n}" for n in names]


def brute_join(left_rows, left_cols, right_rows, right_cols, keys, jtype):
    """Nested-loop join with SQL semantics. Returns output rows and per-join statistics."""
    def key(row, side):
        return tuple(row[k[0] if side == "l" else k[1]] for k in keys)

    lkeys = [key(r, "l") for r in left_rows]
    rkeys = [key(r, "r") for r in right_rows]
    l_null = sum(1 for k in lkeys if any(v is None for v in k))
    r_null = sum(1 for k in rkeys if any(v is None for v in k))
    # matches by nested loops (NULL never matches)
    lmatch = [[j for j, rk in enumerate(rkeys) if all(cmp(a, "=", b) is True for a, b in zip(lk, rk))] for lk in lkeys]
    rmatch_count = [0] * len(right_rows)
    for ms in lmatch:
        for j in ms:
            rmatch_count[j] += 1
    out = []
    for i, ms in enumerate(lmatch):
        for j in ms:
            out.append({**left_rows[i], **right_rows[j]})
        if not ms and jtype in ("LEFT", "FULL"):
            out.append({**left_rows[i], **{c: None for c in right_cols}})
    if jtype in ("RIGHT", "FULL"):
        for j, c in enumerate(rmatch_count):
            if c == 0:
                out.append({**{c2: None for c2 in left_cols}, **right_rows[j]})

    def freq(ks):
        f = {}
        for k in ks:
            if any(v is None for v in k):
                continue
            f[k] = f.get(k, 0) + 1
        return f

    lf, rf = freq(lkeys), freq(rkeys)
    matched = [k for k in lf if k in rf]
    stats = {
        "leftRows": len(left_rows), "rightRows": len(right_rows),
        "leftNullKeyRows": l_null, "rightNullKeyRows": r_null,
        "leftDistinctKeys": len(lf), "rightDistinctKeys": len(rf),
        "leftDuplicateKeys": sum(1 for c in lf.values() if c > 1), "rightDuplicateKeys": sum(1 for c in rf.values() if c > 1),
        "leftMaxMultiplicity": max(lf.values(), default=0), "rightMaxMultiplicity": max(rf.values(), default=0),
        "leftMaxMultiplicityMatched": max((lf[k] for k in matched), default=0), "rightMaxMultiplicityMatched": max((rf[k] for k in matched), default=0),
        "matchedKeys": len(matched),
        # from the nested loops, not from frequencies:
        "matchedPairs": sum(len(ms) for ms in lmatch),
        "leftRowsMatched": sum(1 for ms in lmatch if ms),
        "rightRowsMatched": sum(1 for c in rmatch_count if c > 0),
        "leftRowsMultiplied": sum(1 for ms in lmatch if len(ms) > 1),
        "leftExcessCopies": sum(len(ms) - 1 for ms in lmatch if len(ms) > 1),
        "rightRowsMultiplied": sum(1 for c in rmatch_count if c > 1),
        "rightExcessCopies": sum(c - 1 for c in rmatch_count if c > 1),
    }
    lu = len(left_rows) - stats["leftRowsMatched"]
    ru = len(right_rows) - stats["rightRowsMatched"]

    def rel(lu_, ru_):
        return {(True, True): "one-to-one", (True, False): "one-to-many", (False, True): "many-to-one", (False, False): "many-to-many"}[(lu_, ru_)]

    derived = {
        "outputRows": len(out), "leftUnmatchedRows": lu, "rightUnmatchedRows": ru,
        "leftRowsDropped": 0 if jtype in ("LEFT", "FULL") else lu,
        "rightRowsDropped": 0 if jtype in ("RIGHT", "FULL") else ru,
        "relationship": rel(stats["leftDuplicateKeys"] == 0, stats["rightDuplicateKeys"] == 0),
        "effectiveRelationship": "no-matches" if not matched else rel(stats["leftMaxMultiplicityMatched"] <= 1, stats["rightMaxMultiplicityMatched"] <= 1),
    }
    return out, left_cols + right_cols, stats, derived


def expected_codes(jtype, s, d):
    codes = ["join-cardinality"]
    if s["leftExcessCopies"]:
        codes.append("join-expansion")
    if s["rightExcessCopies"]:
        codes.append("right-rows-repeated")
    if d["leftRowsDropped"] or d["rightRowsDropped"]:
        codes.append("unmatched-rows-dropped")
    if s["leftNullKeyRows"] or s["rightNullKeyRows"]:
        codes.append("null-join-keys")
    if d["effectiveRelationship"] == "many-to-many":
        codes.append("many-to-many-join")
    return codes


def run_plan(case):
    tables = case["tables"]
    alias0, name0 = case["base"]
    rows, cols = rows_of(tables, name0, alias0)
    base_rows, base_cols = rows, cols
    joins = []
    intermediates = []
    for i, j in enumerate(case["joins"]):
        ralias, rname = j["right"]
        rrows, rcols = rows_of(tables, rname, ralias)
        rows, cols, s, d = brute_join(rows, cols, rrows, rcols, j["keys"], j["type"])
        joins.append({"index": i, "type": j["type"], "stats": s, "derived": d, "codes": expected_codes(j["type"], s, d)})
        intermediates.append(len(rows))
    where = case.get("where_py")
    filtered = [r for r in rows if where is None or truthy(where(r))]
    # rows removed by WHERE among NULL-extended rows (preserved-side rows of outer joins)
    outer_removed = []
    if where is not None:
        for i, j in enumerate(case["joins"]):
            if j["type"] == "INNER" or any(x["type"] in ("RIGHT", "FULL") for x in case["joins"][i + 1:]):
                continue
            for side in (["left"] if j["type"] == "LEFT" else ["right"] if j["type"] == "RIGHT" else ["left", "right"]):
                k = j["keys"][0][1] if side == "left" else j["keys"][0][0]
                before = sum(1 for r in rows if r[k] is None)
                after = sum(1 for r in filtered if r[k] is None)
                outer_removed.append({"join": i, "side": side, "before": before, "removed": before - after})
    group = case.get("group")
    if group:
        final = len({tuple(r[g] for g in group) for r in filtered})
    elif case.get("aggregate"):
        final = 1
    else:
        final = len(filtered)
    if case.get("limit") is not None:
        final = min(final, case["limit"])
    metric = None
    if case.get("metric"):
        mcol = case["metric"]
        malias = mcol.split(".")[0]
        mname = dict([case["base"]] + [j["right"] for j in case["joins"]])[malias]
        srows, _ = rows_of(tables, mname, malias)
        src = [r for r in srows if where is None or truthy(where(r))] if case.get("where_only_metric_rel", where is None) else None
        def total(rs):
            vals = [r[mcol] for r in rs if r[mcol] is not None]
            return str(sum(vals, Decimal(0))) if vals else None
        metric = {"source": total(src) if src is not None else None, "joined": total(filtered)}
    return {"baseRows": len(base_rows), "joins": joins, "intermediates": intermediates, "afterWhere": len(filtered) if where is not None else None,
            "final": final, "outerRemoved": outer_removed, "metric": metric}


def render_sql(case):
    a0, n0 = case["base"]
    parts = []
    if case.get("with"):
        parts.append("WITH " + case["with"])
    parts.append(f"SELECT {case.get('select', '*')} FROM {n0} {a0}" if a0 != n0 else f"SELECT {case.get('select', '*')} FROM {n0}")
    for j in case["joins"]:
        ra, rn = j["right"]
        rel = f"{rn} {ra}" if ra != rn else rn
        kw = {"INNER": "JOIN", "LEFT": "LEFT JOIN", "RIGHT": "RIGHT JOIN", "FULL": "FULL OUTER JOIN"}[j["type"]]
        if j.get("using"):
            parts.append(f"{kw} {rel} USING ({', '.join(j['using'])})")
        else:
            parts.append(f"{kw} {rel} ON " + " AND ".join(f"{l} = {r}" for l, r in j["keys"]))
    if case.get("where_sql"):
        parts.append("WHERE " + case["where_sql"])
    if case.get("group"):
        parts.append("GROUP BY " + ", ".join(case["group"]))
    if case.get("limit") is not None:
        parts.append(f"LIMIT {case['limit']}")
    return " ".join(parts)


def from_prefixes(case):
    """SQL FROM-clauses up to each join, so the test can count actual rows with DuckDB."""
    a0, n0 = case["base"]
    acc = f"{n0} {a0}" if a0 != n0 else n0
    out = []
    for j in case["joins"]:
        ra, rn = j["right"]
        rel = f"{rn} {ra}" if ra != rn else rn
        kw = {"INNER": "JOIN", "LEFT": "LEFT JOIN", "RIGHT": "RIGHT JOIN", "FULL": "FULL OUTER JOIN"}[j["type"]]
        acc += f" {kw} {rel} ON " + " AND ".join(f"{l} = {r}" for l, r in j["keys"])
        out.append(acc)
    return out


# ---------------------------------------------------------------- named cases

D = Decimal
INT, VC, DEC = "INTEGER", "VARCHAR", "DECIMAL(12,2)"


def cust(rows):
    return table([("cid", INT), ("name", VC), ("seg", VC)], rows)


def orders(rows):
    return table([("oid", INT), ("cid", INT), ("amount", DEC)], rows)


C_UNIQUE = cust([(1, "ann", "a"), (2, "bob", "b"), (3, "cy", "a")])
C_DUP = cust([(1, "ann", "a"), (2, "bob", "b"), (2, "bob2", "b"), (3, "cy", "a"), (3, "cy2", "a"), (3, "cy3", "a")])
O_BASIC = orders([(10, 1, "5.00"), (11, 2, "7.50"), (12, 2, "2.50"), (13, 3, "1.00"), (14, 4, "9.99"), (15, None, "3.00")])


def named_cases():
    cs = []

    def add(name, desc, **kw):
        kw.setdefault("tables", {})
        cs.append({"name": name, "description": desc, **kw})

    add("one_to_one", "Unique keys on both sides.",
        tables={"a": table([("k", INT), ("x", INT)], [(1, 1), (2, 2), (3, 3)]), "b": table([("k", INT), ("y", INT)], [(1, 10), (2, 20), (4, 40)])},
        base=("a", "a"), joins=[{"type": "INNER", "right": ("b", "b"), "keys": [("a.k", "b.k")]}],
        expectations=[{"kind": "relationship", "join": 0, "expected": "one-to-one"}], must_not=["relationship-violated", "join-expansion"])
    add("one_to_many_legitimate", "Customers LEFT JOIN orders: legitimate expansion, declared one-to-many.",
        tables={"customers": C_UNIQUE, "orders": O_BASIC},
        base=("c", "customers"), joins=[{"type": "LEFT", "right": ("o", "orders"), "keys": [("c.cid", "o.cid")]}],
        expectations=[{"kind": "relationship", "join": 0, "expected": "one-to-many"}], must=["join-expansion"], must_not=["relationship-violated", "many-to-many-join"])
    add("many_to_one", "Orders JOIN unique customers, declared many-to-one.",
        tables={"customers": C_UNIQUE, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "INNER", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        expectations=[{"kind": "relationship", "join": 0, "expected": "many-to-one"}, {"kind": "no-fan-out", "join": 0}], must_not=["relationship-violated", "fan-out", "join-expansion"])
    add("many_to_one_violated", "Declared many-to-one, but customers has duplicated keys.",
        tables={"customers": C_DUP, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "INNER", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        expectations=[{"kind": "relationship", "join": 0, "expected": "many-to-one"}, {"kind": "no-fan-out", "join": 0}], must=["relationship-violated", "fan-out", "join-expansion"])
    add("many_to_many", "Duplicated keys on both sides.",
        tables={"a": table([("k", INT)], [(1,), (1,), (2,), (2,), (2,), (3,)]), "b": table([("k", INT)], [(1,), (1,), (1,), (2,), (2,), (5,)])},
        base=("a", "a"), joins=[{"type": "INNER", "right": ("b", "b"), "keys": [("a.k", "b.k")]}], must=["many-to-many-join", "join-expansion"])
    add("duplicates_only_in_unmatched_keys", "Right duplicates exist only for keys the left side never uses: no expansion.",
        tables={"a": table([("k", INT)], [(1,), (2,)]), "b": table([("k", INT)], [(1,), (2,), (9,), (9,), (9,)])},
        base=("a", "a"), joins=[{"type": "INNER", "right": ("b", "b"), "keys": [("a.k", "b.k")]}],
        expectations=[{"kind": "no-fan-out", "join": 0}], must_not=["fan-out", "join-expansion"])
    add("composite_keys", "Two-column key with a partial NULL.",
        tables={"a": table([("k1", INT), ("k2", VC)], [(1, "x"), (1, "y"), (2, "x"), (2, None), (None, "x")]),
                "b": table([("k1", INT), ("k2", VC)], [(1, "x"), (1, "x"), (2, "x"), (2, None), (None, "x"), (3, "z")])},
        base=("a", "a"), joins=[{"type": "LEFT", "right": ("b", "b"), "keys": [("a.k1", "b.k1"), ("a.k2", "b.k2")]}], must=["null-join-keys", "join-expansion"])
    add("null_keys", "Repeated NULL keys on both sides never match.",
        tables={"a": table([("k", INT)], [(None,), (None,), (1,)]), "b": table([("k", INT)], [(None,), (None,), (None,), (1,)])},
        base=("a", "a"), joins=[{"type": "FULL", "right": ("b", "b"), "keys": [("a.k", "b.k")]}], must=["null-join-keys"], must_not=["join-expansion"])
    for jt in ("INNER", "LEFT", "RIGHT", "FULL"):
        add(f"empty_left_{jt.lower()}", f"Empty left table, {jt} JOIN.",
            tables={"a": table([("k", INT)], []), "b": table([("k", INT)], [(1,), (2,)])},
            base=("a", "a"), joins=[{"type": jt, "right": ("b", "b"), "keys": [("a.k", "b.k")]}])
        add(f"empty_right_{jt.lower()}", f"Empty right table, {jt} JOIN.",
            tables={"a": table([("k", INT)], [(1,), (1,), (None,)]), "b": table([("k", INT)], [])},
            base=("a", "a"), joins=[{"type": jt, "right": ("b", "b"), "keys": [("a.k", "b.k")]}])
    add("both_empty", "Both tables empty.",
        tables={"a": table([("k", INT)], []), "b": table([("k", INT)], [])},
        base=("a", "a"), joins=[{"type": "FULL", "right": ("b", "b"), "keys": [("a.k", "b.k")]}])
    for jt in ("INNER", "LEFT", "RIGHT", "FULL"):
        add(f"unmatched_{jt.lower()}", f"Unmatched keys on both sides with duplicates, {jt} JOIN.",
            tables={"customers": C_DUP, "orders": O_BASIC},
            base=("o", "orders"), joins=[{"type": jt, "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
            expectations=[{"kind": "no-row-loss", "join": 0, "side": "left"}],
            must=(["row-loss"] if jt in ("INNER", "RIGHT") else []), must_not=([] if jt in ("INNER", "RIGHT") else ["row-loss"]))
    add("left_join_where_rejects_nulls", "LEFT JOIN then WHERE on a right-side column removes the NULL-extended rows.",
        tables={"customers": C_UNIQUE, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "LEFT", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        where_sql="c.seg = 'a'", where_py=lambda r: cmp(r["c.seg"], "=", "a"), must=["where-removes-null-extended-rows"], must_not=["where-filters-preserved-side"])
    add("left_join_where_is_null_antijoin", "LEFT JOIN ... WHERE c.cid IS NULL (intentional anti-join) keeps all NULL-extended rows.",
        tables={"customers": C_UNIQUE, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "LEFT", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        where_sql="c.cid IS NULL", where_py=lambda r: r["c.cid"] is None, must_not=["where-removes-null-extended-rows", "where-filters-preserved-side", "where-removes-outer-join-rows"])
    add("filter_on_left_after_left_join", "WHERE on a left-side column after a LEFT JOIN.",
        tables={"customers": C_UNIQUE, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "LEFT", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        where_sql="o.amount > 5.00", where_py=lambda r: cmp(r["o.amount"], ">", D("5.00")), must=["where-filters-preserved-side"], must_not=["where-removes-null-extended-rows"])
    add("filter_before_join_cte", "Filter applied before the join in a CTE.",
        tables={"customers": C_UNIQUE, "orders": O_BASIC},
        with_="ca AS (SELECT * FROM customers WHERE seg = 'a')",
        cte_tables={"ca": ("customers", lambda r: cmp(r["seg"], "=", "a"))},
        base=("o", "orders"), joins=[{"type": "LEFT", "right": ("ca", "ca"), "keys": [("o.cid", "ca.cid")]}], must_not=["where-removes-null-extended-rows", "where-filters-preserved-side", "where-removes-outer-join-rows"])
    add("aggregation_inflation", "SUM(o.amount) after joining customers with duplicated keys.",
        tables={"customers": C_DUP, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "LEFT", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        select="sum(o.amount)", aggregate=True, metric="o.amount",
        expectations=[{"kind": "metric-preserved", "column": "o.amount"}], must=["metric-preserved-violated"])
    add("aggregation_preserved", "SUM(o.amount) through a many-to-one LEFT JOIN: no inflation.",
        tables={"customers": C_UNIQUE, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "LEFT", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        select="c.seg, sum(o.amount)", group=["c.seg"], metric="o.amount",
        expectations=[{"kind": "metric-preserved", "column": "o.amount"}], must_not=["metric-preserved-violated"])
    add("aggregation_inner_loss", "INNER JOIN drops orders, so SUM is lower than the source total.",
        tables={"customers": C_UNIQUE, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "INNER", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        select="sum(o.amount)", aggregate=True, metric="o.amount",
        expectations=[{"kind": "metric-preserved", "column": "o.amount"}], must=["metric-preserved-violated"])
    add("fanout_net_zero_metric", "Fan-out of a +5/−5 pair: the total is unchanged although rows are duplicated.",
        tables={"customers": C_DUP, "orders": orders([(1, 2, "5.00"), (2, 2, "-5.00"), (3, 1, "4.00")])},
        base=("o", "orders"), joins=[{"type": "INNER", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        select="sum(o.amount)", aggregate=True, metric="o.amount",
        expectations=[{"kind": "metric-preserved", "column": "o.amount"}], must=["join-expansion"], must_not=["metric-preserved-violated"])
    add("fanout_and_loss_same_row_count", "One duplicated key adds a row, one unmatched key drops a row: output count equals input count.",
        tables={"a": table([("k", INT)], [(1,), (2,)]), "b": table([("k", INT)], [(1,), (1,)])},
        base=("a", "a"), joins=[{"type": "INNER", "right": ("b", "b"), "keys": [("a.k", "b.k")]}], must=["join-expansion", "unmatched-rows-dropped"])
    add("count_star_after_fanout", "COUNT(*) per segment after a fan-out join.",
        tables={"customers": C_DUP, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "INNER", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        select="c.seg, count(*)", group=["c.seg"], must=["right-rows-repeated"])
    add("three_table_chain", "orders ⋈ customers ⋈ segments: second join uses executed intermediate frequencies.",
        tables={"customers": C_DUP, "orders": O_BASIC, "segments": table([("seg", VC), ("label", VC)], [("a", "Alpha"), ("b", "Beta"), ("b", "Beta2")])},
        base=("o", "orders"), joins=[{"type": "LEFT", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]},
                                     {"type": "INNER", "right": ("s", "segments"), "keys": [("c.seg", "s.seg")]}])
    add("using_join", "JOIN ... USING (cid).",
        tables={"customers": C_DUP, "orders": O_BASIC},
        base=("orders", "orders"), joins=[{"type": "INNER", "right": ("customers", "customers"), "keys": [("orders.cid", "customers.cid")], "using": ["cid"]}])
    add("grain_violated", "Expected one result row per oid; duplicated customers break it.",
        tables={"customers": C_DUP, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "INNER", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        select="o.oid, c.name", expectations=[{"kind": "grain", "columns": ["oid"]}], must=["grain-violated"])
    add("grain_ok", "One result row per oid holds with unique customers.",
        tables={"customers": C_UNIQUE, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "LEFT", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        select="o.oid, c.name", expectations=[{"kind": "grain", "columns": ["oid"]}, {"kind": "row-count", "min": 6, "max": 6}], must_not=["grain-violated", "row-count-violated"])
    add("row_count_violated", "Declared exactly 6 rows; fan-out produces more.",
        tables={"customers": C_DUP, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "LEFT", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}],
        expectations=[{"kind": "row-count", "min": 6, "max": 6}], must=["row-count-violated"])
    add("limit_final_count", "LIMIT affects only the final count.",
        tables={"customers": C_DUP, "orders": O_BASIC},
        base=("o", "orders"), joins=[{"type": "LEFT", "right": ("c", "customers"), "keys": [("o.cid", "c.cid")]}], limit=3)
    return cs


UNSUPPORTED = [
    ("comma join", "SELECT * FROM a, b WHERE a.k = b.k"),
    ("CROSS JOIN", "SELECT * FROM a CROSS JOIN b"),
    ("NATURAL JOIN", "SELECT * FROM a NATURAL JOIN b"),
    ("subquery in FROM", "SELECT * FROM (SELECT * FROM a) s JOIN b ON s.k = b.k"),
    ("subquery in WHERE", "SELECT * FROM a WHERE k IN (SELECT k FROM b)"),
    ("UNION", "SELECT k FROM a UNION ALL SELECT k FROM b"),
    ("window function", "SELECT k, row_number() OVER () FROM a"),
    ("non-equality join", "SELECT * FROM a JOIN b ON a.k < b.k"),
    ("OR join condition", "SELECT * FROM a JOIN b ON a.k = b.k OR a.k = 0"),
    ("expression join key", "SELECT * FROM a JOIN b ON a.k + 1 = b.k"),
    ("IS NOT DISTINCT FROM", "SELECT * FROM a JOIN b ON a.k IS NOT DISTINCT FROM b.k"),
    ("recursive CTE", "WITH RECURSIVE r AS (SELECT 1 AS k UNION ALL SELECT k + 1 FROM r WHERE k < 3) SELECT * FROM r"),
    ("DISTINCT", "SELECT DISTINCT a.k FROM a JOIN b ON a.k = b.k"),
    ("ROLLUP", "SELECT a.k, count(*) FROM a JOIN b ON a.k = b.k GROUP BY ROLLUP (a.k)"),
    ("SEMI JOIN", "SELECT * FROM a SEMI JOIN b ON a.k = b.k"),
    ("ANTI JOIN", "SELECT * FROM a ANTI JOIN b ON a.k = b.k"),
    ("table function", "SELECT * FROM range(3) r JOIN a ON r.range = a.k"),
    ("multiple statements", "SELECT 1 FROM a; SELECT 2 FROM b"),
    ("QUALIFY", "SELECT a.k FROM a JOIN b ON a.k = b.k QUALIFY 1 = 1"),
    ("schema-qualified table", "SELECT * FROM main.a JOIN b ON a.k = b.k"),
    ("right-nested join", "SELECT * FROM a JOIN (b JOIN a AS a2 ON b.k = a2.k) ON a.k = b.k"),
]


# ---------------------------------------------------------------- random cases

def random_cases(n, seed):
    rng = random.Random(seed)
    cases = []
    for i in range(n):
        two_keys = rng.random() < 0.25
        three = rng.random() < 0.25
        def mk(nrows, keyspace, null_rate):
            rows = []
            for _ in range(nrows):
                k1 = None if rng.random() < null_rate else rng.randint(1, keyspace)
                k2 = None if (two_keys and rng.random() < null_rate / 2) else rng.randint(1, 2)
                rows.append((k1, k2, rng.randint(-50, 99)))
            return table([("k1", INT), ("k2", INT), ("v", INT)], rows)
        tables = {"a": mk(rng.choice([0, 1, 3, 8, 15, 25]), rng.randint(1, 8), rng.choice([0, 0.1, 0.3])),
                  "b": mk(rng.choice([0, 1, 3, 8, 15, 25]), rng.randint(1, 8), rng.choice([0, 0.1, 0.3]))}
        keys = [("a.k1", "b.k1")] + ([("a.k2", "b.k2")] if two_keys else [])
        joins = [{"type": rng.choice(["INNER", "LEFT", "RIGHT", "FULL"]), "right": ("b", "b"), "keys": keys}]
        if three:
            tables["c"] = mk(rng.choice([0, 2, 6, 12]), rng.randint(1, 6), rng.choice([0, 0.2]))
            src = rng.choice(["a", "b"])
            # later RIGHT/FULL joins are fine for cardinality; the outer-WHERE check skips them
            joins.append({"type": rng.choice(["INNER", "LEFT", "RIGHT", "FULL"]), "right": ("c", "c"), "keys": [(f"{src}.k1", "c.k1")]})
        case = {"name": f"random_{i:03d}", "description": "seeded random case", "tables": tables, "base": ("a", "a"), "joins": joins}
        if rng.random() < 0.4:
            t = rng.randint(-10, 60)
            col = rng.choice(["a.v", "b.v"])
            case["where_sql"] = f"{col} > {t}"
            case["where_py"] = (lambda c, t: (lambda r: cmp(r[c], ">", t)))(col, t)
        cases.append(case)
    return cases


# ---------------------------------------------------------------- CTE handling for brute force

def materialise_ctes(case):
    """For cases with a filtered CTE: add the CTE as a concrete table for the brute-force engine."""
    for name, (src, pred) in case.get("cte_tables", {}).items():
        t = case["tables"][src]
        names = [c[0] for c in t["columns"]]
        case["tables"][name] = {"columns": t["columns"], "rows": [r for r in t["rows"] if truthy(pred(dict(zip(names, r))))], "cte": True}


INTEGER_TYPES = {"TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT"}


def mvp_eligible(case):
    """MVP scope (P-031): two named relations, one INNER/LEFT join, same-type integer keys, plain projection."""
    if len(case["joins"]) != 1 or case["joins"][0]["type"] not in ("INNER", "LEFT"):
        return False
    if case.get("with") or case.get("with_") or case.get("where_sql") or case.get("group") or case.get("limit") is not None:
        return False
    sel = case.get("select", "*")
    if sel != "*" and any(ch in sel for ch in "()"):
        return False
    types = {}
    for alias, name in [case["base"], case["joins"][0]["right"]]:
        for col, typ in case["tables"][name]["columns"]:
            types[f"{alias}.{col}"] = typ
    return all(types.get(l) in INTEGER_TYPES and types.get(l) == types.get(r) for l, r in case["joins"][0]["keys"])


def serialise(case):
    eligible = mvp_eligible(case)
    materialise_ctes(case)
    if case.get("with_"):
        case["with"] = case.pop("with_")
    res = run_plan(case)
    sql = render_sql(case)
    out = {
        "name": case["name"], "description": case["description"], "sql": sql,
        "tables": {k: v for k, v in case["tables"].items() if not v.get("cte")},
        "expectations": case.get("expectations", []),
        "fromPrefixes": from_prefixes(case) if not case.get("with") else [],
        "mvpEligible": eligible,
        "expected": {
            "status": "analyzed",
            "baseRows": res["baseRows"],
            "joins": [{"index": j["index"], "type": j["type"], "stats": j["stats"], "derived": j["derived"]} for j in res["joins"]],
            "joinCodes": [j["codes"] for j in res["joins"]],
            "afterWhere": res["afterWhere"], "final": res["final"], "outerRemoved": res["outerRemoved"], "metric": res["metric"],
            "mustInclude": case.get("must", []), "mustExclude": case.get("must_not", []),
        },
    }
    return json.loads(json.dumps(out, default=str))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--random", type=int, default=200)
    ap.add_argument("--seed", type=int, default=20261125)
    a = ap.parse_args()
    shared = {"a": table([("k", INT)], [(1,), (2,)]), "b": table([("k", INT)], [(1,), (3,)])}
    doc = {
        "generator": "scripts/make_analysis_fixtures.py", "seed": a.seed,
        "named": [serialise(c) for c in named_cases()],
        "random": [serialise(c) for c in random_cases(a.random, a.seed)],
        "unsupported": [{"name": n, "sql": s, "tables": shared} for n, s in UNSUPPORTED],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(doc['named'])} named, {len(doc['random'])} random, {len(doc['unsupported'])} unsupported cases")


if __name__ == "__main__":
    main()
