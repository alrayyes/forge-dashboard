#!/usr/bin/env bash
# Checks scripts/build-reports.sh turns the test, coverage and Lighthouse
# outputs into the layout apis.ryankes.eu serves. Builds its own small inputs,
# so it runs the same on a pull request as on main. Needs go and jq.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root="$PWD"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

go test -coverprofile="$work/coverage.out" ./internal/requestlog/ >/dev/null
cat >"$work/junit.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="x" tests="1"><testcase name="t"/></testsuite></testsuites>
XML
cp "$work/junit.xml" "$work/e2e.xml"
mkdir "$work/lhci"
echo '<html>run</html>' >"$work/lhci/lhr-1.html"
echo '{"categories":{}}' >"$work/lhci/lhr-1.json"
echo '<html>run2</html>' >"$work/lhci/lhr-2.html"
echo '{"categories":{}}' >"$work/lhci/lhr-2.json"
echo '[{"url":"http://localhost:8080/login.html","isRepresentativeRun":true,"htmlPath":"/ci/work/lhci/lhr-1.html","jsonPath":"/ci/work/lhci/lhr-1.json"},{"url":"http://localhost:8080/issues.html","isRepresentativeRun":true,"htmlPath":"/ci/work/lhci/lhr-2.html","jsonPath":"/ci/work/lhci/lhr-2.json"}]' >"$work/lhci/manifest.json"

# Everything present: every report lands, with no repo-name prefix.
full="$work/full"
GO_JUNIT="$work/junit.xml" COVERAGE_OUT="$work/coverage.out" E2E_JUNIT="$work/e2e.xml" LHCI_DIR="$work/lhci" \
  "$root/scripts/build-reports.sh" "$full"
for f in index.html tests/index.html tests/unit.xml tests/e2e.xml coverage/index.html \
  coverage/coverage.xml coverage/coverage.out lighthouse/index.html lighthouse/report.html lighthouse/report.json; do
  [ -s "$full/reports/$f" ] || fail "missing reports/$f"
done
grep -q '<coverage ' "$full/reports/coverage/coverage.xml" || fail "coverage.xml is not Cobertura"
grep -q '<testsuite' "$full/reports/tests/unit.xml" || fail "unit.xml has no testsuite"
grep -q 'href="lighthouse/"' "$full/reports/index.html" || fail "index.html does not link lighthouse"
for page in /login.html /issues.html; do
  grep -q "$page" "$full/reports/lighthouse/index.html" || fail "lighthouse index misses $page"
done
grep -q 'lhr-2.html' "$full/reports/lighthouse/index.html" || fail "lighthouse index does not link every page's run"
grep -q 'e2e.xml' "$full/reports/tests/index.html" || fail "tests index does not link e2e.xml"
[ ! -e "$full/forge-dashboard" ] || fail "reports carry a repo-name prefix"

# Optional reports absent: nothing empty is published for them.
min="$work/min"
GO_JUNIT="$work/junit.xml" COVERAGE_OUT="$work/coverage.out" "$root/scripts/build-reports.sh" "$min"
[ ! -e "$min/reports/lighthouse" ] || fail "lighthouse published without a run"
[ ! -e "$min/reports/tests/e2e.xml" ] || fail "e2e.xml published without a run"
grep -q 'lighthouse' "$min/reports/index.html" && fail "index.html links an absent lighthouse report"

echo ok
