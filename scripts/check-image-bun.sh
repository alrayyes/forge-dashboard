#!/usr/bin/env bash
# Fails unless the Bun in the CI image is the one package.json's
# `packageManager` names. The three browser jobs (the e2e shards, Lighthouse
# and the release screenshots) run it as a step, so the parsing lives here once.
# `packageManager` may carry a hash suffix (`bun@1.3.14+sha512.<hex>`); the
# part after `+` is not a version and is dropped.
# PACKAGE_JSON and BUN_VERSION override the file and the installed Bun, for
# scripts/test-playwright-image.sh.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

package_json=${PACKAGE_JSON:-package.json}
wanted=$(node -p "require(require('path').resolve('$package_json')).packageManager.split('@')[1].split('+')[0]")
have=${BUN_VERSION:-$(bun --version)}
if [ "$have" != "$wanted" ]; then
  echo "the image's bun is $have, but packageManager names $wanted" >&2
  exit 1
fi
