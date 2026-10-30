# Architecture

How the pieces fit, on one page. The detail per package is in
[CONTRIBUTING.md](CONTRIBUTING.md#how-it-fits-together); the reasons behind the
big choices are in [the decision records](docs/adr/).

## The shape

```text
GitHub, Forgejo
      │  REST and GraphQL, one credential set
      ▼
internal/github, internal/forgejo      adapters: each forge's shape mapped to ours
      │  dashboard.Source
      ▼
internal/dashboard                     domain: the model, the rules, one Aggregator
      │  Service.Get (never waits on a forge)
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
- **The aggregator** refreshes the instance's one snapshot in the
  background, so a request reads the last good snapshot and never blocks on a
  forge. A webhook from a forge refreshes one repo early.
- **The API** is `api/openapi.yaml`, written first and reviewed as the design.
  Go tests validate the handlers against it, and the client libraries are
  generated from it.
- **Auth and settings** (`internal/auth`, `internal/settings`) keep the one
  user, its passkeys and its encrypted credentials in SQLite. A credential
  never reaches the browser.

## Where logic lives

A rule that decides what a pull request may do or which issues count as work
lives in `internal/dashboard`. The API works the answer out and sends it
(`allowedActions`, `housekeeping`), and the write endpoints enforce it. The
page only shows what it was told. The test is whether a second client, a client
library or an agent, would need the same answer. The reasons, and what it
costs, are in [ADR 0001](docs/adr/0001-business-rules-live-behind-the-api.md).

### The one exception: the pill folds in the page

A CI pill is drawn from the jobs, not from a verdict the server computed.
The server sends the facts: each run (`runs` on a default branch, the runs on
the check stream) with its jobs, their status and conclusion, and whether the
job list was cut short. The page folds them once, in `web/src/lib/check-fold.ts`
(a branch) and `web/src/lib/pr-fold.ts` (a pull request, built on the first).
The same jobs fill the pipeline dialog, so a pill and the list under it cannot
disagree, and a live stream changes the pill without a refresh.

This departs from the preceding rule on purpose. The pill is a display of what
the jobs did and decides nothing. A second client that wants its own pill
folds the same facts. The cost is one fold kept in step with the server's
(the cases in `check-fold.test.ts` and the server's own tests).

What stays on the server, because a rule reads it:

- `ci` and `checks` on a pull request: what it may do (`allowedActions`),
  auto-merge and its status, the quick filters, the navigation counts, the
  CI poll and the auto-update of a branch.
- `status` and `checks` on a default branch: the CI poll reads them. The MCP
  tools only return the row. No server rule reads `failingJobs`, and the page
  needs it for a row with no `runs` or a cut-short job list.

The page draws those fields for a row it has no facts for: a branch with no
`runs` or a cut-short job list, a pull request outside the rows in view.

One more server-only fact never reaches the wire: on GitHub, whether held
runs are the only reason CI reads as failing. The menu pill count reads it.

A run that was only cancelled reads as cancelled in the fold, on a branch and
on a pull request. The server's own pull request verdict differs (GitHub's
combined result says failure, Forgejo's says none or success), which is why
the pill of a watched row can differ from the field until the next refresh.

## One user per instance

An instance has exactly one user, the owner. There are no invites, no admin
area and no sharing, and one aggregator serves the whole instance. The options
and the cost are in
[ADR 0002](docs/adr/0002-one-user-per-instance.md).

## Design

- **Passkey login, no passwords anywhere.** Registration and sign-in are
  real [WebAuthn](https://webauthn.io) ceremonies — works with Proton
  Pass, 1Password, iCloud Keychain, a platform authenticator, or a
  hardware key, anything that speaks passkeys. Nothing password-shaped is
  ever stored or transmitted.
- **You configure your own forges.** The GitHub/Forgejo tokens are set from
  the Settings page and never leave the backend.
- **Credentials never reach the browser.** The Go backend holds the
  owner's tokens server-side, encrypted at rest, and only ever hands the
  frontend its own already-filtered JSON. Confirm this yourself: open the
  browser's network tab and watch it call only this app's own routes (`/api/v1/...`
  and the static `/changelog.json`), never a forge — and that
  `/api/v1/settings` never echoes a forge token back, only whether one is set.
- **An MCP endpoint for agents, `/api/v1/mcp`, read-only except for one
  setting (the web app itself can act on pull requests).**
  Authenticated the same way any other `/api/v1/*` route already
  is — a personal API token (Settings → API tokens),
  `Authorization: Bearer <token>` — not a separate credential system. Its
  tools so far are `get_dashboard`, which mirrors `GET /api/v1/dashboard`
  exactly (it takes no arguments, and the old `owner` argument is
  refused), and `get_main_branches`, which mirrors
  `GET /api/v1/main-branches` (default-branch CI status and open dependency
  advisories, no forge budget), and
  `get_pull_request_details`, which mirrors `GET /api/v1/pull-requests/details`
  (a pull request's description, comments and reactions). That one reads the
  forge on demand and spends budget: one GraphQL query on GitHub, up to 53
  requests on Forgejo. Another is
  `get_pull_request_checks`, which reads a pull request's individual CI
  checks. It has no HTTP endpoint: the jobs travel on the dashboard stream,
  and the WebMCP tool reads them there. It spends budget too: 4 REST
  requests on GitHub (more for failed jobs), 3 plus one per run on Forgejo
  (and one log read per failed job, five at most).
  `get_main_branch_checks` does the same for the jobs of a default branch's
  newest pipeline, in the same shape. It spends
  budget too: one request for the commits plus one per commit until one has
  checks on GitHub, 3 plus one per run on Forgejo (and one log read per
  failed job, five at most).
  `get_repository_advisories` mirrors `GET /api/v1/main-branches/advisories` (a
  GitHub repository's open dependency advisories in full, the worst first). It
  spends budget too: one REST request per page of alerts. A list that cannot
  be read is state unknown with a reason, never an empty list.
  `get_check_log` mirrors `GET /api/v1/checks/log` (one CI job's output as plain
  text, the last 256 KiB at most, by the `jobId` a check carries). It spends
  one request on Forgejo and one plus a short-lived download on GitHub. It refuses
  a repository you don't track with a 404, before any forge call, and answers
  503 while your repositories haven't loaded yet.
  `list_queued_actions` mirrors `GET /api/v1/queued-actions` (your actions
  waiting on a rate-limited forge, and the finished ones from the last 24
  hours, under a `queuedActions` key). It costs no forge budget.
  `get_version` mirrors `GET /api/version` (the running server's release
  tag, under a `version` key). It costs no forge budget.
  `get_forge_api_stats` mirrors `GET /api/v1/stats/forge-api` (the forge request
  counters and budgets). It costs no forge budget.
  `get_settings` mirrors `GET /api/v1/settings` without the webhook token and
  secret, which are never sent over MCP; it reports `webhookConfigured`
  instead, and unlike the HTTP read it never creates them. It carries
  `ignoredTitleCounts` too, null per entry until the first refresh ends.
  Over HTTP the same body is `GET /api/v1/settings/summary`, which also
  creates and returns no webhook credentials.
  `set_pull_request_auto_update` is the one tool that writes: it mirrors
  `POST /api/v1/pull-requests/auto-update` and turns the automatic branch update
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
  and an unknown `/api/v1/` path stays a JSON error. Errors the proxy makes
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
  button you pressed) and repo, and `GET /api/v1/stats/forge-api` serves the
  rows for your own credentials. The counters are in memory and restart at
  zero. A key carries no user id, only a label for the account or App
  installation. [Rate limits](docs/rate-limits.md#reading-the-stats) says how
  to read them.
- **[WebMCP](https://github.com/webmachinelearning/webmcp) tools in the frontend
  itself: `get_dashboard`, `get_main_branches`, `get_main_branch_checks`,
  `get_check_log`, `get_repository_advisories`, `get_pull_request_checks`,
  `get_pull_request_details`, `list_queued_actions`, `get_settings` and
  `set_pull_request_auto_update`.**
  Experimental — as of this writing it's an Origin Trial in Chrome 149+/Edge
  150+ only, with no stable spec yet — so this is a no-op everywhere else rather
  than a real dependency the page needs. Where it's present, it lets an
  in-browser AI agent fetch the same data the page itself renders.
  `get_dashboard` calls the page's own already-authenticated fetch layer
  (`fetchDashboardData()`) directly, the same request `/api/v1/dashboard` already
  answers; the others call their endpoint the same way (`list_queued_actions`
  returns `GET /api/v1/queued-actions` under a `queuedActions` key, as the
  server's tool of that name does; `get_settings` returns
  `GET /api/v1/settings/summary`, the same body as the server's tool, with
  `webhookConfigured` and no webhook token or secret). Like the server's
  tool, `get_settings` creates nothing: `webhookConfigured` is false until
  the user has opened Settings. `set_pull_request_auto_update` posts to
  `POST /api/v1/pull-requests/auto-update` like the server's tool of that name,
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

### Which hosts a log download may reach

One policy covers the URL a GitHub job-log request redirects to (Forgejo
answers the log itself). It lives in `logBlobClient` and `logTransport` in
`internal/github/job_log.go`. The request carries no token and times out after
15 seconds. Reading more than 64 megabytes fails the request with an error.

- Every hop must be HTTPS, or share the API's scheme, host, and port. At most
  three redirects are followed. Any public HTTPS host passes, so a separate
  blob host is fine.
- A direct dial is refused when the resolved address is local (127.0.0.0/8 or
  ::1), private, link-local, shared (100.64.0.0/10), a group address,
  unspecified, or in the NAT64 prefix. The check is on the resolved address,
  so DNS rebinding doesn't get around it. The one exception is the API's own
  host and port, so a GitHub Enterprise Server instance on a private network
  can serve its logs itself.
- With a proxy configured, the proxy does the resolving. A request whose host
  is exactly `localhost` or a literal non-public address is refused before it
  is sent. The environment's proxy settings skip localhost, local addresses and
  `NO_PROXY` hosts, so those take the direct path above.
- The proxy's own host and port is dialled without the address check, and so
  is any later direct dial to that same host and port from the same client. A
  proxy URL without a port isn't recognised, so a proxy on a private network
  is refused.

There is no allowlist: a blob host on a private network is refused, by design.

### What the passkey login covers

It covers passkey registration and login gating the
dashboard, GitHub/Forgejo tokens (configured from the Settings
page).

## Where to look next

- A change in flight: `openspec/changes/`. A shipped capability:
  `openspec/specs/`.
- A design for a screen: `docs/design/`.
- How to run it: [docs/running.md](docs/running.md). How to deploy it:
  [docs/deployment.md](docs/deployment.md). How to configure it:
  [docs/configuration.md](docs/configuration.md).
