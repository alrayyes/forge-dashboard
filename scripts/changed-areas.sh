#!/usr/bin/env bash
# Reads changed file paths on stdin, one per line, and prints one
# `<area>=true|false` line per CI area. ci.yml's `changes` job turns those
# into job outputs, and each job runs only when its area is true
# (rules/ci.md, "Run a check only when the files it covers change").
#
# The areas are what a job reads, not what it is called: the Go tests open
# api/openapi.yaml and the embedded internal/api/static, the image and the
# end-to-end run build the whole app, and prettier checks every yml and
# svelte file, not only Markdown.
#
# A path no rule below knows runs everything. A new top-level file then costs
# a full run instead of a skipped job that could have failed.
set -euo pipefail

go=false web=false image=false hadolint=false prose=false api=false

all() { go=true web=true image=true hadolint=true prose=true api=true; }

while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    .github/workflows/ci.yml | scripts/changed-areas.sh | scripts/test-changed-areas.sh)
      all
      ;;
    # Workflows with their own filter or no gate at all, and files no job
    # in ci.yml reads.
    .github/workflows/* | .github/dependabot.yml | renovate.json | .gitleaks.toml | codecov.yml | \
      release.config.mjs | release-please-config.json | .release-please-manifest.json | LICENSE | \
      .gitignore | .prettierignore | openspec/*)
      ;;
    *.go | go.mod | go.sum | .golangci.yml | integration/* | internal/* | cmd/*)
      go=true
      ;;
    api/*)
      api=true go=true
      ;;
    redocly.yaml)
      api=true
      ;;
    docs/api/*)
      api=true prose=true
      ;;
    docs/* | styles/* | .vale.ini | .ltex.json | .markdownlint* | .prettierrc.json | *.md)
      prose=true
      ;;
    package.json | bun.lock | bunfig.toml)
      web=true api=true prose=true
      ;;
    web/* | tests/* | scripts/* | playwright.config.ts | biome.json | tsconfig.json | lighthouserc.json)
      web=true
      ;;
    Dockerfile | Dockerfile.release | .dockerignore | .hadolint.yaml)
      image=true hadolint=true
      ;;
    lefthook.yml)
      prose=true
      ;;
    *)
      all
      ;;
  esac
  # Prettier and markdownlint cover these wherever they sit, so they count
  # as prose on top of whatever area the path belongs to above.
  case "$path" in
    *.md | *.yml | *.yaml | *.svelte) prose=true ;;
  esac
done

# The image and the end-to-end run build both halves of the app, so a change
# to either one is a change to what they cover.
if [ "$go" = true ] || [ "$web" = true ]; then
  image=true
fi

# The Playwright suite runs against the built binary, so it follows the
# image: Go, web or Docker changes all can break it.
e2e=$image

printf 'go=%s\nweb=%s\nimage=%s\ne2e=%s\nhadolint=%s\nprose=%s\napi=%s\n' \
  "$go" "$web" "$image" "$e2e" "$hadolint" "$prose" "$api"
