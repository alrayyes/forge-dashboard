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

## Requirements

- **Go 1.27 or newer**, to build.
- **[bun](https://bun.sh)**, to build from source — `bun run build:web`
  has to run before `go build` picks up its output (see
  [Architecture](ARCHITECTURE.md#design)). Not needed to run a pre-built release
  binary or the Docker image, both of which already have that step baked in.
- **A passkey-capable browser** to sign in at all — any current Chrome,
  Safari, Firefox or Edge; a phone counts too. Nothing else to install.
- **Somewhere writable for the database** (`DB_PATH`, default
  `/data/forge-dashboard.db`) that survives a restart — registered
  passkeys, sessions, and every user's encrypted forge credentials live
  there. In Docker that means a mounted volume at `/data`; see **Docker**
  below.
- **`ENCRYPTION_KEY`**, a base64-encoded 32-byte key the process refuses
  to start without — see [Configuration](docs/configuration.md) for how to
  generate one.
  It's what encrypts every user's forge tokens at rest; there's no
  sensible default for a secret like this one.
- Each signed-in user configures their own forge credentials from the
  Settings page after registering — see
  [Credentials](docs/accounts.md#credentials) for exactly which permissions to
  grant. Nothing forge-related needs setting before
  the process starts.

## Documentation

- [Pull request actions](docs/pull-request-actions.md): what a row offers, and
  why a blocked action is blocked.
- [Issues](docs/issues.md): the issues page and the settings that hide issues.
- [Main branches](docs/main-branches.md): the default-branch CI page and
  `GET /api/main-branches`.
- [Live updates and filters](docs/live-updates.md): how the board refreshes, what
  waits behind "N updates available", the first load after a restart, the
  navigation counts, and how filters are offered, remembered and folded on a
  phone.
- [API](docs/api.md): the HTTP endpoints, the OpenAPI contract and the MCP
  endpoint.
- [Accounts](docs/accounts.md): passkey login, API tokens, the admin area,
  sharing a dashboard and the GitHub and Forgejo credentials.
- [Configuration](docs/configuration.md): every environment variable, how repositories
  are discovered and the GitHub App option.
- [Webhooks](docs/webhooks.md): registering the forge webhook and the checks the
  dashboard runs on its own.
- [Architecture](ARCHITECTURE.md#design): the design choices behind the app, from
  passkey login to the MCP endpoint and the single binary.

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
