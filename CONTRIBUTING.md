# Contributing

## Getting set up

- **Go 1.27 or newer.**
- **[bun](https://bun.sh)** for the tooling that isn't Go — commitlint,
  Prettier, markdownlint, [Redocly](https://redocly.com/docs/cli), and
  [Playwright](https://playwright.dev) for the accessibility journey test.
- **[golangci-lint](https://golangci-lint.run) v2.13.1**, which the
  pre-commit hook runs from your `PATH` while CI runs it pinned. Install
  that version rather than whichever is current: when the two disagree,
  the hook passes and the pipeline fails, and the reason isn't obvious
  from the failure.
- **[Vale](https://vale.sh)** on your `PATH`, for the style tier of the
  prose lint:

  ```sh
  go install github.com/errata-ai/vale/v3/cmd/vale@latest
  ```

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

```sh
go build ./...
go vet ./...
go test ./...                                    # unit + handler tests
go test -tags=integration ./integration/... -v   # real Forgejo in a container
go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...
golangci-lint run
golangci-lint fmt          # the fixer; `run` stays the check

bunx playwright test       # accessibility + journey tests against a running binary
bun run format:check       # bun run lint:md, lint:api, lint:prose, lint:mechanics too
```

## How it fits together

- `api/openapi.yaml` is the contract — handwritten and reviewed as the
  design — see `internal/api`'s handlers for what implements it.
- `internal/dashboard` is the domain: the `PullRequest`/`Issue`/`Snapshot`
  model, the `Source`/`ForgeClient` interfaces, the `Aggregator` that
  refreshes one user's snapshot in the background so a request never
  blocks on either forge, and the `Manager` that owns one `Aggregator`
  (and its refresh goroutine) per signed-in user.
- `internal/github` and `internal/forgejo` are the two adapters — thin,
  handwritten REST clients, each wrapped in a `dashboard.GenericSource`
  rather than duplicating the concurrency/error-handling logic per forge.
- `internal/auth` is passkey registration, login, sessions, and admin
  user-management — `Store` persists users/credentials/sessions to
  SQLite (plus `ListUsers`/`RevokeUser`/`DeleteUser` for the admin
  area), `Service` drives the WebAuthn ceremonies against `Store`,
  `RequireAuth` is the middleware that gates a handler on a valid
  session, and `RequireAdmin` composes inside it to gate one on the
  session's own `IsAdmin` flag.
- `internal/settings` is each user's own GitHub/Forgejo configuration —
  `Cipher` is AES-256-GCM encryption keyed off `ENCRYPTION_KEY`, and
  `Store` persists it to SQLite with the tokens encrypted, never in
  plaintext.
- `internal/sharing` tracks who's granted whom read-only access to their
  dashboard — `Store` owns nothing about what a dashboard actually is,
  just the owner/viewer relationship; `internal/api`'s dashboard handler
  is what turns a granted share into an actual `dashboard.Manager`
  lookup for the owner's snapshot instead of the caller's own.
- `internal/api/static` is the frontend: plain HTML/CSS/JS, embedded into
  the binary with `//go:embed`. No build step, no framework — see the
  README for why. `login.html`/`login.js` are the one page that stays
  reachable without a session; `settings.html`/`settings.js` is where a
  signed-in user sets their own tokens and manages sharing; `admin.html`/
  `admin.js` is the admin's user list, reachable by anyone with a session
  but functionally gated by every API call it makes 403ing for a
  non-admin.
- `cmd/forge-dashboard` is the composition root: reads environment
  variables, wires the auth service, the settings store and the
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
