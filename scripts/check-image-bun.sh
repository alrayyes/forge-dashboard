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
die() {
  echo "check-image-bun: $1" >&2
  exit 1
}

[ -f "$package_json" ] || die "$package_json: no such file"
# The path goes in through the environment, never into the JS source.
command -v node >/dev/null || die "could not run node, which reads $package_json"
node_rc=0
package_manager=$(PACKAGE_JSON_PATH="$package_json" node -e '
  let parsed;
  try {
    parsed = JSON.parse(require("fs").readFileSync(process.env.PACKAGE_JSON_PATH, "utf8"));
  } catch {
    process.exit(2);
  }
  const named = parsed?.packageManager;
  process.stdout.write(typeof named === "string" ? named : "");
') || node_rc=$?
case $node_rc in
  0) ;;
  2) die "$package_json is not valid JSON" ;;
  *) die "could not run node, which reads $package_json (exit $node_rc)" ;;
esac
# Any version after bun@, pre-releases included; the part after `+` is a hash.
if ! [[ $package_manager =~ ^bun@([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)(\+.*)?$ ]]; then
  die "$package_json packageManager '${package_manager:-<unset>}' does not name bun@X.Y.Z"
fi
wanted=${BASH_REMATCH[1]}
have=${BUN_VERSION:-$(bun --version)}
if [ "$have" != "$wanted" ]; then
  echo "the image's bun is $have, but packageManager names $wanted" >&2
  exit 1
fi
