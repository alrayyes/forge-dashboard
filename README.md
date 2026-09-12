# forge-dashboard

[![CI](https://github.com/alrayyes/forge-dashboard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alrayyes/forge-dashboard/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/alrayyes/forge-dashboard?sort=semver)](https://github.com/alrayyes/forge-dashboard/releases/latest)
[![licence](https://img.shields.io/badge/licence-GPL--3.0-blue)](LICENSE)

A single-page dashboard of open pull requests, issues, and CI status across
every repository you have write access to on **GitHub** and a **Forgejo**
instance — one page instead of two forge UIs. See
[#1](https://github.com/alrayyes/forge-dashboard/issues/1) for the full
acceptance criteria this v1 was built against.

## Design

- **No authentication.** v1 assumes whatever network reaches this service
  is already trusted — a tailnet, a VPN, a firewall rule. There's no login
  system to bypass because there isn't one; don't expose this on the open
  internet.
- **Credentials never reach the browser.** The Go backend holds both
  forges' tokens server-side and only ever hands the frontend its own
  already-filtered JSON. Confirm this yourself: open the browser's network
  tab and watch it call nothing but `/api/dashboard` and `/healthz`.
- **One Go binary, no frontend build step.** Plain HTML/CSS/JS, embedded
  into the binary with `//go:embed`. `go build` is the whole pipeline — no
  Node toolchain needed to run the service, only to run its own lint/test
  tooling (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- **Read-only.** Nothing here writes back to either forge. It aggregates
  and displays; every row links out to the real thing.

## Requirements

- **Go 1.27 or newer**, to build.
- Credentials for at least one forge — see **Credentials** below for
  exactly which permissions to grant. `GITHUB_*` and `FORGEJO_*` are
  entirely independent and each optional on its own: run with just one
  forge configured, or neither (an empty dashboard), if that's ever
  useful for a smoke test.

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

| Variable           | Required | Default | Meaning                                                                                           |
| ------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------- |
| `ADDR`             | no       | `:8080` | Listen address.                                                                                   |
| `GITHUB_TOKEN`     | no\*     | —       | A GitHub personal access token. Every repo it can push to is tracked, private included.           |
| `GITHUB_USERNAME`  | no\*     | —       | Used only when `GITHUB_TOKEN` is unset — shows that account's **public** repos, unauthenticated.  |
| `FORGEJO_URL`      | no\*     | —       | Base URL of the Forgejo instance, for example `https://git.example.com`.                          |
| `FORGEJO_TOKEN`    | no\*     | —       | A Forgejo API token. Every repo it can push to is tracked, private included.                      |
| `FORGEJO_USERNAME` | no\*     | —       | Used only when `FORGEJO_URL` is set but `FORGEJO_TOKEN` isn't — that account's public repos only. |
| `REFRESH_INTERVAL` | no       | `5m`    | How often the backend re-polls both forges, as a Go duration (`2m30s`, `10m`).                    |

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
GITHUB_TOKEN=ghp_xxx FORGEJO_URL=https://git.example.com FORGEJO_TOKEN=xxx \
  ./forge-dashboard
```

Then open `http://localhost:8080`.

### Docker

```sh
docker build -t forge-dashboard .
docker run --rm -p 8080:8080 \
  --cap-drop=ALL --security-opt=no-new-privileges --read-only \
  --memory=64m --cpus=0.5 \
  -e GITHUB_TOKEN=ghp_xxx -e FORGEJO_URL=https://git.example.com -e FORGEJO_TOKEN=xxx \
  forge-dashboard
```

The published image is `ghcr.io/alrayyes/forge-dashboard`, built and
pushed on every release by `.goreleaser.yml`'s `dockers:` block — tagged
by version and `:latest`, `linux/amd64` and `linux/arm64`.

## Deployment

Deployed on a homelab, reachable only over Tailscale — the tailnet is the
access boundary v1's "no authentication" design leans on. The image is
pulled into that homelab's existing `vps-docker` compose setup as its own
service directory, routed through the Traefik instance already running
there; there's no per-service Tailscale sidecar, since every service on
that host reaches the tailnet the same way. That deployment config lives
in `vps-docker`, not here — this repo only has to produce the image.

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
