# Accounts

Signing in, API tokens, and the forge
credentials each account saves.

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
  login page. See [Invites](#invites) for generating, listing, and
  revoking them.
- **An invite is a single-use, one-hour link.** The admin picks the
  username and display name up front through `POST /api/admin/invites`; the
  generated `/login.html?invite=<token>&username=<username>`
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

## Invites

The dashboard has no admin page. The user list and the invites are reachable
through the API only: `GET /api/admin/users`, with
`POST .../{username}/revoke` or `DELETE .../{username}` to remove a user,
and `GET`/`POST /api/admin/invites` with
`POST /api/admin/invites/{token}/revoke`. All of them refuse anyone but the
admin, and a signed-in session or an API token reaches them like any other
endpoint.

An invite is a single-use registration link: send the username and display
name up front, and the invitee only ever completes the WebAuthn ceremony. The
link comes back exactly once. Only the token's hash is stored server-side, so
losing it means creating a new one, the same "show once" handling a personal
API token gets. Every invite expires after one hour, fixed and not
configurable: long enough to hand a link off and have the invitee act on it in
one sitting, short enough that a forgotten invite isn't a standing credential.

Revoking a user signs them out everywhere, clearing every passkey and API
token, and leaves the account and its saved forge credentials alone. Removing
one deletes the account outright, along with its passkeys, sessions, tokens and
saved credentials, and frees the username. Neither works on the admin's own
account; the backend refuses it with a 400.

## Credentials

Set from the Settings page (`/settings.html`, linked from the dashboard
header) once you're signed in — nothing forge-related is configured by
the process itself. The page has four groups (Display, Connections,
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
  out of sync with it.
- **Username only** (token left blank): shows that account's public
  repositories, fully unauthenticated — the same data anyone gets
  landing on `github.com/<username>?tab=repositories`. Verified live
  against a real 105-public-repo account. GitHub caps unauthenticated API
  calls far lower than token calls (see [Rate limits](rate-limits.md)), so this
  mode only sees everything on an account small enough to fit that budget. A
  token is what a bigger account needs.
- **GitHub App installation** (operator opt-in): if this deployment has
  a GitHub App configured, a field next to the token lets you connect
  an installation instead — its own independent rate-limit budget
  rather than your account's shared one. Setup is in
  [GitHub App support](configuration.md#github-app-support), and
  [Rate limits](rate-limits.md) explains the budgets.

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
