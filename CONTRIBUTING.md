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
  install: `scripts/vale.sh` runs the `vale` on your `PATH` only when it is
  the version CI pins, and otherwise the pinned `jdkato/vale` image through
  Docker. A newer binary misses errors the pinned one reports, so with a
  different version and no Docker the script fails and says so. The style
  packages in `.vale.ini` are pinned to exact release URLs for the same
  reason: a newer release can need a newer Vale. Bump them together with the
  Vale pin, never to "latest"; `scripts/test-vale-pin.sh` fails on a bare name.

  `ltex-cli-plus` needs nothing installed: the hook fetches and caches it
  on first use. The pre-push hook runs it only when the push contains
  Markdown, and checks just those files; `bun run lint:mechanics` and CI
  check everything.

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

A fresh checkout needs nothing beyond `bun install`: the pre-push hook builds
the web app itself (`bun run build:web`) before the Go tests, because the
embedded static files include the built `style.css`. Run the same
`bun run build:web` by hand before `go test ./...`. The build leaves
`web/build` behind; `svelte-check` skips it, so there's nothing to delete
before a push.

Every one of these is what a hook or CI runs — see `lefthook.yml` and
`.github/workflows/*.yml` for exactly which.

The pre-push hook runs in two steps. The quick lint and test jobs go first, in
parallel. Then the three heavy ones run one at a time: the Storybook
screenshots, the component tests and the image build. Side by side, and beside
other pushes from the same machine, they starved each other into timeouts. A
job with a file filter runs only when the push touches a matching file, so a
docs-only push skips the Go tests, Go lint, Storybook, component tests and
image build. `lefthook run pre-push --verbose` lists each skip. The filters
are each job's inputs (the Dockerfile's `COPY` sources, the `go:embed` targets,
the build scripts), and `scripts/lefthook-globs.test.ts` fails when one drifts.
A push that only edits `lefthook.yml` runs the Go tests, Storybook, the
component tests and the image build, but not Go lint or the `go mod` checks.
CI still runs everything the hook skips, and the CI-only list at the top of
`lefthook.yml` still holds.

`bun run storybook:screenshots` takes its shots in one browser per core, up to
four, in the hook and in CI alike. A story mustn't count on running after
another one. A story whose render hasn't finished 15 seconds after its page
loaded fails the run, and the failure lists its render phases, whether
animation frames still came, the requests still open and its last console
messages. A page that can't be asked gives the reason instead of the phases and
frames. Other timeouts, such as the page load itself, carry no such list. Keep
the block when you report one.

CI runs a job only when a file it reads changed. The first job, `changes`,
maps the pull request's diff to areas with `scripts/changed-areas.sh`, and
each job runs when its area is set:

| Area       | Changes that set it                                                            | Jobs                                                                     |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `go`       | Go files, `go.mod`, `api/openapi.yaml`, `integration/`                         | `lint`, `test`, `build`, `container-integration`, `govulncheck`, `gomod` |
| `web`      | `web/`, `tests/`, `scripts/`, `.semgrep/`, `package.json`, `biome.json`        | `js`, `svelte-check`, `tests-types`, `audit`, `semgrep`                  |
| `image`    | Go, web, or Docker changes                                                     | `docker`, `e2e`                                                          |
| `hadolint` | `Dockerfile*`, `.dockerignore`                                                 | `dockerfile`                                                             |
| `prose`    | Markdown, `.yml`, `.svelte`, `styles/`, `scripts/lint-*.sh`, `scripts/vale.sh` | `prose`, `prose-tiers` (style and mechanics)                             |
| `api`      | `api/`, `redocly.yaml`, `.spectral.yaml`, `package.json`                       | `api`, `api-security`                                                    |
| `release`  | `.goreleaser.yml`                                                              | `goreleaser`                                                             |

A path the script doesn't know runs everything, and so does every push to
`main` and any change to `ci.yml`. Skipped jobs report as skipped, which
satisfies a required check. Add a case to `scripts/test-changed-areas.sh`
when you add a rule.

A script under `scripts/` skips `image` and `e2e` unless the image build or a
browser job runs it. `changed-areas.sh` lists those, and its test fails when the
list misses one or names a file that is gone. The Go programs there and the
report builder set `go` instead of `web`.

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
bun run lint:specs         # specs name /api/v1 routes, so no mock silently stops matching
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

That repo is archived. On it the open pull requests read as blocked (the
conflicting one as dirty), so two entries in `knownDisagreements` (pull
requests 220 and 221) are stale and
`TestGitHubState_DashboardAgreesWithGitHub` fails on them, though it only reads.
`TestGitHubState_ClosedAndMergedPullRequestsAreNotListed` also only reads, and
passes. The other two,
`TestGitHubState_MergeUsesAMethodTheRepoAllows` and
`TestGitHubState_AutoMergeFollowsTheRepoSetting`, write to the repo, and so do
`reset.sh` and `build.sh`. They fail with a read-only error. To run them all,
restore the repo from archive in its settings, under Danger zone, rebuild the
fixture, and archive it again afterwards.

```sh
scripts/e2e-fixture/reset.sh                 # needs the repo restored
scripts/e2e-fixture/build.sh /path/to/clone  # needs the repo restored
GITHUB_TOKEN=$(gh auth token) go test -tags ghfixture -run '^TestGitHubState_ClosedAndMergedPullRequestsAreNotListed$' -v ./integration/  # works while archived
GITHUB_TOKEN=$(gh auth token) go test -tags ghfixture -run TestGitHubState -v ./integration/  # needs restore and rebuild
```

The tests print one row per pull request: what GitHub says, what the dashboard
says, and the verdict. Needs:

- `gh` logged in as the fixture repo's owner (the tests read `viewerCanMergeAsAdmin`;
  the two writing tests also change merge settings and open and merge pull
  requests of their own).
- For the full comparison, the fixture restored from archive and rebuilt, and
  its checks finished. Two pull requests hold a "slow" check pending for 55
  minutes, so run the test within that window or rebuild.

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

`./tests/run-local.sh` builds the binary and runs the suite. Every worker
starts a server of its own from it, on a free port, and a throwaway SQLite
database, so nothing needs cleaning up and a dev server on 8080 can keep
running. Extra arguments go to Playwright
(`./tests/run-local.sh tests/auth.spec.ts --workers=2`).

CI runs the browser jobs (the e2e shards, Lighthouse, the Storybook
screenshots, and the release screenshots) in our own image, `ghcr.io/alrayyes/ci-playwright:<version>`,
built from Playwright's official image with bun added. It already holds the
browsers, bun, node, git, `gh`, and ImageMagick, so no job downloads a
browser, installs bun, or runs apt. The tag is the `@playwright/test` version,
and the bun inside is the one `packageManager` names.
`scripts/test-playwright-image.sh` fails the `changes` job when an image's
version differs from `package.json` or `bun.lock`, when two jobs use
different images, or when a job loses its container options (`--ipc=host` and
`--init`, which Playwright's Docker guide recommends) or its bun check
(`scripts/check-image-bun.sh`), so a Playwright bump changes `package.json`,
`bun.lock` and the image lines in `ci.yml` and `release.yml` together. The
check must be a plain step with no `if` or `continue-on-error: true`, placed
before any step that mentions bun or Playwright (including `setup-bun`). The
e2e and Lighthouse jobs must not set `continue-on-error` on the job either,
since that would hide a failed check; only the release screenshots job does,
on purpose. The guard reads `image:` and `options:` only from the job's own
`container:` block. It doesn't check that a digest belongs to its tag; that
takes a registry call.

On a Dependabot pull request that moves `@playwright/test`, the
`pin-playwright-image` workflow updates the image pin for you. It reads the
version from `package.json`, looks up the digest of `ci-playwright:<version>`
and rewrites the image lines in `ci.yml` and `release.yml`. Then it checks it
changed only those two files and the expected three and one lines. It pushes one
commit as `github-actions[bot]` with the `RELEASE_TOKEN` secret so the new head
gets CI, and comments on the pull request. `RELEASE_TOKEN` only needs to be a
Dependabot secret (`gh secret set RELEASE_TOKEN --app dependabot`), and it needs
Contents and Workflows read and write, since the push changes files under
`.github/workflows/`. Until the secret exists, only a pull request that changes
`@playwright/test` fails, with that command in the message. The workflow
runs no script from the pull request, but anyone who can edit the workflow file
on a Dependabot branch can still reach the token, which is the write access they
already have. Once that commit is on the branch, Dependabot
stops rebasing it, so a pull request that falls behind main needs a comment
reading `@dependabot recreate`. The new branch gets the pin again. Two things
stay manual:

- If the image repo hasn't built that Playwright version yet, the job fails
  and says so. Re-run it once the tag exists.
- The workflow doesn't touch `packageManager`. The image's bun is whatever the
  image repo built, so when it differs from `packageManager` the bun check
  fails, and someone bumps `packageManager` to match.

For a bump that doesn't come from Dependabot, run
`bun scripts/pin-playwright-image.ts` and commit the result. The workflow
doesn't use that script; it does the same rewrite with its own `sed`.
The image repo's README says how a new tag is published.
`run-local.sh` doesn't use the image: it runs on your machine with the browsers
you installed once with `bunx playwright install chromium`.

CI splits the suite over eleven shards by spec duration, not by test count.
`scripts/e2e-shards.ts` gives each shard the spec files it should run from
`tests/e2e-durations.json` (seconds per spec): slow specs first, each into the
shard with the least work so far. A new spec needs no entry: it counts as the
average spec until the file is refreshed. To refresh it, download the
`e2e-reports` artifact of a green run on `main` and run `bun
scripts/e2e-shards.ts record <path>/e2e.xml`; `bun scripts/e2e-shards.ts plan 11`
prints the expected load per shard. Shard 1 once ran about a quarter slower
than the others, so `SHARD_SPEEDS` in the script gives it a little less work;
drop that entry if it stays in line. Each shard still builds its own binary and
database, and the merged JUnit report still holds every test. Runners differ:
the same specs can take a third longer on one than on another, so one run's
shard times can be two minutes apart with a good split. Judge the split by
`plan` and by several runs, not one. `scripts/e2e-shards.test.ts` fails when a
shard is planned more than 300 seconds of work: add a shard then.

A shard that runs past its 10-minute limit is cancelled, and the log ends at
`The operation was canceled.` A final `cancelled()` step then writes an error
annotation and a job summary line saying it hit the limit, with the elapsed
time (`scripts/e2e-shard-cancelled.sh`). A shard cancelled by a newer push
says so instead and claims no timeout: the script compares the elapsed time
with the limit, allowing 40 seconds for pulling the image. On that message,
refresh the durations, and add a shard if the refresh doesn't bring the
slowest back well under the limit. `scripts/test-e2e-shard-timeout.sh` checks
the step, and that its limit matches the job's `timeout-minutes`.

A run takes about two minutes on 16 cores. Locally it uses the default worker
count; CI uses one worker and one retry. A red run that passes alone usually
means a test raced the page, so fix the wait rather than adding a retry. A
test that stays flaky gets `test.fixme`/an annotation naming the reason and a
linked issue.

Every spec runs in the `single-user` Playwright project (`playwright.config.ts`),
listed by name in the config. A spec missing from the list fails the run, naming
it, rather than being skipped. The project gives every worker a server of its
own and one signed-in owner, so a spec needs no registration of its own:

- Import `test` from `tests/server-fixture.ts`. The `server` fixture (once per
  worker) starts the binary on a free port with a temp database and registers
  the owner through the Chrome virtual authenticator, as a first visit does.
- Before each test `POST /__e2e/reset` empties every table except the owner's,
  keeps the first passkey, and answers with a fresh session cookie, so a test
  starts signed in with nothing left over from the last, and one that logs out
  hurts only itself. A test about a visitor with no session calls
  `context.clearCookies()` first.
- A test that logs in with the passkey again calls `addOwnerPasskey(page, server)`
  (an authenticator belongs to one browser session). A test that needs a virgin
  database, such as the first visit registering the owner, takes `freshServer`.
- The route exists only in a binary built with `-tags e2e`. `run-local.sh` and CI
  build that and pass it as `E2E_BINARY`; a default build, and so a release,
  carries no route that can wipe the database. Build it yourself with
  `bun run build:web && go build -tags e2e -o forge-dashboard-e2e ./cmd/forge-dashboard`
  to run `bunx playwright test` by hand. The binary embeds the web bundle, so
  a stale one would pass a spec against old code: without `E2E_BINARY`,
  `tests/global-setup.ts` fails the run, printing that command, when
  `forge-dashboard-e2e` is older than any file under `cmd/`, `internal/`,
  `web/src/` or `web/static/`, or than `go.mod` or `go.sum`. Go `_test.go`
  files and `testdata/` directories don't count, since they aren't compiled
  into the binary, and neither does a broken symlink. It also fails when a file
  under `web/src/` or `web/static/` is newer than the bundle in
  `internal/api/static/_app/`: `go build` alone leaves the old bundle embedded,
  so run `bun run build:web` first. (Without `_app/` there is no bundle to
  compare, and that check passes.) A watched file dated in the future is named
  as the cause, because no rebuild can make the binary newer than it. Setting
  `E2E_BINARY` skips all of these checks.
- A new spec imports its `test` from `tests/server-fixture.ts` and goes at the
  end of the list in the config.

Specs import `test` from `tests/server-fixture.ts`, not from `@playwright/test`.
It is Playwright's own `test`, started against a server of its own and reset
between tests, with one more addition: mocked snapshots whose pull requests
don't state `allowedActions`, `status` or `kind` get them filled in from a table
the Go rules generate (`tests/allowed-actions-stand-in.ts` looks a mocked pull
request up in `tests/generated/allowed-actions.json`). A spec that wants to say
exactly what the server answered sets `allowedActions` itself, as
`tests/allowed-actions.spec.ts` does. When
`internal/dashboard/allowed_actions.go`, `pull_request_status.go` or `bot_pr.go`
changes, `go test ./internal/dashboard` fails until the table is regenerated
with `UPDATE_FIXTURES=1 go test ./internal/dashboard -run
TestAllowedActionsFixture`; commit the result. A mock whose raw fields the table
has no value for fails loudly: widen the axis in
`allowed_actions_fixture_test.go`.

The nav badges work the same way. A mocked `/api/v1/dashboard` takes its
`navCounts` from `navCountsFor` in `tests/nav-counts-helper.ts`, which adds up
what `tests/generated/nav-counts.json` says each pull request contributes,
including the Bots page's `behind` count: a mocked pull request sets
`behindBase` (and `empty` when nothing is left to merge) to raise it. The
Branches badge isn't in it: the page counts the `mainBranchPage` rows, so a
mocked dashboard carries those.
`go test ./internal/api` fails when `buildNavCounts` or a field name changes
until `UPDATE_FIXTURES=1 go test ./internal/api -run TestNavCountsFixture`
regenerates it.

The page also moves a pull request between those numbers from its live jobs, in
`web/src/lib/nav-counts-live.ts`. `tests/generated/live-nav-counts.json` keeps
it sorting as the server does: `go test ./internal/api` fails when it goes stale,
until `UPDATE_FIXTURES=1 go test ./internal/api -run TestLiveNavCountsFixture`
regenerates it.

A mocked dashboard answer builds each `forges` entry with `forgeHealth()` from
`tests/forge-health-helper.ts`, which fills `capabilities` from
`tests/generated/forge-capabilities.json`. `go test ./internal/dashboard` fails
when the Go table changes until `UPDATE_FIXTURES=1 go test ./internal/dashboard
-run TestForgeCapabilitiesFixture` regenerates it. Older specs still write the
entry by hand and move over as they are touched.

Web code that behaves differently per forge asks `forgeCan(forge, flag)` in
`web/src/lib/forges.ts`, never the forge's name. A read of the API teaches it
each forge's flags. The shipped forges are seeded there so a page that asks
early behaves as it will later, and `forges.test.ts` keeps the seed equal to
the generated fixture.

## Unit tests

A rule that needs no browser is tested without one. `web/src/lib/*.test.ts`
runs under `bun test` (`bun run test:unit`): about 10 ms for a module, no
server, no Chromium. CI runs the suite twice, the second time with
`--randomize`: modules keep state between tests, so a test that leaves some
behind passes in file order and fails at random. A red random run prints its
seed; `bun test web/src scripts --randomize --seed=<seed>` repeats it.

Today that's `insights.ts` (the age buckets and repo
ranking behind the Insights page), `failure-details.ts`,
`hidden-pull-requests.ts`, `confirm-arm.ts`, `filters.ts` (the choices a
filter offers) and the wording half of `wait-chip.ts`. Move a rule here when it
is a pure function of its inputs, and keep the Playwright journey only for what
the page does with the answer.

What the built frontend ships, as opposed to how it behaves, is checked in Go,
not in a browser: `internal/api/static_pages_test.go` reads the pages the
binary embeds (so run `bun run build:web` first) and asserts the minified
CSS, the font `<link rel="preload">` tags and `@font-face` files being
served, no external loads, a distinct description on every page, and
`noindex`.

A component's markup, wording, focus or layout, with its API mocked, is
asserted in the `play` function of its Storybook story and run by
`bun run test:components` (Vitest in Chromium, no Go binary; see
[the catalogue](docs/storybook.md)). Pick the lowest tier that can see the
behaviour: `bun test`, then a story, then Playwright.

Two things to know. Unit tests live under `web/src` (or `scripts/`, for the
helpers the e2e specs import), not `tests/`, because Playwright picks up any
`tests/*.test.ts` and a bare `bun test` fails on Playwright specs. And
`bun test` has no Svelte compiler, so it can't load a `.svelte.ts` rune module
(`$state is not defined`) or render a component; Vitest in the story tier
does. `bun test` was picked
for plain modules because it runs in about 0.01 s with nothing new to install,
where Vitest takes 0.4 s or more and a dependency.

## How it fits together

- `api/openapi.yaml` is the contract — handwritten and reviewed as the
  design — see `internal/api`'s handlers for what implements it.
  Four value lists are open on purpose: `AllowedAction.action`,
  `AllowedAction.blocked.code`, `ActionError.code` and `SetupErrorCode` use
  `x-extensible-enum`, so a new value is a
  minor SDK release (`oasdiff` calls a new value in a closed `enum` breaking).
  Every other list stays closed. `kin-openapi` doesn't check an extension, so
  `internal/api/openapi_extensible_enums_test.go` holds the Go list. Add a
  new action or code there, in the spec, and where the server emits it. For
  `ActionError.code` the test also reads the `ActionCode` constants from
  `internal/dashboard/action_refusal.go`, so a constant missing from the spec
  fails the build.
- `internal/dashboard` is the domain: the `PullRequest`/`Issue`/`Snapshot`
  model, the `Source`/`ForgeClient` interfaces, the `Aggregator` that
  refreshes the snapshot in the background so a request never
  blocks on either forge, and the `Service` that owns the one `Aggregator`
  (and its refresh goroutine) and rebuilds it on a settings save.
- `internal/github` and `internal/forgejo` are the two adapters — thin,
  handwritten REST clients, each wrapped in a `dashboard.GenericSource`
  rather than duplicating the concurrency/error-handling logic per forge.
- `internal/auth` is passkey registration, login and sessions — `Store`
  persists users/credentials/sessions to SQLite, `Service` drives the
  WebAuthn ceremonies against `Store` and refuses registration once a user
  holds a passkey, and `RequireAuth` is the middleware that gates a handler
  on a valid session.
- `internal/settings` is the owner's GitHub/Forgejo configuration —
  `Cipher` is AES-256-GCM encryption keyed off `ENCRYPTION_KEY`, and
  `Store` persists it to SQLite with the tokens encrypted, never in
  plaintext.
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
  needs (forge health, the refresh
  button) — its own plain, non-landmark markup rather than merged into
  the shared `<header>`, since a layout renders that before any child
  page's own script runs at all. `web/src/routes/login` is the one page
  genuinely outside `(app)` — no persistent nav chrome to inherit before
  a session exists. Settings
  (`web/src/routes/(app)/settings`) is where the signed-in owner sets
  their tokens and theme. There is no admin page.
- `cmd/forge-dashboard` is the composition root: reads environment
  variables, wires the auth service, the settings store, and the
  dashboard service, and serves the API and static files. The
  process's own `AppContext` (not the request's — see `internal/api.Deps`'s own
  comment) roots the background refresh goroutine so it outlives
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
`.goreleaser.yml`, and not a test, a Markdown file, or CI config.
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
