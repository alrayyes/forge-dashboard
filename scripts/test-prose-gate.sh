#!/usr/bin/env bash
# Branch protection requires `ci result` (rules/ci.md), so a job it doesn't
# wait for can go red and still merge. prose.yml's style and mechanics jobs
# did exactly that. A static check of the wiring: ci.yml calls prose.yml for
# the prose area, `ci result` needs that job, and prose.yml no longer runs on
# its own triggers, which would run every check twice. ROOT overrides the tree
# checked.
set -euo pipefail

cd "${ROOT:-$(dirname "${BASH_SOURCE[0]}")/..}"

failed=0
fail() {
  echo "FAIL: $1"
  failed=1
}

ci=.github/workflows/ci.yml
prose=.github/workflows/prose.yml

grep -Eq '^  workflow_call:' "$prose" || fail "prose.yml is not callable (no workflow_call trigger)"
if grep -Eq '^  (push|pull_request):' "$prose"; then
  fail "prose.yml still runs on push or pull_request; ci.yml calls it, so each check would run twice"
fi

# The block of one job in ci.yml, up to the next job.
block() { awk -v job="  $1:" '$0 == job {on=1; next} on && /^  [a-z-]+:/ {exit} on' "$ci"; }

# One caller job runs both tiers: a called workflow can't be asked for one job.
b=$(block prose-tiers)
if [ -z "$b" ]; then
  fail "ci.yml has no prose-tiers job"
else
  echo "$b" | grep -Eq 'uses: \./\.github/workflows/prose\.yml' || fail "ci.yml job prose-tiers does not call prose.yml"
  echo "$b" | grep -Eq "needs\.changes\.outputs\.prose == 'true'" || fail "ci.yml job prose-tiers is not limited to the prose area"
fi

# alls-green lets a skipped job through, so the path filter still works.
block ci-result | grep -Eq '^\s+prose-tiers,?$' || fail "ci result does not need prose-tiers"

# Without allowed-skips, a skipped prose-tiers (path filter) would fail the gate.
block ci-result | grep -Fq 'allowed-skips: ${{ toJSON(needs) }}' || fail "ci result does not set allowed-skips: \${{ toJSON(needs) }}"

exit "$failed"
