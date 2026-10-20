# Architecture

How the pieces fit, on one page. The detail per package is in
[CONTRIBUTING.md](CONTRIBUTING.md#how-it-fits-together); the reasons behind the
big choices are in [the decision records](docs/adr/).

## The shape

```text
GitHub, Forgejo
      │  REST and GraphQL, one credential set per user
      ▼
internal/github, internal/forgejo      adapters: each forge's shape mapped to ours
      │  dashboard.Source
      ▼
internal/dashboard                     domain: the model, the rules, one Aggregator per user
      │  Manager.Get (never waits on a forge)
      ▼
internal/api                           HTTP, written against api/openapi.yaml
      │  JSON, SSE, MCP
      ▼
web/ (SvelteKit, built into the binary)   the page; client libraries and agents use the same API
```

One Go binary serves all of it. `web/` builds to static files that
`internal/api` embeds, so a released binary needs nothing else.

## The parts

- **Adapters** turn a forge's answer into `dashboard.PullRequest`, `Issue` and
  `Repo`. Nothing outside them knows what a GraphQL node looks like.
- **The aggregator** refreshes one user's snapshot in the background, so a
  request reads the last good snapshot and never blocks on a forge. A webhook
  from a forge refreshes one repo early.
- **The API** is `api/openapi.yaml`, written first and reviewed as the design.
  Go tests validate the handlers against it, and the client libraries are generated
  from it.
- **Auth, settings and sharing** (`internal/auth`, `internal/settings`,
  `internal/sharing`) keep users, passkeys, encrypted credentials and who may
  see whose board in SQLite. A credential never reaches the browser.

## Where logic lives

A rule that decides what a pull request may do, which issues count as work, or
how worried to be about a rate limit lives in `internal/dashboard`. The API
works the answer out and sends it (`allowedActions`, `housekeeping`,
`severity`), and the write endpoints enforce it. The page only shows what it
was told. The test is whether a second client, a client library or an agent,
would need the same answer. The reasons, and what it costs, are in
[ADR 0001](docs/adr/0001-business-rules-live-behind-the-api.md).

## Design

- **Passkey login, no passwords anywhere.** Registration and sign-in are
  real [WebAuthn](https://webauthn.io) ceremonies — works with Proton
  Pass, 1Password, iCloud Keychain, a platform authenticator, or a
  hardware key, anything that speaks passkeys. Nothing password-shaped is
  ever stored or transmitted.
- **Every user configures their own forges.** Each signed-in user has
  their own GitHub/Forgejo tokens, set from the Settings page, and sees
  only their own dashboard — nobody else's tokens, nobody else's repos.
- **Credentials never reach the browser.** The Go backend holds every
  user's tokens server-side, encrypted at rest, and only ever hands the
  frontend its own already-filtered JSON. Confirm this yourself: open the
  browser's network tab and watch it call only this app's own routes (`/api/...`
  and the static `/changelog.json`), never a forge — and that
  `/api/settings` never echoes a forge token back, only whether one is set.
- **An MCP endpoint for agents, `/api/mcp`, read-only except for one
  setting (the web app itself can act on pull requests).**
  Authenticated the same way any other `/api/*` route already
  is — a personal API token (Settings → API tokens),
  `Authorization: Bearer <token>` — not a separate credential system. Its
  tools so far are `get_dashboard`, which mirrors `GET /api/dashboard`
  exactly (including its own `?owner=`/`owner` semantics for a dashboard
  someone else has shared with you), and `get_main_branches`, which mirrors
  `GET /api/main-branches` (default-branch CI status, no forge budget), and
  `get_pull_request_details`, which mirrors `GET /api/pull-requests/details`
  (a pull request's description, comments and reactions). That one reads the
  forge on demand and spends budget: one GraphQL query on GitHub, up to 53
  requests on Forgejo. Another is
  `get_pull_request_checks`, which mirrors `GET /api/pull-requests/checks`
  (a pull request's individual CI checks). It spends budget too: 4 REST
  requests on GitHub (more for failed jobs), 3 plus one per run on Forgejo.
  `get_main_branch_checks` mirrors `GET /api/main-branches/checks` (the jobs
  of a default branch's newest pipeline, in the same shape). It spends
  budget too: one request for the commits plus one per commit until one has
  checks on GitHub, 3 plus one per run on Forgejo.
  `list_queued_actions` mirrors `GET /api/queued-actions` (your actions
  waiting on a rate-limited forge, and the finished ones from the last 24
  hours, under a `queuedActions` key). It costs no forge budget.
  `get_version` mirrors `GET /api/version` (the running server's release
  tag, under a `version` key). It costs no forge budget.
  `get_forge_api_stats` mirrors `GET /api/stats/forge-api` (the forge request
  counters and budgets). It costs no forge budget.
  `get_settings` mirrors `GET /api/settings` without the webhook token and
  secret, which are never sent over MCP; it reports `webhookConfigured`
  instead, and unlike the HTTP read it never creates them. It carries
  `ignoredTitleCounts` too, null per entry until the first refresh ends.
  Over HTTP the same body is `GET /api/settings/summary`, which also
  creates and returns no webhook credentials.
  `set_pull_request_auto_update` is the one tool that writes: it mirrors
  `POST /api/pull-requests/auto-update` and turns the automatic branch update
  on or off for one pull request, or hands it back to its repo with `enabled`
  null or omitted. It changes only this app's own setting, sends nothing to a
  forge and costs no forge budget. It is the same function as the handler, so
  the validation and the errors are the same, and a token that can call the
  route can call the tool.
  Each calls the same function as its handler rather than adding a second,
  parallel path to the same data. Built on the official
  [MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk), over the
  Streamable HTTP transport.
  The aim is that every API operation has a tool, so an agent is
  never blocked by something only the API or the page can do. A test lists
  every `operationId` in `api/openapi.yaml` and fails unless it has a tool,
  a written exclusion (the operation's `x-mcp-excluded` reason in
  `api/openapi.yaml`: sign-in ceremonies, token management, webhook receivers,
  probes and the cookie-only filter state), or a place on the list of tools
  still to come in `internal/api/mcp_operations.go`. Tools arrive in small pull
  requests, one resource each.
- **One Go binary.** The frontend, SvelteKit, is embedded into
  the binary with `//go:embed`; a released binary needs nothing but
  `go build` to run. Building from source needs one extra step first,
  `bun run build:web`, to produce the pages `internal/api/static`
  embeds — run automatically in CI and the Docker build's own
  `web-build` stage, a manual step before a local `go build` otherwise.
  See [CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain either half
  needs. The server sets the cache headers itself: files under
  `/_app/immutable/` (content-hashed) get `Cache-Control: public,
max-age=31536000, immutable`; every other file gets `no-cache` and a weak
  `ETag`, so a browser checks with a cheap 304; the pages behind a
  session get `private, no-cache`. Text responses (HTML, JS, CSS, JSON, SVG,
  plain text) over 1 KiB are sent compressed with brotli or gzip when the client
  accepts it, with `Vary: Accept-Encoding`. Compression covers the static
  files only, not the API and not its event streams. A reverse proxy in front
  needs no cache or compression rules of its own. A path no page matches
  answers the app's own `404.html` with a real 404, a handler that panics
  answers `500.html` with a 500 (the stack goes to the log, never the page),
  and an unknown `/api/` path stays a JSON error. Errors the proxy makes
  itself (502, 503, 504) need its own static pages.
- **It writes to the forges only when you ask, and for the webhooks.** The
  board reads from GitHub and Forgejo, and every row links out to the real
  thing. What it writes: the pull request actions you press (merge, enable
  or cancel auto-merge, update branch, close, re-run failed checks, the
  Dependabot and Renovate rebase), the same actions it runs for you when you
  queue them or turn on auto-update or auto-merge, and the webhook it adds
  when you click "Add a webhook", plus the events it adds to a webhook it
  created earlier (a Forgejo token needs write access for that, since its
  hooks API has no separate read-only scope).
- **Every forge request is counted.** A counting transport sits under each
  client's HTTP cache, so it sees the real answers, including a `304`. Each
  request is counted by forge, credential, why it was made (a full refresh, a
  webhook's scoped refresh, a CI poll, a detail view, webhook upkeep, a
  button you pressed) and repo, and `GET /api/stats/forge-api` serves the
  rows for your own credentials. The counters are in memory and restart at
  zero. A key carries no user id, only a label for the account or App
  installation. [Rate limits](docs/rate-limits.md#reading-the-stats) says how
  to read them.
- **[WebMCP](https://github.com/webmachinelearning/webmcp) tools in the frontend
  itself: `get_dashboard`, `get_main_branches`, `get_main_branch_checks`,
  `get_pull_request_checks`, `get_pull_request_details`,
  `list_queued_actions`, `get_settings` and `set_pull_request_auto_update`.**
  Experimental — as of this writing it's an Origin Trial in Chrome 149+/Edge
  150+ only, with no stable spec yet — so this is a no-op everywhere else rather
  than a real dependency the page needs. Where it's present, it lets an
  in-browser AI agent fetch the same data the page itself renders.
  `get_dashboard` calls the page's own already-authenticated fetch layer
  (`fetchDashboardData()`) directly, the same request `/api/dashboard` already
  answers; the others call their endpoint the same way (`list_queued_actions`
  returns `GET /api/queued-actions` under a `queuedActions` key, as the
  server's tool of that name does; `get_settings` returns
  `GET /api/settings/summary`, the same body as the server's tool, with
  `webhookConfigured` and no webhook token or secret). Like the server's
  tool, `get_settings` creates nothing: `webhookConfigured` is false until
  the user has opened Settings. `set_pull_request_auto_update` posts to
  `POST /api/pull-requests/auto-update` like the server's tool of that name,
  then reads the board through the page so what the person sees matches. All
  ride on the browser's own session cookie exactly like the page's own poll
  does.
  Nothing new crosses to the browser that the preceding
  "Credentials never reach the browser" bullet doesn't already allow: the tools
  never see a token, only the same already-filtered JSON the page always got.
  The tools live in `web/src/lib/webmcp-tools.ts`, each named for the API
  operation it covers. A unit test, `web/src/lib/webmcp-parity.test.ts`, lists
  every `operationId` in `api/openapi.yaml` and fails unless it has a tool, a
  written exclusion (the same `x-mcp-excluded` reason the server MCP uses, so
  one list serves both) or a place on the test's list of tools still to come.

### What the passkey login covers

It covers passkey registration and login gating the
dashboard, per-user GitHub/Forgejo tokens (every signed-in user
configures their own forges from the Settings page and sees only their
own dashboard by default), an admin area for whoever registers first
(list every registered user, generate and manage the single-use invite
links every registration after the first requires, revoke a user's
passkeys and sessions without deleting their account, or remove one
outright), and dashboard sharing (grant another registered user
read-only access to your own dashboard, from Settings).

## Where to look next

- A change in flight: `openspec/changes/`. A shipped capability:
  `openspec/specs/`.
- A design for a screen: `docs/design/`.
- How to run it: [docs/running.md](docs/running.md). How to deploy it:
  [docs/deployment.md](docs/deployment.md). How to configure it:
  [docs/configuration.md](docs/configuration.md).
