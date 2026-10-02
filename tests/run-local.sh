#!/usr/bin/env bash
# One-command local Playwright run: builds the binary, starts it on a
# throwaway database and a port of its own, runs the suite, tears it down.
# The admin global setup only works on an empty database, so every run
# gets a fresh one. Extra arguments go to `playwright test`.
#
#   ./tests/run-local.sh                 # whole suite
#   ./tests/run-local.sh tests/auth.spec.ts --workers=2
#
# PORT=8081 picks another port, so a dev server on 8080 can keep running.
# The script refuses to start if something already listens on the port.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"
if (echo > "/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  echo "port ${PORT} is already in use; stop that server first" >&2
  exit 1
fi

work="$(mktemp -d)"
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

bun run build:web >/dev/null
go build -o "$work/forge-dashboard" ./cmd/forge-dashboard

rm -f tests/.auth/admin.json
DB_PATH="$work/test.db" ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  ADDR=":${PORT}" RP_ORIGIN="http://localhost:${PORT}" "$work/forge-dashboard" >"$work/server.log" 2>&1 &
server_pid=$!
bunx wait-on "http-get://localhost:${PORT}/login.html" --timeout 30000

E2E_BASE_URL="http://localhost:${PORT}" bunx playwright test "$@" || {
  status=$?
  echo "server log: $work/server.log (removed on exit; copy it now if needed)" >&2
  exit "$status"
}
