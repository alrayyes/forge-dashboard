#!/usr/bin/env bash
# Merges web/build (SvelteKit's adapter-static output) into
# internal/api/static, which //go:embed all:static reads at compile time.
# A plain `cp -a` merge, not a mirror: internal/api/static still holds
# hand-written pages that haven't migrated to Svelte yet, and this must
# never delete them. Only paths a migrated page's build can produce —
# web/build's own filenames, plus the shared _app/ asset directory — are
# gitignored on the receiving end, so a merge here is always safe to rerun.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -d web/build ]; then
  echo "sync-web-build.sh: web/build doesn't exist -- run 'bun --cwd web run build' first" >&2
  exit 1
fi

cp -a web/build/. internal/api/static/
