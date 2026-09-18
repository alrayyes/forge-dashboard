# Proposal

## Why

forge-dashboard's API already documents a genuinely headless-friendly auth path (`bearerAuth`, a personal API token) but has no official client library in any language — every external script has to hand-roll HTTP calls and auth handling against `api/openapi.yaml` itself. See [alrayyes/forge-dashboard#366](https://github.com/alrayyes/forge-dashboard/issues/366).

## What Changes

- Four new repos, one per language (Node, Python, Go, PHP), each an SDK generated from `api/openapi.yaml`.
- Each repo pulls the spec in as a git submodule (not a copy) and regenerates its client via a daily codegen job, modeled directly on the already-proven `hush-hush-{go,node,python,php}` / `pipeline-analytics-sdk-*` pattern: `oasdiff`-classified spec diffs drive Conventional Commits severity, release-please computes semver, and every regeneration lands as a PR requiring real review — never auto-merged, per `rules/sdk-generation.md`.
- No changes to forge-dashboard's own runtime behavior or its API surface — this only builds clients against what already exists.

## Capabilities

### New Capabilities

(none — this change produces new external repos/deliverables, not a change to forge-dashboard's own observable behavior; `skip_specs: true` is set in this change's `.openspec.yaml`)

### Modified Capabilities

(none)

## Impact

- No changes to `forge-dashboard` itself beyond what its `api/openapi.yaml` already documents.
- Four new repos: `forge-dashboard-sdk-{node,python,go,php}`, each bootstrapped via `skills/repo-creation/`'s language scaffolds and wired with the codegen/release pipeline described above.
- Each SDK published to its ecosystem's registry (npm, PyPI, pkg.go.dev, Packagist) per `rules/releases.md`.
