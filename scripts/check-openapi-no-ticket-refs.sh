#!/usr/bin/env bash
# The spec is published as the API reference and read by MCP clients, so its
# descriptions can't point at tickets a reader has no access to (rules/docs.md,
# "No ticket references in public docs"). Fails on `#123`, `issue 123` and
# issue or pull URLs. Takes the file to check, default api/openapi.yaml.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

file=${1:-api/openapi.yaml}
pattern='#[0-9]{2,}|[Ii]ssues? [0-9]+|/(issues|pull)/[0-9]+'

if hits=$(grep -nE "$pattern" "$file"); then
  echo "FAIL: ticket references in $file; say why instead of citing the ticket:"
  echo "$hits"
  exit 1
fi
echo "ok: no ticket references in $file"
