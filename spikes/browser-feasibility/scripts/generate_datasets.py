#!/usr/bin/env python3
"""Seeded synthetic dataset generator for the QueryVerdict browser-feasibility spike.

Writes an `orders` fact table and a `customers` dimension table with a controlled
join fan-out (some customer keys are duplicated) and controlled orphans (some
orders reference customer keys that do not exist). Expected answers for the
benchmark workloads are computed exactly while generating and written to a
manifest, so the browser results can be checked against known values.

Output goes to spikes/browser-feasibility/data/<size>/ which is git-ignored.

Usage:
  python3 scripts/generate_datasets.py --size 50MB
  python3 scripts/generate_datasets.py --size 500MB --confirm-large
  python3 scripts/generate_datasets.py --size 50MB --formats csv,parquet,json

Sizes are decimal megabytes (1 MB = 1,000,000 bytes) of the orders CSV file.
Parquet conversion needs pyarrow; CSV and NDJSON use the standard library only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

GENERATOR_VERSION = "1"
ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = ROOT / "data"
SIZES = {"tiny": 200_000, "50MB": 50_000_000, "200MB": 200_000_000, "500MB": 500_000_000, "1GB": 1_000_000_000}
LARGE_THRESHOLD = 500_000_000
STATUSES = ["placed", "paid", "shipped", "delivered", "returned"]
REGIONS = ["AMER", "EMEA", "APAC", "LATAM"]
SEGMENTS = ["consumer", "smb", "enterprise"]
WORDS = ["alpha", "bravo", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kelp", "lumen"]
BASE_TS = datetime(2026, 1, 1, tzinfo=timezone.utc)

# Fan-out control: a customer key k is duplicated DUP_COPIES times when
# (k * 2654435761) % 1000 < dup_permille. Deterministic, independent of the RNG.
DUP_COPIES = 3


def copies_for(key: int, dup_permille: int) -> int:
    return DUP_COPIES if (key * 2654435761) % 1000 < dup_permille else 1


def check_disk(target_bytes: int, out_dir: Path) -> None:
    free = shutil.disk_usage(out_dir if out_dir.exists() else ROOT).free
    needed = 3 * target_bytes + 2_000_000_000
    if free < needed:
        sys.exit(f"Refusing to generate: {free/1e9:.1f} GB free, need at least {needed/1e9:.1f} GB "
                 "(3x target + 2 GB headroom for swap).")


class HashingWriter:
    """Text writer that tracks bytes and SHA-256 of what it writes."""

    def __init__(self, path: Path):
        self.f = open(path, "w", encoding="utf-8", newline="")
        self.h = hashlib.sha256()
        self.bytes = 0

    def write(self, s: str) -> None:
        b = s.encode("utf-8")
        self.h.update(b)
        self.bytes += len(b)
        self.f.write(s)

    def close(self) -> str:
        self.f.close()
        return self.h.hexdigest()


def generate(size_label: str, seed: int, formats: list[str], dup_permille: int, orphan_permille: int,
             out_dir: Path) -> dict:
    target = SIZES[size_label]
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    t0 = time.time()

    # Estimate the customer key space from the target size (~95 bytes per order row).
    est_orders = max(1000, target // 95)
    n_customers = max(100, est_orders // 20)
    # Order customer_ids are drawn from 1..max_key; keys above n_customers are orphans.
    max_key = n_customers + (n_customers * orphan_permille) // 1000

    want_json = "json" in formats
    orders_csv = HashingWriter(out_dir / "orders.csv")
    orders_csv.write("order_id,customer_id,order_ts,status,region,quantity,amount,note\n")
    orders_json = HashingWriter(out_dir / "orders.ndjson") if want_json else None

    expected = {
        "orders_rows": 0, "orders_amount_cents_sum": 0, "orders_shipped_rows": 0,
        "orders_amount_over_900_rows": 0, "orders_unmatched_rows": 0,
        "inner_join_rows": 0, "left_join_rows": 0, "inner_join_amount_cents_sum": 0,
        "region_rows": {r: 0 for r in REGIONS},
    }
    order_id = 0
    while orders_csv.bytes < target:
        order_id += 1
        cid = rng.randint(1, max_key)
        ts = (BASE_TS + timedelta(seconds=rng.randrange(0, 365 * 86400))).strftime("%Y-%m-%d %H:%M:%S")
        status = STATUSES[rng.randrange(len(STATUSES))]
        region = REGIONS[rng.randrange(len(REGIONS))]
        qty = rng.randint(1, 9)
        cents = rng.randint(100, 99_999)
        note = f"{WORDS[rng.randrange(12)]}-{WORDS[rng.randrange(12)]}-{rng.randrange(100000):05d}"
        amount = f"{cents // 100}.{cents % 100:02d}"
        orders_csv.write(f"{order_id},{cid},{ts},{status},{region},{qty},{amount},{note}\n")
        if orders_json:
            orders_json.write(json.dumps({"order_id": order_id, "customer_id": cid, "order_ts": ts, "status": status,
                                          "region": region, "quantity": qty, "amount": float(amount), "note": note},
                                         separators=(",", ":")) + "\n")
        e = expected
        e["orders_rows"] += 1
        e["orders_amount_cents_sum"] += cents
        e["region_rows"][region] += 1
        if status == "shipped":
            e["orders_shipped_rows"] += 1
        if cents > 90_000:
            e["orders_amount_over_900_rows"] += 1
        if cid > n_customers:
            e["orders_unmatched_rows"] += 1
            e["left_join_rows"] += 1
        else:
            m = copies_for(cid, dup_permille)
            e["inner_join_rows"] += m
            e["left_join_rows"] += m
            e["inner_join_amount_cents_sum"] += m * cents

    files = {"orders.csv": {"bytes": orders_csv.bytes, "sha256": orders_csv.close()}}
    if orders_json:
        files["orders.ndjson"] = {"bytes": orders_json.bytes, "sha256": orders_json.close()}

    cust_csv = HashingWriter(out_dir / "customers.csv")
    cust_csv.write("customer_id,name,segment,country,signup_date\n")
    customers_rows = 0
    duplicated_keys = 0
    for k in range(1, n_customers + 1):
        m = copies_for(k, dup_permille)
        if m > 1:
            duplicated_keys += 1
        for copy in range(m):
            customers_rows += 1
            seg = SEGMENTS[rng.randrange(3)]
            day = (BASE_TS - timedelta(days=rng.randrange(0, 2000))).strftime("%Y-%m-%d")
            cust_csv.write(f"{k},customer-{k}-{copy},{seg},C{rng.randrange(50):02d},{day}\n")
    files["customers.csv"] = {"bytes": cust_csv.bytes, "sha256": cust_csv.close()}

    expected.update({
        "customers_rows": customers_rows,
        "customers_distinct_keys": n_customers,
        "customers_duplicated_keys": duplicated_keys,
        "customers_excess_rows": customers_rows - n_customers,
    })

    if "parquet" in formats:
        files.update(to_parquet(out_dir))

    manifest = {
        "generator": "scripts/generate_datasets.py",
        "generator_version": GENERATOR_VERSION,
        "size_label": size_label,
        "target_orders_csv_bytes": target,
        "seed": seed,
        "params": {"dup_permille": dup_permille, "dup_copies": DUP_COPIES, "orphan_permille": orphan_permille,
                   "n_customer_keys": n_customers, "max_order_customer_key": max_key},
        "schema": {
            "orders": "order_id BIGINT, customer_id BIGINT, order_ts TIMESTAMP, status VARCHAR, region VARCHAR, "
                      "quantity INTEGER, amount DECIMAL(7,2) (CSV text; NDJSON as JSON number), note VARCHAR",
            "customers": "customer_id BIGINT, name VARCHAR, segment VARCHAR, country VARCHAR, signup_date DATE",
        },
        "files": files,
        "expected": expected,
        "generation_seconds": round(time.time() - t0, 1),
        "python": sys.version.split()[0],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def to_parquet(out_dir: Path) -> dict:
    """Stream-convert the CSV files to Parquet with explicit types (no full in-memory load)."""
    try:
        import pyarrow as pa
        import pyarrow.csv as pacsv
        import pyarrow.parquet as pq
    except ImportError:
        sys.exit("Parquet output needs pyarrow (pip install pyarrow), or use --formats csv,json")
    schemas = {
        "orders": {"order_id": pa.int64(), "customer_id": pa.int64(), "order_ts": pa.timestamp("s"),
                   "status": pa.string(), "region": pa.string(), "quantity": pa.int32(),
                   "amount": pa.decimal128(7, 2), "note": pa.string()},
        "customers": {"customer_id": pa.int64(), "name": pa.string(), "segment": pa.string(),
                      "country": pa.string(), "signup_date": pa.date32()},
    }
    result = {}
    for name, cols in schemas.items():
        src, dst = out_dir / f"{name}.csv", out_dir / f"{name}.parquet"
        reader = pacsv.open_csv(src, read_options=pacsv.ReadOptions(block_size=16 << 20),
                                convert_options=pacsv.ConvertOptions(column_types=cols))
        writer = None
        for batch in reader:
            if writer is None:
                writer = pq.ParquetWriter(dst, batch.schema, compression="snappy")
            writer.write_batch(batch, row_group_size=1_000_000)
        writer.close()
        h = hashlib.sha256()
        with open(dst, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        result[f"{name}.parquet"] = {"bytes": dst.stat().st_size, "sha256": h.hexdigest(),
                                     "compression": "snappy", "pyarrow": pa.__version__}
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--size", required=True, choices=list(SIZES))
    ap.add_argument("--seed", type=int, default=20261125)
    ap.add_argument("--formats", default="csv,parquet", help="comma list of csv,parquet,json (csv always written)")
    ap.add_argument("--dup-permille", type=int, default=10, help="per-mille of customer keys duplicated (fan-out)")
    ap.add_argument("--orphan-permille", type=int, default=20, help="extra key space with no customer (row loss)")
    ap.add_argument("--confirm-large", action="store_true", help="required for sizes >= 500MB")
    ap.add_argument("--out", type=Path, help="output directory (default data/<size>)")
    a = ap.parse_args()

    target = SIZES[a.size]
    if target >= LARGE_THRESHOLD and not a.confirm_large:
        sys.exit(f"{a.size} needs --confirm-large (see README safety rules).")
    out_dir = a.out or DATA_ROOT / a.size
    check_disk(target, out_dir)
    formats = [f.strip() for f in a.formats.split(",") if f.strip()]
    m = generate(a.size, a.seed, formats, a.dup_permille, a.orphan_permille, out_dir)
    print(json.dumps({"out": str(out_dir), "files": m["files"], "expected": m["expected"],
                      "seconds": m["generation_seconds"]}, indent=2))


if __name__ == "__main__":
    main()
