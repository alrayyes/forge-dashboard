# Configuration

Everything the process itself needs is environment variables — no
config file, and nothing forge-related, since that's per-user now (see
[Credentials](accounts.md#credentials)):

| Variable                        | Required                           | Default                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ---------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADDR`                          | no                                 | `:8080`                    | Listen address.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DB_PATH`                       | no                                 | `/data/forge-dashboard.db` | Where passkeys, sessions, and every user's encrypted forge credentials live. It also holds a cache of what the dashboard last learned from the forges: GitHub's `ETag` answers (at most 20 megabytes, the least recently used dropped first), the last snapshot, the webhook checks and when each webhook delivery last arrived. The cache is keyed by credential and repository, not by user, and is safe to delete: the next start begins empty and refills it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RP_ID`                         | no                                 | `localhost`                | The WebAuthn relying party ID — set to your real domain in any real deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `RP_ORIGIN`                     | no                                 | `http://localhost:8080`    | The WebAuthn relying party origin — set to the real `https://` origin users reach this at.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ENCRYPTION_KEY`                | **yes**                            | —                          | Base64-encoded 32-byte key for encrypting forge tokens at rest. Generate with `openssl rand -base64 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GITHUB_APP_ID`                 | no                                 | —                          | The numeric ID of a GitHub App this deployment lets users connect instead of pasting a personal access token — see **GitHub App support** below. Unset means the option doesn't exist at all; no other GitHub behaviour changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | **yes, if `GITHUB_APP_ID` is set** | —                          | Base64-encoded PEM private key for that App, downloaded from its GitHub settings page. Validated at startup — a malformed key fails loudly there, the same way a bad `ENCRYPTION_KEY` does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `REFRESH_INTERVAL`              | no                                 | `20m`                      | How often the backend re-polls a signed-in user's forges, as a Go duration (`2m30s`, `10m`). The minimum is `1m`: a value below it, like a value that is not a duration, is logged and falls back to the default. A safety net now that every tracked repo gets a webhook — lower it if you're not relying on those. While every tracked repo has a healthy webhook, the wait stretches to four times this value, up to 2 hours (80 minutes at the default), and the wait is re-checked at each refresh, so a lost webhook can take up to one stretched wait to be noticed. The wait stays at this value unless every tracked repo currently has a confirmed webhook. That is not the case when no webhook path is configured, when no repos are tracked yet, when the credential can't manage hooks, or when a repo has no hook or its hook check failed. Ignoring a repo doesn't change this: an ignored repo with a healthy hook still counts as covered. A value you set is the shortest the wait ever gets, and one above 2 hours is never shortened. See [Rate limits](rate-limits.md). |
| `IDLE_AFTER`                    | no                                 | `15m`                      | How long nothing may have used the dashboard before the backend stops its scheduled refresh, as a Go duration. A signed-in request or a visible tab in use counts; a stream, a hidden tab or a failed request doesn't. The first use after a rest refreshes once. Webhook-driven refreshes, Refresh now and the CI poll are unaffected, and the schedule keeps running while a pull request is armed for auto-merge or waiting for auto-update. Set `0s` to refresh on schedule whoever is there. A negative value, like a value that isn't a duration, is logged and falls back to the default. What still runs while it rests is in [Rate limits](rate-limits.md).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SHUTDOWN_DRAIN`                | no                                 | `5s`                       | How long `/readyz` answers 503 after SIGTERM before the server stops accepting connections, so a router polling it takes the container out of rotation first. `0s` skips the wait. A negative value, like a value that isn't a duration, is logged and falls back to the default. Keep the container's stop grace period longer than this plus 5 seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CI_POLL_INTERVAL`              | no                                 | `1m`                       | How often the backend re-checks just the open pull requests whose CI is still pending, or that have GitHub's own auto-merge armed (GitHub merges those by itself, and without a webhook the board would otherwise learn of it at the next full refresh; one is polled for as long as it stays armed, and not at all while the forge's budget is spent), as a Go duration. This is the shortest gap: GitHub's pull requests are read together in one query per 25, a pull request that reads the same after a poll waits twice as long next time up to 15 minutes, and a GitHub pull request whose head commit keeps getting signed check events from the webhook isn't polled for checks (see [Rate limits](rate-limits.md#how-the-ci-poll-spends-the-budget)). A fallback for real Forgejo instances that silently drop the webhook event CI status rides on (see [Webhooks](webhooks.md)) — set to `0s` to turn it off if you don't need it. A negative value, like a value that is not a duration, is logged and falls back to the default.                                                |
| `LOG_LEVEL`                     | no                                 | `info`                     | `debug`, `info`, `warn`, or `error`. `debug` logs every outbound request to GitHub/Forgejo (method, URL) — turn it on to diagnose a request-volume spike from the process's own logs instead of reasoning about the code from the outside.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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
Ordinary conversation comments are counted apart, as `conversationComments`, and
the row's comment pill shows the sum of the two. GitHub reads the review numbers
from the review threads in the pull request query, so it costs no request. It
reads the first 30 threads, so a pull request with more reports fewer than it
has. The unauthenticated fallback has no thread data and reports 0 comments and
a `null` `unresolvedThreads`. Forgejo's count is the sum of each review's
comments from the reviews call that already feeds `review`, so a draft
reports 0. Forgejo gives no resolved state without a request per review, so its
`unresolvedThreads` is `null`: unknown, not zero.

Each row shows that as a pill beside the other status pills: the number of
comments, review and conversation together, and `7 · 2 open` in amber, with a
dot, when threads are still unresolved. A pull request with no comments shows
nothing, and on Forgejo, where `unresolvedThreads` is `null`, the pill shows the
count with no open state. The pill is a link to the pull request's
files-and-review view on the forge, or to the pull request itself when it has
only conversation comments, opened in a new tab. Its accessible name is the full
sentence, such as "7 review comments, 2 unresolved threads", or "3 comments"
once a conversation comment is in the count.

`awaitingWorkflowApproval` is true when GitHub is holding a workflow run on the
head commit until someone approves it (a check run counted as `ACTION_REQUIRED`
in the checks summary). It adds no request, and it is false when that summary
belongs to an earlier commit. Runs a first-time contributor's pull request
holds create no check runs, so when a required check hasn't reported the
dashboard asks the repository's Actions runs for the head commit once, and a
held run sets it too, with `ci` failing instead of pending. It can be true
while `ci` is pending or failing for another reason. A third-party check that
concludes `action_required` counts too. Forgejo and the unauthenticated fallback
always report false.

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
to show. For what the dashboard does while a forge is limited, see
[Rate limits](rate-limits.md).

## Reserve for your own actions

On GitHub the dashboard holds back 10% of each of the REST and GraphQL budgets
(never less than 50 points) for the things you click: Merge, Update branch, the
bot rebases, Close and Enable auto-merge. Scheduled refreshes, polls and webhook
maintenance wait for the reset instead of spending it; your actions and Refresh
now don't. The size is fixed and has no environment variable. To spend less in
the background, raise `REFRESH_INTERVAL` or `CI_POLL_INTERVAL`. Forgejo reports
no budget, so nothing is held back there. See [Rate limits](rate-limits.md).

## GitHub App support

A personal access token's polling shares the account's rate-limit budget with
anything else acting as that account. A GitHub App installation token draws from
that installation's own independent budget instead, so this is worth setting up
once your account's own usage is bumping into the shared limit. See
[Rate limits](rate-limits.md) for how the budgets work.

To offer this to your users:

1. [Register a GitHub App](https://github.com/settings/apps/new) —
   any name, no webhook of its own needed. Under **Repository
   permissions**, grant Contents, Issues, and Pull requests (read and
   write) for repo discovery, plus **Webhooks (Read and write)** for
   "Add a webhook", plus **Actions (Read and write)** for "Rerun failed
   checks" and for listing workflow runs held for approval; Metadata (read)
   comes along automatically. (GitHub also
   has an _organization_ Webhooks permission; that is not the one.) An
   installation has no role on a repo, so the Webhooks page offers the Add
   button wherever listing that repo's webhooks works. That proves read
   access only; write is confirmed when Add is used. If you add or change
   a permission on an App that is already installed, GitHub holds the change
   until the owner accepts it on the installation's page, and the App has
   the old permissions until then. A refused action reads "Resource not
   accessible by integration" until you accept it.
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
App (see the Dependabot buttons in
[Pull request actions](pull-request-actions.md)). Leave `GITHUB_APP_ID`
unset and the field simply doesn't appear; nothing else about GitHub credentials
changes.
