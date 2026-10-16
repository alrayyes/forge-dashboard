#!/usr/bin/env bash
# govulncheck for the whole module, in the pinned golang image like every other
# Go command here. Run it by hand; it is not a pre-push hook. A hook can't
# compare base and head, so it fails on advisories already on the default
# branch and teaches LEFTHOOK=0, which also skips the tests and gitleaks.
# CI owns the gate: ci.yml's govulncheck job fails a pull request only on what
# it introduces, and dependency-scan.yml keeps the ticket for the rest
# (rules/dependencies.md, #1606).
set -euo pipefail

exec "$(dirname "$0")/go-docker.sh" go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...
