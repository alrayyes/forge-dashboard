# Rate limits

A forge limits how many requests a credential can make in a window of time.
When the dashboard says a forge is rate limited, the forge has refused its
requests until a reset time. It isn't a fault in the dashboard. This page
explains why it happens, what the dashboard does meanwhile, and what you can
change.

## How the forges limit requests

**GitHub** gives each credential a request budget and reports it on every
response: the limit, what is left and when it resets. REST and GraphQL are two
separate budgets, and the header shows them on two lines, "GH REST" and "GH
GraphQL". The dashboard reads both, so a spent REST budget doesn't stop
GraphQL, and the other way round. GitHub's own pages have the actual numbers,
which differ by credential type and change over time:

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
exists, it comes from a proxy in front of the instance. A refused request
carries a `Retry-After` header, in seconds or as a date, and the dashboard takes
the reset time from it. The Why? text says so for Forgejo.

## Why a budget runs out

- **A shared credential.** A personal access token acts as your GitHub
  account, so its budget is the account's. Anything else acting as that account
  spends the same budget: your own use of `gh`, other tools, scripts, CI.
- **Many tracked repositories.** One GraphQL query returns every repository with
  its open pull requests, issues and CI status, and a bigger answer costs more.
  The dashboard logs each query's cost at the `info` log level.
- **A restart.** The dashboard keeps the answers to conditional requests in
  memory. GitHub doesn't charge a request that comes back unchanged, so the
  cache saves budget, and after a restart it starts empty and the first
  refresh pays in full.
- **Refreshing often.** Each full refresh spends budget. `REFRESH_INTERVAL` sets
  how often it runs (see [Configuration](configuration.md)).

A GitHub App installation has its own budget, separate from your tokens and
from other tools. The dashboard asks GitHub for an installation token for the
installation you connect and uses only that for the requests it makes. It is the
better choice when a token is shared. Setup is in
[GitHub App support](configuration.md#github-app-support).

Without a token the dashboard reads a username's public repositories over REST,
one request after another, and GitHub limits those requests per address instead
of per account (see [Accounts](accounts.md#credentials)). The limit is small, so
a token suits any account with more than a few repositories.

## What the dashboard shows

The server grades each budget, and the page follows the grade:

| Severity   | Meaning                    | What you see                                                |
| ---------- | -------------------------- | ----------------------------------------------------------- |
| `ok`       | At least 20% left.         | The remaining count and reset in the header.                |
| `warning`  | Under 20% left.            | The same.                                                   |
| `low`      | Under 5% left.             | The banner "Rate limit running low", with the count left.   |
| `exceeded` | Nothing left, reset ahead. | The forge goes read-only under one banner with a countdown. |

Once the reset time has passed a spent budget stops counting as exceeded, even
before the next refresh confirms it.

While a forge is read-only, the controls that need the spent budget aren't
drawn, a **Why?** under the banner explains the limit, and **What still works**
lists what you can still do. Other forges are unaffected. The controls come back
at the reset, with a toast. [Pull request actions](pull-request-actions.md)
has the details, including which actions need which budget.

The data stays visible. The dashboard keeps the last pull requests, issues and
repos it fetched, marked stale, and the header's Refreshed time says how old
they are. It also asks less:

- Under 5% left, the next scheduled refresh waits for the reset plus 30 seconds,
  and never longer than an hour.
- With the budget spent, it skips that forge's refresh and its CI check polling
  until the reset, because the request would fail and still count against the
  forge.
- "Refresh now" runs at most once every five seconds.

You can queue Update branch, `Dependabot: Rebase` and `Renovate: Rebase`
while a forge is limited. They run after the reset, when the pull request still
needs them, and Merge and Close can't be queued. See
[Pull request actions](pull-request-actions.md) for what happens to a queued action.

## What you can do

- **Connect a GitHub App installation** instead of a token, or give the token
  to the dashboard alone, so nothing else spends its budget.
- **Track fewer repositories.** Each one adds to every refresh.
- **Keep the webhooks working.** A webhook delivery refreshes only the repo that
  changed, which costs far less than a full refresh. With working webhooks the
  full refresh is a safety net, so a longer `REFRESH_INTERVAL` is safe. See
  [Webhooks](webhooks.md).
- **Wait.** The reset time is in the banner and the header. The page recovers by
  itself, with no reload.
