#!/usr/bin/env bash
# The release job's actions run directly, never inside Wandalen/wretry.action.
# Under Node 24 that wrapper reports success with no output and never runs the
# wrapped action, so release_created came back empty and releases silently
# stopped (rules/release-publishing.md). A static check, since a release can't
# be run here: no wrapper anywhere, each action is a direct `uses:` step pinned
# by full SHA, and the outputs the later jobs read come straight from the step.
# WORKFLOW overrides the file checked, so the check can be pointed at another
# copy of the workflow. AUTO_MERGE_WORKFLOW does the same for the auto-merge
# workflow checked at the end.
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

# A release whose job died after release-please created it (v0.194.0, #1587)
# can only be completed by building its artefacts again from the tag, and the
# workflow has no other trigger than a push to main. So it takes a manual
# dispatch with the tag, checks that tag is a release tag that exists before
# anything is built, and checks out that tag, never the branch.
grep -Eq '^\s+workflow_dispatch:' "$wf" || fail "$src has no workflow_dispatch, so a release that stalled cannot be completed"
grep -Eq '^\s+tag:' "$wf" || fail "$src's workflow_dispatch takes no tag input"
grep -Eq 'github\.event_name == .workflow_dispatch.' "$wf" || fail "$src's artefacts job does not run for a dispatch"
grep -Eq 'ref: (refs/tags/)?\$\{\{ .*inputs\.tag' "$wf" || fail "$src's artefacts checkout does not use the dispatched tag"
grep -Eq '\^v\[0-9\]' "$wf" || fail "$src does not check the dispatched tag looks like vX.Y.Z"
grep -Eq 'gh release view' "$wf" || fail "$src does not check the release exists before building, so a dispatch could create a second one"
# goreleaser pushes the image and the latest manifest before it uploads assets,
# so dispatching an OLDER release would move ghcr.io's latest back to it and
# then fail on already_exists. Only the latest release, with no assets yet, is a
# half-published release this path may repair.
# The guard step, exactly: it runs on a dispatch only, and each refusal is a
# real `if` that ends in `exit 1`. A loose grep passes when a comparison is
# replaced by `if false`, so these are whole-line matches inside the step.
guard=$(awk '/- name: the dispatched tag is the latest release, and has no assets yet/ {on=1; next} on && /^      - uses:/ {exit} on' "$wf")
step_has() { printf '%s\n' "$guard" | grep -Fxq -- "$1"; }
step_has "        if: github.event_name == 'workflow_dispatch'" || fail "$src's guard step does not run on a dispatch only"
step_has '          latest=$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name)' || fail "$src does not read the latest release's tag"
step_has '          if [ "$latest" != "$TAG" ]; then' || fail "$src does not refuse a tag that is not the latest release"
step_has "          assets=\$(gh release view \"\$TAG\" --repo \"\$GITHUB_REPOSITORY\" --json assets --jq '.assets | length')" || fail "$src does not count the release's assets"
step_has '          if [ "$assets" != 0 ]; then' || fail "$src does not refuse a release that already has assets"
[ "$(printf '%s\n' "$guard" | grep -Fxc '            exit 1')" -ge 3 ] || fail "$src's guard step does not exit 1 on each refusal"
# A bare tag name resolves to a branch of the same name first.
grep -Eq 'ref: refs/tags/' "$wf" || fail "$src's artefacts checkout does not use refs/tags/<tag>"
# A dispatch cuts no release: release-please runs on a push only.
rp=$(awk '/^  release-please:/ {on=1; next} on && /^  [a-z-]+:/ {exit} on' "$wf")
echo "$rp" | grep -Eq "if: github\.event_name == 'push'" || fail "$src's release-please job is not push-only, so a dispatch could cut a release"

# release-please opens its pull request and adds `autorelease: pending` in a
# second API call, so the `opened` run sees no label and its job skips. Only a
# `labeled` run can see the label, so the trigger has to list that type (#1576).
am=${AUTO_MERGE_WORKFLOW:-.github/workflows/release-auto-merge.yml}
amwf=$(mktemp)
trap 'rm -f "$wf" "$amwf"' EXIT
grep -Ev '^\s*#' "$am" >"$amwf"
if ! grep -Eq '^\s+types:.*\blabeled\b' "$amwf"; then
  fail "$am does not run on the labeled activity type, so it misses the label release-please adds after opening the pull request"
fi

exit "$failed"
