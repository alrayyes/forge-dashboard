# Design reference

These screens come from the Stitch project "Forge Dashboard UI Audit"
(id `564147752128938905`). They live here because Stitch image links
are signed and expire.

The design system is "Forge Engine Visual Language": Geist, Inter and
JetBrains Mono, with indigo for GitHub and orange for Forgejo.

- `dashboard-before.png`: the baseline dashboard.
- `dashboard-after.png`: the redesigned dashboard the tickets build.
- `dashboard-merge-states.png`: Merge waiting on CI, blocked and ready,
  with Close only in the overflow menu.
- `dashboard-bot-rebase.png`: a Dependabot update request from queued to
  picked up.
- `dashboard-stable-feed.png`: rows that stay put, with an updates bar
  and a stable sort.
- `dashboard-forgejo-auto-merge.png`: auto-merge on Forgejo, handled by
  this app.
- `dashboard-inline-feedback.png`: feedback on the row, a toast stack
  and an activity panel instead of a top banner.
- `dashboard-pr-kinds.png`: release and dependency pull requests told apart with
  chips, filter pills and a group-by-kind view.

The design is dark only. The app keeps its light theme.

- `dashboard-rate-limit.png`: a rate-limited forge with disabled actions and
  no Retry, next to a transient error that does offer Try again.
- `dashboard-rate-limit-readonly.png`: Stitch's answer to a request for a
  read-only rate-limit mode. It largely repeats the rate-limit screen and
  does not draw the banner, queue or paused refresh that were asked for.
- `dashboard-inline-confirm.png`: an armed Merge with Confirm, Cancel and a
  hint to cancel by pressing the escape key or clicking away.
  Probe for the CI path filter.
