import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __DUCKDB_WASM_VERSION__: JSON.stringify('test') },
  test: { include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.mjs'], environment: 'node' },
});
