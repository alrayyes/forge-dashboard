# Webhooks

Optional. Without one set up, the dashboard still refreshes on its own
schedule (`REFRESH_INTERVAL`, 5 minutes by default) and the browser tab
polls it every 30 seconds — a webhook just closes that gap, so a new pull
request, a closed issue, or a CI status change on a repo you're tracking
shows up within seconds instead of at the next poll. Nothing about this
is required for the dashboard to work; skip this page entirely and
everything still functions exactly as it did before.

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
