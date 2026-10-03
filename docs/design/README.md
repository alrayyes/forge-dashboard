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
- `screen-mobile-pr-cards.png`: two pull request cards at phone width, in four
  tiers: the repo, the title with labels and times, a strip of status pills
  kept apart from the buttons, and an action row with one 44px primary action
  and a 44px More actions button. The second card shows a failure panel under
  the actions. `crop-mobile-pr-card.png` is that card.
- `screen-mobile-pr-cards-five-states.png`: the same card in five states
  (failing, passing, blocked, GitHub, a long wrapping title), with the
  primary action following the state. Stitch drew both screens on a wide
  canvas, but the content is a phone layout.

The mobile card screens offer a Retry button on an already-merged failure and
show the raw forge error under a disclosure labelled Details. The app does
neither: that failure can't pass by retrying, and the raw text stays in the
server log. The tickets' criteria win over those two details.
