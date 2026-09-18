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

**Reuse the `hush-hush-*`/`pipeline-analytics-sdk-*` pipeline wholesale, not a new design.** Confirmed live (this session) against `hush-hush-go`'s `codegen.yml`: it submodules the source spec, diffs it against the last-generated commit with `oasdiff`, classifies the change as breaking or not, and opens a PR carrying that classification as a Conventional Commits marker so release-please computes the right semver — with no auto-merge step, per `rules/sdk-generation.md`. Alternative considered: a single monorepo with four SDK packages — rejected, since it breaks from the account's own established one-repo-per-language convention and each ecosystem's registry (npm/PyPI/pkg.go.dev/Packagist) expects its own repo-shaped release cadence anyway.

**Language-specific codegen tool stays per-repo, chosen to match each language's own ecosystem convention** (as the existing `hush-hush-*`/`pipeline-analytics-sdk-*` repos already do per language — e.g. PHP's own `scripts/generate.sh`), not one universal generator forced across all four. Each new repo's actual generator choice is an implementation detail for that repo's own setup, not a forge-dashboard-side decision.

**Auth**: each SDK exposes the `bearerAuth` token as its primary credential option (matching forge-dashboard's own `components.securitySchemes.bearerAuth` description of it as "an alternative to the session cookie" for scripts) — no SDK attempts to drive a WebAuthn ceremony itself, the same restraint `pipeline-analytics-sdk-go`'s own README already documents for its own (cookie-only, no token) auth story, except forge-dashboard's real advantage here is that the token path already exists and is documented.

## Risks / Trade-offs

- **Four new repos to maintain indefinitely** (dependency bots, CI, releases) for a personal dashboard tool with an unclear number of real external consumers. → Mitigation: the codegen/release pipeline is close to zero-maintenance once wired up (the same daily-cron-plus-PR pattern already running unattended on the reference repos); the real ongoing cost is reviewing regeneration PRs when the spec changes, which is small and infrequent.
- **Spec drift risk if `api/openapi.yaml` changes land without the SDKs' daily codegen job noticing quickly.** → Mitigation: `repository_dispatch` (already part of the reference pattern) lets forge-dashboard's own CI notify each SDK repo the moment the spec changes, rather than waiting for the next daily cron tick.

## Migration Plan

Purely additive — four brand-new repos, no existing forge-dashboard behavior touched. No rollback concerns beyond archiving a repo if the whole effort is abandoned.
