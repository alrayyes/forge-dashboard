#!/usr/bin/env bash
# The release job's three steps that call GitHub's API are wrapped in
# Wandalen/wretry.action, so one secondary-rate-limit 403 doesn't leave a
# release half done (rules/release-publishing.md, #889). A static check, since
# a release can't be run here: each wrapped action keeps its pinned SHA, none
# is left as a bare `uses:`, and the outputs release-please feeds the later
# jobs are read from the wrapper's JSON.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

wf=.github/workflows/release.yml
failed=0
fail() {
  echo "FAIL: $1"
  failed=1
}

wrapper='Wandalen/wretry.action@[0-9a-f]{40}'
grep -Eq "uses: $wrapper" "$wf" || fail "$wf does not use Wandalen/wretry.action pinned by full SHA"

for action in googleapis/release-please-action goreleaser/goreleaser-action actions/attest-build-provenance; do
  if grep -Eq "^\s+uses: $action@" "$wf"; then
    fail "$action is a bare uses: step, not wrapped in wretry.action"
  fi
  grep -Eq "^\s+action: $action@[0-9a-f]{40}" "$wf" || fail "$action is not wrapped with its pinned SHA"
done

attempts=$(grep -Ec '^\s+attempt_limit: [23]$' "$wf" || true)
[ "$attempts" -ge 3 ] || fail "expected 2 or 3 attempts on each of the three wrapped steps, found $attempts"

# The wrapper hands the wrapped action's outputs back as one JSON string.
if grep -Eq 'steps\.release\.outputs\.(release_created|tag_name)' "$wf"; then
  fail "release-please's outputs are read directly; read them with fromJSON(steps.release.outputs.outputs)"
fi
grep -Eq 'fromJSON\(steps\.release\.outputs\.outputs\)\.release_created' "$wf" || fail "release_created is not read from the wrapper's JSON"
grep -Eq 'fromJSON\(steps\.release\.outputs\.outputs\)\.tag_name' "$wf" || fail "tag_name is not read from the wrapper's JSON"

exit "$failed"
