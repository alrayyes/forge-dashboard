# Proposal

## Why

forge-dashboard's API already documents a genuinely headless-friendly auth path (`bearerAuth`, a personal API token) but has no official client library in any language — every external script has to hand-roll HTTP calls and auth handling against `api/openapi.yaml` itself. See [alrayyes/forge-dashboard#366](https://github.com/alrayyes/forge-dashboard/issues/366).

## What Changes

- Four new repos, one per language (Node, Python, Go, PHP), each an SDK generated from `api/openapi.yaml`.
- Each repo pulls the spec in via a `hack/fetch-spec.sh` step plus a pinned `openapi/SPEC_COMMIT` file (not a copy, and not a git submodule — see design.md's "Decisions") and regenerates its client via a daily codegen job, modeled directly on the already-proven `pipeline-analytics-sdk-*` pattern: `oasdiff`-classified spec diffs drive Conventional Commits severity, release-please computes semver, and every regeneration lands as a PR requiring real review — never auto-merged, per `rules/sdk-generation.md`.
- No changes to forge-dashboard's own runtime behavior or its API surface — this only builds clients against what already exists.

## Capabilities

### New Capabilities

(none — this change produces new external repos/deliverables, not a change to forge-dashboard's own observable behavior; `skip_specs: true` is set in this change's `.openspec.yaml`)

### Modified Capabilities

(none)

## Impact

- No changes to `forge-dashboard` itself beyond what its `api/openapi.yaml` already documents.
- Four new repos: `forge-dashboard-sdk-{node,python,go,php}`, each cloned from its `pipeline-analytics-sdk-*` sibling as a template (not the generic `skills/repo-creation/` scaffolds — see design.md) and wired with the codegen/release pipeline described above.
- Each SDK published to its ecosystem's registry (npm, PyPI, pkg.go.dev, Packagist) per `rules/releases.md`.
