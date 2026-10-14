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

- `screen-pr-detail-dialog.png`: a pull request opened in a pop-up sized to
  its content, over the dimmed list: the title, status pills, branch and
  checks, labels, a failure line, and every action in the footer. Merge is
  greyed out with an info icon that opens the blocked reason.
  `crop-pr-detail-dialog.png` is the pop-up alone. Stitch project "Forge
  Dashboard UI Audit" (`564147752128938905`), screen
  `4ef3db25112f48d8ab758be286a7c8bd`. It is the design for the pull request pop-up
  and the greyed-out Merge button.

- `screen-dependabot-ack.png`: a Dependabot request to bring a branch up to
  date, in four states (requested, acknowledged by Dependabot's thumbs-up, no
  reply after about ten minutes, done) and the acknowledged row in the list.
  `crop-dependabot-ack-states.png` is the four states and
  `crop-dependabot-ack-row.png` the row. Stitch project "Forge Dashboard UI
  Audit" (`564147752128938905`), screen `2a2e5152e22e47d1af61540a14e50a69`.
  It's the design for #1082. The banner, "State Lock" and "Worker Task"
  labels and stage numbers are review chrome and don't ship.

- `screen-releases-light.png` and `screen-releases-dark.png`: a page for
  release pull requests only, in light and dark. Rows are grouped by repo
  with the version large in a fixed-width face, a changelog summary, CI and merge
  pills, a "What's in this release" list, and Merge, Update branch and a More
  menu. It also draws the empty, loading and rate-limited states.
  `crop-releases-behind-row.png` is the Behind row, with the plain-words
  reason next to Update branch. Stitch project "Forge Dashboard UI Audit"
  (`564147752128938905`), screens `9f255af3c7674e40af6cd00b3a6e3823` (light)
  and `164a64303e3046dea0eff04607122151` (dark). It's the design for #1107.
  The "Trigger Manual Cut", "Pipeline Rules", "Force changelog scan" and
  "Retry Endpoint" buttons, the hotkeys bar, the queue and latency figures and
  the "Component State" panels are Stitch's own additions: they aren't in the
  ticket and don't ship.

- `screen-main-branches-light.png`, `screen-main-branches-dark.png` and
  `screen-main-branches-mobile.png`: a page with the CI status of every
  repo's default branch, in light, dark and at 390px. Rows carry status,
  branch, latest commit, failing workflow and age; filter pills with counts,
  a forge toggle, search and a failing-first sort sit above them, and a failed
  row shows its failing job and last log lines.
  `crop-main-branches-filter-bar.png` is the header and filter bar and
  `crop-main-branches-failing-row.png` a failed row. Stitch project "Forge
  Dashboard UI Audit" (`564147752128938905`), screens
  `0011e2f09e594d16871f5e7aa4d2af70` (light),
  `94f04efcc8654316a921472cfbb2e7e1` (dark) and
  `57560cd0bdea420f92350ea3fee104cd` (phone). It's the design for #1224. The
  header chips, "Delight Preview", the two cards at the foot, the stability
  figures, the progress percentage, Cancel, Force sync, the raw-log
  buttons and the phone's bottom tab bar are Stitch's own additions: they
  aren't in the ticket and don't ship.

- `screen-waiting-states-light.png`, `screen-waiting-states-dark.png` and
  `screen-waiting-states-mobile.png`: one status chip in a pull request row's
  action area for every wait, in light, dark and at 390px: a bot update, an
  Update branch, armed auto-merge, an action queued for a rate limit reset, a
  merge in progress, then Settled and Still waiting. The row never changes
  height. `crop-waiting-chips.png` is the chips on their own. Stitch project
  "Forge Dashboard UI Audit" (`564147752128938905`), screens
  `f231531e0fa24a46a9eaacc36ba8dbfe` (light), `de83d97b0cac412d90be8021301a354c`
  (dark) and `2b083d7f858a4dd3b33d29ab0819079c` (phone). It's the design for
  #1229. The progress percentage and estimate, the header chips, "Highlight
  Pending", the "Timeout" CI pill, the worker names and the "Ergonomic Rules"
  panel are Stitch's own additions: they aren't in the ticket and don't ship.

- `screen-ci-pill-actions.png`: four pull request rows in a full-width list
  where the CI pill is the button that opens the pipeline, with a hover
  label, a focus ring and a chevron, and the separate "View pipeline"
  button is gone. A row with one extra action (Close) shows it directly.
  A row with two or more extra actions keeps the More actions menu, drawn open
  on the second row. `crop-ci-pill-actions-rows.png` is the first two rows.
  Stitch project "Forge Dashboard UI Audit" (`564147752128938905`), screen
  `d9f335e35872473abec7a73468b3ce83`. It's the design for #1139. The open menu
  covers the Dependabot row's actions and part of the draft row's Close, and
  the hover label sits over the header; both are Stitch drawing slips, not design.
  The notification bell, Group by repo toggle and footer text aren't in the
  ticket and don't ship.
- `screen-pipeline-sheet-mobile.png`: the pipeline as a bottom sheet on a
  phone, opened from the CI pill: the failing check with its error, the
  passing checks, Rerun failed checks and Close. Screen
  `c8c48a12ec30434f949a43b7f7a125c4`. It doesn't draw the cards behind it, so
  it does not show the single-action rule on a phone. The bottom tab bar and
  the "Live" chip aren't in the ticket and don't ship.

- `screen-error-pages.png`: Stitch's candidate for the 404 and 500 pages, a
  "Runtime Exception Simulator" with a status chip, headline, a sentence,
  Back to pull requests, three next-step cards and recovery notes.
  `crop-error-page-head.png` is the head block, the part to build. Stitch
  project "Forge Dashboard UI Audit" (`564147752128938905`), screen
  `993566920566427190fa5e956129caa1`. It's the design for #1175. Most of it
  doesn't ship: the status tabs, trace and network panel, diagnostic JSON,
  stack trace, host names, session key and recovery notes all show internals, which
  an error page must not (rules/error-pages.md).

- `1473-pipeline-states/`: state indicators for the pipeline checks panel, so
  Queued, Skipped and Cancelled stop looking alike (#1473). `matrix.png` is
  the six states, `variants.png` the two layouts, `pipeline-states-full.png`
  the whole screen. Stitch project "Forge Dashboard UI Audit"
  (`564147752128938905`), screen `53cfc94d10a04ad7bd2383f2e3de0614`. Variant A
  (glyph inside a tinted pill) is the one to build. Running stays amber, not
  Stitch's blue, which sits too close to its Queued blue. Its contrast ratios,
  "eye travel latency" and spec labels are invented and don't ship.
