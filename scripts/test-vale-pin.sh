#!/usr/bin/env bash
# Vale runs from one pinned image (rules/markdown.md, "Running Vale"). The
# image is named twice because a workflow `container:` can't read a script
# variable: in scripts/vale.sh for the hook and local runs, and in prose.yml
# for CI. This fails when the two drift, when either lacks a digest, or when
# CI goes back to `go install`. It also fails when .vale.ini lists a style
# package by bare name or by a `latest` URL: `vale sync` then fetches whatever
# is newest, and a release the pinned Vale can't run turns the style job red
# on untouched docs.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

failed=0
fail() {
  echo "FAIL: $1"
  failed=1
}

pin='jdkato/vale:v[0-9.]+@sha256:[0-9a-f]{64}'

script_pin=$(grep -Eo "$pin" scripts/vale.sh 2>/dev/null | head -n1 || true)
workflow_pin=$(grep -Eo "$pin" .github/workflows/prose.yml | head -n1 || true)

[ -n "$script_pin" ] || fail "scripts/vale.sh has no jdkato/vale image pinned by tag and digest"
[ -n "$workflow_pin" ] || fail ".github/workflows/prose.yml has no jdkato/vale image pinned by tag and digest"
if [ -n "$script_pin" ] && [ -n "$workflow_pin" ] && [ "$script_pin" != "$workflow_pin" ]; then
  fail "the pins differ: scripts/vale.sh has $script_pin, prose.yml has $workflow_pin"
fi

if grep -q 'go install' .github/workflows/prose.yml; then
  fail ".github/workflows/prose.yml still runs go install"
fi

packages=$(sed -n 's/^Packages[[:space:]]*=[[:space:]]*//p' .vale.ini)
if [ -z "$packages" ]; then
  fail ".vale.ini lists no Packages line"
fi
IFS=',' read -ra entries <<<"$packages"
for entry in "${entries[@]}"; do
  entry=${entry//[[:space:]]/}
  [ -n "$entry" ] || continue
  if ! [[ $entry =~ ^https://github\.com/[^/]+/[^/]+/releases/download/v[0-9]+\.[0-9]+\.[0-9]+/[A-Za-z0-9_.-]+\.zip$ ]]; then
    fail ".vale.ini package '$entry' is not an exact release URL (…/releases/download/vX.Y.Z/Name.zip)"
  fi
done

exit "$failed"
