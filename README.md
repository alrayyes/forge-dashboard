# forge-dashboard

[![CI](https://github.com/alrayyes/forge-dashboard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alrayyes/forge-dashboard/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/alrayyes/forge-dashboard?sort=semver)](https://github.com/alrayyes/forge-dashboard/releases/latest)
[![licence](https://img.shields.io/badge/licence-GPL--3.0-blue)](LICENSE)

A single-page dashboard of open pull requests, issues, and CI status across
every repository you have write access to on **GitHub** and a **Forgejo**
instance — one page instead of two forge UIs. See
[#1](https://github.com/alrayyes/forge-dashboard/issues/1) for the v1
acceptance criteria this was built against, and
[#3](https://github.com/alrayyes/forge-dashboard/issues/3) for the
passwordless login, per-user tokens, sharing, and an admin role this document
now describes the first slice of.

## Design

- **Passkey login, no passwords anywhere.** Registration and sign-in are
  real [WebAuthn](https://webauthn.io) ceremonies — works with Proton
  Pass, 1Password, iCloud Keychain, a platform authenticator, or a
  hardware key, anything that speaks passkeys. Nothing password-shaped is
  ever stored or transmitted.
- **Credentials never reach the browser.** The Go backend holds both
  forges' tokens server-side and only ever hands the frontend its own
  already-filtered JSON. Confirm this yourself: open the browser's network
  tab and watch it call nothing but `/api/dashboard`, `/api/auth/*` and
  `/healthz`.
- **One Go binary, no frontend build step.** Plain HTML/CSS/JS, embedded
  into the binary with `//go:embed`. `go build` is the whole pipeline — no
  Node toolchain needed to run the service, only to run its own lint/test
  tooling (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- **Read-only against both forges.** Nothing here writes back to GitHub or
  Forgejo. It aggregates and displays; every row links out to the real
  thing.

### Where this stands against #3

This ships passkey registration and login gating the dashboard, and an
admin flag established at startup rather than by whoever registers
first. It does **not** yet ship #3's other two pieces: per-user
GitHub/Forgejo tokens (every signed-in user currently sees the same
dashboard, still configured by the environment variables below) and
dashboard sharing between users. Those land as their own follow-up work
on top of this.

## Requirements

- **Go 1.27 or newer**, to build.
- **A passkey-capable browser** to sign in at all — any current Chrome,
  Safari, Firefox or Edge; a phone counts too. Nothing else to install.
- **Somewhere writable for the auth database** (`DB_PATH`, default
  `/data/forge-dashboard.db`) that survives a restart — registered
  passkeys and sessions live there. In Docker that means a mounted volume
  at `/data`; see **Docker** below.
- Credentials for at least one forge — see **Credentials** below for
  exactly which permissions to grant. `GITHUB_*` and `FORGEJO_*` are
  entirely independent and each optional on its own: run with just one
  forge configured, or neither (an empty dashboard), if that's ever
  useful for a smoke test.

## Authentication

The first visit registers a passkey; every visit after that signs in with
it — no password, no separate account system. `POST /api/auth/register/begin`
and `.../finish` run the WebAuthn registration ceremony,
`.../login/begin`/`.../finish` run the login ceremony, and a signed
session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` whenever the request
arrived over HTTPS) is what actually gates `/` and `/api/dashboard`
afterward — see `internal/auth` and `api/openapi.yaml`'s `auth` tag.

- **`ADMIN_USERNAME`** names the one username that becomes an admin the
  moment it registers — decided here, at startup, rather than by whoever
  happens to register first. Leave it unset and nobody registers as an
  admin (fine for now: nothing in this slice is admin-gated yet — that's
  part of #3's remaining scope).
- **`RP_ID`** / **`RP_ORIGIN`** configure the WebAuthn relying party.
  They default to `localhost` / `http://localhost:8080` for a local run;
  a real deployment **must** set both to its real domain, or every
  passkey registered against the default refuses to work there — a
  passkey is cryptographically bound to the origin it was created for,
  not something this service can paper over after the fact.

## Credentials

Each forge takes either a token (sees private repos too) or a bare
username (public repos only, no credential at all) — never both
purposes at once. A token always wins over a username if you set both.

### GitHub

- **Token** (`GITHUB_TOKEN`): a personal access token with read access
  to the repositories you want tracked.
  - Classic token: the `repo` scope.
  - Fine-grained token: **Contents**, **Issues**, **Pull requests**
    (Read-only), plus **Metadata** (Read-only, mandatory on every
    fine-grained token regardless).
- **Username only** (`GITHUB_USERNAME`, `GITHUB_TOKEN` unset): shows
  that account's public repositories, fully unauthenticated — the same
  data anyone gets landing on `github.com/<username>?tab=repositories`.
  Verified live against a real 105-public-repo account. Unauthenticated
  GitHub API calls are capped at **60 requests/hour**, so this mode only
  sees everything on an account small enough to fit that budget — a
  token (5,000/hour) is what an account this size actually needs.

### Forgejo

- **Token** (`FORGEJO_TOKEN`): `Settings → Applications → Generate New
Token`, with **`read:repository`**, **`read:issue`**, and
  **`read:user`** all checked. `read:user` is easy to miss — it isn't
  obviously related to repos, but `GET /user/repos` (how repository
  discovery works) refuses a token without it: confirmed live against a
  real instance, `403 token does not have at least one of required
scope(s): [read:user]`, before `read:user` was added to the token.
- **Username only** (`FORGEJO_USERNAME`, `FORGEJO_TOKEN` unset): shows
  that account's public repositories on the configured instance,
  unauthenticated — same trade-off as GitHub's username mode. Verified
  against a real Forgejo instance's `GET /users/<username>/repos`.

## Configuration

Everything is environment variables — no config file:

| Variable           | Required | Default                    | Meaning                                                                                           |
| ------------------ | -------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `ADDR`             | no       | `:8080`                    | Listen address.                                                                                   |
| `DB_PATH`          | no       | `/data/forge-dashboard.db` | Where the auth database (passkeys, sessions) lives. Needs to persist across restarts.             |
| `RP_ID`            | no       | `localhost`                | The WebAuthn relying party ID — set to your real domain in any real deployment.                   |
| `RP_ORIGIN`        | no       | `http://localhost:8080`    | The WebAuthn relying party origin — set to the real `https://` origin users reach this at.        |
| `ADMIN_USERNAME`   | no       | —                          | The one username that becomes an admin on registration. Unset means nobody does.                  |
| `GITHUB_TOKEN`     | no\*     | —                          | A GitHub personal access token. Every repo it can push to is tracked, private included.           |
| `GITHUB_USERNAME`  | no\*     | —                          | Used only when `GITHUB_TOKEN` is unset — shows that account's **public** repos, unauthenticated.  |
| `FORGEJO_URL`      | no\*     | —                          | Base URL of the Forgejo instance, for example `https://git.example.com`.                          |
| `FORGEJO_TOKEN`    | no\*     | —                          | A Forgejo API token. Every repo it can push to is tracked, private included.                      |
| `FORGEJO_USERNAME` | no\*     | —                          | Used only when `FORGEJO_URL` is set but `FORGEJO_TOKEN` isn't — that account's public repos only. |
| `REFRESH_INTERVAL` | no       | `5m`                       | How often the backend re-polls both forges, as a Go duration (`2m30s`, `10m`).                    |

\* Each forge is entirely optional, and GitHub and Forgejo don't depend on
each other — configure one, both, or neither (the process still starts
and serves an empty snapshot either way, rather than refusing to boot).
Within a forge, its token wins over its username when both are set.

Repository discovery is automatic. With a token, the dashboard lists
every repository it has push access to (`GET /user/repos` on both APIs);
with only a username, it lists that account's public repositories
(`GET /users/<username>/repos`, also both APIs) with no credential in
play at all. Either way there's no per-repo allowlist to maintain.

## Running it

```sh
go build -o forge-dashboard ./cmd/forge-dashboard
mkdir -p data
DB_PATH=./data/forge-dashboard.db \
  GITHUB_TOKEN=ghp_xxx FORGEJO_URL=https://git.example.com FORGEJO_TOKEN=xxx \
  ./forge-dashboard
```

Then open `http://localhost:8080` and register a passkey — `RP_ID`/
`RP_ORIGIN` default to `localhost`/`http://localhost:8080`, which matches
this local run with nothing extra to set.

### Docker

The `/data` directory the image ships is where the auth database goes —
mount a volume there, or every passkey registered is gone the moment the
container is recreated:

```sh
docker build -t forge-dashboard .
docker run --rm -p 8080:8080 \
  --cap-drop=ALL --security-opt=no-new-privileges --read-only \
  --memory=64m --cpus=0.5 \
  -v forge-dashboard-data:/data \
  -e RP_ID=localhost -e RP_ORIGIN=http://localhost:8080 -e ADMIN_USERNAME=you \
  -e GITHUB_TOKEN=ghp_xxx -e FORGEJO_URL=https://git.example.com -e FORGEJO_TOKEN=xxx \
  forge-dashboard
```

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

`api/openapi.yaml` is the contract: `GET /healthz` for liveness, and
`GET /api/dashboard` for the aggregated snapshot the frontend renders.
`redocly lint` validates it; nothing yet asserts the handlers still match
it (see [CONTRIBUTING.md](CONTRIBUTING.md#how-it-fits-together)).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain, the hooks, and
how a change gets reviewed and released.

## Licence

[GPL-3.0](LICENSE).
