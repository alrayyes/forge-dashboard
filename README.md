# forge-dashboard

[![CI](https://github.com/alrayyes/forge-dashboard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alrayyes/forge-dashboard/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/alrayyes/forge-dashboard?sort=semver)](https://github.com/alrayyes/forge-dashboard/releases/latest)
[![licence](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)
[![coverage](https://codecov.io/gh/alrayyes/forge-dashboard/branch/main/graph/badge.svg)](https://codecov.io/gh/alrayyes/forge-dashboard)
[![Go Reference](https://pkg.go.dev/badge/github.com/alrayyes/forge-dashboard.svg)](https://pkg.go.dev/github.com/alrayyes/forge-dashboard)

A single-page dashboard of open pull requests, issues, and CI status across
every repository you have write access to on **GitHub** and a **Forgejo**
instance — one page instead of two forge UIs. See
[#1](https://github.com/alrayyes/forge-dashboard/issues/1) for the v1
acceptance criteria this was built against, and
[#3](https://github.com/alrayyes/forge-dashboard/issues/3) for the
passwordless login, per-user tokens, sharing, and an admin role this document
now describes the first slice of.

![forge-dashboard, light mode](docs/screenshots/dashboard-light.png)
![forge-dashboard, dark mode](docs/screenshots/dashboard-dark.png)

Fixture data, not a real account's actual repositories — regenerated
automatically by the release workflow on every release (see
`scripts/capture-screenshots.js`), so it's never more than one release
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
- **One Go binary.** The frontend — SvelteKit throughout, migrated
  incrementally one page at a time (see #326) — ends up embedded into
  the binary with `//go:embed`; a released binary needs nothing but
  `go build` to run. Building from source needs one extra step first,
  `bun run build:web`, to produce the pages `internal/api/static`
  embeds — run automatically in CI and the Docker build's own
  `web-build` stage, a manual step before a local `go build` otherwise.
  See [CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain either half
  needs.
- **Read-only against both forges, with one caveat.** Nothing here writes
  back to GitHub or Forgejo — it aggregates and displays, and every row
  links out to the real thing. The caveat: checking whether a repo's
  webhook is already pointed at this dashboard (the Webhooks card, and the
  dashboard's own coverage summary) needs a token scope that includes
  write access on Forgejo, since its hooks API has no separate read-only
  scope — this app still only reads that list, and never creates or edits a
  hook itself.

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
either credential (session cookie or a live token) the same way. The raw
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

Merge and Update branch appear on a pull request row when the forge
reports it's actually possible — a merge conflict, a token missing the
right permission, or the forge being unreachable all hide or lock the
button instead of letting the click fail. Merge asks for confirmation
first; Update branch doesn't, since a merge from the base branch is
easy to reverse and a merge itself isn't. Close is always available on
an open pull request, regardless of mergeability — for one that turns
out not to need merging at all (a duplicate, or one whose content
already landed another way), it's the action that actually applies —
and asks for confirmation the same way Merge does.

A pull request opened by release-please, Dependabot, or Renovate keeps
itself current on its own schedule — for release-please specifically,
a manual Update branch click can fight its own next run, since it
regenerates the branch and changelog together on every push to the base
branch. Update branch stays hidden on a PR any of them opened unless
"Allow updating bot-managed PR branches" is turned on in Settings, which
also reveals a field for the label Renovate's own rebase/retry trigger
listens for on your repos (its own `rebaseLabel` config option, genuinely
per-repo configurable — leave blank for Renovate's own default, `rebase`).

A Dependabot-authored pull request on GitHub instead gets its own pair of
buttons — `Dependabot: Rebase` and `Dependabot: Recreate` — that trigger
Dependabot's own [comment commands](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/managing-pull-requests-for-dependency-updates#managing-dependabot-pull-requests-with-comment-commands)
(`@dependabot rebase` / `@dependabot recreate`) instead of you switching to
the forge to type them yourself. GitHub only — Dependabot doesn't run on
Forgejo.

A Renovate-authored pull request, on either forge, gets a `Renovate:
Rebase` button that adds the configured `rebase` label (Settings' own
`Renovate rebase label` field, described earlier) instead of you finding
and adding it yourself — Renovate's own rebase/retry trigger is a label,
not a comment command. On Forgejo the label has to already exist on the
repo (its labels API takes an existing label's ID, not an arbitrary
name); the button reports that plainly instead of silently doing
nothing if it doesn't.

A pull request with any CI reported at all gets a `View pipeline`
button, opening a panel that lists every individual job/check against
its head commit — status, name, and a link to that job's own page on
the forge — instead of only the row's own collapsed CI pill. Fetched
fresh every time the panel opens, not cached, or part of the regular
dashboard refresh. Falls back to the legacy combined commit-status
API's own per-check entries when a repo (or an older Forgejo instance)
reports no Actions/Workflow runs at all for that commit.

## Webhooks

Optional. Without one, the dashboard still refreshes on its own schedule
and the browser tab polls it every 30 seconds; a webhook just means a new
pull request, a closed issue, or a CI status change on a tracked repo
shows up within seconds instead of at the next poll. Set up from the
Settings page, one forge at a time — full copy-pasteable steps, exactly
which events each part of the dashboard needs (CI status specifically
needs its own, easy-to-miss event), and how delivery verification works:
[docs/webhooks.md](docs/webhooks.md).

A delivery refreshes just the repository it names, not the account's
whole tracked-repo set — a much smaller GraphQL query on GitHub than a
full refresh runs. A payload with no repository (the initial "ping"
delivery a new webhook sends, say) falls back to a full refresh instead.

## Configuration

Everything the process itself needs is environment variables — no
config file, and nothing forge-related, since that's per-user now (see
the preceding **Credentials** section):

| Variable           | Required | Default                    | Meaning                                                                                                                                                                                                                                    |
| ------------------ | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADDR`             | no       | `:8080`                    | Listen address.                                                                                                                                                                                                                            |
| `DB_PATH`          | no       | `/data/forge-dashboard.db` | Where passkeys, sessions, and every user's encrypted forge credentials live.                                                                                                                                                               |
| `RP_ID`            | no       | `localhost`                | The WebAuthn relying party ID — set to your real domain in any real deployment.                                                                                                                                                            |
| `RP_ORIGIN`        | no       | `http://localhost:8080`    | The WebAuthn relying party origin — set to the real `https://` origin users reach this at.                                                                                                                                                 |
| `ENCRYPTION_KEY`   | **yes**  | —                          | Base64-encoded 32-byte key for encrypting forge tokens at rest. Generate with `openssl rand -base64 32`.                                                                                                                                   |
| `REFRESH_INTERVAL` | no       | `20m`                      | How often the backend re-polls a signed-in user's forges, as a Go duration (`2m30s`, `10m`). A safety net now that every tracked repo gets a webhook — lower it if you're not relying on those.                                            |
| `LOG_LEVEL`        | no       | `info`                     | `debug`, `info`, `warn`, or `error`. `debug` logs every outbound request to GitHub/Forgejo (method, URL) — turn it on to diagnose a request-volume spike from the process's own logs instead of reasoning about the code from the outside. |

Repository discovery is automatic per user. With a token, the dashboard
lists every repository it has push access to — on GitHub, one GraphQL
query returns that whole list along with every repo's open pull requests,
open issues, and CI status in a single request (drawing from GraphQL's
own separate rate-limit pool, not the REST budget everything else on the
account shares); on Forgejo, `GET /user/repos`. With only a username, it
lists that account's public repositories (`GET /users/<username>/repos`
on both) with no credential in play at all — GitHub's GraphQL API allows
no anonymous access, so this mode stays REST-based there too. Either way
there's no per-repo allowlist to maintain — archived and forked
repositories are excluded automatically, on both forges, in either mode.
On Forgejo, a mirrored repository is excluded too — a pull mirror has no
pull requests or issues of its own to poll, and its canonical home is
whichever forge it's mirrored from.

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
  --memory=64m --cpus=0.5 \
  -v forge-dashboard-data:/data \
  -e RP_ID=localhost -e RP_ORIGIN=http://localhost:8080 \
  -e ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  forge-dashboard
```

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
existing `vps-docker` compose setup as its own service directory, routed
through the Traefik instance already running there; there's no
per-service Tailscale sidecar, since every service on that host reaches
the tailnet the same way. That deployment config — including the `/data`
volume this now needs, and `RP_ID`/`RP_ORIGIN` set to the real deployed
domain rather than the `localhost` defaults — lives in `vps-docker`, not
here.

## API

`api/openapi.yaml` is the contract: `GET /healthz` for liveness,
`GET /api/dashboard` for the signed-in user's aggregated snapshot (or,
with `?owner=<username>`, one shared with them), `GET`/`PUT
/api/settings` for that user's own GitHub/Forgejo configuration — the
`PUT` response never echoes a token back, only whether one is now set
— `GET/PUT/DELETE /api/sharing(/{username})` for managing who can see
your dashboard, and `GET /api/admin/users` plus the revoke/delete
endpoints, alongside `GET/POST /api/admin/invites` and
`POST /api/admin/invites/{token}/revoke` for generating, listing, and
revoking registration invites, every one of them refusing anyone but the
designated admin. `redocly lint` validates it; nothing yet asserts the
handlers still match it (see
[CONTRIBUTING.md](CONTRIBUTING.md#how-it-fits-together)).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain, the hooks, and
how a change gets reviewed and released.

## Licence

[AGPL-3.0](LICENSE). Chosen over the plain GPL-3.0 this project started
under because AGPL's network-use clause also covers running a modified
copy as a hosted service, which GPL alone doesn't.
