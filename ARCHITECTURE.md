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

## Where to look next

- A change in flight: `openspec/changes/`. A shipped capability:
  `openspec/specs/`.
- A design for a screen: `docs/design/`.
- How to run, configure and deploy it: the [README](README.md).
