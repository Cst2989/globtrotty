#!/usr/bin/env bash
# scripts/ci-migrate.sh — apply bootstrap + every migration in name order to $DATABASE_URL.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/ci-bootstrap.sql
for f in $(ls supabase/migrations/*.sql | sort); do
  echo "applying $f"; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
