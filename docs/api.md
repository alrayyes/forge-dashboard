# API

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
[CONTRIBUTING.md](../CONTRIBUTING.md#how-it-fits-together)). Rendered docs
live at `docs/api/index.html` (Scalar, zero-build), published
to <https://alrayyes.github.io/forge-dashboard/docs/api/> on every push to
`main` that passes CI.

The dashboard response carries `readIntervalSeconds`, the server's advice on
how often to re-read it. `POST /api/dashboard/refresh` fetches from the forges
right now, but at most once every five seconds per user. A call inside that
window skips the fetch and answers 200 with the current snapshot and a
`Retry-After` header, so a follow-up refresh after an action never fails. The
page follows both: it polls at `readIntervalSeconds`, and "Refresh now" locks
for `Retry-After` seconds. Neither number lives in the front end.

`GET/POST /api/queued-actions` and `DELETE /api/queued-actions/{id}` list,
queue and cancel the actions that wait for a rate limit reset (see
[Pull request actions](pull-request-actions.md)).

`GET/POST/DELETE /api/mcp` sits outside this contract — it's the MCP
Streamable HTTP transport (JSON-RPC over HTTP, not a REST resource
`redocly`/OpenAPI describes), not a plain request/response endpoint. See
the **Design** section of the [README](../README.md#design) for what it exposes
and how it authenticates.
