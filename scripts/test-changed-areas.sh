#!/usr/bin/env bash
# One case per kind of path for changed-areas.sh (rules/ci.md: give the
# filter a test with one case per path). Each case is the changed files, then
# the areas expected to be true; every other area must be false.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

failed=0

check() {
  local want=" $1 " files=$2
  shift 2
  local got
  got=$(printf '%s\n' "$files" | scripts/changed-areas.sh | awk -F= '$2 == "true" { printf "%s ", $1 }')
  got=" ${got% } "
  # Compare as sorted sets so the order of areas doesn't matter.
  local want_sorted got_sorted
  want_sorted=$(tr ' ' '\n' <<<"$want" | sort | xargs)
  got_sorted=$(tr ' ' '\n' <<<"$got" | sort | xargs)
  if [ "$want_sorted" != "$got_sorted" ]; then
    echo "FAIL: [$files]"
    echo "  want: $want_sorted"
    echo "  got:  $got_sorted"
    failed=1
  fi
}

# Docs only: prose, nothing that builds or tests the app.
check "prose" "README.md"
check "prose" "docs/design/README.md"
check "prose" "docs/screenshots/dashboard-dark.png"
check "prose" "styles/Vale/style.yml"
check "api prose" "docs/api/index.html"

# Go only.
check "go image e2e" "internal/forgejo/client.go"
check "go image e2e" "integration/forgejo_test.go"
check "go image e2e" "go.mod"
# Prettier checks every yml, so a config in yml is prose as well.
check "go image e2e prose" ".golangci.yml"
check "go image e2e prose" "internal/forgejo/README.md"
check "go api image e2e prose" "api/openapi.yaml"

# Web only.
check "web image e2e" "web/src/lib/filters.ts"
check "web image e2e prose" "web/src/routes/(app)/+page.svelte"
check "web image e2e" "tests/dashboard.spec.ts"
check "web image e2e" "biome.json"
# The prose jobs run these scripts, so editing one runs them (#884).
check "web image e2e prose" "scripts/lint-prose.sh"
check "web image e2e prose" "scripts/lint-mechanics.sh"
check "web image e2e prose" "scripts/vale.sh"
check "web api image e2e prose" "package.json"
check "web api image e2e prose" "bun.lock"

# Docker only.
check "image e2e hadolint" "Dockerfile"
check "image e2e hadolint" ".dockerignore"

# The pipeline's own files.
check "go web image e2e hadolint prose api" ".github/workflows/ci.yml"
# Other workflows filter themselves; prettier still checks their yml.
check "prose" ".github/workflows/prose.yml"
check "prose" ".github/workflows/release.yml"
check "prose" "lefthook.yml"

# Files no job reads.
check "" "LICENSE"
check "" "release-please-config.json"

# A path nobody listed runs everything rather than skipping a job.
check "go web image e2e hadolint prose api" "some-new-top-level-file.txt"

# Several files: the union of their areas.
check "go prose image e2e" $'internal/api/server.go\nREADME.md'
check "" ""

exit "$failed"
