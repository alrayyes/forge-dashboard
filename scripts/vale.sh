#!/usr/bin/env bash
# Runs Vale. The binary on PATH when there is one: the CI job runs inside the
# pinned image below, where it is. Otherwise the same image through Docker, so
# a machine with no Vale gets the version CI uses instead of whichever one
# `go install` found. rules/markdown.md, "Running Vale", has the reasoning.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Keep in step with the container image in .github/workflows/prose.yml;
# scripts/test-vale-pin.sh fails when they differ.
# renovate: datasource=docker depName=jdkato/vale
VALE_IMAGE=jdkato/vale:v3.17.1@sha256:7dba3c9104ba366f172d119022c4ec53a005f7d14dc1b80e285421a3f0b71657

if command -v vale >/dev/null 2>&1; then
  exec vale "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Vale needs either a vale binary on PATH or Docker to run $VALE_IMAGE" >&2
  exit 127
fi

exec docker run --rm --user "$(id -u):$(id -g)" \
  -v "$(pwd):/src" -w /src --entrypoint vale \
  "$VALE_IMAGE" "$@"
