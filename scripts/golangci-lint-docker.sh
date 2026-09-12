#!/usr/bin/env bash
# Runs golangci-lint inside its own pinned image rather than the host
# binary — same reasoning as go-docker.sh, and the same version this
# repo's CI runs (GOLANGCI_LINT_VERSION in .github/workflows/ci.yml).
# rules/go-lint.md has the full invocation this mirrors.
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p "$HOME/.cache/go-build-docker" "$HOME/.cache/golangci-lint-docker"

docker run --rm --user "$(id -u):$(id -g)" \
  -v "$(pwd):/src" -w /src \
  -e GOCACHE=/gocache -v "$HOME/.cache/go-build-docker:/gocache" \
  -e GOLANGCI_LINT_CACHE=/cache -v "$HOME/.cache/golangci-lint-docker:/cache" \
  golangci/golangci-lint:v2.13.1@sha256:d371321370bf2907bd13a8f6f8baff0e0ca7438d76fdf636b281eadf7e2305e3 \
  "$@"
