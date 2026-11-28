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
check "prose" "docs/screenshots/pull-requests-dark.png"
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
check "go" "scripts/build-reports.sh"
check "go" "scripts/test-build-reports.sh"

# Web only.
check "web image e2e" "web/src/lib/filters.ts"
check "web image e2e prose" "web/src/routes/(app)/+page.svelte"
check "web image e2e" "tests/dashboard.spec.ts"
# The generated table is checked by a Go test, so a change to it alone needs the
# Go job (#1437).
check "go web image e2e" "tests/generated/allowed-actions.json"
check "web image e2e" "biome.json"
check "web image e2e prose" ".semgrep/svelte.yml"
# A script neither the build nor a browser job runs keeps its own tests, lint
# and type check, and skips the image and the end-to-end run (#5188).
check "web" "scripts/e2e-audit-csv.test.ts"
check "web" "scripts/check-release-type.sh"
check "web" "scripts/e2e-fixture/build.sh"
check "go" "scripts/memory-bench/seed.go"

# Every script the build or a browser job names must still run them, so the
# list in changed-areas.sh can't fall behind.
used=$(
  {
    cat Dockerfile playwright.config.ts lighthouserc.json web/package.json
    grep -E '"build(:web)?":' package.json
    git grep -h '\.\./scripts/' -- tests
    awk '/^  [a-z0-9-]+:$/ { job = $1 } job ~ /^(docker|e2e-shard|e2e|lighthouse):$/' .github/workflows/ci.yml
  } | grep -vE '^[[:space:]]*(#|//)' |
    grep -oE 'scripts/[a-z0-9-]+(\.(sh|ts|js))?' |
    sed -E '/\.(sh|ts|js)$/!s/$/.ts/' | sort -u
)
[ -n "$used" ] || {
  echo "FAIL: found no scripts used by the build or the browser jobs"
  failed=1
}
for script in $used; do
  check "web image e2e" "$script"
done

# The prose jobs run these scripts, so editing one runs them (#884).
check "web prose" "scripts/lint-prose.sh"
check "web prose" "scripts/lint-mechanics.sh"
check "web prose" "scripts/vale.sh"
check "web prose" "scripts/check-doc-ticket-refs.ts"
check "web prose" "scripts/check-doc-links.ts"
check "web api image e2e prose" "package.json"
check "api prose" ".spectral.yaml"
check "web api image e2e prose" "bun.lock"

# Docker only.
check "prose release" ".goreleaser.yml"
check "image e2e hadolint" "Dockerfile"
check "image e2e hadolint" ".dockerignore"

# The pipeline's own files.
check "go web image e2e hadolint prose api release" ".github/workflows/ci.yml"
# Other workflows filter themselves; prettier still checks their yml.
check "prose" ".github/workflows/prose.yml"
check "prose" ".github/workflows/release.yml"
check "prose" "lefthook.yml"

# Files no job reads.
check "" "LICENSE"
check "" "release-please-config.json"

# A path nobody listed runs everything rather than skipping a job.
check "go web image e2e hadolint prose api release" "some-new-top-level-file.txt"

# Several files: the union of their areas.
check "go prose image e2e" $'internal/api/server.go\nREADME.md'
check "" ""

exit "$failed"
