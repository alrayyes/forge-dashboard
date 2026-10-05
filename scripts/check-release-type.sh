#!/usr/bin/env bash
# A feat, fix or perf commit has to change something that ships. release-please
# turns those types into a version and a changelog entry, so one typed on a
# docs, test or CI change cuts a release for nothing (rules/releases.md,
# "Release only when logic code changes").
#
# Logic code is what ships: cmd/, internal/, web/, api/, go.mod, go.sum, the
# Dockerfiles and .goreleaser.yml. Tests, prose, CI and hook config, scripts,
# styles and openspec are not.
#
#   check-release-type.sh check SUBJECT          files on stdin, one per line
#   check-release-type.sh message FILE           the commit-msg hook: FILE's
#                                                subject against the staged files
#   check-release-type.sh range BASE HEAD        every commit BASE..HEAD
#   check-release-type.sh title TITLE BASE HEAD  a pull request title against the
#                                                whole BASE...HEAD diff, since a
#                                                squash merge turns the title
#                                                into the commit
set -euo pipefail

LOGIC_PATHS='cmd/, internal/, web/, api/, go.mod, go.sum, Dockerfile*, .goreleaser.yml'

is_logic() {
  case $1 in
    *_test.go | */testdata/* | *.test.* | *.spec.* | tests/* | *.md) return 1 ;;
    cmd/* | internal/* | web/* | api/* | go.mod | go.sum | Dockerfile* | .goreleaser.yml) return 0 ;;
  esac

  return 1
}

# check SUBJECT, files on stdin. Prints why to stderr and fails when SUBJECT is
# a release type and no file is a logic path.
check() {
  local subject=$1 file
  local release_type='^(feat|fix|perf)(\([^)]*\))?!?: '
  if ! [[ $subject =~ $release_type ]]; then
    cat >/dev/null

    return 0
  fi
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if is_logic "$file"; then
      cat >/dev/null

      return 0
    fi
  done

  return 1
}

explain() {
  echo "  $1" >&2
  echo "  is a feat, fix or perf commit that touches no logic path ($LOGIC_PATHS)." >&2
  echo "  Type it docs, test, ci, build or chore, or include the change that ships." >&2
}

mode=${1:-}
shift || true

case $mode in
  check)
    check "$1"
    ;;
  message)
    subject=$(head -n1 "$1")
    files=$(git diff --cached --name-only)
    # An amend that only rewords stages nothing; CI judges the range instead.
    [ -n "$files" ] || exit 0
    if ! printf '%s\n' "$files" | check "$subject"; then
      explain "$subject"
      exit 1
    fi
    ;;
  range)
    status=0
    for sha in $(git rev-list --no-merges --reverse "$1..$2"); do
      subject=$(git log -1 --format=%s "$sha")
      if ! git diff-tree --no-commit-id --name-only -r --root "$sha" | check "$subject"; then
        explain "${sha:0:7} $subject"
        status=1
      fi
    done
    exit "$status"
    ;;
  title)
    if ! git diff --name-only "$2...$3" | check "$1"; then
      explain "pull request title: $1"
      exit 1
    fi
    ;;
  *)
    echo "usage: $0 check SUBJECT | message FILE | range BASE HEAD | title TITLE BASE HEAD" >&2
    exit 2
    ;;
esac
