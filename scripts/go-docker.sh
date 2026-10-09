#!/usr/bin/env bash
# Runs a Go toolchain command inside the pinned golang image rather than
# the host binary, so the version doing the work is what go.mod's own `go`
# directive says, not whatever the host package manager currently has —
# those two can drift independently and did, once, on this account.
# rules/go-mod.md has the full reasoning and the exact invocation this
# mirrors.
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p "$HOME/.cache/go-build-docker" "$HOME/.cache/go-mod-docker"

docker run --rm --user "$(id -u):$(id -g)" \
  -v "$(pwd):/src" -w /src \
  -e GOCACHE=/gocache -v "$HOME/.cache/go-build-docker:/gocache" \
  -e GOMODCACHE=/gomod -v "$HOME/.cache/go-mod-docker:/gomod" \
  golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 \
  "$@"
