// A representative bounded SQL document: 1,000 lines of join queries with comments, strings and numbers.
export function sampleSql(lines = 1000): string {
  const out: string[] = [];
  for (let i = 0; out.length < lines; i++) {
    out.push(`-- query ${i}: orders joined to customers`, `SELECT o.order_id, o.customer_id, c.region, 'note ${i}' AS label, ${i * 7} AS n`, 'FROM orders AS o', 'INNER JOIN customers AS c', `  ON o.customer_id = c.customer_id WHERE o.amount > ${i}.5;`);
  }
  return out.slice(0, lines).join('\n');
}
export const t0 = performance.now();
export function ready(extra: Record<string, unknown>) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    (window as unknown as { __e9: unknown }).__e9 = { moduleStart: t0, ready: performance.now(), ...extra };
  }));
}
