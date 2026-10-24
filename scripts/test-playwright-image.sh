#!/usr/bin/env bash
# The e2e shards, the Lighthouse job and the release screenshots job run in
# our own CI image (github.com/alrayyes/ci-playwright), tagged with the
# Playwright version it carries, so no job downloads a browser or runs apt (a
# hang in `playwright install` used to fail pipelines). The image's browsers
# only work with the library version they shipped with, and a container image
# can't read package.json, so the tag is written out in the workflows. This
# fails when a job's image drifts from the @playwright/test version in
# package.json and bun.lock, lacks a tag and a digest, or differs from another
# job's image, so a bump of the library can't land with browsers that disagree.
# WORKFLOWS (space separated), PACKAGE_JSON and LOCKFILE override the files
# checked.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

workflows=${WORKFLOWS:-.github/workflows/ci.yml .github/workflows/release.yml}
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
done < <(grep -hE '^\s+image: ghcr\.io/alrayyes/ci-playwright:' $workflows | sed -E 's/^\s+image: //')
[ "${#images[@]}" -ge 3 ] || fail "found ${#images[@]} jobs on the CI image, expected the e2e shards, lighthouse and the release screenshots"

for image in "${images[@]}"; do
  if ! [[ $image =~ ^ghcr\.io/alrayyes/ci-playwright:([0-9]+\.[0-9]+\.[0-9]+)@sha256:[0-9a-f]{64}$ ]]; then
    fail "image '$image' is not pinned by an exact version and a digest (ghcr.io/alrayyes/ci-playwright:X.Y.Z@sha256:...)"
    continue
  fi
  if [ "${BASH_REMATCH[1]}" != "$lib" ]; then
    fail "image '$image' is for Playwright ${BASH_REMATCH[1]}, but @playwright/test is $lib"
  fi
done

if [ "${#images[@]}" -gt 0 ] && [ "$(printf '%s\n' "${images[@]}" | sort -u | wc -l)" -gt 1 ]; then
  fail "the jobs use different Playwright images: ${images[*]}"
fi

# The browser jobs themselves, by name: each must hold the image, --ipc=host
# and the Bun check, so a job that loses its container block can't hide behind
# another one that has it.
job_block() { # file job
  awk -v job="  $2:" '$0 == job {on=1; next} on && /^  [A-Za-z0-9_-]+:/ {exit} on' "$1"
}
for entry in ci.yml:e2e-shard ci.yml:lighthouse release.yml:screenshots; do
  file=${entry%%:*}
  job=${entry#*:}
  path=$(printf '%s\n' $workflows | grep -E "(^|/)$file\$" | head -n1 || true)
  if [ -z "$path" ]; then
    fail "no workflow named $file in WORKFLOWS ($workflows), so job '$job' can't be checked"
    continue
  fi
  block=$(job_block "$path" "$job")
  [ -n "$block" ] || { fail "$path has no job '$job'"; continue; }
  printf '%s\n' "$block" | grep -Eq '^\s+image: ghcr\.io/alrayyes/ci-playwright:' || fail "$path job '$job' does not run in the CI image"
  printf '%s\n' "$block" | grep -Eq '^\s+options: .*--ipc=host( |$)' || fail "$path job '$job' lacks 'options: --ipc=host'"
  printf '%s\n' "$block" | grep -Eq '^\s+options: .*--init( |$)' || fail "$path job '$job' lacks '--init' in its container options"
  # A real step, not a comment or an echo that mentions the script.
  printf '%s\n' "$block" | grep -Eq '^\s+(- )?run: bash scripts/check-image-bun\.sh$' || fail "$path job '$job' has no 'run: bash scripts/check-image-bun.sh' step to check the image's bun against package.json"
done

# scripts/check-image-bun.sh is the one place the Bun check is written. Prove
# it on its own, including the `+sha512.<hex>` suffix a packageManager field
# can carry, since a regression there only shows when a job runs.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bun_out=
bun_check() { # packageManager installed-bun; leaves the script's output in bun_out
  printf '{"packageManager": "%s"}\n' "$1" >"$tmp/package.json"
  bun_run "$tmp/package.json" "$2"
}
bun_run() { # package.json installed-bun; stderr is kept so a script that can't run fails the match
  local rc=0
  bun_out=$(PACKAGE_JSON="$1" BUN_VERSION="$2" scripts/check-image-bun.sh 2>&1) || rc=$?
  return "$rc"
}
# A refusal counts only when it exits non-zero and says why.
expect_refusal() { # description expected-message-fragment command...
  local what=$1 want=$2
  shift 2
  if "$@"; then
    fail "check-image-bun.sh accepts $what"
  elif ! grep -Fq -- "$want" <<<"$bun_out"; then
    fail "check-image-bun.sh refuses $what without saying '$want' (got: ${bun_out:-nothing})"
  fi
}
bun_check 'bun@1.3.14' 1.3.14 || fail "check-image-bun.sh rejects a matching Bun: $bun_out"
bun_check 'bun@1.3.14+sha512.deadbeef' 1.3.14 || fail "check-image-bun.sh does not drop the +sha512 suffix from packageManager: $bun_out"
expect_refusal "a Bun that differs from packageManager" "bun is 1.3.13, but packageManager names 1.3.14" bun_check 'bun@1.3.14' 1.3.13
expect_refusal "a differing Bun when packageManager has a suffix" "bun is 1.3.13, but packageManager names 1.3.14" bun_check 'bun@1.3.14+sha512.deadbeef' 1.3.13
expect_refusal "a packageManager that is not Bun" "does not name bun@" bun_check 'pnpm@9.0.0' 1.3.14
expect_refusal "a packageManager without a version" "does not name bun@" bun_check 'bun' 1.3.14
printf '{"name": "x"}\n' >"$tmp/package.json"
expect_refusal "a package.json with no packageManager" "does not name bun@" bun_run "$tmp/package.json" 1.3.14
expect_refusal "a missing package.json" "no such file" bun_run "$tmp/absent.json" 1.3.14
printf 'not json\n' >"$tmp/package.json"
expect_refusal "a package.json that is not JSON" "is not valid JSON" bun_run "$tmp/package.json" 1.3.14
# A quote in the path must not reach a JS string literal.
mkdir "$tmp/it's"
printf '{"packageManager": "bun@1.3.14"}\n' >"$tmp/it's/package.json"
bun_run "$tmp/it's/package.json" 1.3.14 || fail "check-image-bun.sh breaks on a quote in the package.json path: $bun_out"

# Not checked here: that each digest is the image built for its tag. That
# needs a registry call (`docker manifest inspect`), so a digest taken from
# another tag still passes the shape check above.

for workflow in $workflows; do
  if grep -Eq 'playwright install' "$workflow"; then
    fail "$workflow still runs 'playwright install'; the image already has the browsers"
  fi
done

exit "$failed"
