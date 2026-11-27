# Webhooks

The dashboard registers and repairs its own webhook on every repo your token can
administer, and only the dashboard does (see
[What the dashboard checks on its own](#what-the-dashboard-checks-on-its-own)).
There is no URL or secret to copy into a forge. A hook made by hand would
carry a secret the dashboard didn't write, and it would be rewritten or
duplicated, so don't add one.
Without one, the dashboard still refreshes on its own schedule
(`REFRESH_INTERVAL`, 20 minutes by default, longer while every repo has a
healthy webhook, every forge's last fetch worked and every repo was fully
fetched) and the browser tab polls it every 30 seconds — a webhook just closes
that gap, so a new pull request, a closed issue, or a CI status change on a repo
you're tracking shows up within seconds instead of at the next poll. Nothing
about this is required for the dashboard to work; without a webhook everything
still functions on the poll.

Which repos have a confirmed webhook isn't a page of its own. A repo without
one says so where you already work: Branches marks it with a "Polling only"
chip, and Settings, Repositories gives its row the reason and the fix (see
[Polling only](#polling-only)). The dashboard checks the forge's own webhook
list directly, so a repo with one already pointed at this dashboard counts as
confirmed immediately, not once something happens to trigger it. That live check
can fail (rate limiting, an unreachable forge, a token missing the webhook-list
scope; Settings' own field hints say what that is per forge), in which case it
falls back to whether this app has ever received a signature-verified delivery
for that repo. For why a forge refuses requests, see
[Rate limits](rate-limits.md).

The old Webhooks page (`/webhooks.html`) is gone. Its address, and `/webhooks`,
send you to Settings, Repositories. The per-repo controls (Auto-update,
bot-rebase and Ignore) live in that group, described under
[Pull request actions](pull-request-actions.md). Settings has no Webhooks card,
and old `#webhooks` and `#webhook-howto` links open Integrations and security.

## When the dashboard can't create a hook

The dashboard creates and repairs hooks itself (see
[What the dashboard checks on its own](#what-the-dashboard-checks-on-its-own)).
It creates one via the forge's own API, pointed at this dashboard's URL and
secret, subscribed to every event the table below recommends. If a
forge-dashboard webhook already exists there but is turned off, has a different
secret or is missing an event, it is fixed in place rather than duplicated. A
repo the forge refused, or one the dashboard is waiting out a retry on, is
tried again on its own, with nothing to press: a refusal after an hour, a
rate-limited or unreachable forge on a later refresh.

This needs a broader token scope than just reading your repos. GitHub's
fine-grained tokens need the Webhooks permission set to **Read and write**, and
Forgejo's `write:repository` (already required just to check coverage, since
Forgejo's webhook API has no separate read-only scope). See Settings' own field
hints for the exact scope per forge. A repo the token
can't administer stays on polling, and its row in Settings, Repositories says
which scope is missing.

A GitHub App connection has no role on a repo, so it needs the App's
**Repository permissions → Webhooks** set to **Read and write** (not the
organization-level Webhooks permission). Listing only proves read access: an App
with read-only Webhooks lists fine, and the create is refused with a message
naming the permission. After you change an installed App's permissions, accept
the change on the installation's page, or GitHub keeps the old ones.

A repo is skipped with the missing permission named only when GitHub refuses the
listing outright ("Resource not accessible by integration", or the repo isn't in
the installation). A server error, a rate limit, or a bad credential says
nothing about the permission, so it leaves the repo as it was.

On Forgejo the dashboard needs admin on the repo. It reads that from the
`permissions` object Forgejo sends with each repo. Forgejo and Gitea set it on
every repo, so a missing one is rare; when it happens the reason says Forgejo
didn't report your access, instead of telling you to ask an owner, because
nothing says you aren't an admin.

With no Forgejo token saved, the dashboard lists your public repos by username
and Forgejo answers as an anonymous caller, so it reports no admin rights on any
of them. Those repos say a saved token is needed and link to Settings. Once a
token is saved, a repo that says it needs admin access means the account isn't
an admin on that repo, or the saved token lacks admin scope.

A GitHub fine-grained token also gates _which_ repos it can see at all,
separately from the preceding permissions — set at token creation, either
"All repositories" or an explicit list. A repo left out of that list fails
with "Resource not accessible by personal access token" even with every
permission granted correctly, which reads like a scope problem but isn't
one. This is easy to hit for a repo created after the token, or a token
deliberately scoped to a subset of repos.

**A webhook is only as complete as the events it subscribes to.** The
dashboard subscribes to every event below. A hook missing one leaves part of
the dashboard on the slower, polling-only path while the rest updates
live, and the dashboard edits it back. The one people miss is CI: a pull
request's status colour is driven
by a _different_ event than the one that shows the pull request existing
at all, so it's easy to end up with a webhook that reacts to a new pull
request or a comment but never to that pull request's checks finishing.

| Live update you want                                                                            | GitHub events                                      | Forgejo events                                                                          |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A pull request opening, closing, or its labels/reviewers changing                               | Pull requests                                      | Pull Request                                                                            |
| An issue opening or closing                                                                     | Issues                                             | Issue                                                                                   |
| A comment on an issue or a pull request, which also moves "Last activity"                       | Issue comments                                     | Issue Comment, Pull Request Comment                                                     |
| A review on a pull request, or a comment on its diff                                            | Pull request reviews, Pull request review comments | Pull Request Review Approved, Pull Request Review Rejected, Pull Request Review Comment |
| A review thread being resolved or unresolved (GitHub only)                                      | Pull request review threads                        | not tracked                                                                             |
| **CI/build status** — Actions, a third-party check, or a classic commit status, on either forge | Statuses, Check runs                               | Status                                                                                  |
| A commit landing outside an open pull request                                                   | not tracked                                        | Push                                                                                    |
| An Actions run finishing, including a rerun, so a branch's pill leaves the old result           | covered earlier                                    | Action Run Failure, Action Run Success                                                  |

GitHub splits CI into two separate events because it has two separate
CI mechanisms with two separate APIs — **Statuses** is the older
commit-status API (what most third-party CI still posts to), **Check
runs** is GitHub Actions and any GitHub App-based check. Without either
one, a pull request whose only checks come from the other mechanism won't
update its CI colour until the next poll — everything else
about that pull request still updates live. Forgejo doesn't have this
split: its own Actions runs post to the same combined commit-status
endpoint external CI does, so **Status** covers both. A rerun is the
exception. It posts nothing until a job ends, so **Action Run Failure**
and **Action Run Success** are what refresh a branch's pill when a run
finishes. Forgejo sends them on the final state only, so the pill can
show the old result until then. A Forgejo that drops these names falls
back to the next poll. A pull request has no such delivery until its
rerun ends, so the CI poll looks for one itself (see
[Rate limits](rate-limits.md#how-the-ci-poll-spends-the-budget)).

Forgejo's **Push** doesn't feed anything the dashboard displays on its
own — there's no commit feed here — but it's cheap to include: a push to
a pull request's head branch is normally caught by the preceding
pull-request events already, and Push is a harmless second trigger for
the same refresh in case that doesn't fire.

## A repo the dashboard can't fetch

A repo whose fetch failed gets a "Failing since" badge under its name in
Settings, Repositories, with the time its fetch first failed. Its pull requests
and issues are then the last ones the dashboard could read. Once a repo has
failed past the cutoff described under [Rate limits](rate-limits.md), the badge
reads "Still failing since" and the note says retrying hasn't helped. The page
learns that at the next refresh, so a repo crossing the cutoff keeps the
shorter wording until then. The badge goes when a fetch succeeds, and the time
starts again after a restart.

## Why a repo has no webhook

A repo without a hook says why on its row in Settings, Repositories, in one
line, with the longer text on hover or keyboard focus. The reason comes from the
server as `webhookReason`, and the page words it:

- `no_permission`: the token can't administer hooks on that repo. The row's
  own note says which token scope or role to change, so there's no second line.
- `forge_unavailable`: the forge was rate limited or unreachable on the last
  attempt. The row says the dashboard tries again, and it does, on its own.
- `forge_refused`: the forge answered the create with a refusal. The row shows
  when the next attempt is (the one-hour retry wait). The longer text says
  what the forge said, in its own words, only when the forge gave a plain
  sentence. When it gave none, the text says the forge refused and gave no
  reason, in the dashboard's voice.

The longer text opens over the rows below instead of between them, so the list
doesn't move. The Escape key hides it, and it comes back when you move off the
note and return.

A reason goes away as soon as the hook exists, when the repo leaves the list,
and while the public address below can't receive hooks, since no attempt is
made then. The page reads a reason that appeared after a pass on its next read
of the dashboard, not the moment the pass ends.

A public address that can't receive hooks (localhost, a private network
address, or plain HTTP on a public name) is the same problem for every repo, so
each repo without a hook says the forge can't reach this dashboard. Fix
`RP_ORIGIN` and the next refresh creates them.

## Polling only

A repo with no confirmed webhook still updates, but on a schedule (see
`REFRESH_INTERVAL` in [Configuration](configuration.md)) instead of the moment
something happens. Settings, Repositories and Branches say so with an amber
notice, "N repos refresh on a schedule instead of instantly", and a "Show only
these" button that narrows the list to those repos. The notice is not drawn when
every tracked repo has a hook.

Each such row in Repositories says why, and links to the fix:

- Your token can't manage webhooks on that repo: "Fix in Connections" opens
  Settings, Connections.
- The public address can't receive hooks (see `RP_ORIGIN`): the forge can't
  reach this dashboard, so fix the address first.
- The forge didn't answer or refused the last attempt: the line says when the
  next attempt is.

On Branches the repo carries a "Polling only" chip, and "See why in Settings"
opens Repositories.

## How a delivery is verified

Every delivery's signature is checked against the dashboard's secret before
anything acts on it — an unsigned or wrongly signed request is refused
outright, not just ignored. GitHub signs with `X-Hub-Signature-256`;
Forgejo signs with `X-Forgejo-Signature` (or `X-Gitea-Signature` on an
instance whose webhook was set up with the legacy "Gitea" type) — both
are an HMAC-SHA256 of the raw request body, keyed with the dashboard's secret. Once
verified, the payload's `repository` field is read to refresh just that
one repo instead of everything you track — a delivery whose payload
doesn't carry one (the initial "ping", most concretely) falls back to a
full refresh instead, so every event type still results in _something_
refreshing either way.

A single push sends several deliveries within a moment: the push itself, the
pull request update, and a check suite for each CI system. Refreshing the repo
once per delivery would fetch the same data several times over, so the
dashboard waits for the repo's deliveries to go quiet and refreshes once. The
refresh runs 2 seconds after the latest delivery. A repo that never goes quiet,
a busy CI for example, is still refreshed 5 seconds after its first delivery,
so a burst waits at most 5 seconds and a lone delivery waits 2. A repo is also
refreshed at most once every 30 seconds by default, the browser tab's own poll
period: a delivery inside that interval waits for it to pass, and the one
refresh then reads everything that arrived meanwhile. A push's check runs send
deliveries over tens of seconds, and refreshing for each would multiply the
load on a forge that may already be struggling. After a rerun, a check change
can therefore show up to 30 seconds late. Set `WEBHOOK_MIN_INTERVAL` (a Go
duration such as `10s`; see [Configuration](configuration.md)) to change that
interval. `WEBHOOK_MIN_INTERVAL=0s` turns it off, so only the 2-second quiet
window and the 5-second cap apply, at the price of a refresh per burst of
deliveries. Two repos are held back independently of
each other. Only deliveries wait: the periodic
refresh, the CI-status poll, the refresh button and anything you do on a pull
request run at once. A delivery that arrives while a refresh of the same repo
is running is not lost; it causes exactly one more refresh when the running one
finishes. A delivery with no repository (the "ping") falls back to a full
refresh straight away. If the dashboard shuts down during the wait, or your account's
connection is replaced (you save new credentials) or removed, the pending
refresh is dropped, and the next scheduled refresh picks the change up.

On GitHub a delivery's refresh also waits while the budget is at its
[reserve](rate-limits.md#a-reserve-for-your-own-actions), until 30 seconds
after the reset. The deliveries that arrive meanwhile still cost one refresh per
repository.

A `pull_request` delivery whose action is `closed` also takes that pull
request off the board before the refresh runs (merged or not). GitHub can go
on listing a pull request it just merged as open for a few seconds, and a
refresh that fails lists nothing, so the delivery itself is trusted. The
pull request stays off until a refresh stops listing it or two minutes
pass, and a `reopened` delivery puts it back at once.

## What the dashboard checks on its own

Each refresh also asks GitHub whether every repo's webhook is pointed at the
dashboard. A GitHub App without the repository webhooks permission gets
"Resource not accessible by integration" for all of them, so that answer is
remembered for an hour and the checks are skipped, with one warning in the log.
A token that can't administer one repo is skipped for that repo alone. Grant
the permission, accept it on the installation, and the next check after the
hour sees it. Rows stay locked until then, up to an hour; restarting the
dashboard clears it at once.

The dashboard writes webhooks on its own, so it needs a token that can: GitHub's
Webhooks permission set to **Read and write**, and on Forgejo `write:repository`
with admin on the repo.

- **A repo with no hook** that the token can administer gets one after the next
  refresh, pointed at this dashboard with the current event list. A hook of
  this dashboard's that already exists is edited, never duplicated.
- **A hook that is switched off or lacks an event** the dashboard now subscribes
  to is edited in place on the first refresh after it is found. The dashboard
  lists each hooked repo's hooks for this at most once an hour, so a hook
  switched off later is switched back on within the hour, with no restart. It
  can't read a hook's secret back from the forge, so it can't tell a stale
  secret from a current one by looking.
- **A changed secret** is handled by remembering. The dashboard keeps a
  fingerprint (a hash, never the secret) of the secret it last wrote to every
  hook. When the secret in use differs, the pass rewrites the secret on each of
  this dashboard's hooks and never creates a second hook. On GitHub that is
  one edit per repo, because the dashboard reuses the hook it saw on its last
  check, and one listing first only when it has no recent sighting or the
  remembered hook is gone. On Forgejo it is one listing and one edit per repo.
  Once every repo has an answer the new fingerprint is stored, so a refresh
  after that makes no extra write. A forge that is rate limited or unreachable
  is asked again on a later refresh, and the fingerprint waits for it. A repo
  the forge refuses, or answers with an authorization error, is logged and
  tried again later. Which repos are done is kept in memory,
  so a restart in the middle of a rotation edits them again, which is safe.
- **A secret changed before this existed isn't detected.** The first start
  after this was introduced records the secret in use as the baseline and
  rewrites nothing, since there is nothing to compare against. A hook whose
  secret was replaced earlier still holds the old one until the secret
  changes again, which rewrites every hook the dashboard made.
- **A repo the token can't administer**, a forge that is unreachable or out of
  REST budget, and a repo the forge refuses are skipped without failing the
  refresh. The dashboard asks a refused repo again after an hour, with no
  restart, and a forge that is down on the next refresh.
- **A public address a forge can't reach** (`RP_ORIGIN` on localhost, a private
  address or plain HTTP) gets no hook created, because it would never fire. The
  log says why the first time a repo needed a hook, and again only if the
  reason changes.

Requests run at most four at a time, each after a short random pause, and are
logged under the hook-maintenance kind. A locked or skipped repo is
tried again on a later refresh.

## Troubleshooting

- **Everything about a pull request updates live except its CI colour**:
  the hook is working, it's just missing the CI-specific event — see
  the preceding table. The dashboard adds a missing event on its next hook
  check (see "What the dashboard checks on its own"), so wait for a refresh
  rather than editing the hook on the forge.
- **A Forgejo webhook's `status` event won't stick**: confirmed live against
  two separate real instances
  (`16.0.4+gitea-1.22.0` among them) — both the settings form's own
  `POST`/`PATCH` and a direct API call can report success while the
  hook's persisted event list simply never includes `status`, with
  nothing in the response to say why. This looks like a bug in how
  those instances accept or persist that specific event name, not
  something forge-dashboard's own webhook-creation code is doing
  wrong — worth reporting against your Forgejo instance if you hit it,
  but there's nothing to configure differently here that fixes it.
  `CI_POLL_INTERVAL` ([Configuration](configuration.md)) is the actual
  fix: forge-dashboard re-checks CI directly, on its own short
  interval, for exactly the open pull requests whose CI is still
  pending — scoped to just those, not every tracked repo, and on GitHub
  skipped for a pull request while signed check events naming its head
  commit arrive — so a broken
  `status` event costs at most that interval's own staleness instead of
  the full `REFRESH_INTERVAL`.
- **The forge shows the delivery failing, or your dashboard never
  updates from it**: the hook's secret doesn't match the dashboard's. A
  mismatched secret is indistinguishable from an attacker's forged request
  from this endpoint's point of view, so both are refused the same way. Look
  for `webhook signature invalid` in the log. The dashboard rewrites the
  secret on its own hooks when its secret changes, and a hook it didn't make
  can't be repaired, so delete that one on the forge and let the dashboard
  create its own.
- **A delivery arrives but the dashboard doesn't seem to reflect it**:
  every delivery is logged, each line naming the forge, the event type,
  and the delivery ID — `webhook accepted`, `webhook signature invalid`,
  or `webhook token unknown`, followed by `webhook refresh dispatched`
  once the triggered refresh is queued, which is before it runs (see "How a
  delivery is verified" for how long it can wait). No `LOG_LEVEL` change is
  needed to see them; each logs at its natural level (`INFO` for a
  normal delivery, `WARN` for a rejected one) regardless of what
  `LOG_LEVEL` is set to. A refresh that fails logs `scoped refresh failed`
  with the repo, the delivery ID and, for a pull request event, the pull
  request number.
- **You want to rotate the secret**: there's no button for it. The secret is
  generated once, the first time the Settings page is opened. If it is
  replaced in the database, the next refresh rewrites it on every hook the
  dashboard made (see "What the dashboard checks on its own"), with nothing to
  click per repo.
