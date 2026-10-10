#!/usr/bin/env bash
# Assembles the reports the CI `pages` job publishes at
# apis.ryankes.eu/forge-dashboard/reports/ (rules/published-reports.md).
#
# Usage: build-reports.sh <dest-dir>
#
# <dest-dir> is the Pages artifact root. A project site is already served
# under /<repo>/, so the reports land in <dest-dir>/reports/ with no
# repo-name prefix of their own.
#
# Inputs, each overridable through the environment:
#   GO_JUNIT      gotestsum's JUnit XML       (default junit.xml, required)
#   COVERAGE_OUT  go test -coverprofile       (default coverage.out, required)
#   E2E_JUNIT     Playwright's JUnit XML      (optional, skipped when absent)
#   LHCI_DIR      Lighthouse CI filesystem upload directory (optional)
#
# A report the repo did not produce is left out rather than published empty.
set -euo pipefail

dest="${1:?usage: build-reports.sh <dest-dir>}"
go_junit="${GO_JUNIT:-junit.xml}"
coverage_out="${COVERAGE_OUT:-coverage.out}"
e2e_junit="${E2E_JUNIT:-}"
lhci_dir="${LHCI_DIR:-}"
reports="$dest/reports"

mkdir -p "$reports/tests" "$reports/coverage"

cp "$go_junit" "$reports/tests/unit.xml"
tests_links='<li><a href="unit.xml">unit.xml</a> (Go tests, JUnit XML from gotestsum)</li>'
if [ -n "$e2e_junit" ] && [ -s "$e2e_junit" ]; then
  cp "$e2e_junit" "$reports/tests/e2e.xml"
  tests_links="$tests_links
<li><a href=\"e2e.xml\">e2e.xml</a> (Playwright journeys, JUnit XML)</li>"
fi

cp "$coverage_out" "$reports/coverage/coverage.out"
go run github.com/boumenot/gocover-cobertura@v1.4.0 <"$coverage_out" >"$reports/coverage/coverage.xml"
go tool cover -html="$coverage_out" -o "$reports/coverage/index.html"

index_links='<li><a href="tests/">Test results</a> (JUnit XML)</li>
<li><a href="coverage/">Coverage</a> (<a href="coverage/coverage.xml">Cobertura XML</a>, <a href="coverage/coverage.out">Go profile</a>)</li>'

# Lighthouse CI's filesystem target writes one <page>-<timestamp>.report.{html,json}
# pair per run (the names the manifest gives, not a fixed prefix) plus a
# manifest.json. Publish every file the manifest names, list each audited page's
# representative run in lighthouse/index.html, and copy the first page's to
# report.html and report.json, the stable names.
if [ -n "$lhci_dir" ] && [ -s "$lhci_dir/manifest.json" ]; then
  mkdir -p "$reports/lighthouse"
  jq -r '.[] | .htmlPath, .jsonPath' "$lhci_dir/manifest.json" |
    while read -r path; do
      cp "$lhci_dir/$(basename "$path")" "$reports/lighthouse/"
    done
  cp "$lhci_dir/manifest.json" "$reports/lighthouse/"
  rep="$(jq -r '[.[] | select(.isRepresentativeRun)][0] // .[0] | .htmlPath' "$lhci_dir/manifest.json")"
  cp "$lhci_dir/$(basename "$rep")" "$reports/lighthouse/report.html"
  cp "$lhci_dir/$(basename "${rep%.html}.json")" "$reports/lighthouse/report.json"
  pages="$(jq -r '.[] | select(.isRepresentativeRun) | [(.url | sub("^https?://[^/]+"; "")), (.htmlPath | split("/") | last)] | @tsv' "$lhci_dir/manifest.json" |
    while IFS=$'\t' read -r page file; do
      echo "<li><a href=\"$file\">$page</a> (<a href=\"${file%.html}.json\">JSON</a>)</li>"
    done)"
  cat >"$reports/lighthouse/index.html" <<HTML
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lighthouse reports</title></head>
<body><main><h1>Lighthouse reports</h1>
<p>One report per audited page, the run Lighthouse CI marked representative.</p>
<ul>
$pages
</ul>
<p><a href="../">All reports</a></p></main></body>
</html>
HTML
  index_links="$index_links
<li><a href=\"lighthouse/\">Lighthouse</a> (one report per page)</li>"
fi

commit="${GITHUB_SHA:-unknown}"
built="$(date -u +%Y-%m-%d)"

cat >"$reports/tests/index.html" <<HTML
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test results</title></head>
<body><main><h1>Test results</h1>
<ul>
$tests_links
</ul>
<p><a href="../">All reports</a></p></main></body>
</html>
HTML

cat >"$reports/index.html" <<HTML
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>forge-dashboard reports</title></head>
<body><main><h1>forge-dashboard reports</h1>
<p>Commit ${commit:0:7}, built $built.</p>
<ul>
$index_links
</ul></main></body>
</html>
HTML
