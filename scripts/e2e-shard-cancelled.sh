#!/usr/bin/env bash
# Runs when an e2e shard is cancelled. Actions cancels a job for two reasons
# and gives the same log ending for both: the job's timeout-minutes, or a newer
# push cancelling the run (concurrency). Only the first means the split is
# stale, so tell them apart by elapsed time: a timeout fires at the limit, a
# push cancel comes whenever the push does. Time spent pulling the image
# counts toward the limit but happens before the start is recorded: runs here
# lose 21 to 25 seconds to it, so allow 40. A push landing in that last 40
# seconds is called a timeout; the message points at a check anyway, so the
# cost is one look at the durations.
#
# Env: SHARD, SHARD_TOTAL, LIMIT_MINUTES, STARTED (epoch seconds, may be
# empty), NOW (epoch seconds, defaults to the clock).
set -euo pipefail

slack=40
now=${NOW:-$(date +%s)}
limit=$((LIMIT_MINUTES * 60))
label="shard ${SHARD}/${SHARD_TOTAL}"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}

case "${STARTED:-}" in
'' | *[!0-9]*)
  echo "::notice::e2e $label was cancelled; its start time wasn't recorded, so the cause is unknown."
  exit 0
  ;;
esac

elapsed=$((now - STARTED))
shown="$((elapsed / 60))m$((elapsed % 60))s"

if [ "$elapsed" -ge $((limit - slack)) ]; then
  msg="e2e $label hit the ${LIMIT_MINUTES} minute limit after $shown. The split is stale or the suite needs another shard: see the e2e shard split in CONTRIBUTING.md."
  echo "::error title=e2e shard timed out::$msg"
  echo "**$msg**" >>"$summary"
else
  echo "::notice::e2e $label was cancelled after $shown, under the ${LIMIT_MINUTES} minute limit (not the timeout, usually a newer push)."
  echo "e2e $label was cancelled after $shown, under the ${LIMIT_MINUTES} minute limit: not the timeout, usually a newer push." >>"$summary"
fi
