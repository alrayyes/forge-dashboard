# Webhooks

Optional. Without one set up, the dashboard still refreshes on its own
schedule (`REFRESH_INTERVAL`, 5 minutes by default) and the browser tab
polls it every 30 seconds — a webhook just closes that gap, so a new pull
request, a closed issue, or a CI status change on a repo you're tracking
shows up within seconds instead of at the next poll. Nothing about this
is required for the dashboard to work; skip this page entirely and
everything still functions exactly as it did before.

Settings' own Webhooks card shows a "Webhook coverage" summary once
you're tracking any repos, linking to its own page (`/webhooks.html`)
that lists every tracked repo and whether this dashboard has confirmed
a webhook for it — setup status lives with the rest of setup, not on
the main dashboard next to the pull request/issue boards it has
nothing to do with. It checks the forge's own webhook list directly, so a
repo with one already pointed at this dashboard shows as confirmed
immediately, not once something happens to trigger it — no waiting on
a real event to arrive. That live check can fail (rate limiting, an
unreachable forge, a token missing the webhook-list scope — see
Settings' own field hints for what that is per forge), in which case it
falls back to whether this app has ever actually received a
signature-verified delivery for that repo, the same passive signal this
whole page is otherwise about.

## The easy way: "Add a webhook"

On the Webhooks page, a repo without a confirmed webhook gets an "Add a
webhook" button — it creates one via the forge's own API, pointed at
this dashboard's URL and secret, subscribed to every event the table
below recommends. If a forge-dashboard webhook already exists there but
is turned off or missing an event, clicking it fixes that one up in place
rather than creating a second, duplicate hook.

This needs a broader token scope than just reading your repos — GitHub's
fine-grained tokens need the Webhooks permission set to **Read and
write**, and Forgejo's `write:repository` (already required just to
check coverage, since Forgejo's webhook API has no separate read-only
scope). See Settings' own field hints for the exact scope per forge. If
your token can't or won't take that scope, the manual steps below are
still the fallback — nothing here requires the button.

A GitHub fine-grained token also gates _which_ repos it can see at all,
separately from the preceding permissions — set at token creation, either
"All repositories" or an explicit list. A repo left out of that list fails
with "Resource not accessible by personal access token" even with every
permission granted correctly, which reads like a scope problem but isn't
one. This is easy to hit for a repo created after the token, or a token
deliberately scoped to a subset of repos.

**A webhook is only as complete as the events you tell your forge to
send.** Ticking too few doesn't break anything — it just leaves part of
the dashboard on the slower, polling-only path while the rest updates
live. The one people miss is CI: a pull request's status colour is driven
by a _different_ event than the one that shows the pull request existing
at all, so it's easy to end up with a webhook that reacts to a new pull
request or a comment but never to that pull request's checks finishing.

| Live update you want                                                                            | GitHub events        | Forgejo events |
| ----------------------------------------------------------------------------------------------- | -------------------- | -------------- |
| A pull request opening, closing, or its labels/reviewers changing                               | Pull requests        | Pull Request   |
| An issue opening, closing, or getting commented on                                              | Issues               | Issue          |
| **CI/build status** — Actions, a third-party check, or a classic commit status, on either forge | Statuses, Check runs | Status         |
| A commit landing outside an open pull request                                                   | not tracked          | Push           |

GitHub splits CI into two separate events because it has two separate
CI mechanisms with two separate APIs: **Statuses** is the older
commit-status API (what most third-party CI still posts to), **Check
runs** is GitHub Actions and any GitHub App-based check. Skip either one
and a pull request whose only checks come from the mechanism you didn't
select won't update its CI colour until the next poll — everything else
about that pull request still updates live. Forgejo doesn't have this
split: its own Actions runs post to the same combined commit-status
endpoint external CI does, so **Status** alone covers both.

Forgejo's **Push** doesn't feed anything the dashboard displays on its
own — there's no commit feed here — but it's cheap to include: a push to
a pull request's head branch is normally caught by the preceding
pull-request events already, and Push is a harmless second trigger for
the same refresh in case that doesn't fire.

## Find your webhook URL and secret

Open **Settings** (`/settings.html`, linked from the dashboard header) —
the **Webhooks** card there shows a ready-to-paste URL for each forge and
one shared secret, generated the first time you open the page. Both stay
the same across visits, so a webhook configured against them keeps
working; there's no separate step to "save" them.

## GitHub

1. On the repository you want live updates from: **Settings → Webhooks →
   Add webhook**.
2. **Payload URL**: the GitHub webhook URL from Settings.
3. **Content type**: `application/json`.
4. **Secret**: the secret from Settings.
5. **Which events would you like to trigger this webhook?** → "Let me
   select individual events", then check **Pull requests**, **Issues**,
   **Statuses**, and **Check runs**. (Selecting "Send me everything"
   works too, see below — it's just more traffic than needed.)
6. Leave **Active** checked, then **Add webhook**.

GitHub POSTs a `ping` event immediately to confirm the URL is reachable;
a green checkmark next to the webhook in that same settings page means it
was accepted.

## Forgejo

1. On the repository: **Settings → Webhooks → Add Webhook**, then choose
   **Forgejo** (choose **Gitea** instead if that's the only option your
   instance offers — both work the same way here).
2. **Target URL**: the Forgejo webhook URL from Settings.
3. **HTTP Method**: `POST`. **POST Content Type**: `application/json`.
4. **Secret**: the secret from Settings.
5. **Trigger On**: "Custom Events", then check **Pull Request**,
   **Issue**, **Push**, and **Status**. ("All Events" works too, same
   reasoning as the preceding GitHub section.)
6. Leave it **Active**, then **Add Webhook**.

## How a delivery is verified

Every delivery's signature is checked against your secret before
anything acts on it — an unsigned or wrongly signed request is refused
outright, not just ignored. GitHub signs with `X-Hub-Signature-256`;
Forgejo signs with `X-Forgejo-Signature` (or `X-Gitea-Signature` on an
instance whose webhook was set up with the legacy "Gitea" type) — both
are an HMAC-SHA256 of the raw request body, keyed with your secret. Once
verified, the payload's `repository` field is read to refresh just that
one repo instead of everything you track — a delivery whose payload
doesn't carry one (the initial "ping", most concretely) falls back to a
full refresh instead, so every event type still results in _something_
refreshing either way.

## Troubleshooting

- **Everything about a pull request updates live except its CI colour**:
  the webhook is working, it's just missing the CI-specific event — see
  the preceding table. Re-open the webhook on your forge and check
  **Statuses**/**Check runs** (GitHub) or **Status** (Forgejo); nothing
  else about the webhook needs changing.
- **You configured a Forgejo webhook's events through the API or a
  script rather than clicking through this same settings form, and
  Status won't stick**: confirmed on a real instance running
  `16.0.4+gitea-1.22.0` — a `PATCH` to the events list can report
  success while silently dropping `status`, leaving CI updates on the
  poll-only path with no error anywhere to say why. This is a bug in how
  that instance persists the edit, not something forge-dashboard can
  detect or work around. Open the webhook's edit page on the web UI
  itself and confirm Status is still ticked there — if it keeps
  reverting, that's worth reporting against your Forgejo instance.
- **The forge shows the delivery failing, or your dashboard never
  updates from it**: re-check the secret was pasted exactly, with no
  extra whitespace — a mismatched secret is indistinguishable from an
  attacker's forged request from this endpoint's point of view, so both
  are refused the same way.
- **A delivery arrives but the dashboard doesn't seem to reflect it**:
  every delivery is logged, each line naming the forge, the event type,
  and the delivery ID — `webhook accepted`, `webhook signature invalid`,
  or `webhook token unknown`, followed by `webhook refresh dispatched`
  once the triggered refresh actually runs. No `LOG_LEVEL` change is
  needed to see them; each logs at its natural level (`INFO` for a
  normal delivery, `WARN` for a rejected one) regardless of what
  `LOG_LEVEL` is set to.
- **You want to rotate the secret**: there's currently no way to do that
  from the dashboard — it's generated once, the first time the Settings
  page is opened, and stays fixed after that for as long as the account
  exists.
