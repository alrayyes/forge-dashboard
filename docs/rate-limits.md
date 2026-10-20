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
- **A restart.** The dashboard keeps the answers to some REST requests (such as
  the webhook checks and the public-repository mode) in memory, and GitHub
  doesn't charge a request that comes back unchanged. After a restart that
  cache is empty, so those requests are paid in full once. The GraphQL query
  isn't cached.
- **Refreshing often.** Each full refresh spends budget. `REFRESH_INTERVAL` sets
  how often it runs (see [Configuration](configuration.md)).
- **An unwatched dashboard.** While nobody is using the dashboard, the scheduled
  refresh rests. After `IDLE_AFTER` (15 minutes by default) with no signed-in
  request and no open live stream, the schedule skips its turn and tries again
  on the next one. The first request after that refreshes once, so you are not
  shown data from before you left. A tab left open counts as use, because the
  server can't tell a tab you're looking at from one nobody is: close every tab
  and the refresh rests. Webhooks, Refresh now and the CI poll still run while
  it rests.

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

## What you can do

- **Connect a GitHub App installation** instead of a token, or give the token
  to the dashboard alone, so nothing else spends its budget. Dependabot
  commands still use your saved token.
- **Track fewer repositories.** Each one adds to every refresh.
- **Keep the webhooks working.** A webhook delivery refreshes only the repo that
  changed, which costs far less than a full refresh. With working webhooks the
  full refresh is a safety net, so a longer `REFRESH_INTERVAL` is safe. See
  [Webhooks](webhooks.md).
- **Wait.** The reset time is in the banner and the header. The page recovers by
  itself, with no reload.
