# API

`api/openapi.yaml` is the contract: `GET /healthz` for liveness, `GET /readyz`
for readiness,
`GET /api/v1/dashboard` for the aggregated snapshot
(`?includeHidden=true` lists the pull requests the user hid, marked
`hidden`, and `hiddenPullRequests` counts
them), `POST /api/v1/pull-requests/hide` and `/unhide` to hide one pull request
(until restored, or for `days`) and bring it back,
`GET /api/v1/pull-requests/details` for one pull request's description, comments
and thumbs up and down reactions (on demand, never in the snapshot: Markdown
as the forge stores it, cut at 20,000 characters, the first 50 comments, and a
release pull request's release notes; one GraphQL query on GitHub, up to 53
requests on Forgejo, which has no batch read), `GET /api/v1/issues/details` for
one issue's description and comments the same way (without release notes),
`GET /api/v1/main-branches` for
the CI status of every default branch, `GET`/`PUT
/api/v1/settings` for the GitHub/Forgejo configuration — the
`PUT` response never echoes a token back, only whether one is now set
— `GET/PUT /api/v1/settings/timezone` for the zone the user wants times shown
in (an IANA name such as `Europe/Amsterdam`; empty means the browser's own, and
it exists for browsers that report UTC to every page, such as Firefox with
fingerprint resistance).
`redocly lint` validates it, and Go contract tests in
`internal/api` check recorded responses against it (see
[CONTRIBUTING.md](../CONTRIBUTING.md#how-it-fits-together)). Rendered docs
live at `docs/api/index.html` (Scalar, zero-build), published
to <https://alrayyes.github.io/forge-dashboard/docs/api/> on every push to
`main` that passes CI.

The dashboard response carries `readIntervalSeconds`, the server's advice on
how often to re-read it. `POST /api/v1/dashboard/refresh` fetches from the
forges right now, but at most once every five seconds. A call inside that
window skips the fetch and answers 200 with the current snapshot and a
`Retry-After` header, so a follow-up refresh after an action never fails. So
does a call while the first refresh since start-up is still running, which
would otherwise wait for all of it. The
page follows both: it polls at `readIntervalSeconds`, and "Refresh now" locks
for `Retry-After` seconds. Neither number lives in the front end.

`GET/POST /api/v1/queued-actions` and `DELETE /api/v1/queued-actions/{id}` list,
queue and cancel the actions that wait for a rate limit reset (see
[Pull request actions](pull-request-actions.md)).

`GET/POST/DELETE /api/v1/mcp` sits outside this contract — it's the MCP
Streamable HTTP transport (JSON-RPC over HTTP, not a REST resource
`redocly`/OpenAPI describes), not a plain request/response endpoint. See
the **Design** section of [Architecture](../ARCHITECTURE.md#design) for what
it exposes and how it authenticates.

## Versioning

The major version is in the path: every operation lives under `/api/v1`. A
breaking change ships as `/api/v2` beside it, never in place. `info.version` in
`api/openapi.yaml` is the contract's own version number, and its major matches
the path.

Three things stay outside the version because something else holds their
address: `/healthz` and `/readyz`, the forges' webhook routes under
`/api/webhooks/`, and `GET /api/version`, which reports the release and the
current `apiVersion`.

The old addresses without a version (`/api/dashboard`) answer `308 Permanent
Redirect` to their `/api/v1` path for one release, with a `Deprecation` header
([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)). A 308 keeps the method and
body, so a page opened before an upgrade keeps working. Move to the `/api/v1`
paths: the redirects are then removed.
