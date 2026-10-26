#!/usr/bin/env bash
# gitleaks runs from one pinned image (rules/secrets.md). The image is named
# twice because a workflow `container:` can't read a hook's command line: in
# lefthook.yml for the commit hook, and in .github/workflows/gitleaks.yml for
# CI. This fails when the two drift or when either lacks a tag and a digest,
# so the hook and CI can't disagree about what a secret is.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

failed=0
fail() {
  echo "FAIL: $1"
  failed=1
}

pin='gitleaks/gitleaks:v[0-9.]+@sha256:[0-9a-f]{64}'

hook_pin=$(grep -Eo "$pin" lefthook.yml | head -n1 || true)
ci_pin=$(grep -Eo "$pin" .github/workflows/gitleaks.yml | head -n1 || true)

[ -n "$hook_pin" ] || fail "lefthook.yml has no gitleaks image pinned by tag and digest"
[ -n "$ci_pin" ] || fail ".github/workflows/gitleaks.yml has no gitleaks image pinned by tag and digest"
if [ -n "$hook_pin" ] && [ -n "$ci_pin" ] && [ "$hook_pin" != "$ci_pin" ]; then
  fail "the pins differ: lefthook.yml has $hook_pin, gitleaks.yml has $ci_pin"
fi

exit "$failed"
