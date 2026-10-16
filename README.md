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

| Page                                                                                                 | Light                                                                      | Dark                                                                     |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Branches**. The CI status of every default branch, latest commit first.                            | ![Branches, light mode](docs/screenshots/branches-light.png)               | ![Branches, dark mode](docs/screenshots/branches-dark.png)               |
| **Pull requests**. Open pull requests across both forges, with CI status, filters, and sorting.      | ![Pull requests, light mode](docs/screenshots/pull-requests-light.png)     | ![Pull requests, dark mode](docs/screenshots/pull-requests-dark.png)     |
| **Pipeline checks**. A pull request's checks with state, time and failure excerpt, from its CI pill. | ![Pipeline checks, light mode](docs/screenshots/pipeline-checks-light.png) | ![Pipeline checks, dark mode](docs/screenshots/pipeline-checks-dark.png) |
| **Issues**. Open issues across both forges.                                                          | ![Issues, light mode](docs/screenshots/issues-light.png)                   | ![Issues, dark mode](docs/screenshots/issues-dark.png)                   |
| **Releases**. Release pull requests waiting to ship.                                                 | ![Releases, light mode](docs/screenshots/releases-light.png)               | ![Releases, dark mode](docs/screenshots/releases-dark.png)               |
| **Bots**. Dependabot and Renovate pull requests.                                                     | ![Bots, light mode](docs/screenshots/bots-light.png)                       | ![Bots, dark mode](docs/screenshots/bots-dark.png)                       |
| **Insights**. Charts of CI state and the busiest repos.                                              | ![Insights, light mode](docs/screenshots/insights-light.png)               | ![Insights, dark mode](docs/screenshots/insights-dark.png)               |
| **Webhooks**. Which tracked repos have a confirmed webhook, and a way to add one.                    | ![Webhooks, light mode](docs/screenshots/webhooks-light.png)               | ![Webhooks, dark mode](docs/screenshots/webhooks-dark.png)               |
| **Settings**. Theme, time zone, and dashboard sharing.                                               | ![Settings, light mode](docs/screenshots/settings-light.png)               | ![Settings, dark mode](docs/screenshots/settings-dark.png)               |
| **Admin**. Users and invites, for the first registered user.                                         | ![Admin, light mode](docs/screenshots/admin-light.png)                     | ![Admin, dark mode](docs/screenshots/admin-dark.png)                     |
| **Login**. Passkey sign-in.                                                                          | ![Login, light mode](docs/screenshots/login-light.png)                     | ![Login, dark mode](docs/screenshots/login-dark.png)                     |

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
  never echoes a token back, only whether one is set.
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
  requests on Forgejo. The last is
  `get_pull_request_checks`, which mirrors `GET /api/pull-requests/checks`
  (a pull request's individual CI checks). It spends budget too: 4 REST
  requests on GitHub (more for failed jobs), 3 plus one per run on Forgejo.
  Each calls the same function as its handler rather than adding a second,
  parallel path to the same data. Built on the official
  [MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk), over the
  Streamable HTTP transport.
  The aim is that every API operation has a tool (#1503), so an agent is
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
  itself: `get_dashboard`, `get_main_branches`, `get_pull_request_checks` and
  `get_pull_request_details`.** Experimental — as of this writing it's an Origin
  Trial in Chrome 149+/Edge 150+ only, with no stable spec yet — so this is a
  no-op everywhere else rather than a real dependency the page needs. Where it's
  present, it lets an in-browser AI agent fetch the same data the page itself
  renders. `get_dashboard` calls the page's own already-authenticated fetch
  layer (`fetchDashboardData()`) directly, the same request `/api/dashboard`
  already answers; the others call their endpoint the same way. All ride on the
  browser's own session cookie exactly like the page's own poll does.
  Nothing new crosses to the browser that the preceding
  "Credentials never reach the browser" bullet doesn't already allow: the tools
  never see a token, only the same already-filtered JSON the page always got.
  The tools live in `web/src/lib/webmcp-tools.ts`, each named for the API
  operation it covers. A unit test, `web/src/lib/webmcp-parity.test.ts`, lists
  every `operationId` in `api/openapi.yaml` and fails unless it has a tool, a
  written exclusion (the same `x-mcp-excluded` reason the server MCP uses, so
  one list serves both) or a place on the test's list of tools still to come
  (#1503).

### Where this stands against #3

This ships every piece of #3: passkey registration and login gating the
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
the process itself. Each forge takes either a token (sees private repos
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
  exact scope, classic and fine-grained, lives in Settings' own field
  hint next to the token field — one place, kept current with what the
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

## Pull request actions

Which actions a row offers, and why a blocked one is blocked, come from the
server: each pull request in `GET /api/dashboard` carries a list named
`allowedActions`, and the page renders what is listed without any rules of its
own. Only
live state is the page's: a rate-limited or unreachable forge, a missing token,
an action already in flight.

Each pull request also carries `status`: the one reason it is waiting on
something or can't be merged (a check still running, a conflict, a draft, a
parent it is stacked on), with the same `code`, `message` and `next` as a
blocked action. It is null when nothing holds the pull request back. An empty
pull request, whose branch is already on the target, offers `close` and no
`merge` or `auto_merge`, since nothing can unlock Merge; its `status` says there
is nothing to merge.

The row shows `status` in one place, a block with an icon and words above its
actions, and a locked Merge is described by it, so the reason is read without
hovering. A pull request with no status has no block.

A pull request stacked on another open one shows a chip with its place and what
it waits for: "Stack 2 of 3 · waits for #840", or "Stack 1 of 3 · merges first"
for the bottom. The members sit together in position order, at the slot of the
first one in the list, as a plain nested list with a thin rule beside each row.
A filter that matches any member keeps the whole stack and dims the rest. A
child says it targets its parent's branch, not main, so auto-merge isn't
offered, and its Merge shows the server's reason. Tapping the chip lists the
stack. On a phone the chip is short, what it waits for goes on a second line,
and the title is what gets cut. The server works out stacks from the branches
(`stack`, `stackedOn` and `stackChildren` on each pull request).

On GitHub, a pull request whose workflow runs are held until someone approves
them (`awaitingWorkflowApproval`) doesn't read "Failing". The CI pill says
"Waiting for workflow approval" and still opens the pipeline panel. An
"Approve on GitHub" link beside it opens the pull request's checks page in a new
tab, where GitHub's own button approves the runs. The dashboard doesn't approve
anything itself. These runs still count as failing CI, so the Failing CI quick
filter keeps matching them.

Every open pull request row has a Merge button. It's clickable when the forge
reports the merge is actually possible. Otherwise it stays on the row, locked
(`aria-disabled`, no click), with the reason printed beside it: "Waiting for CI
to finish" (it unlocks on its own at the next refresh), a merge conflict, a
draft, a branch that's behind, or "Blocked by the forge" when the forge says no
without saying why. A failing check is named only when CI itself reports
failing. A token missing the right permission, or the forge being unreachable,
locks it too. Merge asks for confirmation first: the button turns into Confirm
and Cancel, and the step ends on Cancel, a click anywhere else (which still does
what it would have done), Escape, or after 8 seconds, shown by a thin line that
runs down and waits while the pointer or keyboard focus is in the pair. A line
under the buttons reminds you that Escape or a click elsewhere cancels. Only one
Merge or Close is armed at a time, and a double-click on Merge arms it without
confirming. If the forge still refuses,
the server re-reads the pull request and answers with a code and a short
reason, which the row and a toast show: already merged or closed (the row
switches to "Merged" or "Closed" and drops off the list on the next snapshot),
a conflict, behind the base branch, a check pending or failing, branch
protection, a missing permission, or a rate limit with its reset time. The
codes are in `api/openapi.yaml` (`ActionError`). A Merge or Close that succeeds
takes the pull request off the board at once, even if the forge goes on listing
it as open for a few seconds; the server holds it back for up to two minutes.
Update branch appears when the
forge reports it's possible; it doesn't ask, since a merge from the base branch
is easy to reverse and a merge itself isn't. A GitHub pull request counts as
behind whenever its base has commits it lacks, even in a repo that doesn't
require branches to be up-to-date, and Merge stays allowed there. On a pull
request that's behind but also conflicts with its base, Update branch is locked
with a note that the conflicts need fixing by hand, since the forge would refuse
the update. Close isn't a standalone row button: it lives in the "More actions"
menu on every open pull request regardless of mergeability. A menu is for the
overflow, so when Close is the row's only extra action it's drawn directly
instead. It reads "Close pull request" and is a neutral button on every row,
never green or red: closing is reversible, since the pull request stays listed
as closed and can be reopened, so the warning tone is kept for the confirm step
("Confirm close pull request?"). For one that turns out not to need merging at
all (a duplicate, or one whose content already landed another way) it's the
action that applies. It asks for confirmation the same way Merge does, inside
the menu. Confirming closes the menu and shows progress on the row. Escape drops
an unconfirmed Close and leaves the menu open, a second Escape closes the menu,
and closing the menu any other way drops it too. If the forge refuses a
confirmed Close, the row shows "Close locked" next to the closed menu and the
reason becomes the menu button's description, so you don't have to reopen the
menu to find out.
A permission refusal is re-read too: if the pull request turns out to be
merged or closed, that is what the row says, not "check your token". Only a
rate limit skips the re-read, since it would be limited as well.
On Forgejo a rate limit comes from a proxy in front of it, and its reset time is
read from the `Retry-After` header. Forgejo's API says only whether a pull
request can be merged, not why, so a Merge it refuses on a pull request that
can't be merged is reported as a probable conflict, with the message saying it can't
tell a conflict from a merge check that is still running. A missing review or
check is named when the refusal's own text names it.

Every other action (Close, Update branch, Enable auto-merge, Dependabot and
Renovate `rebase`) answers a refusal the same way as Merge. A pull request found
already merged or closed switches its row to "Merged" or "Closed" with a polite
toast, whichever button was clicked. Otherwise the reason is in plain words,
and Retry shows only for a reason that can pass by itself. A few codes belong
to one action: update branch can say there is nothing to bring in,
Enable auto-merge can say the repo doesn't allow it or that the pull request is
already ready to merge, and Renovate `rebase` can say the label is missing on the
repo.

A locked action offers Retry only when waiting might fix it, such as a 502. When
a forge's API budget is spent, the forge goes read-only: the controls that need
that budget (Merge, Update branch, the Dependabot and Renovate commands, Close
and, on its GraphQL budget, Enable auto-merge) are not drawn at all, and one
banner at the top says so for that forge ("GitHub is rate limited. Read-only
until 14:32.") with a live countdown. When only one budget is spent the banner
names what is affected. REST drives Merge, Update branch, the bot commands and
Close, and GraphQL drives auto-merge, so the others keep working. A "What still
works" disclosure under the banner lists the read-only actions: the pipeline
panel, the link to the pull request on the forge, and browsing and filtering the
last data. A "Why?" under the banner explains the limit in a few sentences, so
it isn't taken for a fault in the dashboard, and for GitHub links to its own
rate limit rules. Other forges are unaffected. The controls come back by
themselves at the reset time, with a polite "Rate limit reset, actions available
again" toast. While the forge is read-only the server stops refreshing it until
the reset, so the rows are the last ones it saw. The header's Refreshed time
shows how old they are.

A forge that can't be reached gets the same treatment. Its controls are not
drawn either, and no row carries a Retry or a pointer to a status line. One
banner that stays in view while you scroll, on a phone too, says "GitHub is
unreachable. Showing the last data from 14:32.", gives the cause in plain words,
and has the one Retry, which forces a refresh. GitHub's row also links to
githubstatus.com in a new tab, so you can see whether GitHub is reporting an
incident; a Forgejo instance is self-hosted and has no such page. When the forge
answers again the
controls return without a reload, with a polite "GitHub is reachable again,
actions available" toast, and the banner clears. A row's own reason for Merge
(stacked, waiting for CI) shows whenever its forge can be reached.

A missing token permission locks that action on that pull request, with no Retry
either, and the reason points to Settings. Other pull requests and other actions
stay usable, since a fine-grained token can lack one permission and have the
rest. The lock lasts as long as the failure line that explains it: dismiss the
line and the action is free again, with no reload. A failure line stays on its
row however many refreshes arrive, and goes when you dismiss it, act on the row
again, or the row leaves the board. The exception is a failure that passes by
itself, one where the request never got an answer (it says "Couldn't reach the
server") or a forge answered 502, 503 or 504. That line clears itself after ten
seconds, holds while you hover it or have focus in it, and when it clears the
row is read again from the server, since the write may have landed before the
connection dropped. Nothing is announced when it clears, the failure stays in
Activity, and an error toast waits for you as before. A 429 on a click the
snapshot hadn't foreseen still greys that one action out with its reason until
the next snapshot. The header shows each forge's remaining budget and reset
time as text, one line per budget and labelled ("GH GraphQL", "GH REST"), since
GitHub keeps the two apart. A remaining count above its limit shows how many are
left and no ratio. Which locks offer Retry follows the refusal's `code`
(`rate_limited` and `permission` don't), not the words in its message. The
banner at the top of the page follows each budget's `severity` (`ok`, `low` or
`exceeded`), which the server grades, so the page holds no threshold of its own.

While a forge is rate limited, you can queue Update branch, `Dependabot: Rebase`
or `Renovate: Rebase` to run when its budget comes back, instead of returning to
click again. `POST /api/queued-actions` stores the choice on the server, per
user, so it survives a page reload and a server restart. The pull request
carries the waiting item as `queued`, for a row to show a waiting chip, `Queued
· 14:32` with `Resets in 8m` and `Cancel` (the "Queue update" button comes back
once you cancel), and the dashboard's `queuedActions` list holds the items and,
once they ran, their outcomes for 24 hours.

It only works while the forge really is limited (a spent budget whose reset is
still ahead), for a pull request that is on your board, behind its base branch
and offering that action. At the reset, plus a 30-second pad, the server reads
the board fresh and looks at the pull request again before it does anything. It
runs the action only if it still applies. Otherwise it records why it did
nothing: the pull request was merged or closed, caught up, picked up a conflict,
or already has the request. A forge that is still limited moves the item to the
new reset. One that doesn't answer is tried again every five minutes for an hour.
A refusal is recorded with the same `code` and `message` the button would have
shown. It runs with your own saved credentials for that forge and no one else's,
and does nothing if you have removed them.

Merge and Close can't be queued, and the API answers 400. They would act
unattended on a pull request whose checks or commits may have changed in the
meantime. To merge once the limit lifts, arm the forge's own auto-merge instead.
After a restart the server starts the dashboard of every user with a waiting
item, so the action still runs at the reset without anyone signing in.

On the page, a pull request that is behind its base on a forge whose REST budget
is spent gets a button where Update branch would have been: "Queue update for
14:32", or `Queue rebase for 14:32` for a Dependabot or Renovate pull request.
Queueing posts to `/api/queued-actions`. The row then says "Update branch queued
for 14:32" with a Cancel button, and Activity lists the item with Cancel (or
Clear, once it has finished). When an outcome arrives while the page is open, a
polite toast and the Activity list say whether it was done, skipped with the
reason ("Already merged") or failed. No queue button is offered for Merge or
Close, for a pull request that isn't behind, or while the forge has budget left.

A forge that fails a refresh keeps showing its last good pull requests and
issues, and the header says so next to it: "Showing data from 3m ago". The
time comes from the server's `staleSince`, which is gone again after the next
good refresh.

A GitHub pull request that isn't already auto-merging gets an "Enable
auto-merge" action in the row's "More actions" menu, arming the forge's
own native auto-merge (GitHub's `enablePullRequestAutoMerge` mutation)
instead of switching to GitHub's own UI just to turn it on. It picks a
merge method the repo actually allows, the same `merge` > `squash` >
`rebase` precedence Merge already uses, with no override of its own.
Merge is skipped when the default branch requires linear history.
A squash, from Merge or from auto-merge, is titled with the pull request's own
title and its number, `title (#N)`, whatever commits the branch holds, so a stray
commit message can't become the subject and the changelog entry.
Available whenever the pull request isn't a genuine conflict — unlike
Merge, a pending or not-yet-required check doesn't hide it, since
arming auto-merge ahead of CI finishing is the whole point. It only
shows when GitHub itself will accept the request (`viewerCanEnableAutoMerge`):
a stacked pull request whose base branch has no protection rule has
nothing to wait for, so GitHub refuses it and the action stays hidden.
When GitHub's answer isn't known, the action shows as usual.

Forgejo's pull request JSON doesn't say whether a merge is scheduled, so on
Forgejo this app keeps the auto-merge itself. "Enable auto-merge" stores your
intent for that pull request and sends nothing to Forgejo. The pull request
then shows "Auto-merge on" and "Managed by Forge Dashboard", and a waiting chip
(below) with a `Disarm` button. After each refresh the server merges an armed
pull request once its checks have passed and Forgejo says it can merge, with
the repo's own merge method, the same as Merge. A pull request you didn't arm
is never merged. Checks that fail, conflicts, a draft, a stack parent that
hasn't merged yet or no checks at all keep it waiting, and it merges once that
clears. The row says which, in words: the chip reads `Waiting for CI`, `Waiting
for parent`, `Rate limited` and so on, and a text line says it stopped (a
failed check, a conflict, or a refused merge, including a token without merge
permission). When the server merges one it tells the page, which shows
"Auto-merged owner/repo#N after checks passed" for the next few minutes. If
Forgejo refuses the merge, the server doesn't ask again until the pull request
changes (a rate limit or an unreachable forge is retried after five minutes),
and the log records each attempt by repo and number. Closing or merging the
pull request elsewhere removes the intent, once Forgejo confirms it. A token
that can push but not merge only finds out at the merge itself.

A merge scheduled in Forgejo's own web UI ("Merge when checks succeed") shows
as auto-merging too, with Cancel auto-merge on it. Forgejo has no field for it,
so each refresh reads the pull request's timeline (`GET
/repos/{owner}/{repo}/issues/{n}/timeline`): the latest of the
`pull_scheduled_merge` and `pull_cancel_scheduled_merge` events decides. That
is two extra requests per pull request (a page, then the empty page that ends
the read, since Forgejo drops some rows after paging and a cancel can sit on a
later one), so it only runs for open pull requests that aren't drafts or
empty, at most eight per repo per refresh, eight at a time. The ones over the
cap are read on the next refresh, oldest read first, and keep their last known
state until then. A failed read keeps the last known
state too and never fails the refresh. Cancel auto-merge also calls Forgejo's
cancel endpoint (`DELETE /repos/{owner}/{repo}/pulls/{n}/merge`), and treats
"nothing scheduled" (404 or 409) as done.

Under a Forgejo repo's heading, when pull requests are grouped, a note says that
Forge Dashboard handles auto-merge there, not Forgejo, and links to the "Forgejo
auto-merge" card in Settings, which explains it in plain words.

Merge, close, auto-merge, Update branch, and the Dependabot and Renovate actions
all report on the row you acted on, not in a banner at the top of the page. A
wait shows as one chip in the row's action area (below), and a failure gets a
status line under the actions: "Failed" with the reason, a Retry button and a
Dismiss button. Each pull request in flight has its own. A failure says one
plain sentence: the server's own reason when it gave one, or "The forge refused
this action and gave no reason." The raw error text stays in the server log, and
off the row. A **Copy** button beside the failure (on the row and in its toast,
and under a failed **Rerun failed checks** in the pipeline panel) copies what
the server really answered, for pasting into a ticket or a chat: one JSON
object with the HTTP status, the response body as it arrived (the raw `error`
included), the action, the pull request's forge, repo and number, and the time.
The button says "Copied" for two seconds. A failure with no answer at all
copies the action's context and the browser's own error. Where the clipboard
can't be written (an insecure page, a refused permission), the same text shows
in a box to select. Retry shows only for a failure that can pass by itself, such
as the forge not answering. The line clears when you dismiss it, when you start
another action on the row, with "Clear finished", or when a refresh shows the
pull request gone.

A toast appears bottom-right when something completes or fails: up to three at a
time, the newest on top, with the `owner/repo#N`, a one-line message, "Show row"
(scrolls to the row and focuses it; if a filter hides the row it clears just
that filter, if the row is on another page it moves there, and if the pull
request is merged or closed it says so) and a dismiss button. Success toasts go
after about six seconds and wait while you hover or focus them. Error toasts
stay until you dismiss them. The sticky "Activity" control keeps a count and
opens a panel of in-flight and recent actions per pull request, with "Show row"
and "Clear finished", so a dismissed toast isn't lost. A reload keeps the
finished entries for as long as the tab stays open, up to 40, until you use
"Clear finished" (they live in the tab's `sessionStorage`; with storage blocked
the list starts empty). A restored failure has no Retry. A request still queued
comes back from the server, which holds it on the pull request until a refresh
shows it landed or the wait runs out. One polite live region announces each
event once and never reads out the countdown, and with reduced motion on, toasts
appear without animation. The banner at the top is left for global conditions
such as a rate limit or an unreachable forge.

The waiting chip is how a row says "something is happening, hold on". It is one
chip in a slot at the top of the row's action area, which every pull request row
always reserves, so a chip coming or going never moves the row. It has an icon,
a bold label of at most three words and a lighter line naming the actor or the
reason. The fuller explanation is a hint that opens on hover and on keyboard
focus (the chip takes focus), and a button shows only where one exists. The
states: `Rebase requested` and then `Rebasing` for a Dependabot or Renovate
`rebase`, `Recreating` for a Dependabot recreate, `Updating branch`, `Merging`
and `Closing` while the forge answers, `Arming` and `Disarming` for auto-merge,
and `Waiting for CI` (or `Waiting for parent`, `Rate limited`, `Waiting for
ready`, `Waiting for forge`) for an armed auto-merge on either forge, with `Disarm`.
Once nothing is left to wait for, Forgejo's reads `Merging next` (this app
merges it on its next refresh) and GitHub's reads `Merging` (GitHub merges it
as soon as it can). On GitHub, Disarm turns GitHub's own auto-merge off with
`disablePullRequestAutoMerge`. When a pull request goes empty, because its branch
landed on the base some other way, the app cancels an armed auto-merge on it
(GitHub's with the same mutation, Forgejo's by dropping its intent) and the
row's `autoMerge` status says "Auto-merge was cancelled: there is nothing left
to merge." for ten minutes. A pull request that is not empty, or not armed, is
never touched. When a request ends well the chip reads `Settled`
for four seconds and goes. A wait with no change for two minutes reads `Still
waiting` with `Check again`, which reads the row from the server now. Each
change is announced once through the polite live region, the ticking age and the
refresh countdown are kept out of it, and nothing is announced when the chip
clears. With reduced motion on, the spinner is a still icon. Icon and words
carry every state, not colour. On a phone the chip fills the card's width
without widening it, and its button is 44px high. The chip's wording lives in
one place, `web/src/lib/wait-chip.ts`. A failure or a timeout is not a wait and
stays a text line with Retry and Dismiss.

Update branch, `Dependabot: Rebase` and `Renovate: Rebase` only ask the forge or
a bot to act, and the result shows up on a later refresh. Update branch turns
into a "Queued…" button the moment you click it. It ignores clicks but keeps
keyboard focus (`aria-disabled`), so you don't lose your place. The row's
`Updating branch` chip says the request went out and counts down to the next
background poll. If the countdown runs out before the refresh lands, it reads
"Refreshing…" instead. An unrelated refresh doesn't clear it. Update branch
clears once a refresh shows the branch caught up. If the request fails, the
button comes back and the row and an error toast say why.

The server keeps the request: a branch update the forge accepted shows up on the
pull request as `updateRequest`, with a phase (`queued` or `expired`), when it
was asked and `expiresAt`. It clears on the first snapshot from a fetch that
started after the request and shows the pull request no longer behind, or when
the pull request is gone, and goes `expired` after five minutes still behind.
Like `botRequest` it is in memory per account, so a server restart forgets it.
The page only draws it: the click shows the `Updating branch` chip at once, and
after that each snapshot decides. A snapshot without the record finishes the row
with a `Settled` chip ("Branch updated"), the `expired` phase ends it with a
timed-out line, an error toast and Retry, and a record the page never clicked (a
reload mid-wait) starts the row with the chip.

A bot `rebase` waits on the bot, not on the dashboard. The button becomes
`Rebase requested` and is `aria-disabled` (focus returns to the row's More
actions button when the menu closes), and the chip reads `Rebase requested` with
the bot's name and an age that ticks along, kept out of what a screen reader
announces. Its hint says the bot acts on its own schedule and that it can take a
few minutes. Dependabot is asked with the `@dependabot rebase` comment and
Renovate with the `rebase-check` checkbox in the pull request body (the `rebase`
label when the body has none), and the hint says which. The request lives on the
server: a successful Dependabot or Renovate request shows up on the pull request
as `botRequest`, so a reload mid-wait still shows the chip, with the age counted
from when it was asked. The page only draws it. When the server moves the
request to `rebasing` (the bot pushed, and CI hasn't restarted), the chip reads
`Rebasing`. When the server drops it (CI showing pending, two minutes after the
push, or the pull request leaving), the chip reads `Settled`, then goes, and a
toast says it finished. When the server marks it `expired` (ten minutes with no
sign of the bot), the row says it timed out, with an error toast and a Retry.

While Renovate's rebase checkbox is ticked, a rebase is already waiting for
Renovate, so `Renovate: Rebase` is shown disabled, with "A Renovate rebase is
already requested on this pull request." beside it. The server reads the box
from the pull request description in the same list call (no extra request), so
it holds whether the box was ticked here or on the forge. Renovate clears the
box once it has rebased, and the next snapshot offers the action again.

Dependabot tells you it got a command by reacting to the comment with a
thumbs-up, and it can then take several minutes to push. The server looks for
that reaction on each refresh while a Dependabot `rebase` is waiting, and the
chip's second line changes from "Dependabot" to "Dependabot got it", with one
announcement for screen readers. If no thumbs-up shows after ten minutes the row
says "No reply from Dependabot yet. The command may have been dropped or rate
limited.", and offers `Ask again` (it posts the command once more) and `Open
comment`, a link to the comment on GitHub. A thumbs-up that turns up after that
revives the request. An acknowledgment gets another ten minutes to become a
push. Looking up the reaction needs no extra permission, and if GitHub can't
answer, the chip stays on "Dependabot" and shows no error. Renovate and
`Dependabot: Recreate` have no such signal and read as before.

The server's `botRequest` has these fields: the bot, the action, a phase
(`queued`, `rebasing` or `expired`), when it was asked, `expiresAt` (when the
server stops waiting in that phase) and, for a Dependabot `rebase`,
`acknowledgedAt` (when its thumbs-up was first seen) and `commentUrl`. It moves
along on each snapshot from a fetch that started after the request: a changed
head, or a pull request that was behind and isn't, means the bot pushed. An
expired request goes after an hour. The record is in memory per account, so a
server restart forgets it and a browser reload doesn't. The page shows the
request as queued the moment you click, until the next snapshot says otherwise.

A queued Dependabot request names itself: `Rebase requested` or `Recreate
requested` on the button. While `Recreate requested` shows, the row hides
`Dependabot: Rebase`, since recreating rebuilds the whole pull request. `Rebase
requested` keeps `Dependabot: Recreate`, which is still a different outcome.
Both buttons come back once the bot has acted.

A Dependabot or Renovate pull request gets no Update branch button: each
has its own `Rebase` action instead (below). A pull request counts as
Renovate's when its author is GitHub's Renovate App (`renovate`,
`renovate[bot]`), is an account named `renovatebot`, or when its head branch
starts with `renovate/`, Renovate's default prefix, whoever the author is. A
Forgejo or GitLab instance can name its Renovate account anything, so if
neither default catches it, list it in Settings under `Renovate logins`
(`renovateAuthors` in the API). Until you do, that account's pull requests
look like a person's. A release-please pull request
does get one, because release-please has no `rebase` command. It only
regenerates its pull request when the release notes change. A release
pull request can therefore fall behind with nothing else to catch it up. When
release-please does regenerate it, it force-pushes the branch, so the
merge commit Update branch adds is overwritten rather than conflicting.

A Dependabot-authored pull request on GitHub instead gets its own pair of
buttons — `Dependabot: Rebase` and `Dependabot: Recreate` — that trigger
Dependabot's own [comment commands](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/managing-pull-requests-for-dependency-updates#managing-dependabot-pull-requests-with-comment-commands)
(`@dependabot rebase` / `@dependabot recreate`) instead of you switching to
the forge to type them yourself. GitHub only — Dependabot doesn't run on
Forgejo.

Dependabot only honours these commands from a user with push access, and
it ignores GitHub App accounts whatever permissions the App holds
([upstream issue](https://github.com/dependabot/dependabot-core/issues/9147)).
So when you've connected a GitHub App, the commands go out with your saved
personal access token instead, and the comment shows up as you. With an
App and no saved token, both buttons are locked with that explanation
and the background pass below skips Dependabot pull requests, rather than
posting comments Dependabot would only refuse.

A repo with a behind pull request can also be brought up to date without a
click at all, by enabling auto-update-branch for it in Settings. The Update branch
button then stays off that repo's rows, except to flag a conflict and on a
release-please pull request (the pass skips those). The "behind" reason on Merge
says whether the app or you update the branch. For a
Dependabot pull request specifically, that background pass drives the same `@dependabot
rebase` command the manual button does rather than a generic branch update
— and if that `rebase` leaves the pull request's CI failing, follows up with
`@dependabot recreate` on its own, the same way you'd notice the failure
and click Recreate yourself. A Renovate pull request gets the same
treatment as the manual `Renovate: Rebase` button below it — the
body's `rebase-check` checkbox ticked (or the configured `rebase` label when the
body has none) instead of a generic branch update, since that's Renovate's
own rebase/retry trigger, not a comment command.
The background pass always skips release-please pull requests, so nothing
writes to a release branch unattended. The manual Update branch button is
the way to catch one up. A generic update the forge refuses, such as a merge
conflict, isn't tried again until the pull request changes or an hour passes,
and any other failure waits five minutes, so a stuck pull request costs one
request, not one per refresh.

A Renovate-authored pull request, on either forge, gets a `Renovate:
Rebase` button that ticks the `rebase-check` checkbox in the pull request's
body, which every Renovate pull request carries and which needs no setup on
the repo. Renovate doesn't read comments as commands, so the checkbox and a
label are its only rebase/retry triggers. The dashboard edits that one
character and leaves the rest of the body alone. If the box is already
ticked the button answers `already_requested` and changes nothing. A body
with no checkbox falls back to adding the configured `rebase` label
(Settings' own `Renovate rebase label` field, described earlier). On Forgejo
that label has to already exist on the repo (its labels API takes an
existing label's ID, not an arbitrary name); the button reports that plainly
instead of silently doing nothing if it doesn't.

On a pull request with any CI reported, the CI pill is a button that opens
a panel listing every individual job/check against its head commit —
status, name, and a link to that job's own page on the forge — instead of
only the pill's own summary. (Filtering by CI status is the column filter's
job.) Fetched
fresh every time the panel opens, not cached, or part of the regular
dashboard refresh. Falls back to the legacy combined commit-status
API's own per-check entries when a repo (or an older Forgejo instance)
reports no Actions/Workflow runs at all for that commit.

On GitHub, the pill stays pending while a check that branch protection or a
ruleset requires hasn't finished. GitHub's combined status only counts checks
that exist, and can read as passed for a moment after a push while the rest of
the pipeline is still queued, so a pull request with one of five required
checks reported would read as passed. A required check that is queued or
running counts as not finished. The server looks the required checks up only
when the combined status says success and GitHub still blocks the pull request.

Just after a push, a response from GitHub can briefly show the new head beside
the finished checks of the previous commit. The server reads the id of the
commit the checks belong to, and when it isn't the head of the pull request the
pill stays pending until they agree.

On GitHub, each failed Actions job also carries how long it ran, the step that
failed and an excerpt: the last lines of its log as plain text, with
timestamps and colour codes removed, capped at 2,000 characters. Those cost up
to three extra requests per failed job (at most five jobs), made only when the
panel opens. A check that isn't an Actions job, or a log the token can't read
or that has expired, shows without them and keeps its link. Forgejo's API
doesn't serve job steps, logs or timing, so a failed Forgejo check offers only
its link.

A pull request whose CI is failing also offers `Rerun failed checks` at the top
of that panel, on GitHub and on Forgejo. It reruns only the failed jobs of each
workflow run on the head commit, once per run, and answers when the forge has
queued them: the panel says "Rerun queued" and the new results show after the
next refresh. It needs a token that can write to Actions. When the forge refuses
(no permission, a run too old or already running, a Forgejo too old to have the
rerun route), the panel shows its reason and the button stays for another try.
A failed check that isn't an Actions job, such as an external CI, can't be
rerun and is skipped; a pull request with nothing left to rerun answers "no
failed job to rerun" (`POST /api/pull-requests/rerun-checks`, listed as
`rerun_checks` in `allowedActions`).

When the forge says which checks the base branch's protection requires,
the panel groups them: a `Required` group first, with a failing required
check flagged `Blocking`, then `Advisory`. GitHub's classic required
status checks and its rulesets are both read, and Forgejo's
`status_check_contexts` patterns. Reading branch protection needs more
permission than listing checks (admin on GitHub's classic rules and on
Forgejo), so with a token that can't, or for a check the dashboard can't
match to a protection entry, the check lands under `Status unknown`
rather than being guessed advisory. A Forgejo Actions job is only marked
required when a pattern matches its job name or its workflow-file
context; it is never marked advisory. If nothing is known for any check,
the panel stays the flat list.

Each check's state has its own glyph inside a tinted pill, so states differ
by shape and word, not colour alone. Passed is a check in a circle, Failed and
Timed out a cross, Running an amber spinning arc (a still clock under reduced
motion), Queued an hourglass in a dashed blue ring, Skipped a slashed circle in
the quietest weight, and Cancelled a stop square in a circle.

## Error pages

The dashboard has its own error pages, built with the rest of the web app as
`404.html` ("Page not found") and `500.html` ("Something went wrong on our
side"). The Go server sends the first for an address nothing matches and the
second for a crash, each with its real status code. Asking for either file by
name gets the 404, never a 200. Each page says what happened in plain words and
gives a way back: a primary link to the pull requests and a short list of the
other pages. The 500 page also has a `Try again` link to the same address. They
show nothing about the server, with no stack trace, path, host or version, and
follow the light or dark theme. They run no script, so the app's router can't
swap one for the page whose address it was sent at. Inside the app,
`+error.svelte` renders the same page for an error the router meets, and
`handleError` keeps the message generic. `src/error.html` is the static fallback
for an error the app can't render itself.

## Pull request details

Each pull request row has a **Details** button. It opens a read-only pop-up
with the pull request's description, its comments and the thumbs up and thumbs
down reactions on each, and an **Open on GitHub** (or Forgejo) link. On the
Releases page the pop-up shows the release notes in place of the description.
A Dependabot or Renovate pull request opens the same pop-up, with its long
generated description folded away until you open it. There are no actions in
it yet: Merge, Update branch and the rest stay on the row.

The pop-up loads when it opens, from `GET /api/pull-requests/details`, and
never as part of the dashboard snapshot, so a forge's budget isn't spent on
rows nobody opens. It shows the first 50 comments and says so when there are
more. The header shows status chips taken from the row (draft, CI, merge state,
out of date, auto-merge) as they were when it opened, and the version on the
Releases page. Each comment carries the author's avatar (the forge's own HTTPS
image URL, or an initial if it isn't one or can't load), a relative time and an
"edited" mark. A deleted author reads "ghost". Hovering or focusing a reaction
lists who gave it, up to ten names and then "and N more"; Escape hides that
list first and a second press closes the pop-up. Reactions are display only.
When the details can't load, it says so in plain words with **Try again**.

The text is Markdown and the server doesn't sanitise it, so the page renders
it with [markdown-it](https://github.com/markdown-it/markdown-it) with raw HTML
off: tags show as text, images aren't loaded, only absolute `http`, `https`
and `mailto` links are links (anything else stays plain text), and they open
in a new tab with `rel="noopener noreferrer"`. The
library loads the first time a pop-up opens.

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
of them are failing. It is one pill: a neutral **total**, then the counts above
zero, each with its own glyph so colour is never the only signal. Branches
counts default branches. Pull requests, Releases and Bots count their pull
requests (without the ones that belong to another of the three). All four show
how many are failing (red), running (amber, a spinner, or a still clock under
reduced motion) and passing (green), in that order. A pull request with no
checks is in the total only, so its numbers needn't add up. Branches adds a
fifth, neutral count with a dashed circle for the branches with no pipeline, so
its numbers do add up. A zero is never drawn, and the link's name
says the same in words: "Pull requests, 15 total, 2 failing, 3 running, 10
passing", and "Branches, 7 total, 2 failing, 1 running, 3 passing, 1 without a
pipeline". On a phone the total sits on its own line above the counts, and with
three-digit numbers each count takes a line, so the busy tabs grow to about
110px. Issues counts open issues, without Renovate's Dependency Dashboard, and
has no failed count. The server works the numbers out from the same lists the
pages show (`navCounts` on `/api/dashboard`), so a page agrees with its icon,
and a hidden pull request is in neither. The dashboard pages set them from each
snapshot. The other signed-in pages (Branches, Insights, Settings and the rest)
load them and ask again every 30 seconds while the tab is visible, so a refresh
or a webhook changes them without a reload.

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
both in words: "Branches, 12 total, 3 failing, 1 running, 8 passing" on the
header icon, "12 Branches, 3 failing, 1 running, 8 passing" on the tab, which
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

Each row shows the status as an
icon and a word (Failed, Running, Passed or No pipeline), the repo, the
branch, the short SHA, subject and author of the newest commit, how long ago the
run finished and how long it ran. A failed row names its failing jobs and
expands to list them. **View run** opens the run on the forge. Rows come
latest commit first, in the order the server sends them.

The pills (All, Failing, Passing, Running, No pipeline) carry the server's
counts. A pill, and each forge in the toggle, is offered only when a row would
show under it, given the search and the other pill, so none leads to an empty
list; the one that is active always stays, so it can be cleared. A forge toggle
and a search box narrow the list further; search
matches the repo, branch, commit, author and failing job names. The filter is
saved in a cookie of its own, `forge-board-main-branches`, and is still set
after a reload. It is not part of the shared filter cookie, which holds
pull request and issue state.

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
total (#1531). They count what each page shows when it opens. Pull requests
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
by the server) and takes pushes over a live stream, but
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

## Hiding one pull request

A pull request you can't or won't act on yet can be hidden. **More actions** on
its row has **Hide this pull request**, and **Hide for 7 days** under it. It
leaves the list, the quick-filter counts and Insights at once,
with no confirm step, since it is reversible. Nothing is sent to the forge.

A status message says "Hid PR #123 ‘title’." with an **Undo** button. It stays
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

Each row shows that as a pill beside the other status pills (#1335): the number
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
App (see the Dependabot buttons above). Leave `GITHUB_APP_ID` unset and
the field simply doesn't appear; nothing else about GitHub credentials
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
  one report (and its JSON) for the login page and for each signed-in page.
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
