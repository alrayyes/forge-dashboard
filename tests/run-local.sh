#!/usr/bin/env bash
# One-command local Playwright run: builds the binary and runs the suite.
# Every worker starts a server of its own from that binary, on a free port
# and a throwaway database (tests/server-fixture.ts). Extra arguments go to
# `playwright test`.
#
#   ./tests/run-local.sh                 # whole suite
#   ./tests/run-local.sh tests/auth.spec.ts --workers=2
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

bun run build:web >/dev/null
# -tags e2e adds POST /__e2e/reset, which the specs call between tests.
go build -tags e2e -o "$work/forge-dashboard" ./cmd/forge-dashboard
export E2E_BINARY="$work/forge-dashboard"

bunx playwright test "$@"
