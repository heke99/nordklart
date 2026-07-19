#!/usr/bin/env bash
# Bootstrap a database for the pg-real test suite (T02).
#
# Builds the schema from EVERY migration in supabase/migrations/ against the
# database in $DATABASE_URL (default: postgresql://postgres:postgres@localhost:5432/postgres).
#
# Works against BOTH:
#   * supabase/postgres images (auth schema + extensions preinstalled) — the
#     CI path (.github/workflows/test-pg-real.yml),
#   * plain PostgreSQL 15/16 (apt/brew) with the pgvector + pg_cron packages —
#     tests/pg/bootstrap-plain-postgres.sql emulates the Supabase auth schema,
#     roles and realtime publication.
#
# Usage:
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     npm run test:pg:bootstrap
#   npm run test:pg
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
cd "$(dirname "$0")/.."

echo "==> Bootstrapping pg-real test database: ${DATABASE_URL%%@*}@…"

# Detect plain Postgres (no auth schema) and apply the compatibility bootstrap.
HAS_AUTH=$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM pg_namespace WHERE nspname = 'auth'")
if [ "$HAS_AUTH" = "0" ]; then
  echo "==> Plain PostgreSQL detected — applying tests/pg/bootstrap-plain-postgres.sql"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f tests/pg/bootstrap-plain-postgres.sql
fi

echo "==> Applying tests/pg/bootstrap.sql (storage schema stubs)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f tests/pg/bootstrap.sql

echo "==> Applying all migrations from supabase/migrations/"
shopt -s nullglob
files=(supabase/migrations/*.sql)
if [ ${#files[@]} -eq 0 ]; then
  echo "No migration files found" >&2
  exit 1
fi
for f in "${files[@]}"; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null || {
    echo "FAILED: $f" >&2
    exit 1
  }
done

echo "==> All $(printf '%s\n' "${files[@]}" | wc -l | tr -d ' ') migrations applied."
echo "==> Run the suite with: DATABASE_URL=$DATABASE_URL npm run test:pg"
