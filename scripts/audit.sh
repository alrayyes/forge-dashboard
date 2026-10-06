#!/usr/bin/env bash
# bun audit with the advisories we have decided to live with, and one retry
# when the registry (not an advisory) fails (rules/ci.md).
#
# Every ignore carries the date it was added and why. Look at them again
# whenever the dependency in question releases, and delete the ones that
# have a fix. Added 2026-10-05, from a run where bun audit fix had fixed
# everything it could (devalue, fast-uri).
set -euo pipefail

ignores=(
  # No published version fixes these, any release.
  --ignore GHSA-hp3w-g68c-fv3c # sprintf-js <=1.1.3, latest is 1.1.3, via argparse (dev tooling), added 2026-10-06
  --ignore GHSA-vfj7-8cjw-p6xm # braces <=3.0.3, via markdownlint-cli2 > globby (dev tooling)
  --ignore GHSA-7pqw-9j4j-h8q3 # extract-zip <=2.0.1, via @lhci/cli > lighthouse (dev tooling)
  --ignore GHSA-jmr9-qjv8-65gv # extract-zip <=2.0.1, same path
  # A fix exists, but a dependent's range excludes it until that package
  # releases. Dev tooling only: nothing here ships in the image.
  --ignore GHSA-c475-qrg2-pj4r # basic-ftp, get-uri@6 wants ^5, via @lhci/cli
  --ignore GHSA-52f5-9888-hmc6 # tmp, @lhci/cli wants ^0.1 and external-editor ^0.0.33
  --ignore GHSA-ph9p-34f9-6g65 # tmp, same
  --ignore GHSA-w5hq-g745-h8pq # uuid, @lhci/cli wants ^8
)

attempt=1
while true; do
  status=0
  out=$(bun audit "${ignores[@]}" 2>&1) || status=$?
  echo "$out"
  [ "$status" -eq 0 ] && exit 0
  # An advisory is a real failure. Anything else is the registry: try once more.
  if echo "$out" | grep -q "vulnerabilit"; then
    exit "$status"
  fi
  if [ "$attempt" -ge 2 ]; then
    exit "$status"
  fi
  attempt=$((attempt + 1))
  echo "bun audit failed without an advisory, retrying once" >&2
  sleep 10
done
