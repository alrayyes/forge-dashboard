#!/usr/bin/env bash
# A shard cancelled by its job timeout used to end at "The operation was
# canceled." with nothing saying it ran out of time (#4734). This checks the
# e2e-shard job records its start, runs scripts/e2e-shard-cancelled.sh on
# cancelled(), and passes the same limit as its timeout-minutes. It also runs
# the script for both cancel causes: a timeout names the limit, a newer push
# (cancelled well before the limit) must not claim one.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

failed=0
fail() {
  echo "FAIL: $1"
  failed=1
}

ci=.github/workflows/ci.yml
script=scripts/e2e-shard-cancelled.sh

# The e2e-shard job block: from its key to the next job at the same indent.
job=$(awk '/^  e2e-shard:/{f=1; print; next} f && /^  [a-z0-9_-]+:/{exit} f' "$ci")
[ -n "$job" ] || fail "$ci has no e2e-shard job"

limit=$(printf '%s\n' "$job" | sed -n 's/^    timeout-minutes: \([0-9]*\).*/\1/p' | head -n1)
[ -n "$limit" ] || fail "the e2e-shard job has no timeout-minutes"

printf '%s\n' "$job" | grep -q 'E2E_SHARD_STARTED=' || fail "the e2e-shard job doesn't record its start time"
printf '%s\n' "$job" | grep -q "if: \${{ cancelled() }}" || fail "the e2e-shard job has no step on cancelled()"
printf '%s\n' "$job" | grep -q "$script" || fail "the e2e-shard job doesn't run $script"
if [ -n "$limit" ]; then
  printf '%s\n' "$job" | grep -Eq "LIMIT_MINUTES: \"?$limit\"?\$" ||
    fail "the cancelled step's LIMIT_MINUTES doesn't match timeout-minutes ($limit)"
fi

[ -x "$script" ] || fail "$script is missing or not executable"

if [ -x "$script" ]; then
  run() { # elapsed seconds
    local summary
    summary=$(mktemp)
    SHARD=3 SHARD_TOTAL=6 LIMIT_MINUTES=10 STARTED=1000 NOW=$((1000 + $1)) \
      GITHUB_STEP_SUMMARY="$summary" "$script" >"$summary.out"
    cat "$summary" "$summary.out"
    rm -f "$summary" "$summary.out"
  }

  out=$(run 600)
  case "$out" in *"::error"*"shard 3/6"*"10 minute"*"CONTRIBUTING.md"*) ;; *) fail "a shard cancelled at the limit gets no timeout annotation: $out" ;; esac
  case "$out" in *"hit the 10 minute limit"*) ;; *) fail "the job summary doesn't say the shard hit the limit: $out" ;; esac

  out=$(run 575)
  case "$out" in *"hit the 10 minute limit"*) ;; *) fail "a cancel just inside the grace window isn't treated as a timeout: $out" ;; esac

  out=$(run 120)
  case "$out" in *"hit the"*) fail "a shard cancelled after 2 minutes claims a timeout: $out" ;; esac
  case "$out" in *"::error"*) fail "a shard cancelled by a newer push gets an error annotation: $out" ;; esac
  case "$out" in *"::notice"*"not the timeout"*) ;; *) fail "a cancel before the limit isn't reported as not a timeout: $out" ;; esac

  # No recorded start (the step failed early): say nothing false.
  out=$(SHARD=1 SHARD_TOTAL=6 LIMIT_MINUTES=10 STARTED= NOW=5000 GITHUB_STEP_SUMMARY=/dev/null "$script")
  case "$out" in *"hit the"*) fail "a missing start time claims a timeout: $out" ;; esac
fi

exit "$failed"
