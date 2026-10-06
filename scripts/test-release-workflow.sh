#!/usr/bin/env bash
# The release job's actions run directly, never inside Wandalen/wretry.action.
# Under Node 24 that wrapper reports success with no output and never runs the
# wrapped action, so release_created came back empty and releases silently
# stopped (rules/release-publishing.md). A static check, since a release can't
# be run here: no wrapper anywhere, each action is a direct `uses:` step pinned
# by full SHA, and the outputs the later jobs read come straight from the step.
# WORKFLOW overrides the file checked, so the check can be pointed at another
# copy of the workflow.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Comments are dropped first: the workflow explains here why it isn't wrapped.
src=${WORKFLOW:-.github/workflows/release.yml}
wf=$(mktemp)
trap 'rm -f "$wf"' EXIT
grep -Ev '^\s*#' "$src" >"$wf"
failed=0
fail() {
  echo "FAIL: $1"
  failed=1
}

if grep -Eq 'Wandalen/wretry\.action' "$wf"; then
  fail "$src wraps a step in Wandalen/wretry.action, which never runs the wrapped action under Node 24"
fi

for action in googleapis/release-please-action goreleaser/goreleaser-action actions/attest-build-provenance; do
  grep -Eq "^\s+uses: $action@[0-9a-f]{40}" "$wf" || fail "$action is not a direct uses: step pinned by full SHA"
done

grep -Eq 'steps\.release\.outputs\.release_created' "$wf" || fail "release_created is not read from the release-please step's outputs"
grep -Eq 'steps\.release\.outputs\.tag_name' "$wf" || fail "tag_name is not read from the release-please step's outputs"
if grep -Eq 'fromJSON\(steps\.release\.outputs\.outputs\)' "$wf"; then
  fail "outputs are read through the wrapper's JSON; read them directly from the step"
fi

exit "$failed"
