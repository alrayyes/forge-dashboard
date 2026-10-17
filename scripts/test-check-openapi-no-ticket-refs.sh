#!/usr/bin/env bash
# Tests scripts/check-openapi-no-ticket-refs.sh against small fixtures.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failed=0

expect() { # want-exit text
  printf '%s\n' "$2" >"$tmp/spec.yaml"
  rc=0
  scripts/check-openapi-no-ticket-refs.sh "$tmp/spec.yaml" >/dev/null || rc=$?
  if [ "$rc" != "$1" ]; then
    echo "FAIL: expected exit $1, got $rc for: $2"
    failed=1
  fi
}

expect 1 'description: Refused with 403 (#1000).'
expect 1 'description: See issue 123 for why.'
expect 1 'description: https://github.com/a/b/issues/12'
expect 0 'description: Refused with 403.'
expect 0 "\$ref: '#/components/schemas/Thing'"

# the real spec
scripts/check-openapi-no-ticket-refs.sh >/dev/null || { echo "FAIL: api/openapi.yaml has ticket references"; failed=1; }

[ "$failed" = 0 ] && echo "ok"
exit "$failed"
