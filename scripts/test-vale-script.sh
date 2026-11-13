#!/usr/bin/env bash
# scripts/vale.sh has to run the Vale version CI runs. A newer binary on PATH
# misses errors the pinned one reports, so the hook passes and CI fails. Stub
# `vale` and `docker` on a private PATH and check the four ways it can go.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pinned=$(grep -Eo 'jdkato/vale:v[0-9.]+' "$root/scripts/vale.sh" | head -n1 | sed 's/.*:v//')

failed=0
fail() {
  echo "FAIL: $1"
  failed=1
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# stubs <vale-version|-> <docker yes|no>: a fresh bin dir with only what's asked.
stubs() {
  local bin="$work/bin"
  rm -rf "$bin" && mkdir -p "$bin"
  for tool in bash dirname id pwd sed grep head cut tr; do
    ln -s "$(command -v $tool)" "$bin/$tool"
  done
  # shellcheck disable=SC2016
  if [ "$1" != - ]; then
    printf '#!/bin/sh\nif [ "$1" = --version ]; then echo "vale version %s"; else echo "ran-binary $*"; fi\n' "$1" >"$bin/vale"
    chmod +x "$bin/vale"
  fi
  if [ "$2" = yes ]; then
    printf '#!/bin/sh\necho "ran-docker $*"\n' >"$bin/docker"
    chmod +x "$bin/docker"
  fi
  echo "$bin"
}

has() { printf '%s' "$1" | grep -Eq -- "$2"; }
run() { PATH="$1" /usr/bin/env bash "$root/scripts/vale.sh" x.md 2>&1 || echo "exit=$?"; }

out=$(run "$(stubs "$pinned" yes)")
case "$out" in *ran-binary*) ;; *) fail "a vale at the pinned version should run: $out" ;; esac

out=$(run "$(stubs 9.9.9 yes)")
case "$out" in *ran-docker*"jdkato/vale:v$pinned@sha256:"*) ;; *) fail "another version with Docker should run the pinned image: $out" ;; esac

out=$(run "$(stubs 9.9.9 no)")
if ! { has "$out" "exit=[1-9]" && has "$out" "9.9.9" && has "$out" "$pinned"; }; then
  fail "another version without Docker should fail naming both versions: $out"
fi

out=$(run "$(stubs - yes)")
case "$out" in *ran-docker*) ;; *) fail "no vale with Docker should run the pinned image: $out" ;; esac

out=$(run "$(stubs - no)")
if ! { has "$out" "exit=127" && has "$out" "Docker"; }; then
  fail "neither should fail and say what to install: $out"
fi

exit "$failed"
