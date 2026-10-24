#!/usr/bin/env bash
# The e2e shards and the Lighthouse job run in Playwright's own image, so no
# job downloads a browser or runs apt (a hang in `playwright install` used to
# fail pipelines). The image's browsers only work with the library version they
# shipped with, and a container image can't read package.json, so the tag is
# written out in ci.yml. This fails when a job's image drifts from the
# @playwright/test version in package.json and bun.lock, or lacks a tag and a
# digest, so a bump of the library can't land with browsers that disagree.
# WORKFLOW, PACKAGE_JSON and LOCKFILE override the files checked.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

workflow=${WORKFLOW:-.github/workflows/ci.yml}
package_json=${PACKAGE_JSON:-package.json}
lockfile=${LOCKFILE:-bun.lock}

failed=0
fail() {
  echo "FAIL: $1"
  failed=1
}

lib=$(grep -Eo '"@playwright/test": "[0-9]+\.[0-9]+\.[0-9]+"' "$package_json" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' || true)
[ -n "$lib" ] || fail "$package_json pins no exact @playwright/test version"
locked=$(grep -Eo '"@playwright/test@[0-9]+\.[0-9]+\.[0-9]+"' "$lockfile" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
if [ -n "$lib" ] && [ "$lib" != "$locked" ]; then
  fail "$package_json pins @playwright/test $lib but $lockfile locks ${locked:-nothing}"
fi

# Every job that runs a browser names the image on an `image:` line.
images=()
while IFS= read -r line; do
  images+=("$line")
done < <(grep -E '^\s+image: mcr\.microsoft\.com/playwright:' "$workflow" | sed -E 's/^\s+image: //')
[ "${#images[@]}" -ge 2 ] || fail "$workflow has ${#images[@]} jobs on the Playwright image, expected the e2e shards and lighthouse"

for image in "${images[@]}"; do
  if ! [[ $image =~ ^mcr\.microsoft\.com/playwright:v([0-9]+\.[0-9]+\.[0-9]+)-noble@sha256:[0-9a-f]{64}$ ]]; then
    fail "image '$image' is not pinned by an exact version and a digest (vX.Y.Z-noble@sha256:...)"
    continue
  fi
  if [ "${BASH_REMATCH[1]}" != "$lib" ]; then
    fail "image '$image' is for Playwright ${BASH_REMATCH[1]}, but @playwright/test is $lib"
  fi
done

if [ "${#images[@]}" -gt 0 ] && [ "$(printf '%s\n' "${images[@]}" | sort -u | wc -l)" -gt 1 ]; then
  fail "the jobs use different Playwright images: ${images[*]}"
fi

if grep -Eq 'playwright install' "$workflow"; then
  fail "$workflow still runs 'playwright install'; the image already has the browsers"
fi

exit "$failed"
