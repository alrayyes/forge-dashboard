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
- **A restart.** The dashboard remembers the answers to its REST reads, together
  with the ETag the forge sent, and asks again with `If-None-Match`. GitHub
  documents that a request that comes back unchanged (`304 Not Modified`)
  doesn't count against the limit; this hasn't been verified here (see
  [Conditional requests](#conditional-requests)). The answers are kept in the
  database too, so after a restart the first refresh still sends the saved
  ETags, and an unchanged read is answered `304` again. The GraphQL
  query isn't cached, so a restart still pays for one of those. The last
  snapshot, the webhook checks and the time each webhook delivery last arrived
  are kept as well. Until the first refresh succeeds the page shows the saved
  snapshot marked stale.
- **Refreshing often.** Each full refresh spends budget. `REFRESH_INTERVAL` sets
  how often it runs (see [Configuration](configuration.md)). While every tracked
  repo has a healthy webhook the wait is four times that, up to 2 hours, so 80
  minutes at the default of 20. It is `REFRESH_INTERVAL` again when no webhook
  path is configured, no repos are tracked yet, a repo has no hook or its hook
  check failed, or you can't manage hooks on a repo (such an account keeps the
  shorter wait). It is also `REFRESH_INTERVAL` when a forge's last fetch failed
  or it has not reported, or a repo could not be fully fetched. A repo that has
  failed to fetch for three times `REFRESH_INTERVAL` of clock time, counted from
  its first failed fetch, counts as failing for good and stops holding the short
  wait, so one broken repo (issues disabled, an empty repo, a token without the
  scope) doesn't cost every other repo the saving. A webhook-driven refresh that
  fetches a stale repo clears the mark, which also ends its hold, unless its
  default branch read failed, since that row is still the old one; the CI poll
  fetches no issues and leaves it. The count belongs to the full refresh, so a
  webhook refresh doesn't restart it: only a full refresh that fetches the repo
  does. A restart forgets how long a repo has been failing, so the count starts
  again. One forge being down keeps the shorter
  wait for all of them, even a forge whose repos are all covered, until it
  answers again. The same goes for the saved snapshot a restart starts from,
  until a refresh has reached the forge.
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

## A reserve for your own actions

On GitHub the dashboard keeps part of each budget for you. Background work
(the scheduled full refresh, the CI and auto-merge polls, and webhook
maintenance) stops once a call would leave the REST or the GraphQL budget at or
under the reserve: 10% of the budget, never less than 50 points and never more
than half of it. A 5000 point budget keeps 500. A low budget of either kind
holds all of that background work, even work that only uses the other. For a
full refresh, "a call" means what the last one spent, counted from its own
requests, not from how far the budget fell since the one before (your own
actions and the polls drain it too). A failed refresh, or one
that reports no GraphQL cost, leaves the figure alone. A refresh that couldn't
read some repos still counts for the ones it read, so a repo that never reads
doesn't switch the hold off. The figure is the dearest of the last three
refreshes, so one that the cache answered for nothing doesn't lower it. A
background full refresh waits when one costing that much would take the budget
under the reserve. It waits for the reset, and the board keeps its last data,
marked stale, in the meantime.

Your own actions are never held back by it: Merge, Update branch, the bot
rebases, Close, Enable auto-merge, queued actions, Refresh now, and the refresh
that opening the board after an idle spell starts. They stop only when the
budget is spent, as described above. A refresh that a webhook delivery asks for
is cheap and is how the board stays current, so it also runs inside the reserve
and waits only when the budget is spent.

Forgejo reports no budget, so it has no reserve and is never held back. The
reserve is fixed, not a setting. If background work is using too much, raise
`REFRESH_INTERVAL` or set up webhooks rather than looking for a knob here.

## How the CI poll spends the budget

The CI poll covers the open pull requests whose checks are still running and the
ones with GitHub's auto-merge armed. It asks less than it used to in three ways.

- **One query for all of them.** On GitHub the poll reads every due pull request,
  across every repo, in one aliased GraphQL query, 25 pull requests to a query.
  It used to send one query per repo. The reply for a pull request that has since
  merged or closed takes it off the board, and a repo GitHub can't answer for (a
  deleted one, or an installation that lost access) is read on its own while the
  rest of the query still counts. If a query fails part way (only the later
  chunks of a large batch), the answers already received are kept, and the pull
  requests it did not answer are read through their repos, as they are when the
  whole query fails. Forgejo has no GraphQL and keeps one scoped refresh per
  repo.
- **Longer gaps while nothing changes.** A pull request that reads the same after
  a poll waits twice as long before the next one: `CI_POLL_INTERVAL`, then double,
  up to 15 minutes. Any change in its checks, merge state or auto-merge setting
  puts it back at `CI_POLL_INTERVAL`. If you set `CI_POLL_INTERVAL` above 15
  minutes, that wins, so the poll is never faster than you asked. Only a poll
  that read the pull request counts: a refresh that failed leaves the gap alone
  and the next tick tries again. A read that joined a webhook refresh already in
  flight counts, because the refresh it waited for began after the poll did. A
  pull request whose
  lookup keeps failing (a deleted or transferred one) is read through its repo,
  and backs off like any other that reads the same. A pull request with GitHub's
  auto-merge armed never backs off, because GitHub merges it without telling us
  and the board should notice within one interval.
- **No poll while the webhook is working.** A pull request is left out of the poll
  when its repo's webhook is confirmed to deliver check events (`check_run` or
  `check_suite`) and a delivery for that pull request's own head commit arrived
  within three poll intervals. A delivery for another pull request, or for
  another commit, doesn't count, so one busy pull request can't hide a quiet
  one. The delivery has to carry a valid signature, and its body has to name the
  commit (`check_run.head_sha`, `check_suite.head_sha` or a status event's
  `sha`). A check header on some other body counts as nothing. Once deliveries go
  quiet for longer than that, polling starts again by itself. This applies only
  to pull requests waiting on a check, never to an armed auto-merge, because the
  merge itself isn't a check delivery. Forgejo is never skipped: its webhook
  can't subscribe to the event CI status rides on.
- **What a replay can still do.** The event type travels in an unsigned header,
  but the body is signed, so a forged delivery is rejected. Someone who captured
  a genuine signed check delivery for a pull request's current head commit could
  replay it and keep that pull request out of the poll. That is capped: a
  delivery holds a pull request off for at most 15 minutes (or
  `CI_POLL_INTERVAL` if that is longer) before one poll reads it, and the hold
  then starts over. The hold-off clock starts when the pull request is first
  due and held, not at its last read, so the gap between two reads is the
  back-off gap plus the hold-off: about 30 minutes at the 15-minute cap. The
  cost is a check colour up to that much late, never a missed merge.

For a rough sense of the saving, take 30 pull requests with a running check, on
12 repos, polled every minute, where nothing changes for ten minutes and there is
no working check webhook. Before, that was 12 queries a minute for 10 minutes,
12 × 10 = 120. Now each poll is 2 queries (30 pull requests in chunks of 25), and
the gaps double from one minute, so the polls fall at minutes 0, 1, 3 and 7:
4 polls × 2 queries = 8. The
behind-or-not lookup some pull requests need is one more request per query, where
it used to be one per repo. With a working check webhook the figure is 0. These
are counts worked out from how the poll is scheduled and checked by tests, not a
fresh measurement against GitHub; the baseline table below is the measured
reference.

You can queue Update branch, `Dependabot: Rebase` and `Renovate: Rebase`
while a forge is limited. They run after the reset, when the pull request still
needs them, and Merge and Close can't be queued. See
[Pull request actions](pull-request-actions.md) for what happens to a queued
action.

## Conditional requests

Every REST read the dashboard sends to GitHub goes through one cache. The first
answer is kept with its `ETag`. The next request for the same URL sends it back
as `If-None-Match`, and if nothing changed GitHub answers `304 Not Modified`.
The dashboard counts it under `notModified` and serves the kept body, so the
rest of the code never sees the difference. GitHub documents that such a reply
doesn't count against the REST limit, in its
[REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate).
We haven't verified that: our measurements read only the dashboard's own
counters, not GitHub's remaining budget
([details](#a-repeated-webhook-check)). The same page says a `304` is only
free when the request is authorized, so the public-repository mode, which sends
no credential, may still be charged.

The cache is keyed by forge, credential label, URL and `Accept` header, never
by user. GitHub folds the credential into the ETag, so one credential's ETag is
never offered under another. Two clients holding the same credential share
entries, and a replaced token starts empty. A page size, page number or filter
is part of the URL, so a different one is a different entry.

The cache lives in memory and in the database, and both are bounded. A body over
a megabyte is never kept, so that read costs a full response each time. The
cache reads no more than that megabyte ahead to find out, and the caller still
gets the whole body. In memory the cache holds at most 5000 answers and 32
megabytes, and past either limit it drops the least recently used answer first.
The database copy holds at most 20 megabytes and drops the oldest answer first.
A request that misses in memory reads the database before it goes out, so a
restart doesn't lose the ETags. The database copy is keyed the same way as the
memory one, with no user in it.

Forgejo, as probed, doesn't take part. The Forgejo instance we tested
(16.0.6, built on Gitea 1.22) sends no `ETag` and no `Last-Modified` header on
its JSON endpoints (pull requests, issues, commit statuses, Actions runs,
repositories, search), and it answers a request with `If-None-Match` or
`If-Modified-Since` with a full `200`. We haven't tested other versions.
Forgejo reports no request budget of its own to spend, so each read costs a
round trip and nothing more. Check again when you upgrade Forgejo; if it starts
sending ETags, add a cache for it the way GitHub's works. Until then the
default-branch pill keeps a finished run's job list in memory (a finished run
never changes) and reads the jobs of runs still going on each poll. A run that
finished with no jobs is read again for five minutes, in case the forge is still
catching up, then kept empty too.

Each row below is one source file with its number of REST `GET` call sites. A
test reads this table and fails when a file's count differs from the source, so
a new read can't skip the question of whether it can be conditional.

| File                                       | Calls | Reads                                                                                                                                                               | Conditional                       |
| ------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `internal/github/client.go`                | 22    | Hooks, repository, pull requests, files, issues, commits, check runs, statuses, runs, branch protection and rules, jobs, and installation and user repository lists | Yes, all but the job log download |
| `internal/github/dependabot_ack.go`        | 2     | Comments and comment reactions                                                                                                                                      | Yes                               |
| `internal/github/job_log.go`               | 2     | One job's log, then its download                                                                                                                                    | No, a log is never cached         |
| `internal/github/pull_request_body.go`     | 1     | One pull request                                                                                                                                                    | Yes                               |
| `internal/github/required_checks.go`       | 3     | Workflow runs, check runs, statuses                                                                                                                                 | Yes                               |
| `internal/github/rerun.go`                 | 4     | One pull request, commits, check runs, one job                                                                                                                      | Yes                               |
| `internal/forgejo/advisories.go`           | 3     | The repository's file tree, one call per 1000 files up to five, a slashed default branch's commit, and each lock file (at most 20)                                  | No, Forgejo sends no ETag         |
| `internal/forgejo/client.go`               | 16    | Hooks, repositories, pull requests, issues, labels, reviews, statuses, Actions runs and jobs, protection                                                            | No, Forgejo sends no ETag         |
| `internal/forgejo/issue_details.go`        | 1     | One issue                                                                                                                                                           | No, Forgejo sends no ETag         |
| `internal/forgejo/job_log.go`              | 1     | One job's log                                                                                                                                                       | No, Forgejo sends no ETag         |
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

| Count         | What it counts                                                                           |
| ------------- | ---------------------------------------------------------------------------------------- |
| `rest`        | REST requests, each charged against the REST budget.                                     |
| `graphql`     | GraphQL requests made.                                                                   |
| `graphqlCost` | The points the GraphQL requests were charged (`rateLimit.cost`).                         |
| `notModified` | Requests answered `304 Not Modified`. GitHub documents these as free; not verified here. |

The kind says why the request was made:

| Kind               | Cause                                                                                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full`             | A refresh of the whole account.                                                                                                                                                                                                                                |
| `scoped_webhook`   | A refresh of one repo after a webhook delivery.                                                                                                                                                                                                                |
| `ci_poll`          | A poll of pull requests with a check still running.                                                                                                                                                                                                            |
| `auto_merge_poll`  | A poll of pull requests with an armed auto-merge, none of them waiting on a check.                                                                                                                                                                             |
| `details`          | A pull request, issue or check list you opened.                                                                                                                                                                                                                |
| `hook_maintenance` | Checking, adding or upgrading webhooks.                                                                                                                                                                                                                        |
| `advisories`       | Reading a repo's open Dependabot alerts, or on Forgejo its file tree and lock files, at most every 15 minutes per repo. A failed read, or a first refusal, is tried again after 5. Opening a repo's advisories dialog reads its alerts in full, once per open. |
| `user_action`      | A button you pressed, a queued action, or auto-merge and auto-update acting for you.                                                                                                                                                                           |
| `unknown`          | A request nobody tagged. That is a bug in the dashboard; please report it.                                                                                                                                                                                     |

A few things to know when you read the numbers:

- The counts start at zero on every start. `since` says when counting began, so
  compare two readings taken some time apart, not one reading to a budget.
- A request that names no repo, such as listing an account's repos, has an empty
  `repo`. A GitHub full refresh is one query for every repo, so it shows under
  the empty repo too.
- Rows are matched to the credentials you saved. A GitHub App installation id
  is a number you type in, so if you save another account's installation id you
  see that installation's counts. Tokens can't be matched this way without
  knowing them.
- The credential is a label, `app:<installation id>`, `token:<short hash>` or
  `public:<username>`. It holds no secret. Two accounts that connect the same
  token share a row, because they share a budget.
- Forgejo has no GraphQL, so its `graphql` and `graphqlCost` stay zero.
- `graphqlCost` is what each reply reports in `rateLimit { cost }`, and every
  GraphQL read the dashboard sends asks for it: the full refresh, the CI and
  auto-merge polls, a webhook's refresh of one repo and of its default branch,
  the check of whether a pull request is behind, and the pull request, issue,
  and release details.
  A kind that shows `0` with a non-zero `graphql` count was answered without a
  cost, so check that before trusting it.
- Two things are not measured. The GraphQL mutations (enabling or disabling
  auto-merge) have no `rateLimit` field to ask for, and GitHub's response
  headers carry no cost for GraphQL, only the remaining budget. They count in
  `graphql` with a cost of `0`, and their real cost is not in the figures.
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

| Kind               | Why                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto_merge_poll`  | Needs a pull request with auto-merge armed, which would change a real repo.                                                                                                                                                                                     |
| `hook_maintenance` | Adding and upgrading webhooks writes to the repos' settings, so it was not run on purpose. Checking them is read-only. Only a repeat check of 3 repos was counted, [outside a running server](#a-repeated-webhook-check), and what GitHub charged was not read. |
| `user_action`      | A merge, close or branch update changes a real pull request, so none was pressed.                                                                                                                                                                               |
| Forgejo            | The fixture and the account are on GitHub only. Forgejo has no GraphQL.                                                                                                                                                                                         |

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

## A full refresh that fetches only what changed

A scheduled refresh no longer re-reads every repo. When a webhook is
configured, it first asks GitHub one cheap question per 100 repos: when each
repo was last pushed to or edited, how many open pull requests and issues it
has, and when the newest-touched one last changed. A repo whose answer matches
the last refresh, and whose webhook is confirmed healthy, is skipped: its pull
requests, issues and main-branch row stay as they were, and only the repos that
changed are fetched in full.

What the answer can and can't see, found by reading a real repo:

| Change                      | Moves repo `pushedAt` / `updatedAt`  | Moves a signal the probe reads        |
| --------------------------- | ------------------------------------ | ------------------------------------- |
| A push or a merge           | Yes                                  | Yes                                   |
| A comment on a pull request | No                                   | Yes (that pull request's `updatedAt`) |
| A finished check run        | No                                   | No                                    |
| A label or a review         | Not isolated, so treated as not seen | Moves that pull request's `updatedAt` |

GitHub's reference for the repository, pull request and issue objects doesn't
say what moves a repo's `updatedAt`, so the table is what was observed, not a
promise. Because a finished check is invisible to the probe, a repo is only
skipped while its webhook is confirmed: that webhook delivers check events and
refreshes the repo on its own. A repo with no confirmed webhook always counts
as changed.

Always a full pass:

- the first refresh after a start, because the remembered answers live in
  memory only;
- every sixth refresh, as a safety net for a change the probe can't see;
- a refresh you ask for with Refresh now, and any refresh while you have one
  pending;
- a refresh where the probe itself failed.

The webhook check still runs for a skipped repo, as the same conditional
request it always was, so a repo that loses its webhook is noticed and fetched
next time. The issues "changed since" marker advances per repo, only for repos
actually fetched, so a skipped repo's issues are never missed.

Cost, with a personal token. The probe measured 2 GraphQL points per page of
100 repos (112 repos on the measured account, 2 pages, so about 4 points and 2
requests). A refresh where nothing changed is that, plus the webhook checks.
Before this change the same account's full refresh was the 5 requests and 606
points of the [baseline](#baseline-what-each-kind-of-refresh-costs-today). A
refresh where a few repos changed adds one batched query per 20 changed repos.
The "after" figure for the probe is one measured query; the rest follows from
the call counts the tests pin (no per-repo query for an unchanged account),
not from a second full measurement.

## A repeated webhook check

Measured on 2026-10-21 against GitHub with a personal access token, as a
throwaway Go test against `github.com` rather than a running server. The test
wasn't kept, so the steps and versions follow. One
client, with an empty in-memory cache and no database, checked whether a
webhook exists on 3 repos of the same account (`forge-dashboard`,
`forge-dashboard-e2e-fixture` and `dotfiles`) and then did the same again
straight away, with nothing changed in between. The counters were read from
`apistats`, the same ones `GET /api/stats/forge-api` serves, and the REST API
version was whatever the client library sends by default.

To repeat it, with versions as of that run:

1. Use the `go-github` client at v75.0.0, which sends the REST API version
   `2022-11-28` (`X-GitHub-Api-Version`).
2. Wrap its transport in the dashboard's ETag cache (`internal/github`) with an
   empty in-memory store, and count requests with `internal/apistats`.
3. Check for a webhook on each of 3 repos, read the counters, then check the
   same 3 again at once, and read the counters again.
4. To see what GitHub charges, also read `GET /rate_limit` before and after
   each pass. GitHub documents that call as not counting against the limit.
   We didn't do this.

| Pass   | REST | Not modified |
| ------ | ---: | -----------: |
| First  |    3 |            0 |
| Second |    0 |            3 |

The second pass went to the network: the client kept the first answers' ETags in
memory, sent them back as `If-None-Match`, and counted three `304` replies. It
wasn't served from saved hook-check state. Only the dashboard's own counters
were read, not GitHub's remaining budget, so this shows three requests answered
`304` instead of `200`, not what GitHub charged for them. The installation
repository list of a GitHub App is covered by a unit test against a stubbed
server and was not measured live.

## What you can do

- **Connect a GitHub App installation** instead of a token, or give the token
  to the dashboard alone, so nothing else spends its budget. Dependabot
  commands still use your saved token.
- **Track fewer repositories.** Each one adds to every refresh.
- **Keep the webhooks working.** A webhook delivery refreshes only the repo that
  changed, which costs far less than a full refresh. A burst of deliveries for one
  repo, which is what a push sends, is merged into one refresh that runs 2
  seconds after the last of them (never more than 5 seconds after the first).
  With working webhooks the full refresh is a safety net, and it runs four
  times less often on its own (80 minutes at the default) while every repo has
  a healthy webhook and every forge's last fetch worked. A repo the forge could
  not fully fetch keeps the shorter wait too. See [Webhooks](webhooks.md).
- **Wait.** The reset time is in the banner and the header. The page recovers by
  itself, with no reload.
