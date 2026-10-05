#!/usr/bin/env bash
# Closes every open pull request in the fixture repo and deletes the base/ and
# head/ branches and their protection, leaving main and the workflow.
set -euo pipefail
REPO=alrayyes/forge-dashboard-e2e-fixture
for n in $(gh pr list -R "$REPO" --state open --limit 100 --json number --jq '.[].number'); do
  gh pr close -R "$REPO" "$n" >/dev/null
done
for b in $(gh api "repos/$REPO/branches" --paginate --jq '.[].name' | grep -E '^(base|head)/' || true); do
  gh api -X DELETE "repos/$REPO/branches/$b/protection" >/dev/null 2>&1 || true
  gh api -X DELETE "repos/$REPO/git/refs/heads/$b" >/dev/null || true
done
echo "reset"
