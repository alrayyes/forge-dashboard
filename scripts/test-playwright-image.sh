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
# checked. WORKFLOWS must list both ci.yml and release.yml (by file name), since
# the browser jobs are looked up in them; the guard fails if either is missing.
set -euo pipefail

self=$(realpath "${BASH_SOURCE[0]}")
cd "$(dirname "$self")/.."

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
container_block() { # job block: the job's own `container:` lines, not a services: entry
  awk '/^    container:/ {on=1; next} on && /^    [A-Za-z]/ {exit} on' <<<"$1"
}
# Where the Bun check sits among the job's steps: "missing", "guarded" when the
# step has an `if` or `continue-on-error`, "late" when a step that runs bun or
# playwright comes first, else "ok".
bun_step_state() { # job block
  awk '
    /^      - / {n++}
    /run: bash scripts\/check-image-bun\.sh$/ {check = n; next}
    /^      - (if|continue-on-error):|^        (if|continue-on-error):/ {guarded[n] = 1}
    /run: .*(bun |bunx |playwright)/ && !first {first = n}
    END {
      if (!check) print "missing"
      else if (guarded[check]) print "guarded"
      else if (first && first < check) print "late"
      else print "ok"
    }' <<<"$1"
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
  container=$(container_block "$block")
  grep -Eq '^\s+image: ghcr\.io/alrayyes/ci-playwright:' <<<"$container" || fail "$path job '$job' does not run in the CI image"
  grep -Eq '^\s+options: .*--ipc=host( |$)' <<<"$container" || fail "$path job '$job' lacks 'options: --ipc=host' in its container"
  grep -Eq '^\s+options: .*--init( |$)' <<<"$container" || fail "$path job '$job' lacks '--init' in its container options"
  # A real step, not a comment or an echo that mentions the script, that always
  # runs and comes before any step that uses bun or the browsers.
  case $(bun_step_state "$block") in
    ok) ;;
    guarded) fail "$path job '$job' has an 'if' or 'continue-on-error' on its Bun check step, so it can be skipped or ignored" ;;
    late) fail "$path job '$job' runs the Bun check after a step that already uses bun or playwright" ;;
    *) fail "$path job '$job' has no 'run: bash scripts/check-image-bun.sh' step to check the image's bun against package.json" ;;
  esac
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

# The guard on doctored copies of the real workflows: each must fail, and say
# why. The nested run skips this block, so it doesn't recurse.
if [ -z "${PLAYWRIGHT_IMAGE_NESTED:-}" ]; then
  cases=0
  doctored() { # name sed-or-perl-command file-to-doctor expected-message-fragment...
    local name=$1 tool=$2 prog=$3 file=$4 want=$5 dir="$tmp/doctored-$((++cases))" rc=0 out
    mkdir "$dir"
    cp .github/workflows/ci.yml .github/workflows/release.yml "$dir/"
    case $tool in
      sed) sed -i -E "$prog" "$dir/$file" ;;
      perl) perl -0pi -e "$prog" "$dir/$file" ;;
    esac
    if cmp -s ".github/workflows/$file" "$dir/$file"; then
      fail "doctoring '$name' changed nothing, so the case proves nothing"
      return
    fi
    out=$(PLAYWRIGHT_IMAGE_NESTED=1 WORKFLOWS="$dir/ci.yml $dir/release.yml" "$self" 2>&1) || rc=$?
    if [ "$rc" -eq 0 ]; then
      fail "the guard passes a workflow with $name"
    elif ! grep -Fq -- "$want" <<<"$out"; then
      fail "the guard fails a workflow with $name without saying '$want' (got: ${out:-nothing})"
    fi
  }
  check_step='        run: bash scripts/check-image-bun.sh'
  doctored "an if on the Bun check" sed "s|^$check_step\$|        if: false\n&|" ci.yml "has an 'if' or 'continue-on-error'"
  doctored "continue-on-error on the Bun check" sed "s|^$check_step\$|        continue-on-error: true\n&|" release.yml "has an 'if' or 'continue-on-error'"
  doctored "the Bun check after bun install" perl 's/(      - name: the image.s bun[^\n]*\n        run: bash scripts\/check-image-bun\.sh\n)(      - run: bun install --frozen-lockfile\n)/$2$1/' release.yml "runs the Bun check after"
  doctored "no --init in the container options" sed 's|^(      options: --ipc=host) --init$|\1|' ci.yml "lacks '--init'"
  # A services: entry elsewhere in the job must not stand in for the container's own lines.
  doctored "options only on a service" perl 's/^      options: --ipc=host --init\n//m; s/^    permissions:\n/    services:\n      s:\n        options: --ipc=host --init\n$&/mg' release.yml "lacks 'options: --ipc=host'"
  doctored "the CI image only on a service" perl 's/^(    container:\n)      image: (ghcr[^\n]*)\n/$1      image: ubuntu:24.04\n    services:\n      s:\n        image: $2\n/m' release.yml "does not run in the CI image"
  if out=$(PLAYWRIGHT_IMAGE_NESTED=1 WORKFLOWS=".github/workflows/ci.yml" "$self" 2>&1); then
    fail "the guard passes when WORKFLOWS leaves out release.yml"
  elif ! grep -Fq "no workflow named release.yml" <<<"$out"; then
    fail "the guard fails without release.yml without naming it (got: ${out:-nothing})"
  fi
fi

exit "$failed"
