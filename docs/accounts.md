# Accounts

Signing in, API tokens, and the forge
credentials each account saves.

## Authentication

Forge Dashboard is an internal tool, not a public site, so it keeps out of
search engines. Every response carries `X-Robots-Tag: noindex, nofollow`, the
HTML shell has a matching `<meta name="robots">` tag, and `robots.txt` allows
crawling on purpose: a crawler that can't fetch a page never reads its
`noindex`. The real barrier is the passkey login below.

The first visit registers a passkey and becomes the instance's only user —
no password anywhere, and no separate account system. Neither registering nor
signing in asks for a username: the server names the account, and the sign-in
button starts the passkey prompt straight away. The sign-in names no passkey,
so the browser offers whichever one it has saved for the site, and every new
passkey is registered as a discoverable one (a resident key) for that reason.
A passkey from a password manager or a phone is already discoverable, and one
registered back when a username was asked for keeps working. `POST
/api/v1/auth/register/begin` and `.../finish` run the WebAuthn registration
ceremony, `.../login/begin`/`.../finish` run the login ceremony, and a
signed session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` whenever the
request arrived over HTTPS) is what actually gates `/` and
`/api/v1/dashboard` afterward — see `internal/auth` and `api/openapi.yaml`'s
`auth` tag.

- **Registration closes for good once a passkey exists.** No environment
  variable to set or get wrong, and no reliance on a deployment's own
  network boundary either: `Service.BeginRegistration` checks server-side
  whether any user already holds a passkey and answers 403
  `registration is closed` if so. The login page only shows the registration
  button on an instance with no users. More passkeys for the same account are
  added from Settings, signed in.
- **Passkeys can be renamed.** Settings lists each passkey by name, with a
  Rename button next to Remove, so a password manager and a security key can
  be told apart. A name is trimmed and 1 to 64 characters, whether it is
  given when adding a passkey or when renaming one, and is always shown as
  plain text. A passkey that never had a name is listed by the date it was
  added. For one with no stored record at all, from before names existed,
  that date is the account's creation time. The API route is
  `PATCH /api/v1/auth/credentials/{id}`.
- **A security key may hold a passkey that sign-in can't use.** Registered
  before sign-in dropped the username, a key such as a YubiKey stored a
  credential that isn't discoverable, which the browser can't offer without
  being told its ID. Sign in on a device with a saved passkey, then add the
  key again from Settings: it is now registered as a discoverable passkey.
  If the old key was the only passkey, no device offers one, and the way back
  in is `forge-dashboard reset-passkeys` below.
  The login page points to this after a second failed prompt in a row, since
  the browser reports a cancelled prompt and a missing passkey the same way.
- **Losing every passkey is fixed from the host, not the browser.** There's
  no email or SMS channel here to build a self-service recovery flow on, so
  the operator runs `forge-dashboard reset-passkeys`, which clears the
  owner's passkeys and reopens registration. Settings and the webhook token
  are kept. See [Lost your only passkey](running.md#lost-your-only-passkey).
- **`RP_ID`** / **`RP_ORIGIN`** configure the WebAuthn relying party.
  They default to `localhost` / `http://localhost:8080` for a local run;
  a real deployment **must** set both to its real domain, or every
  passkey registered against the default refuses to work there — a
  passkey is cryptographically bound to the origin it was created for,
  not something this service can paper over after the fact.

### Rate limit

The sign-in and registration endpoints take requests from anyone, and each
`begin` call parks a ceremony on the server for five minutes. So they are
limited per client address: `POST /api/v1/auth/register/begin`, `.../finish`,
`login/begin` and `.../finish` share one allowance of 10 requests at once, then
one more every 6 seconds. Past it the server answers `429` with a `Retry-After`
header in seconds, and the login page says to wait that long. Signing in takes
two requests, so the owner never reaches it. Over five minutes one address can
make at most 60 requests, fewer than the 100 pending ceremonies the server
holds, so a scanner can't push the owner's sign-in out.

The limit is on the address, not the account: sign-in names no user, and a
limit per account would let a stranger lock the owner out. The address is the
connection's own. Behind a reverse proxy that is the proxy, so the service reads
the client from the proxy's `X-Forwarded-For` instead, from the right end,
skipping every address listed in `TRUSTED_PROXIES` (see
[Configuration](configuration.md)). It believes that header only from those
proxies, and only the entries they wrote. An IPv6 client counts by its /64.

The proxy must forward the client's address in `X-Forwarded-For`. Most do by
default; some need a setting that adds the header. When a trusted proxy sends
none (or only addresses of trusted proxies), nothing tells the visitors apart.
Those requests then share one bucket, twice the size of a single address's
(20 at once, then one every 6 seconds), and are refused with `429` and
`Retry-After` like any other. Over five minutes that is at most 70 requests,
fewer than the 100 pending ceremonies, so this bucket alone can't fill the
store. It can be used up, though, and then the owner gets `429` for a while.
One address that does forward adds up to 60 more in the same five minutes, so
the shared bucket and such addresses together can exceed 100, as two addresses
always could. The server logs a warning once, naming the peer.

Running `docker run -p 8080:8080` with the default settings is this case: the
container sees the Docker gateway address, which is in the default trusted
ranges, and no `X-Forwarded-For`. Every visitor shares the one bucket. To get
a limit per address, put a proxy that forwards the client address in front. If
the service is reached with no proxy and the real client address does reach it,
set `TRUSTED_PROXIES=none` so each visitor counts by its own address. Behind
published Docker ports the real address is often lost, and then there is one
shared bucket either way.

Account lockout and CAPTCHA are not part of this.

### API tokens

A script can authenticate the same way a signed-in browser does, without
a WebAuthn ceremony of its own to perform: generate a personal API token
from Settings' "API tokens" card, then send it as a Bearer credential —

```sh
curl -H "Authorization: Bearer fdb_<the-generated-token>" \
  http://localhost:8080/api/v1/dashboard
```

against any endpoint the frontend itself calls, `RequireAuth` accepts
either credential (session cookie or a live token) the same way. The one
exception is the saved filters of the web UI
(`/api/v1/settings/filter-state`): that is the browser's own state, so it
takes a session cookie only and answers a
token with 403. Each save is logged with the user agent, so a filter
that changed by itself can be traced to the client that wrote it. The raw
value is shown exactly once, right after generating it — only its hash
is stored, so losing it means generating a new one, same as any other
bearer credential. Settings lists every live token (label, created date,
last-used date) with a one-click **Revoke** that stops it authenticating
immediately.

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

The server decides whether a save is valid (a Forgejo token or username
with no instance URL, or a bad installation ID). A refused save answers 400 with
the reason and the name of the field (`field`), and the page shows that reason
and puts focus on that input. The page holds no copy of those rules.

### GitHub

- **Token**: a personal access token with read access to the
  repositories you want tracked, plus write access to their webhooks if
  you ever plan to use the Webhooks page's "Add a webhook" button, and
  optionally Dependabot alerts (read) for the Branches page's advisories. The
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
