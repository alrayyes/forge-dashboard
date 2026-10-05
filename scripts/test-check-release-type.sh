#!/usr/bin/env bash
# One case per kind of path for check-release-type.sh (rules/ci.md: give the
# filter a test with one case per path). Each case is a commit subject, the
# files it touched, and whether the check should pass.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

failed=0

check() {
  local want=$1 subject=$2 files=$3 code=0
  printf '%s\n' "$files" | scripts/check-release-type.sh check "$subject" >/dev/null 2>&1 || code=$?
  local got=pass
  [ "$code" -eq 0 ] || got=fail
  if [ "$got" != "$want" ]; then
    echo "FAIL: [$subject] [$files]: want $want, got $got"
    failed=1
  fi
}

# A release type that changes nothing that ships fails.
check fail "feat: add a thing" "README.md"
check fail "fix(ci): repair the cache" ".github/workflows/ci.yml"
check fail "perf: faster test setup" "tests/dashboard.spec.ts"
check fail "fix!: break the docs" "docs/design/README.md"
check fail "feat(hooks): quieter output" "lefthook.yml"
check fail "fix: reword a script" "scripts/lint-prose.sh"
check fail "feat: openspec change" "openspec/changes/x/proposal.md"
check fail "fix: a Go test" "internal/api/health_test.go"
check fail "fix: a Go fixture" "internal/api/testdata/case.json"
check fail "fix: a web test" "web/src/lib/filters.test.ts"
check fail "fix: styles" "styles/config/vocabularies/Base/accept.txt"

# The same files under a type that cuts no release are fine.
check pass "docs: reword the README" "README.md"
check pass "ci: repair the cache" ".github/workflows/ci.yml"
check pass "test: cover the filter" "tests/dashboard.spec.ts"
check pass "chore: tidy a script" "scripts/lint-prose.sh"
check pass "build: bump a dev tool" "package.json"
check pass "style: format" "README.md"
check pass "refactor: split a file" "README.md"
check pass "chore(main): release 0.130.1" "CHANGELOG.md"

# One logic path is enough, whatever else the commit touched.
check pass "fix: handler" "internal/api/health.go"
check pass "feat: command" "cmd/forge-dashboard/main.go"
check pass "fix: page" "web/src/lib/Dashboard.svelte"
check pass "feat: spec" "api/openapi.yaml"
check pass "fix: go dependency" "go.mod"
check pass "fix: go dependency sums" "go.sum"
check pass "fix: image" "Dockerfile"
check pass "fix: release image" "Dockerfile.release"
check pass "fix: packaging" ".goreleaser.yml"
check pass "fix(ci): and a handler" $'.github/workflows/ci.yml\ninternal/api/health.go'
check pass "perf!: breaking" $'README.md\ncmd/forge-dashboard/main.go'

# Not a release type, or not a conventional subject at all.
check pass "Merge branch 'main' into x" "README.md"
check pass "revert: undo a docs change" "README.md"

exit "$failed"
