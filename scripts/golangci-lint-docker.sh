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
  golangci/golangci-lint:v2.14.0@sha256:ad862ba6b3798cbe0fd9fd7408d498fd74fbd2623a92406b2fd3898faf0bf98f \
  "$@"
