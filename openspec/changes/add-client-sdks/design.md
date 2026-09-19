# Design

## Context

See proposal.md - Why. `api/openapi.yaml` is a real, reviewed, hand-written spec (this project's own "spec first" convention) with a documented `bearerAuth` scheme backed by real personal API tokens (`POST /api/tokens`). This account already has a proven, working reference implementation of exactly this pattern — spec-driven, four-language, auto-regenerating SDKs — in `hush-hush-{go,node,python,php}`, and a second confirmed instance in `pipeline-analytics-sdk-{node,python,go,php}`. This design is deliberately not novel: it's "do what those repos do, pointed at a different spec."

## Goals / Non-Goals

**Goals:**

- Four SDKs that stay in sync with `api/openapi.yaml` automatically, with no hand-maintained client code to drift from the spec.
- Every regeneration goes through real review before merging, never silently auto-merged, regardless of how large or small the diff looks.

**Non-Goals:**

- No new forge-dashboard API surface — the SDKs consume what `api/openapi.yaml` already documents. Any endpoint gap discovered during SDK work is a separate forge-dashboard change, not folded into this one.
- No change to forge-dashboard's own auth model. The SDKs use the existing `bearerAuth` token flow as-is.

## Decisions

**Reuse the `hush-hush-*`/`pipeline-analytics-sdk-*` pipeline wholesale, not a new design.** Confirmed live (this session) against both families' own workflows. `hush-hush-go`'s `codegen.yml` submodules the source spec; `pipeline-analytics-sdk-go`/`-node` — the newer, more current sibling family, wrapping this same author's own service's own spec, the closer analog to forge-dashboard than `hush-hush-*`'s different-shaped API — instead pull a pinned copy via a `hack/fetch-spec.sh` step plus an `openapi/SPEC_COMMIT` file naming the exact upstream commit it was generated from, the other spec-pinning shape `rules/sdk-generation.md`'s "One spec, many SDKs" section explicitly sanctions alongside a submodule. Built and proven live against two of the four repos (`forge-dashboard-sdk-go`, `forge-dashboard-sdk-node`): the fetch-script pattern is what all four repos actually use, not a submodule. Either way, the change is diffed against the last-generated commit with `oasdiff`, classified as breaking or not, and opened as a PR carrying that classification as a Conventional Commits marker so release-please computes the right semver — with no auto-merge step, per `rules/sdk-generation.md`. Alternative considered: a single monorepo with four SDK packages — rejected, since it breaks from the account's own established one-repo-per-language convention and each ecosystem's registry (npm/PyPI/pkg.go.dev/Packagist) expects its own repo-shaped release cadence anyway.

**Language-specific codegen tool stays per-repo, chosen to match each language's own ecosystem convention** (as the existing `hush-hush-*`/`pipeline-analytics-sdk-*` repos already do per language — e.g. PHP's own `scripts/generate.sh`), not one universal generator forced across all four. Each new repo's actual generator choice is an implementation detail for that repo's own setup, not a forge-dashboard-side decision.

**Auth**: each SDK exposes the `bearerAuth` token as its primary credential option (matching forge-dashboard's own `components.securitySchemes.bearerAuth` description of it as "an alternative to the session cookie" for scripts) — no SDK attempts to drive a WebAuthn ceremony itself, the same restraint `pipeline-analytics-sdk-go`'s own README already documents for its own (cookie-only, no token) auth story, except forge-dashboard's real advantage here is that the token path already exists and is documented.

**Bootstrap each repo from its `pipeline-analytics-sdk-*` sibling, not the generic language scaffolds.** The six `skills/repo-creation/` scaffolds have never solved this specific problem (a spec-driven, auto-regenerating SDK family); cloning the sibling repos starts from something that already has, keeping all four SDK repos structurally consistent with each other rather than splitting the family across two different origins for no real gain.

**`repository_dispatch` event type: `openapi-spec-updated`, not `spec-updated`.** Requested directly by name in the issue's own follow-up comment, and already the type both built repos' `regenerate.yml` listens for — the forge-dashboard-side sender (task 3.1) has to match whatever the receivers actually use.

## Risks / Trade-offs

- **Four new repos to maintain indefinitely** (dependency bots, CI, releases) for a personal dashboard tool with an unclear number of real external consumers. → Mitigation: the codegen/release pipeline is close to zero-maintenance once wired up (the same daily-cron-plus-PR pattern already running unattended on the reference repos); the real ongoing cost is reviewing regeneration PRs when the spec changes, which is small and infrequent.
- **Spec drift risk if `api/openapi.yaml` changes land without the SDKs' daily codegen job noticing quickly.** → Mitigation: `repository_dispatch` (already part of the reference pattern) lets forge-dashboard's own CI notify each SDK repo the moment the spec changes, rather than waiting for the next daily cron tick.

## Migration Plan

Purely additive — four brand-new repos, no existing forge-dashboard behavior touched. No rollback concerns beyond archiving a repo if the whole effort is abandoned.
