# Tasks

## 1. Repo bootstrap (per language)

- [x] 1.1 Create `forge-dashboard-sdk-go` cloned from `pipeline-analytics-sdk-go` as its template (not the generic Go scaffold — see design.md), adapted for forge-dashboard's own spec/module path/auth, and verify it builds with a real generated client
- [x] 1.2 Create `forge-dashboard-sdk-node` cloned from `pipeline-analytics-sdk-node` as its template, and verify it builds
- [x] 1.3 Create `forge-dashboard-sdk-python` cloned from `pipeline-analytics-sdk-python` as its template, and verify it builds
- [x] 1.4 Create `forge-dashboard-sdk-php` cloned from `pipeline-analytics-sdk-php` as its template, and verify it builds

## 2. Spec pipeline (per language)

- [x] 2.1 Pull `api/openapi.yaml` (from `forge-dashboard`) into each of the four repos via a `hack/fetch-spec.sh` step plus a pinned `openapi/SPEC_COMMIT` file naming the exact upstream commit (not a git submodule — see design.md), and verify the fetch script pulls the current spec
- [x] 2.2 Wire each repo's own codegen tool (per that language's own ecosystem convention) to generate a client from the fetched spec, and verify a first generation produces working, compiling/importable code
- [ ] 2.3 Add the `regenerate.yml`-shaped daily cron + `workflow_dispatch` + `repository_dispatch` (type `openapi-spec-updated` — see design.md) workflow to each repo, modeled on `pipeline-analytics-sdk-go`'s own, and verify a manual `workflow_dispatch` run opens a regeneration PR against a deliberately stale spec pin
  - Workflow file is present and correctly shaped in all four repos, but `regenerate.yml` has never actually run (0 workflow runs on any of the four) — the `workflow_dispatch` verification this task asks for hasn't happened yet.
- [ ] 2.4 Wire `oasdiff` breaking-change classification into each repo's regeneration PR, driving its Conventional Commits marker, and verify both an additive and a breaking spec change produce the right marker
  - oasdiff is wired into `regenerate.yml`'s classify step in all four, but unverified for the same reason as 2.3 — no run has ever exercised it.
- [x] 2.5 Confirm no auto-merge step exists on any of the four regeneration workflows, per `rules/sdk-generation.md`

## 3. Cross-repo notification

- [ ] 3.1 Add a step to `forge-dashboard`'s own CI that fires `repository_dispatch` (type `openapi-spec-updated`) to all four SDK repos when `api/openapi.yaml` changes on `main`, and verify it fires on a real spec-changing PR merge
  - `openapi-dispatch.yml` exists, but its one real run (2026-09-20T09:35, run 35502711713) failed on every per-repo dispatch job: `GH_TOKEN` is referenced but empty (`gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable`) — the `env:` block's token source isn't actually populated. Needs a fix in forge-dashboard's own workflow before this can be checked off.

## 4. Auth and quickstart (per language)

- [ ] 4.1 Implement the `bearerAuth` token credential as each SDK's primary auth option, and verify an example call succeeds against a real forge-dashboard instance using a personal API token
  - Bearer-token auth is implemented in all four clients' code, but none of the four repos has an e2e workflow (no `e2e.yml` in any of them), so "verify against a real instance" has no automated evidence behind it.
- [x] 4.2 Write each repo's README quickstart documenting the token flow (matching `pipeline-analytics-sdk-go`'s README as a shape reference, since forge-dashboard's token story is actually simpler — no cookie-only fallback needed)

## 5. Release and publish (per language)

- [x] 5.1 Wire release-please + the language's own release tooling into each repo, matching the reference repos' existing setup
  - All four already have real cut releases: go v1.0.0, node v1.0.1, python v0.1.2, php v0.1.2.
- [ ] 5.2 Publish each SDK to its ecosystem's registry (npm, PyPI, pkg.go.dev, Packagist) on first real release, per `rules/releases.md`
  - 3 of 4 done: Packagist (`alrayyes/forge-dashboard-sdk-php`) and PyPI (`forge-dashboard-sdk`) are live, and `forge-dashboard-sdk-go` resolves via the Go module proxy. npm is not — `forge-dashboard-sdk-node` publish is blocked on a missing `NPM_TOKEN` repo secret (tracked in forge-dashboard-sdk-node#6).
