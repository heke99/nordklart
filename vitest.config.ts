import { defineConfig } from 'vitest/config'
import path from 'path'

const alias = { '@': path.resolve(__dirname, '.') }

const unitProject = {
  resolve: { alias },
  test: {
    name: 'unit',
    globals: true,
    environment: 'node' as const,
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.pg.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
  },
}

const pgRealProject = {
  resolve: { alias },
  test: {
    name: 'pg-real',
    globals: true,
    environment: 'node' as const,
    include: ['**/*.pg.test.ts'],
    exclude: ['**/node_modules/**'],
    setupFiles: ['tests/pg/setup.ts'],
    // One-connection-at-a-time to avoid cross-file DB contention.
    fileParallelism: false,
    testTimeout: 15000,
  },
}

// The pg-real project is ALWAYS registered so `npm run test:pg` is a real,
// working entry point (T02) — `vitest run --project pg-real` previously
// failed with "project not found" when DATABASE_URL was unset. The suite
// connects to DATABASE_URL (default postgresql://postgres:postgres@localhost:5432/postgres)
// and fails loudly via the schema sanity check in tests/pg/setup.ts when the
// database is missing or migrations have not been applied. Bootstrap a local
// database with scripts/pg-test-db.sh. A bare `vitest run` still only runs
// the unit project unless DATABASE_URL is exported.
const projects =
  process.env.DATABASE_URL || process.env.VITEST_PG_REAL
    ? [unitProject, pgRealProject]
    : [unitProject]

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    environment: 'node',
    projects,
  },
})
