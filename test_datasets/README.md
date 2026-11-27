# Verdict test datasets

Three small, linked CSV files (30 rows each) for trying the Visual Verdict by hand. They are synthetic. Every expected number below was computed by brute force from the CSV rows, independently of QueryVerdict.

| File | Rows | What is built in |
|---|---|---|
| `customers.csv` | 30 | `customer_id` 101–127; keys **102, 105 and 118 appear twice** (duplicate keys). `customer_code` is text (`C101`). `account_no` is BIGINT **above 2^53** (9007199254740993…). |
| `orders.csv` | 30 | `order_id` 7001–7030 (unique). Customer 101 has 3 orders, 103 has 2. **2 orders have no customer_id** (NULL). Orders 7028/7029 point to customers **140 and 141, who do not exist**. |
| `payments.csv` | 30 | Keyed by (`order_id`, `customer_id`). **Split payments**: 7001 paid twice, 7008 three times. Orders 7003 and 7015 have **no payment**. Payment for unknown order **7099**. One payment with a **NULL** `customer_id`. One payment (7025, customer 123) whose customer **does not match** the order. |

## How to load

1. Open the workspace and choose **+ Import**.
2. Select all three files. They import as tables `customers`, `orders` and `payments`.
3. Paste a query from below into the editor (one query in the editor at a time: Analyze reads the whole editor).
4. Choose **Analyze** (Cmd/Ctrl+Shift+Enter). Optionally choose **Run SQL** too, to compare the actual rows.

## Scenarios

Counts: L = left table, R = right table. "Kept" means unmatched LEFT JOIN rows kept with empty right columns.

| # | Query | What it exercises | Expected numbers |
|---|---|---|---|
| 1 | `SELECT * FROM orders o JOIN orders o2 ON o.order_id = o2.order_id` | **Clean** one-to-one join | 30 × 30 → **30** rows; every row matched once; no loss, no fan-out; "No issues found in these checks" |
| 2 | `SELECT * FROM orders o LEFT JOIN payments p ON o.order_id = p.order_id` | **One-to-many** expansion (split payments), LEFT **kept** rows | 30 orders → **33** rows; 29 matched pairs; 2 orders duplicated (+3 copies, keys 7001 and 7008); **4 orders kept** (7003, 7015, 7026, 7027: no payment row); 1 payment dropped (7099) |
| 3 | `SELECT * FROM orders o JOIN customers c ON o.customer_id = c.customer_id` | **Fan-out + loss together**, NULL keys, unmatched keys on both sides, **many-to-many** | 30 × 30 → **29** rows; 29 matched pairs; orders: 26 matched, **4 dropped** (2 NULL keys + 140, 141), 3 duplicated (+3 copies); customers: 26 matched, **4 dropped**, 2 duplicated (+3 copies); 2 orders key groups and 3 customers key groups duplicated |
| 4 | `SELECT * FROM orders o LEFT JOIN customers c ON o.customer_id = c.customer_id` | Same join as LEFT: **loss becomes "kept"** | **33** rows; 29 matched pairs; **4 orders kept** (not dropped), 0 orders dropped; 4 customers dropped |
| 5 | `SELECT * FROM orders o JOIN payments p ON o.order_id = p.order_id AND o.customer_id = p.customer_id` | **Composite key** (2 columns), NULL key component, mismatched pair | **27** rows; orders: 24 matched, **6 dropped**, 2 duplicated (+3 copies); payments: 27 matched, **3 dropped** (7099, the NULL one, 7025/123) |
| 6 | `SELECT * FROM orders o JOIN payments p ON o.customer_id = p.customer_id` | **Wrong key** (customer instead of order): heavy many-to-many | **38** rows from 30 × 30; orders: 6 duplicated (+13 copies), 5 dropped; payments: 6 duplicated (+10 copies), 2 dropped |
| 7 | `SELECT * FROM customers c JOIN payments p ON c.account_no = p.account_no` | **Integers above 2^53** must appear exactly (9007199254740994, not …992) | **32** rows; customers: 24 matched, 6 dropped, 4 duplicated (+8 copies); payments: 27 matched, 3 dropped (1 NULL key) |

### Expectations to try (Verdict tab → Add an expectation)

| Query | Rule | Expected outcome |
|---|---|---|
| 3 | No fan-out · Left input | **Violated** (3 orders rows appear more than once) |
| 3 | No row loss · Left input | **Violated** (4 orders rows dropped) |
| 4 | No row loss · Left input | **Held** (LEFT JOIN keeps every order) |
| 2 | Relationship · One-to-many | **Held** (order_id unique in orders) |
| 3 | Relationship · One-to-one | **Violated** (duplicates on both sides) |
| 1 | Output row count · min 30, max 30 | **Held** (inclusive bounds) |
| 1 | Output row count · min 31 | **Violated** |

Then edit the SQL, the rules or the data (for example `INSERT INTO orders VALUES (7031, 101, '2026-11-30', 1.00, 1)`): the report must turn **Historical**.

### Unsupported and failing queries (Verdict should explain, not measure)

| Query | Expected answer |
|---|---|
| `SELECT loyalty_tier, count(*) FROM customers GROUP BY loyalty_tier` | No join to analyze (single table) |
| `SELECT c.region, count(*) FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.region` | Aggregation: analyze the join underneath first |
| `SELECT * FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE c.region = 'North'` | WHERE filter: analyze the join without it |
| `SELECT * FROM customers c JOIN orders o ON c.customer_code = o.customer_id` | Join keys have different types (text vs integer) |
| `SELECT * FROM customers a JOIN customers b ON a.region = b.region` | Join key is text; only integer keys are analyzed |
| `SELECT * FROM orders o RIGHT JOIN customers c ON o.customer_id = c.customer_id` | RIGHT JOIN not analyzed: swap and use LEFT JOIN |
| `SELECT * FROM orders o JOIN customers c ON o.customer_id = c.customer_id JOIN payments p ON p.order_id = o.order_id` | More than one join |
| `SELECT * FROM orders o JOIN customers c ON o.customer_idx = c.customer_id` | Cannot read the query (binding error) |
| `SELEC * FROM orders` | Cannot read the query (syntax error) |
