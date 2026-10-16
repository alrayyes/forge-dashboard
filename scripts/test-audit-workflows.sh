#!/usr/bin/env bash
# The dependency audit blocks only what a pull request introduces, and a scan
# of the default branch keeps one ticket (rules/dependencies.md, #1570). A
# static check of the shape, since the advisory database can't be run here:
# no --ignore or allowlist in any pipeline file, every use of the shared
# action pinned by full SHA, the two audit jobs in ci.yml in gate mode, and a
# scan workflow with the three triggers and `issues: write`. ROOT overrides
# the tree checked.
set -euo pipefail

cd "${ROOT:-$(dirname "${BASH_SOURCE[0]}")/..}"

failed=0
fail() {
  echo "FAIL: $1"
  failed=1
}

# Comments are dropped first: the files explain here why there is no ignore.
strip() { grep -Ev '^\s*#' "$1"; }

# An ignore hides a finding from the only place it is tracked.
for f in .github/workflows/*.yml .github/workflows/*.yaml scripts/*.sh package.json lefthook.yml; do
  [ -f "$f" ] || continue
  [ "$f" = scripts/test-audit-workflows.sh ] && continue
  if strip "$f" | grep -Eq -- '--ignore\b|--ignore-|audit-ignore'; then
    fail "$f carries an audit ignore; the scan ticket is where a known advisory lives"
  fi
done
[ ! -e scripts/audit.sh ] || fail "scripts/audit.sh still exists; the shared action runs the audit and its retry"

# The shared action: a full commit SHA, never a tag.
while IFS= read -r line; do
  echo "$line" | grep -Eq 'alrayyes/advisory-scan@[0-9a-f]{40}( |$)' || fail "advisory-scan is not pinned by full SHA: $line"
done < <(grep -rhE 'uses: .*alrayyes/advisory-scan@' .github/workflows || true)

ci=.github/workflows/ci.yml
for job in audit govulncheck; do
  block=$(awk -v job="  $job:" '$0 == job {on=1; next} on && /^  [a-z-]+:/ {exit} on' "$ci")
  echo "$block" | grep -Eq 'uses: alrayyes/advisory-scan@' || fail "ci.yml job $job does not use the advisory-scan action"
  echo "$block" | grep -Eq 'mode: gate' || fail "ci.yml job $job is not in gate mode"
done

scan=.github/workflows/dependency-scan.yml
if [ ! -f "$scan" ]; then
  fail "$scan is missing, so nothing keeps the Dependency advisories ticket"
else
  body=$(strip "$scan")
  echo "$body" | grep -Eq 'mode: scan' || fail "$scan does not run advisory-scan in scan mode"
  echo "$body" | grep -Eq 'schedule:' || fail "$scan has no daily schedule"
  echo "$body" | grep -Eq 'workflow_dispatch:' || fail "$scan cannot be run by hand"
  echo "$body" | grep -Eq 'push:' || fail "$scan does not run when a lockfile changes on the default branch"
  echo "$body" | grep -Eq 'issues: write' || fail "$scan lacks issues: write, so it cannot keep the ticket"
fi

# No dependency audit runs in pre-push (rules/dependencies.md, #1606): a hook
# can't compare base and head, so it fails on advisories already on the default
# branch and teaches LEFTHOOK=0, which also skips the tests and gitleaks. CI
# owns the gate; the command stays a script to run by hand.
if strip lefthook.yml | grep -Eq 'govulncheck|bun audit|npm audit|pip-audit|composer audit|cargo audit'; then
  fail "lefthook.yml runs a dependency audit; CI owns the gate, so remove it from pre-push"
fi
[ -x scripts/govulncheck.sh ] || fail "scripts/govulncheck.sh is missing, so there is no way to run the Go audit by hand"

exit "$failed"
