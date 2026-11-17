#!/usr/bin/env bash
# Measures the dashboard's memory through its first refresh against a synthetic
# GitHub account (#3554, docs/running.md "Measuring the peak").
#
#   scripts/memory-bench/run.sh build
#   scripts/memory-bench/run.sh peak REPOS            # peak at --memory=512m
#   scripts/memory-bench/run.sh min REPOS [LIMIT...]  # smallest limit that holds
#
# `build` makes the image from the repo's own Dockerfile with one change: the
# GitHub API base URL is baked in (the app only takes it as a test hook), so it
# talks to the fake server on the host network instead of GitHub. `peak` and
# `min` start the fake (fake-github.go) with REPOS repositories, save a dummy
# token so the first refresh starts at boot, then start the container, wait for
# the refresh, and read cgroup memory.peak (cgroup v2, kernel 5.19+) and the
# process's own VmHWM. Each figure is the largest of one start and three
# `docker restart`s. A limit "holds" when none of the four starts is OOM-killed
# or restarted by Docker. One container at a time; nothing real is contacted.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
IMAGE=forge-dashboard-membench
NAME=fd-membench-$$
FAKE_PORT=${FAKE_PORT:-28081}
APP_PORT=${APP_PORT:-28080}
RESTARTS=${RESTARTS:-3}
WORK=$(mktemp -d)
FAKE_PID=""

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

build() {
  sed "s|-ldflags=\"-s -w\"|-ldflags=\"-s -w -X main.githubAPIBaseURL=http://127.0.0.1:$FAKE_PORT\"|" \
    "$ROOT/Dockerfile" >"$WORK/Dockerfile"
  grep -q 'main.githubAPIBaseURL' "$WORK/Dockerfile"
  docker build -q -f "$WORK/Dockerfile" -t "$IMAGE" "$ROOT"
}

start_fake() {
  (cd "$ROOT" && go build -o "$WORK/fake-github" scripts/memory-bench/fake-github.go)
  "$WORK/fake-github" -repos "$1" -addr "127.0.0.1:$FAKE_PORT" >"$WORK/fake.log" 2>&1 &
  FAKE_PID=$!
  sleep 1
}

calls() { curl -s "http://127.0.0.1:$FAKE_PORT/__count"; }

# wait_idle BASE waits until the dashboard has made API calls beyond BASE (the
# count before this start) and then stopped for five seconds, with /readyz
# answering. The refresh is a burst of calls.
wait_idle() {
  local base=$1 last=-1 same=0 start=$SECONDS
  while [ $((SECONDS - start)) -lt 90 ]; do
    local now ready
    now=$(calls)
    ready=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/readyz" || true)
    if [ "$now" -gt "$base" ] && [ "$now" = "$last" ] && [ "$ready" = 200 ]; then
      same=$((same + 1))
      [ "$same" -ge 5 ] && return 0
    else
      same=0
    fi
    last=$now
    sleep 1
  done
  return 1
}

# sample prints "<memory.peak bytes> <VmHWM bytes>" for the running container.
sample() {
  local id pid peak hwm
  id=$(docker inspect --format '{{.Id}}' "$NAME")
  pid=$(docker inspect --format '{{.State.Pid}}' "$NAME")
  peak=$(cat "/sys/fs/cgroup/system.slice/docker-$id.scope/memory.peak")
  hwm=$(awk '/VmHWM/ {print $2 * 1024}' "/proc/$pid/status")
  echo "$peak $hwm"
}

# trial LIMIT REPOS runs one container at LIMIT through one start and
# RESTARTS restarts. It prints "<ok|FAILED> <max peak> <max hwm> <restart count>
# <oom killed>" and always returns 0.
trial() {
  local limit=$1 repos=$2 max_peak=0 max_hwm=0 ok=ok
  rm -rf "$WORK/data" && mkdir "$WORK/data"
  export ENCRYPTION_KEY
  ENCRYPTION_KEY=$(openssl rand -base64 32)
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Run as the caller so the host can seed the database. The image's own user
  # changes nothing about memory.
  docker create --name "$NAME" --network host --user "$(id -u):$(id -g)" \
    --memory="$limit" --memory-swap="$limit" --restart=on-failure:2 \
    -e ENCRYPTION_KEY -e "ADDR=127.0.0.1:$APP_PORT" -e RP_ID=localhost \
    -v "$WORK/data:/data" "$IMAGE" >/dev/null
  # First start creates the database, with no credentials and so no refresh.
  docker start "$NAME" >/dev/null
  for _ in $(seq 60); do
    curl -sf "http://127.0.0.1:$APP_PORT/healthz" >/dev/null && break
    sleep 0.5
  done
  docker stop -t 2 "$NAME" >/dev/null
  (cd "$ROOT" && DB_PATH="$WORK/data/forge-dashboard.db" go run scripts/memory-bench/seed.go "$WORK/data/forge-dashboard.db")
  for i in $(seq 0 "$RESTARTS"); do
    local base
    base=$(calls)
    if [ "$i" = 0 ]; then docker start "$NAME" >/dev/null; else docker restart -t 2 "$NAME" >/dev/null; fi
    if wait_idle "$base"; then
      read -r peak hwm < <(sample)
      [ "$peak" -gt "$max_peak" ] && max_peak=$peak
      [ "$hwm" -gt "$max_hwm" ] && max_hwm=$hwm
    else
      ok=FAILED
      break
    fi
  done
  local restarts oom
  restarts=$(docker inspect --format '{{.RestartCount}}' "$NAME")
  oom=$(docker inspect --format '{{.State.OOMKilled}}' "$NAME")
  { [ "$restarts" != 0 ] || [ "$oom" = true ]; } && ok=FAILED
  echo "$ok $max_peak $max_hwm $restarts $oom"
  docker rm -f "$NAME" >/dev/null
}

mib() { awk -v b="$1" 'BEGIN { printf "%.0f MiB", b / 1048576 }'; }

case ${1:-} in
build) build ;;
peak)
  start_fake "$2"
  read -r status peak hwm restarts oom < <(trial 512m "$2")
  echo "repos=$2 limit=512m status=$status memory.peak=$(mib "$peak") VmHWM=$(mib "$hwm") restarts=$restarts oomKilled=$oom"
  ;;
min)
  repos=$2
  shift 2
  limits=${*:-64m 96m 128m 192m 256m}
  start_fake "$repos"
  for limit in $limits; do
    read -r status peak hwm restarts oom < <(trial "$limit" "$repos")
    echo "repos=$repos limit=$limit status=$status memory.peak=$(mib "$peak") VmHWM=$(mib "$hwm") restarts=$restarts oomKilled=$oom"
    [ "$status" = ok ] && break
  done
  ;;
*)
  sed -n 2,17p "$0"
  exit 2
  ;;
esac
