#!/usr/bin/env bash
# Runs goreleaser from the official image, pinned by digest, at the version
# the release job runs (v2.17.1 in .github/workflows/release.yml), so the
# hook can't pass a config the release would refuse. rules/go-releases.md.
#
# goreleaser reads git state even for `check`. A linked worktree's .git is a
# file pointing outside the checkout, so the real git directory is mounted at
# its own host path, which makes that pointer resolve inside the container.
set -euo pipefail

cd "$(dirname "$0")/.."

git_dir=$(git rev-parse --path-format=absolute --git-common-dir)

docker run --rm --user "$(id -u):$(id -g)" \
  -v "$(pwd):/work" -w /work \
  -v "$git_dir:$git_dir" \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  goreleaser/goreleaser:v2.17.1@sha256:1098a0be4da1780f9616a85f4c5050447b53e3e74804d8017ec1e2bbb1fb697a \
  "$@"
