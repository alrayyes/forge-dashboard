# Contributing

## Getting set up

- **Go 1.27 or newer.**
- **[bun](https://bun.sh)** for the tooling that isn't Go — commitlint,
  Prettier, markdownlint, [Redocly](https://redocly.com/docs/cli), and
  [Playwright](https://playwright.dev) for the accessibility journey test.
- **[golangci-lint](https://golangci-lint.run) v2.14.0**, which the
  pre-commit hook runs from your `PATH` while CI runs it pinned. Install
  that version rather than whichever is current: when the two disagree,
  the hook passes and the pipeline fails, and the reason isn't obvious
  from the failure.
- **[Vale](https://vale.sh)**, for the style tier of the prose lint. Nothing to
  install: `scripts/vale.sh` runs the `vale` on your `PATH` if there is one,
  and otherwise the pinned `jdkato/vale` image through Docker, the same one
  CI uses.

  `ltex-cli-plus` needs nothing installed: the hook fetches and caches it
  on first use.

- **Docker**, for `internal/forgejo`'s container-based integration test
  (real testcontainers-go, a real Forgejo instance — see its own file
  header for why) and for building the image locally.
- Nothing extra for `internal/auth`'s tests — the SQLite driver
  (`modernc.org/sqlite`) is pure Go, and the WebAuthn ceremony tests drive
  the real protocol against a virtual authenticator
  (`github.com/descope/virtualwebauthn` at the Go level,
  Playwright + Chrome DevTools Protocol's `WebAuthn` domain at the
  browser level) rather than a physical key or a stand-in for this
  repo's own code.

One command installs the linters and the git hooks:

```sh
bun install
```

## Everyday commands

Every one of these is what a hook or CI runs — see `lefthook.yml` and
`.github/workflows/*.yml` for exactly which.

CI runs a job only when a file it reads changed. The first job, `changes`,
maps the pull request's diff to areas with `scripts/changed-areas.sh`, and
each job runs when its area is set:

| Area       | Changes that set it                                                            | Jobs                                                                     |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `go`       | Go files, `go.mod`, `api/openapi.yaml`, `integration/`                         | `lint`, `test`, `build`, `container-integration`, `govulncheck`, `gomod` |
| `web`      | `web/`, `tests/`, `.semgrep/`, `package.json`, `biome.json`                    | `js`, `svelte-check`, `tests-types`, `audit`, `semgrep`                  |
| `image`    | Go, web or Docker changes                                                      | `docker`, `e2e`                                                          |
| `hadolint` | `Dockerfile*`, `.dockerignore`                                                 | `dockerfile`                                                             |
| `prose`    | Markdown, `.yml`, `.svelte`, `styles/`, `scripts/lint-*.sh`, `scripts/vale.sh` | `prose`                                                                  |
| `api`      | `api/`, `redocly.yaml`, `.spectral.yaml`, `package.json`                       | `api`, `api-security`                                                    |
| `release`  | `.goreleaser.yml`                                                              | `goreleaser`                                                             |

A path the script doesn't know runs everything, and so does every push to
`main` and any change to `ci.yml`. Skipped jobs report as skipped, which
satisfies a required check. Add a case to `scripts/test-changed-areas.sh`
when you add a rule.

```sh
go build ./...
go vet ./...
go test ./...                                    # unit + handler tests
go test -tags=integration ./integration/... -v   # real Forgejo in a container
scripts/govulncheck.sh    # by hand; no audit runs in pre-push, CI owns that gate
golangci-lint run
golangci-lint fmt          # the fixer; `run` stays the check

./tests/run-local.sh       # the Playwright suite in one command, see below
bun run check:tests        # tsc over the tests; Playwright itself never type-checks
bun run format:check       # bun run lint:md, lint:api, lint:prose, lint:mechanics too
```

### Dependency advisories

A pull request that changes `go.mod`, `go.sum`, `package.json` or `bun.lock`
runs `govulncheck` (Go) and `bun audit` through the shared
[`alrayyes/advisory-scan`](https://github.com/alrayyes/advisory-scan) action in
gate mode: it audits the base and the head and fails only on advisories the
head adds. A newly published advisory does not turn an unrelated pull request
red. `.github/workflows/dependency-scan.yml` audits the default branch daily,
on every push that changes a lock file, and by hand, and keeps one open issue
titled `Dependency advisories` with what it finds. It closes the issue when
the audit is clean. There is no ignore list anywhere: an advisory with no fix
stays in that issue until one ships. No audit runs in pre-push: a hook can't
compare base and head, so it would fail on advisories already on `main` and
push you towards `LEFTHOOK=0`, which also skips the tests and the secrets
scan. Run the audits yourself when you want them: `bun audit` and
`scripts/govulncheck.sh`.

### Comparing with real GitHub

The unit tests for merge status and allowed actions use handwritten GitHub
payloads, so they prove the code matches what we assumed GitHub says. The
`ghfixture` tests ask GitHub itself. They compare, pull request by pull
request, GitHub's `mergeStateStatus`, draft flag, behind count, auto-merge
state and merge methods with what the dashboard shows, in the public repo
`alrayyes/forge-dashboard-e2e-fixture`.

```sh
scripts/e2e-fixture/reset.sh                 # close every PR, delete base/ and head/ branches
scripts/e2e-fixture/build.sh /path/to/clone  # one open PR per state, a clone of the fixture repo
GITHUB_TOKEN=$(gh auth token) go test -tags ghfixture -run TestGitHubState -v ./integration/
```

The test prints one row per pull request: what GitHub says, what the dashboard
says, and the verdict. Needs:

- `gh` logged in as the fixture repo's owner (the tests read `viewerCanMergeAsAdmin`,
  change merge settings and open and merge pull requests of their own).
- The fixture built, and its checks finished. Two pull requests hold a "slow" check
  pending for 55 minutes, so run the test within that window or rebuild.

A difference that is deliberate (an empty or stacked pull request, which the
dashboard blocks and GitHub allows; the owner's merge past requirements,
which the dashboard never offers) is listed in the test by reason, so the run
passes and the table still shows it. A difference that is a bug is listed
with its ticket until the fix lands, and the test fails once the entry is
stale.

It stays out of CI. The workflow's `GITHUB_TOKEN` is scoped to this repository,
so it can't read or change the fixture repo, and a personal access token with
admin rights on a repo to run on a schedule isn't worth the exposure.

### Running the Playwright suite locally

`./tests/run-local.sh` builds the binary, starts it on a throwaway SQLite
database and a random key, runs the suite, and removes everything after.
The first-user setup (`tests/admin-global-setup.ts`) only works on an empty
database, so a fresh one per run is the point: don't point the suite at a
database you've used before. Extra arguments go to Playwright
(`./tests/run-local.sh tests/auth.spec.ts --workers=2`), and `PORT=8081`
moves it off 8080 when a dev server is already running there.

A run takes about two minutes on 16 cores. Locally it uses the default worker
count; CI uses one worker and one retry. A red run that passes alone usually
means a test raced the page, so fix the wait rather than adding a retry. A
test that stays flaky gets `test.fixme`/an annotation naming the reason and a
linked issue.

Specs import `test` from `tests/fixtures.ts`, not from `@playwright/test`. It
is Playwright's own `test` with one addition: mocked snapshots whose pull
requests don't state `allowedActions`, `status` or `kind` get them filled in
from a table the Go rules generate (`tests/allowed-actions-stand-in.ts` looks
a mocked pull request up in `tests/generated/allowed-actions.json`). A spec that
wants to say exactly what the server answered sets `allowedActions` itself, as
`tests/allowed-actions.spec.ts` does. When `internal/dashboard/allowed_actions.go`,
`pull_request_status.go` or `bot_pr.go` changes, `go test ./internal/dashboard`
fails until the table is regenerated with `UPDATE_FIXTURES=1 go test
./internal/dashboard -run TestAllowedActionsFixture`; commit the result. A mock
whose raw fields the table has no value for fails loudly: widen the axis in
`allowed_actions_fixture_test.go`.

The nav badges work the same way. A mocked `/api/dashboard` takes its `navCounts`
from `navCountsFor` in `tests/nav-counts-helper.ts`, which adds up what
`tests/generated/nav-counts.json` says each pull request and branch contributes.
`go test ./internal/api` fails when `buildNavCounts` or a field name changes
until `UPDATE_FIXTURES=1 go test ./internal/api -run TestNavCountsFixture`
regenerates it.

## Unit tests

A rule that needs no browser is tested without one. `web/src/lib/*.test.ts`
runs under `bun test` (`bun run test:unit`): about 10 ms for a module, no
server, no Chromium. Today that's `insights.ts` (the age buckets and repo
ranking behind the Insights page), `failure-details.ts`,
`hidden-pull-requests.ts`, `confirm-arm.ts`, `filters.ts` (the choices a
filter offers) and the wording half of `wait-chip.ts`. Move a rule here when it
is a pure function of its inputs, and keep the Playwright journey only for what
the page does with the answer.

Two things to know. Unit tests live under `web/src`, not `tests/`, because
Playwright picks up any `tests/*.test.ts` and a bare `bun test` fails on
Playwright specs. And `bun test` has no Svelte compiler, so it can't load a
`.svelte.ts` rune module (`$state is not defined`) or render a component. When a
test first needs one, add Vitest with `vite-plugin-svelte` for those files; the
options and measurements are on
[#1383](https://github.com/alrayyes/forge-dashboard/issues/1383).

## How it fits together

- `api/openapi.yaml` is the contract — handwritten and reviewed as the
  design — see `internal/api`'s handlers for what implements it.
  Two value lists are open on purpose: `AllowedAction.action` and
  `AllowedAction.blocked.code` use `x-extensible-enum`, so a new value is a
  minor SDK release (`oasdiff` calls a new value in a closed `enum` breaking).
  Every other list stays closed. `kin-openapi` doesn't check an extension, so
  `internal/api/openapi_extensible_enums_test.go` holds the Go list. Add a
  new action or code there, in the spec, and where the server emits it.
- `internal/dashboard` is the domain: the `PullRequest`/`Issue`/`Snapshot`
  model, the `Source`/`ForgeClient` interfaces, the `Aggregator` that
  refreshes one user's snapshot in the background so a request never
  blocks on either forge, and the `Manager` that owns one `Aggregator`
  (and its refresh goroutine) per signed-in user.
- `internal/github` and `internal/forgejo` are the two adapters — thin,
  handwritten REST clients, each wrapped in a `dashboard.GenericSource`
  rather than duplicating the concurrency/error-handling logic per forge.
- `internal/auth` is passkey registration, login, sessions, admin
  user-management, and invite-gated registration — `Store` persists
  users/credentials/sessions/invites to SQLite (plus
  `ListUsers`/`RevokeUser`/`DeleteUser` and
  `CreateInvite`/`ConsumeInviteIfValid`/`ListOutstandingInvites`/
  `RevokeInvite` for the admin area), `Service` drives the WebAuthn
  ceremonies against `Store` and requires a valid invite for every
  registration past the first, `RequireAuth` is the middleware that
  gates a handler on a valid session, and `RequireAdmin` composes inside
  it to gate one on the session's own `IsAdmin` flag.
- `internal/settings` is each user's own GitHub/Forgejo configuration —
  `Cipher` is AES-256-GCM encryption keyed off `ENCRYPTION_KEY`, and
  `Store` persists it to SQLite with the tokens encrypted, never in
  plaintext.
- `internal/sharing` tracks who's granted whom read-only access to their
  dashboard — `Store` owns nothing about what a dashboard actually is,
  just the owner/viewer relationship; `internal/api`'s dashboard handler
  is what turns a granted share into an actual `dashboard.Manager`
  lookup for the owner's snapshot instead of the caller's own.
- `internal/api/static` is the frontend, embedded into the binary with
  `//go:embed` — SvelteKit throughout (`web/src/routes`, built with
  `bun run build:web` and merged in by `scripts/sync-web-build.sh`),
  migrated incrementally, one page at a time, now complete.
  `web/src/routes/(app)` is that route group's own shared layout
  (header, nav — a persistent top nav plus a mobile bottom tab bar
  below `web/src/style.css`'s 420px breakpoint, real Svelte state —
  a shared `Footer` component (`web/src/lib/Footer.svelte`, real Svelte
  state, also used directly by `web/src/routes/login`), theme
  sync), and every page under it gets that chrome, including the
  dashboard
  (`web/src/routes/(app)/+page.svelte`) and the three pages that stay
  reachable without a session (`releases`, `disclaimer`, `privacy`, a
  route check in the layout rather than living outside the group). The
  dashboard is the one page with header-adjacent content nothing else
  needs (forge health, the dashboard-owner switcher, the refresh
  button) — its own plain, non-landmark markup rather than merged into
  the shared `<header>`, since a layout renders that before any child
  page's own script runs at all. `web/src/routes/login` is the one page
  genuinely outside `(app)` — no persistent nav chrome to inherit before
  a session exists. Settings
  (`web/src/routes/(app)/settings`) is where a signed-in user sets
  their own tokens, theme, and manages sharing; admin
  (`web/src/routes/(app)/admin`) is the admin's user list, reachable by
  anyone with a session but functionally gated by every API call it
  makes 403ing for a non-admin.
- `cmd/forge-dashboard` is the composition root: reads environment
  variables, wires the auth service, the settings store, and the
  dashboard manager, and serves the API and static files. A session's
  own `AppContext` (not the request's — see `internal/api.Deps`'s own
  comment) roots each user's background refresh goroutine so it outlives
  the HTTP request that started it.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): description`, types `feat`/`fix`/`docs`/`style`/`refactor`/
`perf`/`test`/`build`/`ci`/`chore`/`revert`. Subject under 50 characters,
lowercase, no trailing full stop. commitlint enforces the shape at
commit-msg and again in CI; the length and case rules are tighter than
what it checks, so hold to them anyway.

A `feat`, `fix` or `perf` commit has to change something that ships:
`cmd/`, `internal/`, `web/`, `api/`, `go.mod`, `go.sum`, a `Dockerfile` or
`.goreleaser.yml`, and not a test, a Markdown file or CI config.
Otherwise release-please cuts a version and a changelog entry for a change
nobody gets. Type a docs, test, CI or tooling change `docs`, `test`, `ci`,
`build` or `chore`. `scripts/check-release-type.sh` fails the commit at
commit-msg, and in CI for each commit and for the pull request title.

## Branching, review, and release

Every change goes through a pull request — nothing is pushed straight to
`main`. The pull request **title** has to be a valid Conventional Commit
too — `pr-title.yml` checks it, since a squash merge defaults its commit
message to the pull request title.

Once a pull request's checks are green, squash-merge it and delete the
branch. [release-please](https://github.com/googleapis/release-please)
reads the Conventional Commits on `main` and keeps a release pull request
open with the next version and changelog entry; merging that one tags the
release. [goreleaser](https://goreleaser.com) then builds the binaries and
pushes the `ghcr.io/alrayyes/forge-dashboard` image goreleaser's own
`dockers:` block describes. Nobody picks a version by hand.

If a release job dies after release-please created the release (a token
missing a permission, say), the release exists with no assets and a re-run
only hits `already_exists`. Dispatch the `release` workflow by hand with the
tag (`gh workflow run release.yml -f tag=vX.Y.Z`). It only repairs a
half-published release: the tag must be `vX.Y.Z`, the latest release, and
have no assets. goreleaser pushes the image and the `latest` manifest before
it uploads assets, so any other tag would be refused before a build starts.
A release that a newer one has superseded is left as it is, with a note in its
release body pointing at the newer release (v0.194.0 is one: v0.194.1 shipped
fully). This path is the safety net for a future half-published latest
release, not for catching up an old one.
After a partial upload, delete the assets from the release by hand first; a
second upload fails on `already_exists`. The dispatch builds the binaries and
the image from that tag onto the release already there. It creates no release
and moves no tag, but it does push the image tags for that version and
`latest` to ghcr.io. A dispatched run's provenance attestation names `main` at
dispatch time as the source ref, not the tag's commit, so verify with
`gh attestation verify --repo alrayyes/forge-dashboard`, not `--source-ref`.
