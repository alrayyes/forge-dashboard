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
- [Pull request pages](docs/pull-request-pages.md): the details pop-up, the
  Releases and Bots pages and hiding one pull request.
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
- [Running it](docs/running.md): building and starting the app, and running the
  Docker image with its health check.
- [Deployment](docs/deployment.md): where the project's own instance runs.
- [The changelog page](docs/changelog-page.md): the page the footer version
  links to.
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
