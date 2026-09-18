# Tasks

## 1. Repo bootstrap (per language)

- [ ] 1.1 Create `forge-dashboard-sdk-go` from the Go CLI/library scaffold via `skills/repo-creation/`, and verify it builds with an empty client
- [ ] 1.2 Create `forge-dashboard-sdk-node` from the TypeScript scaffold, and verify it builds
- [ ] 1.3 Create `forge-dashboard-sdk-python` from the Python scaffold, and verify it builds
- [ ] 1.4 Create `forge-dashboard-sdk-php` from the PHP scaffold, and verify it builds

## 2. Spec pipeline (per language)

- [ ] 2.1 Add `api/openapi.yaml` as a git submodule (from `forge-dashboard`) in each of the four repos, and verify `git submodule update --remote` pulls the current spec
- [ ] 2.2 Wire each repo's own codegen tool (per that language's own ecosystem convention) to generate a client from the submoduled spec, and verify a first generation produces working, compiling/importable code
- [ ] 2.3 Add the `codegen.yml`-shaped daily cron + `workflow_dispatch` + `repository_dispatch` workflow to each repo, modeled on `hush-hush-go`'s own, and verify a manual `workflow_dispatch` run opens a regeneration PR against a deliberately stale submodule pin
- [ ] 2.4 Wire `oasdiff` breaking-change classification into each repo's regeneration PR, driving its Conventional Commits marker, and verify both an additive and a breaking spec change produce the right marker
- [ ] 2.5 Confirm no auto-merge step exists on any of the four regeneration workflows, per `rules/sdk-generation.md`

## 3. Cross-repo notification

- [ ] 3.1 Add a step to `forge-dashboard`'s own CI that fires `repository_dispatch` (type `spec-updated`) to all four SDK repos when `api/openapi.yaml` changes on `main`, and verify it fires on a real spec-changing PR merge

## 4. Auth and quickstart (per language)

- [ ] 4.1 Implement the `bearerAuth` token credential as each SDK's primary auth option, and verify an example call succeeds against a real forge-dashboard instance using a personal API token
- [ ] 4.2 Write each repo's README quickstart documenting the token flow (matching `pipeline-analytics-sdk-go`'s README as a shape reference, since forge-dashboard's token story is actually simpler — no cookie-only fallback needed)

## 5. Release and publish (per language)

- [ ] 5.1 Wire release-please + the language's own release tooling into each repo, matching the reference repos' existing setup
- [ ] 5.2 Publish each SDK to its ecosystem's registry (npm, PyPI, pkg.go.dev, Packagist) on first real release, per `rules/releases.md`
