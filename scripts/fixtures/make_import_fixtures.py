#!/usr/bin/env python3
"""Deterministic import fixtures with independent expected values (docs/TESTING_STRATEGY.md §5.2).

Writes small synthetic CSV and Parquet files to tests/fixtures/import/ and expected.json, which
records the values each file must yield after import, derived here from the Python data, never
from DuckDB. Re-running must produce byte-identical output (checked by tests). Standard library
plus pyarrow (Parquet only).
"""
import json
import os
from decimal import Decimal

import pyarrow as pa
import pyarrow.parquet as pq

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'tests', 'fixtures', 'import')


def write(name, data):
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(data.encode('utf-8') if isinstance(data, str) else data)


def main():
    os.makedirs(OUT, exist_ok=True)
    expected = {}

    # people.csv: quoted commas, escaped quotes, quoted empty strings vs empty fields, an
    # apostrophe, an embedded newline inside quotes, and decimals.
    write('people.csv', (
        'id,name,city,note\n'
        '1,Ann,"Paris, FR","She said ""hi"""\n'
        '2,"",Berlin,\n'
        '3,,"",plain\n'
        "4,O'Neil,Rome,\"two\nlines\"\n"
    ))
    # Policy (P-047): "" is an empty string, an empty unquoted field is NULL.
    expected['people.csv'] = {
        'columns': ['id', 'name', 'city', 'note'],
        'rows': [
            ['1', 'Ann', 'Paris, FR', 'She said "hi"'],
            ['2', '', 'Berlin', None],
            ['3', None, '', 'plain'],
            ['4', "O'Neil", 'Rome', 'two\nlines'],
        ],
    }

    # bigints.csv: integers at and beyond 2^53 and at the 64-bit limits.
    big = [9007199254740993, -9223372036854775808, 9223372036854775807]
    write('bigints.csv', 'k\n' + ''.join(f'{v}\n' for v in big))
    expected['bigints.csv'] = {'columns': ['k'], 'rows': [[str(v)] for v in big]}

    write('header_only.csv', 'a,b\n')
    expected['header_only.csv'] = {'columns': ['a', 'b'], 'rows': []}

    write('malformed_quote.csv', 'a,b\n1,"unterminated\n2,3\n')
    write('ragged.csv', 'a,b\n1,2\n3,4,5\n')
    write('empty.csv', '')
    write('not_parquet.parquet', 'this is not a parquet file\n')

    # people.parquet: typed columns, including exact DECIMAL and BIGINT beyond 2^53, NULLs and ''.
    table = pa.table({
        'id': pa.array([1, 2, 3], type=pa.int64()),
        'name': pa.array(['Ann', '', None], type=pa.string()),
        'amount': pa.array([Decimal('12345678901234567.89'), Decimal('0.00'), None], type=pa.decimal128(20, 2)),
        'big': pa.array([9007199254740993, -9223372036854775808, None], type=pa.int64()),
    })
    pq.write_table(table, os.path.join(OUT, 'people.parquet'), compression='snappy', write_statistics=True, use_dictionary=False)
    expected['people.parquet'] = {
        'columns': ['id', 'name', 'amount', 'big'],
        'types': ['BIGINT', 'VARCHAR', 'DECIMAL(20,2)', 'BIGINT'],
        'rows': [
            ['1', 'Ann', '12345678901234567.89', '9007199254740993'],
            ['2', '', '0.00', '-9223372036854775808'],
            ['3', None, None, None],
        ],
    }

    with open(os.path.join(OUT, 'expected.json'), 'w', encoding='utf-8') as f:
        json.dump(expected, f, indent=2, sort_keys=True)
        f.write('\n')


if __name__ == '__main__':
    main()
