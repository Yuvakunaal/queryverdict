"""Pins the brute-force oracle (scripts/make_analysis_fixtures.py) to hand-computed answers."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("fx", Path(__file__).resolve().parents[2] / "scripts" / "make_analysis_fixtures.py")
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)


def rows(alias, ks):
    return [{f"{alias}.k": k} for k in ks], [f"{alias}.k"]


class OracleTest(unittest.TestCase):
    def join(self, lk, rk, t):
        l, lc = rows("a", lk)
        r, rc = rows("b", rk)
        return fx.brute_join(l, lc, r, rc, [("a.k", "b.k")], t)

    def test_worked_example(self):
        for t, n in (("INNER", 4), ("LEFT", 5), ("RIGHT", 5), ("FULL", 6)):
            out, _, s, d = self.join(["A", "A", "B"], ["A", "A", "C"], t)
            self.assertEqual(len(out), n, t)
            self.assertEqual(s["leftExcessCopies"], 2)
            self.assertEqual(d["relationship"], "many-to-many")

    def test_null_never_matches(self):
        out, _, s, d = self.join([None, None, 1], [None, 1], "INNER")
        self.assertEqual(len(out), 1)
        self.assertEqual((s["leftNullKeyRows"], s["rightNullKeyRows"]), (2, 1))
        out, _, _, _ = self.join([None, None], [None], "FULL")
        self.assertEqual(len(out), 3)

    def test_empty(self):
        for t, n in (("INNER", 0), ("LEFT", 2), ("RIGHT", 0), ("FULL", 2)):
            out, _, _, _ = self.join([1, 1], [], t)
            self.assertEqual(len(out), n, t)

    def test_three_valued_where(self):
        self.assertIsNone(fx.cmp(None, ">", 1))
        self.assertFalse(fx.truthy(None))


if __name__ == "__main__":
    unittest.main()
