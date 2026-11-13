#!/usr/bin/env bash
# Runs Vale at the version CI runs: the binary on PATH when it is that version
# (the CI job runs inside the pinned image below, where it is), otherwise the
# same image through Docker. A different version on PATH is never used. rules/markdown.md, "Running Vale", has the reasoning.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Keep in step with the container image in .github/workflows/prose.yml;
# scripts/test-vale-pin.sh fails when they differ.
# renovate: datasource=docker depName=jdkato/vale
VALE_IMAGE=jdkato/vale:v3.17.1@sha256:7dba3c9104ba366f172d119022c4ec53a005f7d14dc1b80e285421a3f0b71657

pinned_version=${VALE_IMAGE#*:v}
pinned_version=${pinned_version%%@*}

# The binary only counts at the pinned version. A newer one skips the
# Vale.Spelling errors the pinned one reports, so the hook would pass and CI
# fail.
if command -v vale >/dev/null 2>&1; then
  found=$(vale --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
  if [ "$found" = "$pinned_version" ]; then
    exec vale "$@"
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "vale on PATH is ${found:-of unknown version}, CI runs $pinned_version." >&2
    echo "Install Vale $pinned_version, or Docker to run $VALE_IMAGE" >&2
    exit 1
  fi
elif ! command -v docker >/dev/null 2>&1; then
  echo "Vale needs either vale $pinned_version on PATH or Docker to run $VALE_IMAGE" >&2
  exit 127
fi

exec docker run --rm --user "$(id -u):$(id -g)" \
  -v "$(pwd):/src" -w /src --entrypoint vale \
  "$VALE_IMAGE" "$@"
