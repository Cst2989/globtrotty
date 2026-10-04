#!/usr/bin/env bash
#
# Trip-stage pass, section 6: the browser harness's own runner.
#
# Starts `next dev` on port 3100 with `.env.local` loaded, waits for /login to answer 200, runs
# test/e2e/trip.e2e.mjs against it, and stops the server however the run ends.
#
# LOCAL ONLY. The harness signs a throwaway user in with the service-role key and deletes it in
# a `finally`; pointing it at anything but a local dev server is out of scope and the port is
# fixed here rather than taken from the environment for exactly that reason.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT=3100
SITE="http://localhost:${PORT}"

if [ ! -f .env.local ]; then
  echo "scripts/e2e.sh: .env.local is missing; the harness needs it to sign a test user in." >&2
  exit 1
fi

# `next dev` reads .env.local itself; the harness (a plain node script) does not, so it parses
# the file directly. Nothing from it is ever printed.
# Fail fast rather than quietly testing SOMEBODY ELSE'S server: `next dev` exits with
# EADDRINUSE while the wait loop below happily gets a 200 from whatever is already there, and
# the run then dies halfway through with "localhost refused to connect".
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "scripts/e2e.sh: something is already listening on port ${PORT}. Stop it and try again." >&2
  exit 1
fi

LOG="$(mktemp -t globetrotty-e2e-dev)"
echo "dev server log: $LOG"

# `--webpack`, like `pnpm dev`: this project carries a webpack config and Next 16
# refuses to start under Turbopack with one.
pnpm exec next dev --webpack -p "$PORT" >"$LOG" 2>&1 &
DEV_PID=$!

cleanup() {
  if kill -0 "$DEV_PID" 2>/dev/null; then
    kill "$DEV_PID" 2>/dev/null
    wait "$DEV_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

echo "waiting for ${SITE}/login ..."
for _ in $(seq 1 120); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "${SITE}/login" || true)"
  if [ "$code" = "200" ]; then
    echo "dev server is up"
    break
  fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "scripts/e2e.sh: the dev server exited before answering. Its log:" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  sleep 1
done

if [ "${code:-}" != "200" ]; then
  echo "scripts/e2e.sh: ${SITE}/login never answered 200. The dev server log:" >&2
  tail -40 "$LOG" >&2
  exit 1
fi

E2E=1 E2E_SITE="$SITE" node test/e2e/trip.e2e.mjs "$@"
STATUS=$?

echo "harness exited with $STATUS"
exit "$STATUS"
