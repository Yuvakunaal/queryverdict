"""Independent brute-force oracle for Verdict (TESTING_STRATEGY §5.1; P-030).

Computes every reported join statistic by enumerating row pairs with nested loops and SQL NULL
semantics (a key tuple with any NULL component never matches; NULL never equals NULL). It does
NOT use the key-frequency formulas of src/core/verdict/stats.ts, so the two implementations check
each other. Python integers are exact at any size, so keys beyond 2^53 (and beyond 2^64) are exact.

Also derives, independently, the expected witnesses (ordering rules of the report contract), the
expected finding codes and the expected expectation outcomes. Standard library only.
"""
from __future__ import annotations

from typing import Optional, Sequence

Key = tuple


def key_of(row: Sequence[Optional[int]], idx: Sequence[int]) -> Key:
    return tuple(row[i] for i in idx)


def has_null(k: Key) -> bool:
    return any(v is None for v in k)


def relationship(left_unique: bool, right_unique: bool) -> str:
    return {(True, True): "one-to-one", (True, False): "one-to-many", (False, True): "many-to-one", (False, False): "many-to-many"}[(left_unique, right_unique)]


def brute_join(left: list, right: list, lidx: Sequence[int], ridx: Sequence[int], jtype: str) -> dict:
    """INNER or LEFT join by nested loops; returns statistics, derived values and witnesses."""
    assert jtype in ("INNER", "LEFT")
    lkeys = [key_of(r, lidx) for r in left]
    rkeys = [key_of(r, ridx) for r in right]
    # Pair enumeration: which right rows each left row matches (equality, NULL never matches).
    lmatch = [[j for j, rk in enumerate(rkeys) if not has_null(lk) and not has_null(rk) and lk == rk] for lk in lkeys]
    rcount = [0] * len(right)
    for ms in lmatch:
        for j in ms:
            rcount[j] += 1
    output = sum(len(ms) for ms in lmatch) + (sum(1 for ms in lmatch if not ms) if jtype == "LEFT" else 0)

    def multiset(keys):
        m: dict = {}
        for k in keys:
            if not has_null(k):
                m[k] = m.get(k, 0) + 1
        return m

    L, R = multiset(lkeys), multiset(rkeys)
    matched = [k for k in L if k in R]
    s = {
        "leftRows": len(left), "rightRows": len(right),
        "leftNullKeyRows": sum(1 for k in lkeys if has_null(k)), "rightNullKeyRows": sum(1 for k in rkeys if has_null(k)),
        "leftKeyedRows": sum(1 for k in lkeys if not has_null(k)), "rightKeyedRows": sum(1 for k in rkeys if not has_null(k)),
        "leftDistinctKeys": len(L), "rightDistinctKeys": len(R),
        "leftDuplicateKeys": sum(1 for c in L.values() if c > 1), "rightDuplicateKeys": sum(1 for c in R.values() if c > 1),
        "leftMaxMultiplicity": max(L.values(), default=0), "rightMaxMultiplicity": max(R.values(), default=0),
        "leftMaxMultiplicityMatched": max((L[k] for k in matched), default=0), "rightMaxMultiplicityMatched": max((R[k] for k in matched), default=0),
        "matchedKeys": len(matched),
        # The following come from the enumerated pairs, not from frequencies:
        "matchedPairs": sum(len(ms) for ms in lmatch),
        "leftRowsMatched": sum(1 for ms in lmatch if ms),
        "rightRowsMatched": sum(1 for c in rcount if c > 0),
        "leftRowsMultiplied": sum(1 for ms in lmatch if len(ms) > 1),
        "leftExcessCopies": sum(len(ms) - 1 for ms in lmatch if len(ms) > 1),
        "rightRowsMultiplied": sum(1 for c in rcount if c > 1),
        "rightExcessCopies": sum(c - 1 for c in rcount if c > 1),
    }
    lu = len(left) - s["leftRowsMatched"]
    ru = len(right) - s["rightRowsMatched"]
    d = {
        "outputRows": output, "leftUnmatchedRows": lu, "rightUnmatchedRows": ru,
        "leftRowsDropped": 0 if jtype == "LEFT" else lu, "rightRowsDropped": ru, "leftRowsPreserved": lu if jtype == "LEFT" else 0,
        "relationship": relationship(s["leftDuplicateKeys"] == 0, s["rightDuplicateKeys"] == 0),
        "matchedRelationship": "no-matches" if not matched else relationship(s["leftMaxMultiplicityMatched"] <= 1, s["rightMaxMultiplicityMatched"] <= 1),
    }
    # Output rows each witness key contributes, counted from the enumerated pairs.
    def out_rows(k):
        pairs = sum(len(ms) for i, ms in enumerate(lmatch) if lkeys[i] == k)
        preserved = sum(1 for i, ms in enumerate(lmatch) if lkeys[i] == k and not ms) if jtype == "LEFT" else 0
        return pairs + preserved

    fan = sorted((k for k in matched if L[k] > 1 or R[k] > 1), key=lambda k: (-(L[k] * R[k]), k))[:5]
    ul = sorted(k for k in L if k not in R)[:5]
    ur = sorted(k for k in R if k not in L)[:5]
    w = [{"kind": "fan-out", "key": [str(v) for v in k], "leftRows": str(L[k]), "rightRows": str(R[k]), "outputRows": str(out_rows(k))} for k in fan]
    w += [{"kind": "unmatched-left", "key": [str(v) for v in k], "leftRows": str(L[k]), "rightRows": "0", "outputRows": str(out_rows(k))} for k in ul]
    w += [{"kind": "unmatched-right", "key": [str(v) for v in k], "leftRows": "0", "rightRows": str(R[k]), "outputRows": "0"} for k in ur]
    return {"stats": s, "derived": d, "witnesses": w}


def finding_codes(s: dict, d: dict) -> list:
    """Expected observation and suspicious-pattern codes (report contract, findings.ts rules)."""
    codes = ["join-cardinality"]
    if s["leftExcessCopies"]:
        codes.append("left-rows-multiplied")
    if s["rightExcessCopies"]:
        codes.append("right-rows-multiplied")
    if d["leftRowsDropped"] or d["rightRowsDropped"]:
        codes.append("unmatched-rows-dropped")
    if d["leftRowsPreserved"]:
        codes.append("unmatched-left-rows-preserved")
    if s["leftNullKeyRows"] or s["rightNullKeyRows"]:
        codes.append("null-join-keys")
    if d["matchedRelationship"] == "many-to-many":
        codes.append("many-to-many-join")
    for side in ("left", "right"):
        if d[f"{side}RowsDropped"] and s[f"{side}ExcessCopies"]:
            codes.append("loss-and-fan-out")
    return codes


ALLOW = {
    "one-to-one": {"one-to-one"},
    "one-to-many": {"one-to-one", "one-to-many"},
    "many-to-one": {"one-to-one", "many-to-one"},
    "many-to-many": {"one-to-one", "one-to-many", "many-to-one", "many-to-many"},
}


def valid_expectation(e) -> bool:
    if not isinstance(e, dict):
        return False
    k = e.get("kind")
    fields = {"relationship": {"kind", "join", "expected"}, "no-row-loss": {"kind", "join", "side"}, "no-fan-out": {"kind", "join", "side"}, "row-count": {"kind", "min", "max"}}
    if k not in fields or not set(e) <= fields[k]:
        return False
    if k == "relationship":
        return e.get("join") == 0 and type(e.get("join")) is int and e.get("expected") in ALLOW
    if k in ("no-row-loss", "no-fan-out"):
        return e.get("join") == 0 and type(e.get("join")) is int and e.get("side") in ("left", "right")
    ok = lambda v: v is None or (type(v) is int and 0 <= v <= 2 ** 53 - 1)
    mn, mx = e.get("min"), e.get("max")
    return ok(mn) and ok(mx) and (mn is not None or mx is not None) and (mn is None or mx is None or mn <= mx)


def expectation_outcome(e, jtype: str, s: dict, d: dict) -> str:
    if not valid_expectation(e):
        return "unchecked"
    k = e["kind"]
    if k == "relationship":
        return "held" if d["relationship"] in ALLOW[e["expected"]] else "violated"
    if k == "no-row-loss":
        return "violated" if d[f"{e['side']}RowsDropped"] > 0 else "held"
    if k == "no-fan-out":
        return "violated" if s[f"{e['side']}ExcessCopies"] > 0 else "held"
    n = d["outputRows"]
    ok = (e.get("min") is None or n >= e["min"]) and (e.get("max") is None or n <= e["max"])
    return "held" if ok else "violated"
