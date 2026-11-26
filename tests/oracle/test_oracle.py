"""Pins the brute-force oracle to hand-computed answers (python3 -m unittest discover -s tests/oracle)."""
import unittest

from oracle import brute_join, expectation_outcome, finding_codes, valid_expectation


def rows(*keys):
    return [(k,) for k in keys]


class OracleTest(unittest.TestCase):
    def join(self, lk, rk, t):
        return brute_join(rows(*lk), rows(*rk), [0], [0], t)

    def test_worked_example(self):
        # left A,A,B ; right A,A,C (A=1, B=2, C=3)
        i = self.join([1, 1, 2], [1, 1, 3], "INNER")
        l = self.join([1, 1, 2], [1, 1, 3], "LEFT")
        self.assertEqual((i["derived"]["outputRows"], l["derived"]["outputRows"]), (4, 5))
        self.assertEqual(i["stats"]["leftExcessCopies"], 2)
        self.assertEqual(i["derived"]["relationship"], "many-to-many")
        self.assertEqual((l["derived"]["leftRowsDropped"], l["derived"]["leftRowsPreserved"], l["derived"]["rightRowsDropped"]), (0, 1, 1))

    def test_qv_sa_001_shape(self):
        r = self.join([1, 1, 1], [1, 1, 1, 1], "INNER")
        self.assertEqual(r["derived"]["outputRows"], 12)
        self.assertEqual(r["witnesses"], [{"kind": "fan-out", "key": ["1"], "leftRows": "3", "rightRows": "4", "outputRows": "12"}])

    def test_null_never_matches(self):
        r = self.join([None, None, 1], [None, 1], "INNER")
        self.assertEqual(r["derived"]["outputRows"], 1)
        self.assertEqual((r["stats"]["leftNullKeyRows"], r["stats"]["rightNullKeyRows"]), (2, 1))
        r = brute_join([(1, None), (1, 2)], [(1, None), (1, 2)], [0, 1], [0, 1], "LEFT")
        self.assertEqual((r["derived"]["outputRows"], r["stats"]["matchedPairs"], r["stats"]["leftNullKeyRows"]), (2, 1, 1))

    def test_empty_sides(self):
        self.assertEqual(self.join([1, 1], [], "LEFT")["derived"]["outputRows"], 2)
        self.assertEqual(self.join([1, 1], [], "INNER")["derived"]["outputRows"], 0)
        self.assertEqual(self.join([], [1], "LEFT")["derived"]["matchedRelationship"], "no-matches")

    def test_exact_beyond_2_53(self):
        a, b = 9007199254740992, 9007199254740993  # equal as doubles, different integers
        r = self.join([a, b], [b], "INNER")
        self.assertEqual((r["stats"]["matchedPairs"], r["stats"]["leftDistinctKeys"]), (1, 2))
        self.assertEqual(r["witnesses"][0], {"kind": "unmatched-left", "key": [str(a)], "leftRows": "1", "rightRows": "0", "outputRows": "0"})

    def test_witness_order_and_limit(self):
        r = self.join([1, 1, 2, 2, 2, 3, 4, 5, 6, 7, 8, 9], [1, 1, 2, 3, 3, 3], "INNER")
        self.assertEqual([w["key"] for w in r["witnesses"] if w["kind"] == "fan-out"], [["1"], ["2"], ["3"]])  # L·R: 1→2·2=4, 2→3·1=3, 3→1·3=3; ties broken by key
        self.assertEqual([w["key"] for w in r["witnesses"] if w["kind"] == "unmatched-left"], [["4"], ["5"], ["6"], ["7"], ["8"]])

    def test_codes_and_expectations(self):
        r = self.join([1, 2], [1, 1], "INNER")  # offsetting: one row doubled, one lost
        self.assertEqual(finding_codes(r["stats"], r["derived"]), ["join-cardinality", "left-rows-multiplied", "unmatched-rows-dropped", "loss-and-fan-out"])
        self.assertEqual(expectation_outcome({"kind": "row-count", "min": 2, "max": 2}, "INNER", r["stats"], r["derived"]), "held")
        self.assertEqual(expectation_outcome({"kind": "no-fan-out", "join": 0, "side": "left"}, "INNER", r["stats"], r["derived"]), "violated")
        self.assertEqual(expectation_outcome({"kind": "relationship", "join": 0, "expected": "one-to-many"}, "INNER", r["stats"], r["derived"]), "held")
        self.assertFalse(valid_expectation({"kind": "row-count", "min": True}))
        self.assertFalse(valid_expectation({"kind": "no-fan-out", "join": 0}))
        self.assertEqual(expectation_outcome({"kind": "grain"}, "INNER", r["stats"], r["derived"]), "unchecked")


if __name__ == "__main__":
    unittest.main()
