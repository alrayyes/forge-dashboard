# forge-dashboard

[![CI](https://github.com/alrayyes/forge-dashboard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alrayyes/forge-dashboard/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/alrayyes/forge-dashboard?sort=semver)](https://github.com/alrayyes/forge-dashboard/releases/latest)
[![licence](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)
[![coverage](https://codecov.io/gh/alrayyes/forge-dashboard/branch/main/graph/badge.svg)](https://codecov.io/gh/alrayyes/forge-dashboard)
[![Go Reference](https://pkg.go.dev/badge/github.com/alrayyes/forge-dashboard.svg)](https://pkg.go.dev/github.com/alrayyes/forge-dashboard)

A dashboard of open pull requests, issues, and CI status across
every repository you have write access to on **GitHub** and a **Forgejo**
instance — one page instead of two forge UIs. It has passwordless login,
per-user tokens, sharing and an admin role.

| Page                                                                                                           | Light                                                                               | Dark                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Branches**. The CI status of every default branch, latest commit first.                                      | ![Branches, light mode](docs/screenshots/branches-light.png)                        | ![Branches, dark mode](docs/screenshots/branches-dark.png)                        |
| **Pull requests**. Open pull requests across both forges, with CI status, filters, and sorting.                | ![Pull requests, light mode](docs/screenshots/pull-requests-light.png)              | ![Pull requests, dark mode](docs/screenshots/pull-requests-dark.png)              |
| **Pull request details**. A pull request's description, comments, and thumbs reactions.                        | ![Pull request details, light mode](docs/screenshots/pull-request-dialog-light.png) | ![Pull request details, dark mode](docs/screenshots/pull-request-dialog-dark.png) |
| **Phone sheet**. The same details on a 360px screen.                                                           | ![Phone sheet, light mode](docs/screenshots/pull-request-sheet-light.png)           | ![Phone sheet, dark mode](docs/screenshots/pull-request-sheet-dark.png)           |
| **Pipeline checks**. A pull request's checks with state, time and failure excerpt, from its CI pill.           | ![Pipeline checks, light mode](docs/screenshots/pipeline-checks-light.png)          | ![Pipeline checks, dark mode](docs/screenshots/pipeline-checks-dark.png)          |
| **Issues**. Open issues across both forges.                                                                    | ![Issues, light mode](docs/screenshots/issues-light.png)                            | ![Issues, dark mode](docs/screenshots/issues-dark.png)                            |
| **Releases**. Release pull requests waiting to ship.                                                           | ![Releases, light mode](docs/screenshots/releases-light.png)                        | ![Releases, dark mode](docs/screenshots/releases-dark.png)                        |
| **Release details**. The release notes a release pull request publishes.                                       | ![Release details, light mode](docs/screenshots/release-dialog-light.png)           | ![Release details, dark mode](docs/screenshots/release-dialog-dark.png)           |
| **Bots**. Dependabot and Renovate pull requests.                                                               | ![Bots, light mode](docs/screenshots/bots-light.png)                                | ![Bots, dark mode](docs/screenshots/bots-dark.png)                                |
| **Bot details**. A bot pull request, its generated text collapsed.                                             | ![Bot details, light mode](docs/screenshots/bot-dialog-light.png)                   | ![Bot details, dark mode](docs/screenshots/bot-dialog-dark.png)                   |
| **Insights**. Charts of CI state and the busiest repos.                                                        | ![Insights, light mode](docs/screenshots/insights-light.png)                        | ![Insights, dark mode](docs/screenshots/insights-dark.png)                        |
| **Webhooks**. Which tracked repos have a confirmed webhook, and a way to add one.                              | ![Webhooks, light mode](docs/screenshots/webhooks-light.png)                        | ![Webhooks, dark mode](docs/screenshots/webhooks-dark.png)                        |
| **Settings**. Five groups, one at a time: display, sharing, connections, behaviour, integrations and security. | ![Settings, light mode](docs/screenshots/settings-light.png)                        | ![Settings, dark mode](docs/screenshots/settings-dark.png)                        |
| **Admin**. Users and invites, for the first registered user.                                                   | ![Admin, light mode](docs/screenshots/admin-light.png)                              | ![Admin, dark mode](docs/screenshots/admin-dark.png)                              |
| **Login**. Passkey sign-in.                                                                                    | ![Login, light mode](docs/screenshots/login-light.png)                              | ![Login, dark mode](docs/screenshots/login-dark.png)                              |

Fixture data, not a real account's actual repositories. The release
workflow regenerates every screenshot on each release (see
`scripts/capture-screenshots.ts`), so they're never more than one release
stale.

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
  browser's network tab and watch it call nothing but `/api/dashboard`,
  `/api/settings`, `/api/auth/*` and `/healthz` — and that `/api/settings`
  never echoes a forge token back, only whether one is set.
- **An MCP endpoint for agents, `/api/mcp`, read-only like the rest of
  this app.** Authenticated the same way any other `/api/*` route already
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
  `list_queued_actions` mirrors `GET /api/queued-actions` (your actions
  waiting on a rate-limited forge, and the finished ones from the last 24
  hours, under a `queuedActions` key). It costs no forge budget.
  `get_version` mirrors `GET /api/version` (the running server's release
  tag, under a `version` key). It costs no forge budget.
  `get_settings` mirrors `GET /api/settings` without the webhook token and
  secret, which are never sent over MCP; it reports `webhookConfigured`
  instead, and unlike the HTTP read it never creates them. It carries
  `ignoredTitleCounts` too, null per entry until the first refresh ends.
  Over HTTP the same body is `GET /api/settings/summary`, which also
  creates and returns no webhook credentials.
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
- **One Go binary.** The frontend — SvelteKit throughout, migrated
  incrementally, one page at a time — ends up embedded into
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
- **Read-only against both forges, with one caveat.** Nothing here writes
  back to GitHub or Forgejo — it aggregates and displays, and every row
  links out to the real thing. The caveat: checking whether a repo's
  webhook is already pointed at this dashboard (the Webhooks card, and the
  dashboard's own coverage summary) needs a token scope that includes
  write access on Forgejo, since its hooks API has no separate read-only
  scope — this app still only reads that list, and never creates or edits a
  hook itself.
- **[WebMCP](https://github.com/webmachinelearning/webmcp) tools in the frontend
  itself: `get_dashboard`, `get_main_branches`, `get_pull_request_checks`,
  `get_pull_request_details`, `list_queued_actions` and `get_settings`.**
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
  the user has opened Settings. All ride on the browser's own session
  cookie exactly like the page's own poll does.
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
links every registration after the first now requires, revoke a user's
passkeys and sessions without deleting their account, or remove one
outright), and dashboard sharing (grant another registered user
read-only access to your own dashboard, from Settings).

## Requirements

- **Go 1.27 or newer**, to build.
- **[bun](https://bun.sh)**, to build from source — `bun run build:web`
  has to run before `go build` picks up its output (see the preceding
  **Design** section). Not needed to run a pre-built release binary or
  the Docker image, both of which already have that step baked in.
- **A passkey-capable browser** to sign in at all — any current Chrome,
  Safari, Firefox or Edge; a phone counts too. Nothing else to install.
- **Somewhere writable for the database** (`DB_PATH`, default
  `/data/forge-dashboard.db`) that survives a restart — registered
  passkeys, sessions, and every user's encrypted forge credentials live
  there. In Docker that means a mounted volume at `/data`; see **Docker**
  below.
- **`ENCRYPTION_KEY`**, a base64-encoded 32-byte key the process refuses
  to start without — see **Configuration** below for how to generate one.
  It's what encrypts every user's forge tokens at rest; there's no
  sensible default for a secret like this one.
- Each signed-in user configures their own forge credentials from the
  Settings page after registering — see **Credentials** below for exactly
  which permissions to grant. Nothing forge-related needs setting before
  the process starts.

## Authentication

Forge Dashboard is an internal tool, not a public site, so it keeps out of
search engines. Every response carries `X-Robots-Tag: noindex, nofollow`, the
HTML shell has a matching `<meta name="robots">` tag, and `robots.txt` allows
crawling on purpose: a crawler that can't fetch a page never reads its
`noindex`. The real barrier is the passkey login below.

The first visit registers a passkey and becomes the instance's admin;
every registration after that needs an invite link the admin generates —
no password anywhere, and no separate account system. `POST
/api/auth/register/begin` and `.../finish` run the WebAuthn registration
ceremony, `.../login/begin`/`.../finish` run the login ceremony, and a
signed session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` whenever the
request arrived over HTTPS) is what actually gates `/` and
`/api/dashboard` afterward — see `internal/auth` and `api/openapi.yaml`'s
`auth` tag.

- **Whoever registers first becomes admin, and self-registration closes
  the moment they do.** No environment variable to set or get wrong, and
  no reliance on a deployment's own network boundary either — the first
  completed registration is what `Service.BeginRegistration` checks
  server-side, and every registration after that is rejected
  unless it presents a valid invite. New accounts only ever exist because
  the admin decided to add one, regardless of who else can reach the
  login page. See **Admin area** below for generating, listing, and
  revoking invites.
- **An invite is a single-use, one-hour link.** The admin picks the
  username and display name up front from the admin area's own Invites
  card; the generated `/login.html?invite=<token>&username=<username>`
  link is copied out of band (no email system exists here) and handed to
  the invitee, whose own visit to it shows nothing left to fill in but
  the passkey prompt. A token that expires or completes one registration
  can never be used again.
- **Losing every admin passkey with no other admin and no outstanding
  invite is a hard lockout.** There's no email/SMS channel here to build
  a self-service account-recovery flow on top of — the only way back in
  is restoring the SQLite database (`DB_PATH`) from a backup taken before
  the loss.
- **`RP_ID`** / **`RP_ORIGIN`** configure the WebAuthn relying party.
  They default to `localhost` / `http://localhost:8080` for a local run;
  a real deployment **must** set both to its real domain, or every
  passkey registered against the default refuses to work there — a
  passkey is cryptographically bound to the origin it was created for,
  not something this service can paper over after the fact.

### API tokens

A script can authenticate the same way a signed-in browser does, without
a WebAuthn ceremony of its own to perform: generate a personal API token
from Settings' "API tokens" card, then send it as a Bearer credential —

```sh
curl -H "Authorization: Bearer fdb_<the-generated-token>" \
  http://localhost:8080/api/dashboard
```

against any endpoint the frontend itself calls, `RequireAuth` accepts
either credential (session cookie or a live token) the same way. The one
exception is the saved filters of the web UI (`/api/settings/filter-state`): that
is the browser's own state, so it takes a session cookie only and answers a
token with 403. Each save is logged with the user agent, so a filter
that changed by itself can be traced to the client that wrote it. The raw
value is shown exactly once, right after generating it — only its hash
is stored, so losing it means generating a new one, same as any other
bearer credential. Settings lists every live token (label, created date,
last-used date) with a one-click **Revoke** that stops it authenticating
immediately.

## Admin area

Whoever registers first gets an Admin link in the dashboard header,
leading to `/admin.html`: a list of every registered user, with two
actions per row, and an Invites card for generating and managing the
links every registration past the first now requires.

- **Revoke** signs a user out everywhere — clears every passkey and every
  API token they've generated — without touching their account or saved
  forge credentials. They have to register a new passkey from scratch to
  get back in, through a fresh invite the same as any other post-bootstrap
  registration. Useful for a lost device, a compromised passkey manager,
  or a leaked API token, short of removing the person entirely.
- **Remove** deletes the account outright — passkeys, sessions, API
  tokens, and saved forge credentials all go with it, and the username
  becomes available for a fresh invite. Irreversible.

Neither action works on the admin's own account (the backend refuses it
with a 400, and the frontend disables both buttons on that row) — there's
no recovery path for locking yourself out this way.

### Invites

The Invites card generates a single-use registration link: enter the
username and display name up front — the invitee only ever completes the
WebAuthn ceremony — and the generated link is shown exactly once with a
copy button, right after creation. Only the token's hash is stored
server-side, so losing it before copying means generating a new one, the
same "show once" handling a personal API token already gets. A table of
outstanding invites (username, expiry) lists everything not yet used or
expired, each with its own **Revoke** to stop a link that shouldn't be
honoured any more — a revoked invite can never complete a registration.
Every invite expires after one hour, fixed and not configurable: long
enough to hand a link off and have the invitee act on it in one sitting,
short enough that a forgotten, unconsumed invite isn't a standing
credential.

### Requests

The Admin page's Requests card is a log of every outbound call this
instance has made to GitHub or Forgejo — across every account, an admin's
own included — newest first: when it happened, which forge, which account
made it, the method and endpoint, the status code, the outcome
(`success`, or why it failed), and the rate-limit budget left afterward
where the response carried one. It exists for the same reason server
access logs do anywhere else: correlating a shared-credential problem —
a shared GitHub token running two accounts into the same rate limit
being the case that actually motivated it — needs a cross-account view
no single account's own dashboard could give.

Filter by forge or by account (the account filter is a username, not the
internal account id, so it stays something you can actually type), and
**Export CSV** downloads the same filtered rows as a file — useful for
attaching to a bug report or pulling into a spreadsheet rather than
scrolling a table.

## Sharing

From Settings, share your own dashboard with another registered user,
read-only — they need no GitHub/Forgejo credentials of their own
configured. Once shared, a selector appears in their dashboard header
so they can switch between their own dashboard and yours; Settings also
lists everyone who's shared their dashboard with you, and everyone
you've shared yours with, with a one-click way to stop.

Enforced server-side (`GET /api/dashboard?owner=<username>` answers 403
without an active share, not just a hidden frontend control) — see
`internal/sharing` and `api/openapi.yaml`'s `sharing` tag.

## Credentials

Set from the Settings page (`/settings.html`, linked from the dashboard
header) once you're signed in — nothing forge-related is configured by
the process itself. The page has five groups (Display, Sharing, Connections,
Behaviour, Integrations and security), one shown at a time; the group is in
the URL hash, so `/settings.html#connections` opens Connections.

Each forge takes either a token (sees private repos
too) or a bare username (public repos only, no credential at all) —
never both purposes at once. A token always wins over a username if you
set both, and leaving a token field blank on save keeps whatever was
saved before, so updating your username doesn't mean re-pasting the
token too.

The server decides whether a save is valid, such as a Forgejo token or username
with no instance URL, or a bad installation ID. A refused save answers 400 with
the reason and the name of the field (`field`), and the page shows that reason
and puts focus on that input. The page holds no copy of those rules.

### GitHub

- **Token**: a personal access token with read access to the
  repositories you want tracked, plus write access to their webhooks if
  you ever plan to use the Webhooks page's "Add a webhook" button. The
  exact scope, classic and fine-grained, lives in Settings' own
  "What does this token need?" help under the token field — one place, kept
  current with what the
  app actually requests, rather than a second copy here that can drift
  out of sync with it (and did: an earlier version of this section
  named a `Contents` scope Settings' own hint has never actually
  required).
- **Username only** (token left blank): shows that account's public
  repositories, fully unauthenticated — the same data anyone gets
  landing on `github.com/<username>?tab=repositories`. Verified live
  against a real 105-public-repo account. Unauthenticated GitHub API
  calls are capped at **60 requests/hour**, so this mode only sees
  everything on an account small enough to fit that budget — a token
  (5,000/hour) is what an account this size actually needs.
- **GitHub App installation** (operator opt-in): if this deployment has
  a GitHub App configured, a field next to the token lets you connect
  an installation instead — its own independent rate-limit budget
  rather than your account's shared one. See **GitHub App support**
  under **Configuration**.

### Forgejo

- **Token**: `Settings → Applications → Generate New Token`. Same
  "see Settings' own field hint" pointer the GitHub token entry gives
  — it lists every scope, including `read:user`, easy to miss since it isn't
  obviously related to repos, but `GET /user/repos` (how repository
  discovery works) refuses a token without it: confirmed live against a
  real instance, `403 token does not have at least one of required
scope(s): [read:user]`, before it was added to the token.
- **Username only** (token left blank, instance URL still set): shows
  that account's public repositories on the configured instance,
  unauthenticated — same trade-off as GitHub's username mode. Verified
  against a real Forgejo instance's `GET /users/<username>/repos`.

## Documentation

- [Pull request actions](docs/pull-request-actions.md): what a row offers, and
  why a blocked action is blocked.
- [Webhooks](docs/webhooks.md): registering the forge webhook.

## Error pages

The dashboard has its own error pages, built with the rest of the web app as
`404.html` ("Page not found") and `500.html` ("Something went wrong on our
side"). The Go server sends the first for an address nothing matches and the
second for a crash, each with its real status code. Asking for either file by
name gets the 404, never a 200. Each page says what happened in plain words and
gives a way back: a primary link to the pull requests and a short list of the
other pages. The 500 page also has a `Try again` link to the same address. They
show nothing about the server beyond the release version the footer shows
everywhere (no stack trace, path or host), and follow the light or dark theme.
They run no script, so the app can't fetch that version: the Go server fills it
into the `#footer-version` slot of the footer when it starts, and a test fails
if the web build drops the slot. The same no-script rule means the app's router
can't swap one for the page whose address it was sent at. Inside the app,
`+error.svelte` renders the same page for an error the router meets, and
`handleError` keeps the message generic. `src/error.html` is the static fallback
for an error the app can't render itself.

## Pull request details

Clicking a pull request row, anywhere on it, opens a read-only pop-up. The
row's title is the button that does it, stretched over the row; the CI pill,
the labels and the action buttons stay clickable on top of it. The pop-up has
the pull request's description, its comments and the thumbs up and thumbs
down reactions on each, and an **Open on GitHub** (or Forgejo) link. On the
Releases page the pop-up shows the release notes in place of the description.
A Dependabot or Renovate pull request opens the same pop-up, with its long
generated description folded away until you open it. There are no actions in
it yet: Merge, Update branch and the rest stay on the row.

The pop-up loads when it opens, from `GET /api/pull-requests/details`, and
never as part of the dashboard snapshot, so a forge's budget isn't spent on
rows nobody opens. It shows the first 50 comments and says so when there are
more. The header draws the row's three tiers as they were when it opened: the CI
slot first (Running, Failed or Passed, the row's glyphs and words) with a
Conflicting or Blocked pill beside it when the row has one, then the title,
then the attributes as quiet outlined chips (auto-merge, draft, bot, out of
date, labels, and the version on the Releases page). Each comment carries the
author's avatar (the forge's own HTTPS image URL, or an initial if it isn't one
or can't load), a relative time and an
"edited" mark. A deleted author reads "ghost". Hovering or focusing a reaction
lists who gave it, up to ten names and then "and N more"; Escape hides that
list first and a second press closes the pop-up. Reactions are display only.
When the details can't load, it says so in plain words with **Try again**.

The text is Markdown and the server doesn't sanitise it, so the page renders
it with [markdown-it](https://github.com/markdown-it/markdown-it) with raw HTML
off: tags show as text, images aren't loaded, only absolute `http`, `https`
and `mailto` links are links (anything else stays plain text), and they open
in a new tab with `rel="noopener noreferrer"`. Task list items (`- [x]` and
`- [ ]`) show as read-only checkboxes; ticking one changes nothing on the
forge. The library loads the first time a pop-up opens.

## Releases

Release pull requests have their own page, `/releases.html`, reached from the
**Releases** item in the navigation. It is the pull request board over the
pull requests the server marks `kind: release` (release-please's, by its
`autorelease:` label), with the same filters, rows and actions as the main
page. The main pull request page lists none of them, and doesn't count them. Each
row shows the version being released next to the title. Merge is offered when
the release can merge, or greyed out with the reason when it can't. A release
that is behind its base branch gets Update branch and a line saying
release-please won't update it until a releasable change lands. With no release
pull requests open the page says nothing is waiting to ship.

The quick filter pills above the list include **Failing CI**, **Running CI**
and **Passing CI**, each offered only when it would show something. Next to
them an **Auto-merge** control has Any, On and Off. On shows only pull requests
that have auto-merge armed, Off only those without. It combines with a pill, so
Failing CI with Auto-merge On finds armed pull requests whose checks have since
failed.

## Bots

Dependabot and Renovate pull requests have their own page, `/bots.html`,
reached from the **Bots** item in the navigation. Like Releases, it is the pull
request board over the pull requests the server marks `kind: dependency`, with
the same filters, rows and actions as the main page. The main pull request page
lists none of them, so it has no quick filter for bots. A filter saved before
that change is ignored. With no bot pull requests open the page says there is
nothing to review.

Every item in the navigation shows how many items its page lists, and how many
of them are failing. It is one pill: a neutral **total**, then the outcomes,
failing (red) and passing (green), then a thin divider and the state, running
(amber, a spinner, or a still clock under reduced motion). Each count has its
own glyph so colour is never the only signal. Branches counts default
branches. Pull requests, Releases and Bots count their pull requests (without
the ones that belong to another of the three). All four show those three
counts, in that order. The divider appears only when a running count follows an
outcome, and not on a phone. A pull request with no checks is in the total
only, so its numbers needn't add up. Branches adds a fifth, neutral count with
a dashed circle for the branches with no pipeline, last, so its numbers do add
up. A zero is never drawn, and the link's name says the same in words, in the
same order: "Pull requests, 15 total, 2 failing, 10 passing, 3 running", and
"Branches, 7 total, 2 failing, 3 passing, 1 running, 1 without a pipeline". On
a phone the total sits on its own line above the counts, and with three-digit
numbers each count takes a line, so the busy tabs grow to about 110px. Issues
counts open issues, without Renovate's Dependency Dashboard or what your
settings hide, and has no failed count. The server works the numbers out from
the same lists the pages show (`navCounts` on `/api/dashboard`), so a page
agrees with its icon, and a hidden pull request is in neither. The dashboard
pages set them from each snapshot. The other signed-in pages (Branches,
Insights, Settings and the rest) load them and ask again every 30 seconds
while the tab is visible, so a refresh or a webhook changes them without a
reload.

A zero is never drawn: a page with nothing in it has no total, and nothing
failing means no red pill. A page with nothing to show leaves the navigation:
the Pull requests, Releases, Bots and Issues links are not in the header or the
phone's tab bar while their total is 0. Branches always shows. A count that
isn't known yet is not 0, so the links stay until the first snapshot says
otherwise, and the page you are on keeps its own link until you leave it. The
page still opens when typed into the address bar, and says it is empty.

The pages start with their list, with no row of tiles repeating those numbers.
One line near the list's heading says how many rows show: "12 open" with no
filter, "Showing 1 of 12" when a filter narrows it. The Failing CI pill filters
to failing pull requests, and All clears it. How many repositories are tracked
is a quiet line under the Insights heading. A page with nothing open says so,
even when its nav item is hidden.

On a phone the numbers sit above each tab's icon. An item's accessible name says
both in words: "Branches, 12 total, 3 failing, 8 passing, 1 running" on the
header icon, "12 Branches, 3 failing, 8 passing, 1 running" on the tab, which
shows its numbers before its word.

## Main branches

The CI status of every tracked repository's default branch is the first thing
you see: it's the index page, `/`, reached from the **Branches** item, the first
one in the navigation. The menu runs Branches, Pull requests, Releases, Bots, Issues,
then the rest. The item always shows. The page reads
`GET /api/main-branches`, so a broken main shows up without opening each repo.
A repo you ignore for pull requests is left out, here and in the badge.
The pull request list is at `/pull-requests.html`. The page used to live at
`/main-branches.html`, which now redirects to `/`.

Each row shows the status top right, in the same slot the pull request rows use:
a running branch is a state (Running, an amber spinner, a still clock under
reduced motion) and a finished one an outcome (Failed or Passed), with the same
glyphs and colours, so a run turns into its result without the row moving. A
branch with no pipeline is neither, so it gets a quiet outlined "No pipeline"
note instead. The row also shows the repo, the branch, the short SHA, subject
and author of the newest commit, how long ago the run finished and how long it
ran. A failed row names its failing jobs and expands to list them. **View run**
opens the run on the forge. Rows come latest commit first, in the order the
server sends them.

The pills (All, Failing, Passing, Running, No pipeline) keep their filter names,
like the quick pills on the pull request board, and carry the server's counts. A
pill, and each forge in the toggle, is offered only when a row would show under
it, given the search and the other pill, so none leads to an empty list; the one
that is active always stays, so it can be cleared. A forge toggle and a search
box narrow the list further; search matches the repo, branch, commit, author and
failing job names. The filter is saved in a cookie of its own,
`forge-board-main-branches`, and is still set after a reload. It is not part of
the shared filter cookie, which holds pull request and issue state.

Rows from a forge that can't be read, or whose rate limit is spent, keep their
last known status, are marked **stale**, and sit under one banner. The page
offers no write at all: there is no Re-run, because the only re-run endpoint
works on a pull request's checks, not on a default-branch run. With every
default branch passing the page says so, and a filter that matches nothing
offers **Reset filters**. A repo with no pipeline says no run was found.

## Main branches API

`GET /api/main-branches` answers the CI status of every tracked repo's default
branch, so a broken main shows up without opening each repo. One row per repo:
its default branch, the status of the pipeline on the newest commit (`failed`,
`passed`, `running` or `none`), the commit (short SHA, subject, author), the
names of the failed jobs, when the pipeline finished and how long it ran, and a
link to the run. The response also counts the rows per status. Every row is
returned whatever its status, ordered by commit time, latest first (rows with
no commit time last, then by repo name), so a client filters it and its counts
always match what it lists. Status is a filter, not the order.

It reads the snapshot the background refresh already holds and never calls a
forge, so reading it costs no rate-limit budget. The refresh gets the data
cheaply:

- **GitHub**: the default branch's newest commit and its checks ride the
  repository query the refresh already makes for pull requests and issues, so
  they add no request. That covers a personal access token and a GitHub App.
  A username with no token has no rows, because its hourly budget is too small
  to spend on this.
- **Forgejo**: the refresh lists the Actions runs of each repo's default
  branch (one call per repo, plus one for the commit, plus one for the jobs of
  a failed run). Forgejo has no rate limit by default.

A forge that can't be reached keeps its last known rows, each marked `stale`
with the time it was last fetched, and so does a forge whose rate-limit budget
is spent (the refresh skips it until the reset). A repo whose read failed while
its forge answered keeps its own earlier row the same way. A repo with no
pipeline on its newest commit, an empty repo, or a Forgejo instance without
Actions shows `none`. The snapshot updates on each full refresh, and a webhook
delivery for a repo (a finished check, say) re-reads that repo's default branch
at once, so a rerun that passed turns its row green without the next poll. If
that read fails, the row keeps its earlier state.

## Issues

Open issues have their own page, `/issues.html`, reached from the **Issues**
item in the navigation. The item carries a count badge, the number of open
issues without Renovate's Dependency Dashboard, which the page hides by
default. The badge is set from each snapshot on the dashboard and issues
pages, and loaded once on the other signed-in pages. The pull request page no
longer lists issues.

Next to **Hide Dependency Dashboard**, the **Hide titles matching (regex)**
box hides the issues whose title matches a regular expression. The match is
case-insensitive and can fall anywhere in the title, so `^Weekly report` hides
every issue whose title starts with "Weekly report". Empty hides nothing. A
note says how many issues the pattern hides, and the repo, author and label
choices leave out what it hides. The pattern is saved with the other filters,
and **Clear filters** empties it. A pattern the page can't use is ignored and
the list stays as it was. A syntax error shows "That pattern isn't valid." A
pattern that parses but could be slow shows "That pattern is too complex to
check safely. Try a simpler one." The page estimates how many ways the pattern
can match, multiplying every alternative and repeat, and refuses one that is
too many: more than 200 characters, two or more open-ended repeats (`*`, `+`,
`{2,}`) in one pattern (so `\d+\.\d+` and `.*foo.*bar` are refused, while
`start.*end` is fine), or repeated and chained groups such as `(a+)+`,
`(a+){5}` or `(a|b)?` written twenty times in a row. It tests only
the first 128 characters of a title. This is a safety margin tested by
fuzzing, not a proof. The rule applies to the Issues board only; Insights
charts ignore it.

### First refresh

After a restart the server holds no state, so the first snapshot is empty until
the first refresh for that user ends. `firstRefreshDone` on the dashboard
snapshot tells an empty board from one that hasn't loaded: it is `false` from
process start until the viewer's first refresh has finished, whether it
succeeded or failed (a failed one shows in the forge health), and `true` from
then on, including after later refreshes and settings saves. It is per user and
not stored, so a restart resets it. An account with no saved settings has
nothing to refresh, so it reads `true` at once. `GET /api/dashboard`, the
stream and the `get_dashboard` MCP tool all carry it.

### Issues your settings hide

Two settings, saved with your account and applied by the server, keep issues
out of everything you see:

- **Hide Dependency Dashboard** (`hideDependencyDashboard` in the API) leaves
  out the bot-kept Dependency Dashboard issue.
- **Ignored titles** (`ignoredTitles`) is a list of patterns. An issue whose
  title matches at least one is left out. A pattern matches anywhere in the title
  and ignores case, so `^Weekly report` leaves out every issue whose title
  starts with "Weekly report".

The server drops those issues from `issues` in `GET /api/dashboard`, its
stream and the `get_dashboard` MCP tool. `openIssueCount` and
`navCounts.issues.total` count what remains, so the navigation badge, the
Issues board and Insights agree with no arithmetic in the client.
`settingsHiddenIssueCount` says how many issues the settings dropped, and is
`0` when none were. The same response carries `hideDependencyDashboard` and
`ignoredTitlesSet` (true when the list isn't empty), so a client knows whether
to draw its own fields without reading `/api/settings`.

`GET /api/settings` and the response to saving it also carry
`ignoredTitleCounts`: for each pattern in `ignoredTitles`, in the same order,
how many of your open issues that pattern matches on its own. An issue two
patterns match counts for both, so the entries can add up to more than
`settingsHiddenIssueCount`. Issues of a repo whose issues you ignore aren't
counted, as with that total. Every entry is `null` while the answer isn't known
yet, because your first refresh hasn't finished or no forge answered it, and
never a made-up `0`. The
response to a save counts the list just saved, against the issues you had
before the save.

Patterns use Go's RE2 syntax. It has no lookahead, lookbehind or
backreferences, and it can't run slowly, so no pattern is refused for being
complex. A pattern that matches the empty string, such as `.*` or `^`, is
refused: it would match every title and hide every issue. Saving trims each
pattern, drops blanks and repeats (ignoring case), and takes at most 20
patterns of at most 200 characters. A pattern that doesn't compile is a 400
that names `ignoredTitles` and the entry, counted from 1 in the list as sent,
and says why, as in `ignoredTitles entry 2 ("("): missing closing )`.
Nothing is saved then, not the other patterns and not the other settings.

On a dashboard someone shared with you (`?owner=`), the issues are theirs and
the settings are yours: your own choices decide what you see, and theirs don't
reach you.

### Issues in Settings

The **Issues** section of Settings holds two standing rules, saved with the
account and applied by the server, so they follow you to another browser:

- **Hide the Dependency Dashboard issue** leaves Renovate's Dependency
  Dashboard out everywhere.
- **Ignored issue titles** is a list of up to 20 patterns of up to 200
  characters. An issue whose title matches any of them is left out. A
  pattern matches anywhere in the title and ignores case, so `^Weekly report`
  leaves out every issue whose title starts with those words. Type a pattern
  in **Pattern**, then press **Add**. **Remove** drops an entry. Blanks and
  repeats are dropped. Both settings save with the **Save** button.
  Next to each saved pattern a small label says how many of your open
  issues it hides on its own: "hides 3 issues", "hides 1 issue" or "hides no
  issues", so a typo that matches nothing stands out. An issue that two
  patterns match counts for both. The server does the counting, so the numbers
  agree with the Issues page. A pattern you just added says "Counted after you
  save" until the save finishes, and the labels follow each save without a
  reload. When a save comes back before the server can count (your first save,
  or one before the first refresh finished), the labels say "Counting…" and the
  page asks again, up to five times two seconds apart. If no count arrives,
  nothing shows next to the pattern.

Because the server applies them, the Issues badge in the navigation, the
Issues page and the Insights issue charts all leave those issues out, and the
Issues page and Insights say "N hidden by your settings" with a link back to
Settings. They cover issues only, not pull requests. The server checks the
patterns with Go's own syntax (RE2), which cannot look ahead or refer
back to an earlier match, unlike the filter box on the Issues page. A pattern it
refuses is shown beside the list with the reason, and nothing is saved.

While a setting applies, the page's own field for it is not shown: the **Hide
Dependency Dashboard** checkbox on the Issues page and Insights while the first
setting is on, and the **Hide titles matching (regex)** box while the list has
an entry. What you had in those fields is kept, not used, and comes back when
you turn the setting off or empty the list. **Clear filters** changes neither
setting.

The repo, author and label choices on the pull request, release, bot and issue
pages and on Insights come from what the page can show: the items every other
filter lets through, and without the Dependency Dashboard while it is hidden. A
repo whose only issue is that one isn't offered until **Hide Dependency
Dashboard** is unchecked. Hiding it again clears a repo picked on that basis.
The CI status select, the Created and Updated ranges and the forge buttons on
Insights follow the same rule: a CI state, a range or a forge appears only when
something in the results is in it, and a pick that nothing matches any more is
cleared. The CI and age choices also follow the other one and the quick pills,
so picking one never leaves an empty list. The quick pills do too: a pill is
offered only when clicking it would show something, and the one that is active
stays so it can be cleared.

`GET /api/dashboard` and its stream carry `navCounts`, the numbers behind every
navigation badge: for Branches, Pull requests, Releases and Bots a `total` and
how many have CI `running`, `failed` and `passed` (a branch by its
default-branch pipeline); and for Issues a `total` only. A pull request with no
checks counts in the total alone, so the four numbers need not add up. A branch
with no pipeline is counted as `none`, so a branch's four states add up to its
total. They count what each page shows when it opens. Pull requests
leave out ignored repos, drafts and hidden ones, even while Show drafts or
Show hidden is on. Branches counts the default branches its page lists, which
also leave out ignored repos. They are always present, zero when nothing is
there.

The issues page filters like the pull request page: forge, repo, title,
author, label, created and updated, plus Group by. Those filters are shared
and saved with your other filters, so a filter set on one page is still set on
the other. The pull-request-only controls (CI status, the quick filters for
failing, ready, needs-review and conflicting pull requests, Show drafts)
are not on the issues page.

Filters are remembered per account, in a cookie and in a copy on the server,
so they follow you to another browser. The repo, author, label, created,
updated and CI status choices each page offers come from its own list. When
you open a page that doesn't offer a saved choice (an author who wrote no
pull request, on the pull requests page), that page shows its list without
it and leaves the saved choice alone, so it is still set when you go back to
the page that does. The page says so under the filter bar (`Saved author
"x" is not on this page.`) with a Clear button, and Clear filters is on and
ends the saved choice too. Changing that control on the page ends it as well.
Text typed in the title search or the hide-titles pattern is sent to the
server half a second after the last key, and at once when you leave the page
or switch tab, so a value typed just before leaving is kept.
What is deliberately not remembered: the page you were on and the page size,
the open Filters sheet on a phone, held updates, open menus and pop-ups, and
the expanded rows on Branches. Branches keeps its own filter in a cookie
only, so it doesn't follow you to another browser.

The issue list holds still while you read it. A refresh that would add, remove
or move rows is held behind an "N updates available" bar while you're scrolled
below the top, a control in the list has focus, or live updates are paused;
**Show updates**, or a change to a filter or the sort, applies it. The bar
counts only issues the list would show: a change to one the filters or the
hidden Dependency Dashboard keep out of sight asks for nothing, and neither does
a change to pull requests. At the top with nothing focused, changes just appear.
A row whose own content changed updates where it stands, and a refresh with no
change leaves every row alone. Sort works as it does for pull requests. The
pause setting is shared with the pull request page.

## Filters on a phone

Below 760px wide the filter bar folds down so the first screen shows pull
requests. Closed, it is one search row (the title filter and a **Filters**
button) and one row of quick filters that scrolls sideways. The button's count,
as in "Filters (2)", is how many filters are on: forge, repo, author, label,
created, updated, CI status, and Show drafts. Each active filter also shows as a
chip you can tap to remove without opening anything.

**Filters** opens a bottom sheet with the rest of the controls: forge, Show
drafts, sort, group, repo, author, label, created and updated. Filters apply as
you change them, and the sheet's **Show N results** button, which closes it,
says what you would see, so a refresh can't change something you are editing.
**Clear all** resets everything. Escape, the close button, or a tap outside
closes the sheet and returns focus to the Filters button. On wider screens
nothing changes except that the title filter now sits first in the bar.

## Live updates

The board polls on the schedule in `readIntervalSeconds` (30 seconds today, set
by the server, or 2 until your first refresh has finished) and takes pushes
over a live stream, but
rows don't move while you're reading. A change to a row's own content (CI,
merge status, behind, labels, title) updates that row where it stands and
marks it "Updated just now" for a couple of seconds. Anything that would
add, remove or reorder rows waits behind an "N updates available" bar
under the filter bar; **Show updates** applies it all in one render, and so
does changing a filter, the sort or the page. Nothing re-renders while
focus is inside a row, a More actions menu is open, a modal window is open, or a
row action is in flight. **Pause live updates** stops every automatic
update until you turn it back on (Refresh now still works). The **Sort**
control offers Last activity (the default, the server's order: most recently
updated first, whether or not a pull request is ready to merge), Created and
Repository. Pause and sort are saved with your other filters.

Draft pull requests are left out by default. The **Show drafts** toggle in the
filter bar, off to start with, brings them back, marked "Draft", and its muted
"N hidden" count says how many are left out. The choice is saved like the other
filters and goes with every dashboard request, refresh and the live stream.

### The first load after a restart

A restarted server holds no state until your first refresh has finished, so its
first snapshot is empty. While the snapshot's `firstRefreshDone` is `false`,
Pull requests, Releases, Bots, Issues and Branches show placeholder rows and one
polite "Loading your repositories…" line, not their empty states, and the
navigation shows a dash where a count would be. After about ten seconds the line
says the first refresh can take a while. The placeholder doesn't animate under
reduced motion. A snapshot without the flag counts as loaded. An unreachable
forge still shows in the forge health banner. While the flag is `false` the
server also advises a short `readIntervalSeconds` of 2, so the rows appear
soon after the refresh ends, not up to 30 seconds later.

## Hiding one pull request

A pull request you can't or won't act on yet can be hidden. **More actions** on
its row has **Hide this pull request**, and **Hide for 7 days** under it. It
leaves the list, the quick-filter counts and Insights at once,
with no confirm step, since it is reversible. Nothing is sent to the forge.

A status message says `Hid PR #123 ‘title’.` with an **Undo** button. It stays
until the next message, and the same restore is in the list below, so it isn't
lost to a timeout. Once anything is hidden, a **Hidden (N)** button by the list
header opens that list: repo, number, title, "Hidden until you restore it" or
"Back in 6 days", and a **Restore** button on each. With none hidden, neither
shows.

A hide for days ends by itself. A hide is forgotten once the pull request is no
longer open, while its forge answers. A forge that is rate limited or
unreachable draws no controls on its rows, so Hide is absent there too until it
answers again.

## Webhooks

Optional. Without one, the dashboard still refreshes on its own schedule
and the browser tab polls it on the server's schedule (30 seconds
today); a webhook just means a new
pull request, a closed issue, a new comment, or a CI status change on a
tracked repo shows up within seconds instead of at the next poll. Set up from the
Settings page, one forge at a time — full copy-pasteable steps, exactly
which events each part of the dashboard needs (CI status specifically
needs its own, easy-to-miss event), and how delivery verification works:
[docs/webhooks.md](docs/webhooks.md).

A delivery refreshes just the repository it names, not the account's
whole tracked-repo set — a much smaller GraphQL query on GitHub than a
full refresh runs. A payload with no repository (the initial "ping"
delivery a new webhook sends, say) falls back to a full refresh instead.

Each refresh also asks GitHub whether every repo's webhook is pointed at the
dashboard. A GitHub App without the repository webhooks permission gets
"Resource not accessible by integration" for all of them, so that answer is
remembered for an hour and the checks are skipped, with one warning in the log.
A token that can't administer one repo is skipped for that repo alone. Grant
the permission and the next check after the hour sees it.

A webhook the dashboard created earlier is brought up to date without a click.
After the first refresh that finds a repo's webhook, the dashboard lists that
repo's hooks once and, only if the hook lacks an event the dashboard now
subscribes to, edits it in place. It never creates a hook there. Cost: one
extra hooks listing per covered repo per process start (plus one edit for a
hook that is out of date), at most four at a time, each after a short random
pause. A forge that is unreachable or out of REST budget is skipped and tried
again on a later refresh, and never fails one. A repo whose hooks the token
can't administer is tried once and left until the next restart.

## Configuration

Everything the process itself needs is environment variables — no
config file, and nothing forge-related, since that's per-user now (see
the preceding **Credentials** section):

| Variable                        | Required                           | Default                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADDR`                          | no                                 | `:8080`                    | Listen address.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DB_PATH`                       | no                                 | `/data/forge-dashboard.db` | Where passkeys, sessions, and every user's encrypted forge credentials live.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `RP_ID`                         | no                                 | `localhost`                | The WebAuthn relying party ID — set to your real domain in any real deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `RP_ORIGIN`                     | no                                 | `http://localhost:8080`    | The WebAuthn relying party origin — set to the real `https://` origin users reach this at.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ENCRYPTION_KEY`                | **yes**                            | —                          | Base64-encoded 32-byte key for encrypting forge tokens at rest. Generate with `openssl rand -base64 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GITHUB_APP_ID`                 | no                                 | —                          | The numeric ID of a GitHub App this deployment lets users connect instead of pasting a personal access token — see **GitHub App support** below. Unset means the option doesn't exist at all; no other GitHub behaviour changes.                                                                                                                                                                                                                                                                                                                                               |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | **yes, if `GITHUB_APP_ID` is set** | —                          | Base64-encoded PEM private key for that App, downloaded from its GitHub settings page. Validated at startup — a malformed key fails loudly there, the same way a bad `ENCRYPTION_KEY` does.                                                                                                                                                                                                                                                                                                                                                                                    |
| `REFRESH_INTERVAL`              | no                                 | `20m`                      | How often the backend re-polls a signed-in user's forges, as a Go duration (`2m30s`, `10m`). A safety net now that every tracked repo gets a webhook — lower it if you're not relying on those.                                                                                                                                                                                                                                                                                                                                                                                |
| `SHUTDOWN_DRAIN`                | no                                 | `5s`                       | How long `/readyz` answers 503 after SIGTERM before the server stops accepting connections, so a router polling it takes the container out of rotation first. `0s` skips the wait. Keep the container's stop grace period longer than this plus 5 seconds.                                                                                                                                                                                                                                                                                                                     |
| `CI_POLL_INTERVAL`              | no                                 | `1m`                       | How often the backend re-checks just the open pull requests whose CI is still pending, or that have GitHub's own auto-merge armed (GitHub merges those by itself, and without a webhook the board would otherwise learn of it at the next full refresh; one is polled for as long as it stays armed, a query a minute per repo, and not at all while the forge's budget is spent), as a Go duration. A fallback for real Forgejo instances that silently drop the webhook event CI status rides on (see `docs/webhooks.md`) — set to `0s` to turn it off if you don't need it. |
| `LOG_LEVEL`                     | no                                 | `info`                     | `debug`, `info`, `warn`, or `error`. `debug` logs every outbound request to GitHub/Forgejo (method, URL) — turn it on to diagnose a request-volume spike from the process's own logs instead of reasoning about the code from the outside.                                                                                                                                                                                                                                                                                                                                     |

Repository discovery is automatic per user. With a token, the dashboard
lists every repository it has push access to — on GitHub, one GraphQL
query returns that whole list along with every repo's open pull requests,
open issues, and CI status in a single request (drawing from GraphQL's
own separate rate-limit pool, not the REST budget everything else on the
account shares); on Forgejo, `GET /user/repos`. A GitHub App installation
discovers its repos differently: GraphQL's `viewer` field means "the
authenticated user," which an installation access token has none of, so
this path lists the installation's own granted repos via REST
`GET /installation/repositories` instead, then still fetches each one's
open pull requests/issues/CI status via GraphQL (`repository(owner:,
name:)`, which has no such restriction). With only a username, it lists
that account's public repositories (`GET /users/<username>/repos` on
both) with no credential in play at all — GitHub's GraphQL API allows no
anonymous access, so this mode stays REST-based there too. Either way
there's no per-repo allowlist to maintain — archived and forked
repositories are excluded automatically, on both forges, in every mode.
On Forgejo, a mirrored repository is excluded too — a pull mirror has no
pull requests or issues of its own to poll, and its canonical home is
whichever forge it's mirrored from.

Each pull request also carries its review state (`review` in `/api/dashboard`:
decision, approvals, requested reviewers). The **Ready to Merge** and **Needs
review** quick filters read the server's own answers, `readyToMerge` and
`needsReview` on each pull request, so the page holds no definition of either.
On GitHub that rides on fields of the same GraphQL query, so it costs no extra
requests. On Forgejo the requested reviewers come with the pull request list,
but approvals take one `GET /repos/{owner}/{repo}/pulls/{index}/reviews` call
per open, non-draft pull request. Those results are cached until the pull
request's `updated_at` changes, so after the first refresh a quiet dashboard
spends none of them. A pull request that closed or merged drops out of that
cache on the next refresh of its repo. A pull request whose review state
couldn't be read has no `review` and never matches the filter. Needs review
means a review is outstanding: the forge requires one, or a reviewer was asked
and hasn't answered. A pull request nobody was asked to review doesn't count.

The **Review requested from me** quick filter keeps the pull requests that ask
you in particular: `reviewRequestedFromMe` on each pull request, which the
server matches, ignoring case, against the username saved for that forge in
Settings. It needs that username: with none saved for a forge, none of that
forge's pull requests match. It adds no requests, since the requested
reviewers' names come with the data already fetched.

Each pull request also counts its review comments, `reviewComments` in
`/api/dashboard`, and the review threads still open, `unresolvedThreads`.
Ordinary conversation comments aren't counted. GitHub reads both from the
review threads in the pull request query, so it costs no request. It reads the
first 30 threads, so a pull request with more reports fewer than it has. The
unauthenticated fallback has no thread data and reports 0 comments and a `null`
`unresolvedThreads`.
Forgejo's count is the sum of each review's comments from the reviews call that
already feeds `review`, so a draft reports 0. Forgejo gives no resolved state
without a request per review, so its `unresolvedThreads` is `null`: unknown, not
zero.

Each row shows that as a pill beside the other status pills: the number
of review comments, and `7 · 2 open` in amber, with a dot, when threads are
still unresolved. A pull request with no review comments shows nothing, and on
Forgejo, where `unresolvedThreads` is `null`, the pill shows the count with no
open state. The pill is a link to the pull request's files-and-review view on
the forge, opened in a new tab. Its accessible name is the full sentence, such
as "7 review comments, 2 unresolved threads".

`awaitingWorkflowApproval` is true when GitHub is holding a workflow run on the
head commit until someone approves it (a check run counted as `ACTION_REQUIRED`
in the checks summary). It adds no request, and it is false when that summary
belongs to an earlier commit. It can be true while `ci` is pending or failing
for another reason. A third-party check that concludes `action_required` counts
too. Forgejo and the unauthenticated fallback always report false.

The **Conflicts** quick filter keeps the pull requests with a merge conflict, so
they can be fixed in one pass. It reads the `mergeStatus` of each pull request,
`conflicting`, the same field behind the row's own Conflicting pill, so the page
holds no rule of its own. A draft that conflicts is listed too.

Draft pull requests are left out of `/api/dashboard` by default, since nothing
can be merged or updated on one. The response says how many it left out in
`hiddenDrafts`. Pass `includeDrafts=true` to get them back, on the dashboard,
its stream and the refresh endpoint alike. The auto-update-branch feature
never touches a draft either.

Stacked pull requests are marked in `/api/dashboard`. A pull request is
stacked on another when its base branch is that one's head branch, in the same
repository and neither comes from a fork. Each pull request carries `stack`
(its position and the stack's size, or null), `stackedOn` (the parent) and
`stackChildren`. Merge on a stacked child is blocked with the code `stacked`,
since merging it would land it in the parent's branch, and auto-merge isn't
offered either (GitHub refuses it there, because the parent's branch has no
protection rule). The snapshot holds open pull requests only, so a parent that
already merged without the child having its base changed isn't flagged.

When a refresh against a forge fails (a rate limit, a timeout, an error from
its API), the dashboard keeps showing that forge's last good pull requests,
issues and repos instead of none, and the forge's health carries `staleSince`,
the time that data was fetched, next to `reachable: false`. The next good
refresh replaces it. A forge that has never fetched successfully has nothing
to show.

### GitHub App support

GitHub's primary rate limit (5,000 requests/hour, both REST and GraphQL)
is scoped to the _account_, not the token — a personal access token's
polling shares that exact budget with anything else acting as that same
account: your own use of `gh`, other tools, CI. A GitHub App
installation token draws from that installation's own independent
budget instead, so this is worth setting up once your account's own
usage is bumping into the shared limit.

To offer this to your users:

1. [Register a GitHub App](https://github.com/settings/apps/new) —
   any name, no webhook needed. Grant it Contents, Issues, and Pull
   requests (read and write), which is what "Add a webhook" and repo
   discovery need; Metadata (read) comes along automatically.
2. Generate a private key on the App's own settings page, then
   base64-encode the downloaded `.pem`: `base64 -w0 your-key.pem`.
3. Set `GITHUB_APP_ID` (the numeric ID the App's settings page shows)
   and `GITHUB_APP_PRIVATE_KEY_BASE64` (the value from step 2) on the
   deployment and restart it — a malformed key fails at startup, not on
   a user's first save.

From there it's per-user, from Settings: each person installs the App
on their own GitHub account (its own settings page → **Install App**)
and pastes the installation ID GitHub shows them into the new field
next to their token. An installation always wins over a saved token
when both are set for polling and every other action — the token stays
saved rather than being cleared, and is used for one thing only:
sending `@dependabot` comments, which Dependabot refuses from a GitHub
App (see the Dependabot buttons in
[Pull request actions](docs/pull-request-actions.md)). Leave `GITHUB_APP_ID`
unset and the field simply doesn't appear; nothing else about GitHub credentials
changes.

## Running it

```sh
go build -o forge-dashboard ./cmd/forge-dashboard
mkdir -p data
DB_PATH=./data/forge-dashboard.db \
  ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  ./forge-dashboard
```

Then open `http://localhost:8080`, register a passkey — `RP_ID`/
`RP_ORIGIN` default to `localhost`/`http://localhost:8080`, which matches
this local run with nothing extra to set — and add your GitHub/Forgejo
credentials from the Settings page.

### Docker

The `/data` directory the image ships is where the database goes — mount
a volume there, or every passkey and every saved credential is gone the
moment the container is recreated:

```sh
docker build -t forge-dashboard .
docker run --rm -p 8080:8080 \
  --cap-drop=ALL --security-opt=no-new-privileges --read-only \
  --memory=64m --cpus=0.5 --pids-limit=64 \
  -v forge-dashboard-data:/data \
  -e RP_ID=localhost -e RP_ORIGIN=http://localhost:8080 \
  -e ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  forge-dashboard
```

The image carries a `HEALTHCHECK` that runs `/forge-dashboard healthcheck`,
which asks `GET /readyz`. It means "can serve": the database answers and its
tables exist. Once someone has signed in and a first dashboard refresh has
finished, it also waits on that, and a forge that failed the refresh still
counts. A freshly started container has no refresh to wait for, since the
app only fetches from the forges after a sign-in. The database ping gets 2
seconds and its result is reused for about 3, so a stuck database answers
503 instead of hanging the probe. On SIGTERM it answers 503 at once, then
the server waits `SHUTDOWN_DRAIN` before it stops. A 200 also reports the
`goroutines` and OS `threads` the process holds. The container's process limit
counts threads, so watch `threads` to see growth before the healthcheck can no
longer start. A 50-repo refresh from six tabs peaks at about 20 threads, so
`--pids-limit=64` leaves room. Read it with:

```sh
docker inspect --format '{{.State.Health.Status}}' <container>
```

`starting` is normal for up to 30 seconds after boot, then `healthy`. A
healthy container stays healthy when a forge goes unreachable. That shows
on the dashboard, not here. `GET /healthz` stays the cheap liveness answer
(the process is up). In Compose, `depends_on` with
`condition: service_healthy` waits on the same state.

Generate `ENCRYPTION_KEY` once and keep it — losing it makes every saved
credential unrecoverable, and every user has to re-enter theirs from the
Settings page.

The published image is `ghcr.io/alrayyes/forge-dashboard`, built and
pushed on every release by `.goreleaser.yml`'s `dockers:` block — tagged
by version and `:latest`, `linux/amd64` and `linux/arm64`.

## Deployment

Deployed on a homelab, reachable only over Tailscale. Passkey login is
now the actual access control — the tailnet is defence in depth on top
of it, not the only thing standing between a visitor and the dashboard
the way v1 originally had it. The image is pulled into that homelab's
existing compose setup as its own service directory, routed through the
Traefik instance already running there; there's no per-service Tailscale
sidecar, since every service on that host reaches the tailnet the same
way. That deployment config — including the `/data` volume this now
needs, and `RP_ID`/`RP_ORIGIN` set to the real deployed domain rather
than the `localhost` defaults — lives in that private deployment repo,
not here.

### The changelog page

The version in the footer links to `/changelog.html`, which works without
signing in. It lists the releases in `CHANGELOG.md`, newest first, 20 at a time
with a button for the older ones, and makes no request to GitHub. The web build
turns `CHANGELOG.md` into `/changelog.json` (`scripts/changelog-json.ts`, a
build output that isn't committed) and the page reads that one same-origin file.
It therefore lists exactly the releases the running version was built from, so
the footer version and the newest entry agree. The footer reads the running
binary, so it lags the published release until the deployment updates. The page
used to live at `/releases.html`. That address now serves the Releases page
below, with no redirect, so an old bookmark or a browser that cached the earlier
301 needs `/changelog.html` typed once.

## API

`api/openapi.yaml` is the contract: `GET /healthz` for liveness, `GET /readyz`
for readiness,
`GET /api/dashboard` for the aggregated snapshot of the signed-in user (or,
with `?owner=<username>`, one shared with them; `?includeHidden=true` lists the
pull requests the user hid, marked `hidden`, and `hiddenPullRequests` counts
them), `POST /api/pull-requests/hide` and `/unhide` to hide one pull request
(until restored, or for `days`) and bring it back,
`GET /api/pull-requests/details` for one pull request's description, comments
and thumbs up and down reactions (on demand, never in the snapshot: Markdown
as the forge stores it, cut at 20,000 characters, the first 50 comments, and a
release pull request's release notes; one GraphQL query on GitHub, up to 53
requests on Forgejo, which has no batch read), `GET /api/main-branches` for
the CI status of every default branch, `GET`/`PUT
/api/settings` for that user's own GitHub/Forgejo configuration — the
`PUT` response never echoes a token back, only whether one is now set
— `GET/PUT /api/settings/timezone` for the zone the user wants times shown
in (an IANA name such as `Europe/Amsterdam`; empty means the browser's own, and
it exists for browsers that report UTC to every page, such as Firefox with
fingerprint resistance) — `GET/PUT/DELETE /api/sharing(/{username})` for
managing who can see
your dashboard, and `GET /api/admin/users` plus the revoke/delete
endpoints, alongside `GET/POST /api/admin/invites` and
`POST /api/admin/invites/{token}/revoke` for generating, listing, and
revoking registration invites, every one of them refusing anyone but the
designated admin. `redocly lint` validates it, and Go contract tests in
`internal/api` check recorded responses against it (see
[CONTRIBUTING.md](CONTRIBUTING.md#how-it-fits-together)). Rendered docs
live at `docs/api/index.html` (Scalar, zero-build), published
to <https://alrayyes.github.io/forge-dashboard/docs/api/> on every push to
`main` that passes lint.

The dashboard response carries `readIntervalSeconds`, the server's advice on
how often to re-read it. `POST /api/dashboard/refresh` fetches from the forges
right now, but at most once every five seconds per user. A call inside that
window skips the fetch and answers 200 with the current snapshot and a
`Retry-After` header, so a follow-up refresh after an action never fails. The
page follows both: it polls at `readIntervalSeconds`, and "Refresh now" locks
for `Retry-After` seconds. Neither number lives in the front end.

`GET/POST /api/queued-actions` and `DELETE /api/queued-actions/{id}` list,
queue and cancel the actions that wait for a rate limit reset (see Pull request
actions).

`GET/POST/DELETE /api/mcp` sits outside this contract — it's the MCP
Streamable HTTP transport (JSON-RPC over HTTP, not a REST resource
`redocly`/OpenAPI describes), not a plain request/response endpoint. See
the preceding **Design** section for what it exposes and how it
authenticates.

## Reports

Every push to `main` that passes CI publishes the generated reports at
<https://apis.ryankes.eu/forge-dashboard/reports/>:

- [Test results](https://apis.ryankes.eu/forge-dashboard/reports/tests/), the
  JUnit XML of the Go tests (`unit.xml`) and the Playwright journeys
  (`e2e.xml`).
- [Coverage](https://apis.ryankes.eu/forge-dashboard/reports/coverage/), an
  HTML view plus `coverage.xml` (Cobertura) and the native Go `coverage.out`.
- [Lighthouse](https://apis.ryankes.eu/forge-dashboard/reports/lighthouse/),
  one report (and its JSON) for the login page and for each signed-in page,
  under fixed names such as `login.report.html` and `home.report.json` that
  don't change between deploys. Only each page's representative run is kept.
  `lighthouse/report.html` and `report.json` stay as the first page's run.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain, the hooks, and
how a change gets reviewed and released. [ARCHITECTURE.md](ARCHITECTURE.md)
is the one-page map of how the pieces fit, and
[the decision records](docs/adr/) record why the big choices went the way
they did.

## Licence

[AGPL-3.0](LICENSE). Chosen over the plain GPL-3.0 this project started
under because AGPL's network-use clause also covers running a modified
copy as a hosted service, which GPL alone doesn't.

### Fonts

The app serves its own fonts, so a page never contacts another host to render
text. IBM Plex Sans (400, 500, 600, 700) and IBM Plex Mono (400, 500, 600) come
from the pinned `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono`
packages, bundled by the web build in the Latin and Latin Extended subsets, with
`font-display: swap`. IBM Plex is released under
[OFL-1.1](https://openfontlicense.org/), the SIL open font licence, which allows
bundling and redistribution with this app.
