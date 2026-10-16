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
# Lighthouse CI names its files localhost-<page>_html-<timestamp>.report.{html,json},
# not lhr-*, so the fixture uses the real shape. Each page gets an extra,
# non-representative run, as numberOfRuns > 1 produces.
manifest="["
sep=""
n=0
for spec in login.html:login_html issues.html:issues_html :; do
  page="${spec%%:*}"
  key="${spec##*:}"
  [ -n "$key" ] || key="_"
  for rep in true false; do
    n=$((n + 1))
    name="localhost-${key}-2026_10_10_10_00_0$n.report"
    echo "<html>$name</html>" >"$work/lhci/$name.html"
    echo '{"categories":{}}' >"$work/lhci/$name.json"
    manifest="$manifest$sep{\"url\":\"http://localhost:8080/$page\",\"isRepresentativeRun\":$rep,\"htmlPath\":\"/ci/work/lhci/$name.html\",\"jsonPath\":\"/ci/work/lhci/$name.json\"}"
    sep=","
  done
done
echo "$manifest]" >"$work/lhci/manifest.json"

# Everything present: every report lands, with no repo-name prefix.
full="$work/full"
GO_JUNIT="$work/junit.xml" COVERAGE_OUT="$work/coverage.out" E2E_JUNIT="$work/e2e.xml" LHCI_DIR="$work/lhci" \
  "$root/scripts/build-reports.sh" "$full"
for f in index.html tests/index.html tests/unit.xml tests/e2e.xml coverage/index.html \
  coverage/coverage.xml coverage/coverage.out lighthouse/index.html lighthouse/report.html lighthouse/report.json \
  lighthouse/login.report.html lighthouse/login.report.json lighthouse/issues.report.html \
  lighthouse/issues.report.json lighthouse/home.report.html lighthouse/home.report.json; do
  [ -s "$full/reports/$f" ] || fail "missing reports/$f"
done
grep -q '<coverage ' "$full/reports/coverage/coverage.xml" || fail "coverage.xml is not Cobertura"
grep -q '<testsuite' "$full/reports/tests/unit.xml" || fail "unit.xml has no testsuite"
grep -q 'href="lighthouse/"' "$full/reports/index.html" || fail "index.html does not link lighthouse"
for page in /login.html /issues.html /; do
  grep -q "$page" "$full/reports/lighthouse/index.html" || fail "lighthouse index misses $page"
done
grep -q 'href="issues.report.html"' "$full/reports/lighthouse/index.html" || fail "lighthouse index does not link every page's run"
# Stable names: no timestamp anywhere in the directory, so two deploys match.
for f in "$full/reports/lighthouse"/*; do
  case "$(basename "$f")" in *[0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]*) fail "lighthouse file $f carries a timestamp" ;; esac
done
# The manifest names only files that exist, under the stable names.
while read -r path; do
  case "$path" in *.report.html | *.report.json) ;; *) fail "manifest path $path is not a stable name" ;; esac
  [ -s "$full/reports/lighthouse/$(basename "$path")" ] || fail "manifest names $path but it is not published"
done < <(jq -r '.[] | .htmlPath, .jsonPath' "$full/reports/lighthouse/manifest.json")
[ "$(jq length "$full/reports/lighthouse/manifest.json")" = 3 ] || fail "manifest keeps more than one run per page"
# Every link on the index must open something.
while read -r href; do
  [ -s "$full/reports/lighthouse/$href" ] || fail "lighthouse index links $href but the file is not published"
done < <(grep -o 'href="[^"]*"' "$full/reports/lighthouse/index.html" | sed 's/^href="//; s/"$//' | grep -v '^\.\./')
grep -q 'e2e.xml' "$full/reports/tests/index.html" || fail "tests index does not link e2e.xml"
[ ! -e "$full/forge-dashboard" ] || fail "reports carry a repo-name prefix"

# Optional reports absent: nothing empty is published for them.
min="$work/min"
GO_JUNIT="$work/junit.xml" COVERAGE_OUT="$work/coverage.out" "$root/scripts/build-reports.sh" "$min"
[ ! -e "$min/reports/lighthouse" ] || fail "lighthouse published without a run"
[ ! -e "$min/reports/tests/e2e.xml" ] || fail "e2e.xml published without a run"
grep -q 'lighthouse' "$min/reports/index.html" && fail "index.html links an absent lighthouse report"

echo ok
