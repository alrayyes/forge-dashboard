# Main branches

The CI status of every tracked repository's default branch is the first thing
you see: it's the index page, `/`, reached from the **Branches** item, the first
one in the navigation. The item always shows. The page reads
`GET /api/main-branches`, so a broken main shows up without opening each repo.
A repo you ignore for pull requests is left out, here and in the badge.
The pull request list is at `/pull-requests.html`. The page used to live at
`/main-branches.html`, which now redirects to `/`.

Each row shows the status top right, in the same slot the pull request rows use:
a running branch is a state (Running, an amber spinner, a still clock under
reduced motion) and a finished one an outcome (Failed, Passed or Cancelled),
with the same glyphs and colours, so a run turns into its result without the row
moving. A branch with no pipeline is neither, so it gets a quiet outlined "No
pipeline" note instead. The row also shows the repo, the branch, the short SHA,
subject and author of the newest commit, how long ago the run finished and how
long it ran. A branch whose only trouble is a cancelled run (a newer push or a
person stopped it) reads Cancelled, not Failed, with a stop glyph and a link to
that run; a real failure beside a cancelled run is Failed and names only the
failed job, and a cancelled run beside one still going is Running. A failed row
names its failing jobs and expands to list them. The status pill is the link to
the run: it opens the run on the forge in a new tab, and a screen reader hears
it as, for example, "Failed. Open run (opens in a new tab)". It has the pull
request board's colours but is taller and larger, 32 pixels high on a desktop
and 44 on a phone, because this page has room and the pill is the main control
on the row. The "No pipeline" note is plain, not a link, since there is no run
to open. Rows come latest commit first, in the order the server sends them.

The pills (All, Failing, Passing, Running, Cancelled, No pipeline) keep their
filter names, like the quick pills on the pull request board, and carry the
server's counts. A
pill, and each forge in the toggle, is offered only when a row would show under
it, given the search and the other pill, so none leads to an empty list; the one
that is active always stays, so it can be cleared. A forge toggle and a search
box narrow the list further; search matches the repo, branch, commit, author and
failing job names. The filter is saved with the other pages' filters, in the
shared filter cookie and in the copy on the server, so it is still set after a
reload and in another browser.

Rows from a forge that can't be read, or whose rate limit is spent, keep their
last known status, are marked **stale**, and sit under one banner. The page
offers no write at all: there is no Re-run, because the only re-run endpoint
works on a pull request's checks, not on a default-branch run. With every
default branch passing the page says so, and a filter that matches nothing
offers **Reset filters**. A repo with no pipeline says no run was found.

## Main branches API

`GET /api/main-branches` answers the CI status of every tracked repo's default
branch, so a broken main shows up without opening each repo. One row per repo:
its default branch, the status of the pipeline on the newest commit (`failed`,
`passed`, `running`, `cancelled` or `none`), the commit (short SHA, subject,
author), the names of the failed jobs, when the pipeline finished and how long
it ran, and a link to the run. The response also counts the rows per status.
Every row is returned whatever its status, ordered by commit time, latest first
(rows with no commit time last, then by repo name), so a client filters it and
its counts always match what it lists. Status is a filter, not the order.

It reads the snapshot the background refresh already holds and never calls a
forge, so reading it costs no rate-limit budget. The refresh gets the data
cheaply:

- **GitHub**: the default branch's newest commit and its checks ride the
  repository query the refresh already makes for pull requests and issues, so
  they add no request. That covers a personal access token and a GitHub App.
  A username with no token has no rows, because its hourly budget is too small
  to spend on this.
- **Forgejo**: the refresh lists the Actions runs of each repo's default
  branch (one call per repo, plus one for the commit, plus one for the jobs of
  a failed run). Forgejo has no rate limit by default.

A forge that can't be reached keeps its last known rows, each marked `stale`
with the time it was last fetched, and so does a forge whose rate-limit budget
is spent (the refresh skips it until the reset; see
[Rate limits](rate-limits.md)). A repo whose read failed while
its forge answered keeps its own earlier row the same way. A repo with no
pipeline on its newest commit, an empty repo, or a Forgejo instance without
Actions shows `none`. The snapshot updates on each full refresh, and a webhook
delivery for a repo (a finished check, say) re-reads that repo's default branch
at once, so a rerun that passed turns its row green without the next poll. If
that read fails, the row keeps its earlier state.
