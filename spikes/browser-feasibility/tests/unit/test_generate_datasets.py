"""Unit tests for the synthetic dataset generator. Run: python3 -m unittest discover -s tests/unit -p 'test_*.py'"""
import csv
import json
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "generate_datasets.py"


def run(out: Path, *extra: str) -> dict:
    subprocess.run([sys.executable, str(SCRIPT), "--size", "tiny", "--out", str(out), *extra],
                   check=True, capture_output=True)
    return json.loads((out / "manifest.json").read_text())


class GeneratorTest(unittest.TestCase):
    def test_same_seed_is_byte_identical(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            ma = run(Path(a), "--formats", "csv,json")
            mb = run(Path(b), "--formats", "csv,json")
            for name in ("orders.csv", "customers.csv", "orders.ndjson"):
                self.assertEqual(ma["files"][name]["sha256"], mb["files"][name]["sha256"], name)

    def test_different_seed_differs(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            ma = run(Path(a), "--formats", "csv")
            mb = run(Path(b), "--formats", "csv", "--seed", "7")
            self.assertNotEqual(ma["files"]["orders.csv"]["sha256"], mb["files"]["orders.csv"]["sha256"])

    def test_expected_answers_match_a_direct_recount(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            m = run(out, "--formats", "csv")
            e = m["expected"]
            with open(out / "customers.csv") as f:
                cust = Counter(int(r["customer_id"]) for r in csv.DictReader(f))
            inner = left = unmatched = cents_sum = shipped = 0
            with open(out / "orders.csv") as f:
                rows = list(csv.DictReader(f))
            for r in rows:
                n = cust.get(int(r["customer_id"]), 0)
                inner += n
                left += max(1, n)
                unmatched += n == 0
                whole, frac = r["amount"].split(".")
                cents_sum += int(whole) * 100 + int(frac)
                shipped += r["status"] == "shipped"
            self.assertEqual(e["orders_rows"], len(rows))
            self.assertEqual(e["inner_join_rows"], inner)
            self.assertEqual(e["left_join_rows"], left)
            self.assertEqual(e["orders_unmatched_rows"], unmatched)
            self.assertEqual(e["orders_amount_cents_sum"], cents_sum)
            self.assertEqual(e["orders_shipped_rows"], shipped)
            self.assertEqual(e["customers_rows"], sum(cust.values()))
            self.assertEqual(e["customers_duplicated_keys"], sum(1 for v in cust.values() if v > 1))
            # The fixture must actually exercise fan-out and row loss.
            self.assertGreater(e["customers_duplicated_keys"], 0)
            self.assertGreater(e["orders_unmatched_rows"], 0)
            self.assertGreater(e["inner_join_rows"], e["orders_rows"] - e["orders_unmatched_rows"])

    def test_large_sizes_require_confirmation(self):
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, str(SCRIPT), "--size", "500MB", "--out", d],
                               capture_output=True, text=True)
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("--confirm-large", p.stderr)

    def test_parquet_round_trip_when_pyarrow_available(self):
        try:
            import pyarrow.parquet as pq
        except ImportError:
            self.skipTest("pyarrow not installed")
        with tempfile.TemporaryDirectory() as d:
            m = run(Path(d), "--formats", "csv,parquet")
            self.assertEqual(pq.ParquetFile(Path(d) / "orders.parquet").metadata.num_rows, m["expected"]["orders_rows"])
            self.assertEqual(pq.ParquetFile(Path(d) / "customers.parquet").metadata.num_rows,
                             m["expected"]["customers_rows"])


if __name__ == "__main__":
    unittest.main()
