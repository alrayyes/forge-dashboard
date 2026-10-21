# Rate limits

A forge limits how many requests an account or an installation can make in a
window of time.
When the dashboard says a forge is rate limited, the forge has refused its
requests until a reset time. It isn't a fault in the dashboard. This page
explains why it happens, what the dashboard does meanwhile, and what you can
change.

## How the forges limit requests

**GitHub** gives each account or installation a request budget and reports it on
every response: the limit, what is left and when it resets. REST and GraphQL are
two separate budgets, and the header shows them on two lines, "GH REST" and "GH
GraphQL". The dashboard reads both, so a spent REST budget doesn't stop GraphQL,
and the other way round. GitHub's own pages have the actual numbers, which
differ by kind of credential and change over time:

- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Rate limits and query limits for the GraphQL API](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)

GitHub also has secondary limits, which guard against bursts of requests. A
secondary limit can refuse a request while budget is left, and the response may
carry a `Retry-After` header and no budget headers at all. The dashboard still
recognises it as a rate limit and shows the short message, "rate limited, retry
after" that many seconds, instead of GitHub's long legal text. With no budget
headers it has no reset time to count down to, so it keeps the last data and
tries again at the next scheduled refresh.

**Forgejo** doesn't count requests itself and reports no budget. If a limit
exists, it comes from a proxy in front of the instance. When the proxy refuses
an action, the response carries a `Retry-After` header, in seconds or as a
date, and the dashboard takes the reset time from it (see
[Pull request actions](pull-request-actions.md)). Because Forgejo reports no
budget, the severity grades, the banners and the back-off below apply to GitHub
only. A refresh the proxy refuses keeps the last data, and the next scheduled
refresh tries again.

## Why a budget runs out

- **A shared credential.** A personal access token acts as your GitHub
  account, so its budget is the account's. Anything else acting as that account
  spends the same budget: your own use of `gh`, other tools, scripts, CI.
- **Many tracked repositories.** One GraphQL query returns every repository with
  its open pull requests, issues and CI status, and a bigger answer costs more.
  The dashboard logs each query's cost at the `info` log level.
- **A restart.** The dashboard remembers the answers to its REST reads in
  memory, together with the ETag the forge sent, and asks again with
  `If-None-Match`. GitHub doesn't charge a request that comes back unchanged
  (`304 Not Modified`). After a restart that memory is empty, so each read is
  paid in full once. The GraphQL query isn't cached.
- **Refreshing often.** Each full refresh spends budget. `REFRESH_INTERVAL` sets
  how often it runs (see [Configuration](configuration.md)).
- **An unwatched dashboard.** While nobody is using the dashboard, the scheduled
  refresh rests. After `IDLE_AFTER` (15 minutes by default) with no signed-in
  request and no tab that is visible and in use, the schedule skips its turn
  and tries again on the next one. A tab counts while it is visible and has had
  input within that period; it tells the server when it is hidden, and one that
  stops sending its minute-by-minute heartbeat stops counting after three
  minutes. The first request after that refreshes once, a moment after it
  answers, so that request and any client without a live stream can still see
  data from before the rest. An open live stream doesn't count, since it says
  nothing about whether anyone is looking, and neither does the page's own timed
  read of its data. A tab becoming visible again makes the one catch-up refresh.
  What still runs while it rests:
  - Webhook deliveries, which refresh the repository they name.
  - Refresh now.
  - The CI poll, for pull requests with checks still running or GitHub's
    auto-merge armed.
  - The scheduled refresh itself, while something is waiting on it: a pull
    request armed for auto-merge, or a behind pull request with auto-update on
    (for its repository or for that pull request) that hasn't been tried yet or
    whose retry wait is up. Those only ever happen after a refresh, so "merge
    when green" doesn't stall overnight. A refused update (a conflict) isn't
    waiting on anything.

  What waits for the next use instead: Dependabot's acknowledgement checks and
  the check on a rebased Dependabot pull request.

A GitHub App installation has its own budget, separate from your tokens and
from other tools. The dashboard asks GitHub for an installation token for the
installation you connect and uses it for reading and for most actions. The
exception is the `@dependabot` comments, which Dependabot ignores from an App.
They are posted with the personal token you saved, and they spend that token's
budget. An installation is still the better choice when a token is shared,
because the polling, the largest cost, no longer draws on the shared budget.
Setup is in [GitHub App support](configuration.md#github-app-support).

Without a token the dashboard reads a username's public repositories over REST,
one request after another, and GitHub limits those requests per address instead
of per account (see [Accounts](accounts.md#credentials)). The limit is small, so
a token suits any account with more than a few repositories.

## What the dashboard shows

For GitHub, the server grades each budget and the page follows the grade:

| Severity   | Meaning                    | What you see                                                                |
| ---------- | -------------------------- | --------------------------------------------------------------------------- |
| `ok`       | At least 20% left.         | The count and reset in the header, and a green gauge on the Insights page.  |
| `warning`  | Under 20% left.            | The same, with an amber gauge. No banner.                                   |
| `low`      | Under 5% left.             | A red gauge, and the banner "Rate limit running low" with the count left.   |
| `exceeded` | Nothing left, reset ahead. | A red gauge that says "Rate limit exceeded", and a banner with a countdown. |

What stops at `exceeded` depends on the budget, as the next paragraph says.

Once the reset time has passed a spent budget stops counting as exceeded, even
before the next refresh confirms it.

When both the REST and the GraphQL budget are spent, the forge goes read-only.
When only REST is spent, Merge, Update branch, the bot rebases and Close are
unavailable, and Enable auto-merge still works. When only GraphQL is spent, only
Enable auto-merge is unavailable. The controls that can't work aren't drawn, a
**Why?** under the banner explains the limit, and **What still works** lists
what you can still do. Other forges are unaffected. The controls come back at
the reset, with a toast. See [Pull request actions](pull-request-actions.md) for
the details.

The data stays visible. The dashboard keeps the last pull requests, issues and
repos it fetched, marked stale, and the header's Refreshed time says how old
they are. On GitHub, it also asks less:

- Under 5% left but not at zero, the next scheduled refresh waits for the reset
  plus 30 seconds, and never longer than an hour.
- With the budget spent, it skips that forge's refresh and its CI check polling
  until the reset, because the request would fail and still count against the
  forge.

On every forge, "Refresh now" runs at most once every five seconds.

You can queue Update branch, `Dependabot: Rebase` and `Renovate: Rebase`
while a forge is limited. They run after the reset, when the pull request still
needs them, and Merge and Close can't be queued. See
[Pull request actions](pull-request-actions.md) for what happens to a queued
action.

## Conditional requests

Every REST read the dashboard sends to GitHub goes through one cache. The first
answer is kept with its `ETag`. The next request for the same URL sends it back
as `If-None-Match`, and if nothing changed GitHub answers `304 Not Modified`,
which costs nothing against the REST limit. The dashboard counts it under
`notModified` and serves the kept body, so the rest of the code never sees the
difference. GitHub documents this in its
[REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate).
The same page says a `304` is only free when the request is authorized, so the
public-repository mode, which sends no credential, may still be charged.

The cache is keyed by forge, credential label, URL and `Accept` header, never
by user. GitHub folds the credential into the ETag, so one credential's ETag is
never offered under another. Two clients holding the same credential share
entries, and a replaced token starts empty. A page size, page number or filter
is part of the URL, so a different one is a different entry.

The cache lives in memory and is bounded. A body over a megabyte is never kept,
so that read costs a full response each time. The cache reads no more than that
megabyte ahead to find out, and the caller still gets the whole body. Across
all entries the cache holds at most 5000 answers and 32 megabytes, and past
either limit it drops the least recently used answer first.

Forgejo, as probed, doesn't take part. The Forgejo instance we tested
(16.0.6, built on Gitea 1.22) sends no `ETag` and no `Last-Modified` header on
its JSON endpoints (pull requests, issues, commit statuses, Actions runs,
repositories, search), and it answers a request with `If-None-Match` or
`If-Modified-Since` with a full `200`. We haven't tested other versions.
Forgejo reports no request budget of its own to spend, so each read costs a
round trip and nothing more. Check again when you upgrade Forgejo; if it starts
sending ETags, add a cache for it the way GitHub's works.

Each row below is one source file with its number of REST `GET` call sites. A
test reads this table and fails when a file's count differs from the source, so
a new read can't skip the question of whether it can be conditional.

| File                                       | Calls | Reads                                                                                                                                                               | Conditional                       |
| ------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `internal/github/client.go`                | 23    | Hooks, repository, pull requests, files, issues, commits, check runs, statuses, runs, branch protection and rules, jobs, and installation and user repository lists | Yes, all but the job log download |
| `internal/github/dependabot_ack.go`        | 2     | Comments and comment reactions                                                                                                                                      | Yes                               |
| `internal/github/pull_request_body.go`     | 1     | One pull request                                                                                                                                                    | Yes                               |
| `internal/github/required_checks.go`       | 3     | Workflow runs, check runs, statuses                                                                                                                                 | Yes                               |
| `internal/github/rerun.go`                 | 3     | One pull request, check runs, one job                                                                                                                               | Yes                               |
| `internal/forgejo/client.go`               | 15    | Hooks, repositories, pull requests, issues, labels, reviews, statuses, Actions runs and jobs, protection                                                            | No, Forgejo sends no ETag         |
| `internal/forgejo/issue_details.go`        | 1     | One issue                                                                                                                                                           | No, Forgejo sends no ETag         |
| `internal/forgejo/main_branch.go`          | 3     | Repository, Actions runs, one commit                                                                                                                                | No, Forgejo sends no ETag         |
| `internal/forgejo/pull_request_body.go`    | 1     | One pull request                                                                                                                                                    | No, Forgejo sends no ETag         |
| `internal/forgejo/pull_request_details.go` | 4     | Pull request, comments, reactions                                                                                                                                   | No, Forgejo sends no ETag         |
| `internal/forgejo/rerun.go`                | 2     | One pull request, Actions runs                                                                                                                                      | No, Forgejo sends no ETag         |
| `internal/forgejo/scheduled_merge.go`      | 1     | Issue timeline                                                                                                                                                      | No, Forgejo sends no ETag         |

The one GitHub read that isn't conditional is the download of a job's log. The
API answers with a redirect to a short-lived signed address on GitHub's storage,
and that download doesn't count against the REST limit, and its address changes
every time, so there is nothing to match.

## Reading the stats

`GET /api/stats/forge-api` says how many requests the dashboard has spent since
the server started, so you can see what is using a budget before you change
anything. It takes a session or an API token, like the rest of the API, and
returns only the requests made with your own credentials.

Each row is one forge, credential, kind and repo, with four counts:

| Count         | What it counts                                                   |
| ------------- | ---------------------------------------------------------------- |
| `rest`        | REST requests, each charged against the REST budget.             |
| `graphql`     | GraphQL requests made.                                           |
| `graphqlCost` | The points the GraphQL requests were charged (`rateLimit.cost`). |
| `notModified` | Requests answered `304 Not Modified`, which cost nothing.        |

The kind says why the request was made:

| Kind               | Cause                                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| `full`             | A refresh of the whole account.                                                      |
| `scoped_webhook`   | A refresh of one repo after a webhook delivery.                                      |
| `ci_poll`          | A poll of one repo with a check still running.                                       |
| `auto_merge_poll`  | A poll of one repo with an armed auto-merge.                                         |
| `details`          | A pull request, issue or check list you opened.                                      |
| `hook_maintenance` | Checking, adding or upgrading webhooks.                                              |
| `user_action`      | A button you pressed, a queued action, or auto-merge and auto-update acting for you. |
| `unknown`          | A request nobody tagged. That is a bug in the dashboard; please report it.           |

A few things to know when you read the numbers:

- The counts start at zero on every start. `since` says when counting began, so
  compare two readings taken some time apart, not one reading to a budget.
- A request that names no repo, such as listing an account's repos, has an empty
  `repo`. A GitHub full refresh is one query for every repo, so it shows under
  the empty repo too.
- Rows are matched to the credentials you saved. A GitHub App installation id
  is a number you type in, so until the dashboard has one user, someone who
  saves another account's installation id sees that installation's counts.
  Tokens can't be matched this way without knowing them.
- The credential is a label, `app:<installation id>`, `token:<short hash>` or
  `public:<username>`. It holds no secret. Two accounts that connect the same
  token share a row, because they share a budget.
- Forgejo has no GraphQL, so its `graphql` and `graphqlCost` stay zero.
- `budgets` repeats the limits each forge last reported, the same figures as
  `forges` on `GET /api/dashboard`.

## Baseline: what each kind of refresh costs today

This is the reference to compare a change against: what each kind of request
cost before the dashboard was made cheaper. Read it as a fixture baseline, not
as a 30 or more repo account. No account of that size was available, so the
numbers come from the account that owns the project's end-to-end fixture
repository (`alrayyes/forge-dashboard-e2e-fixture`, 18 open pull requests when
measured). That account is not only the fixture, though. The dashboard tracked
**56 repositories** for it, with 27 open pull requests across 3 of them and 89
open issues.

Measured on 2026-10-21 against GitHub with a personal access token, on a
freshly started server (version 0.254.0) with an empty database and default
settings (`REFRESH_INTERVAL` 20 minutes, `CI_POLL_INTERVAL` 1 minute). The
readings are `GET /api/stats/forge-api` snapshots, taken in order, about three
minutes apart from first to last. Each row is the difference between the two
snapshots around it, summed over every repo.

| Kind             | What was done                                | REST | GraphQL requests | GraphQL cost | Not modified |
| ---------------- | -------------------------------------------- | ---: | ---------------: | -----------: | -----------: |
| `full`           | First refresh after the server started       |   28 |                5 |          606 |            0 |
| `full`           | Forced refresh (Refresh now), straight after |    0 |                5 |          606 |            0 |
| `scoped_webhook` | One signed `pull_request` delivery           |    0 |                4 |            0 |            0 |
| `details`        | Opening one pull request and its checks      |    5 |                1 |            0 |            0 |
| `ci_poll`        | All polls over the run (about 3 min)         |    2 |                8 |            0 |            4 |

How to read the table:

- The 28 REST requests of the first refresh are one on each of 22 repos and 6
  on the fixture repo. The forced refresh that followed made none, so they are
  a cost of the first refresh after a start, not of every refresh. The
  counters don't say what each request read.
- A full refresh on GitHub is the same 5 GraphQL requests and 606 points each
  time at 56 repos. The 606 points were charged by 3 of the 5 requests (202
  each); the other two reported none.
- `ci_poll` is a total, not a per-poll figure. The pending check on the
  fixture repo was polled on the one-minute interval for the whole run, and
  the counters don't separate one poll from the next.
- `scoped_webhook` and `ci_poll` recorded a GraphQL cost of 0 although they
  made GraphQL requests. The cost column counts only what the reply reported
  as `rateLimit.cost`.

### Not measured

| Kind               | Why                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `auto_merge_poll`  | Needs a pull request with auto-merge armed, which would change a real repo.               |
| `hook_maintenance` | Checking and adding webhooks writes to the repos' settings, so it was not run on purpose. |
| `user_action`      | A merge, close or branch update changes a real pull request, so none was pressed.         |
| Forgejo            | The fixture and the account are on GitHub only. Forgejo has no GraphQL.                   |

### How it was measured, and what it leaves out

1. Build the binary and start it with a throwaway database and a port of its
   own.
2. Register the owner with a passkey (the browser's virtual authenticator),
   save a GitHub token in Settings, and wait for the first refresh. That is
   the first-refresh row.
3. Press Refresh now once. That is the forced-refresh row.
4. Open one pull request and its checks, post one signed
   `pull_request` delivery to the webhook endpoint, and wait out two CI poll
   intervals.
5. Read `GET /api/stats/forge-api` after each step.

This was a few minutes of use, not an hour, and one start, not several. The
counters reset on a start, so the first-refresh row is also what a restart
costs. The 56 repos are the whole account, so another account with the same
number of repos but different pull requests and issues will differ, most of
all in the REST column.

## What you can do

- **Connect a GitHub App installation** instead of a token, or give the token
  to the dashboard alone, so nothing else spends its budget. Dependabot
  commands still use your saved token.
- **Track fewer repositories.** Each one adds to every refresh.
- **Keep the webhooks working.** A webhook delivery refreshes only the repo that
  changed, which costs far less than a full refresh. A burst of deliveries for one
  repo, which is what a push sends, is merged into one refresh that runs 2
  seconds after the last of them (never more than 5 seconds after the first).
  With working webhooks the
  full refresh is a safety net, so a longer `REFRESH_INTERVAL` is safe. See
  [Webhooks](webhooks.md).
- **Wait.** The reset time is in the banner and the header. The page recovers by
  itself, with no reload.
