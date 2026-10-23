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
long it ran. A GitHub repo with a published release also shows its tag
(for example `v1.2.3`) as a button beside the forge badge. It opens the same
details dialog as the Releases page, showing the release's title and notes, with
an "Open on GitHub" link to the release itself. The notes are read when the
dialog opens, not with the page. Escape or Close puts focus back on the tag. A
screen reader hears it as "Latest release v1.2.3, open details", and on a phone
it is 44 pixels tall. It is underlined like the repo name, and a tag too long
for the row is cut to one line, with the whole tag on hover. A repo with no
release, or only drafts and pre-releases, shows no tag, and so does every
Forgejo repo for now. A GitHub repo with open Dependabot alerts on its default branch
also shows a pill with the count and the highest severity in words, for example
"3 advisories, critical", linking to the alerts on GitHub in a new tab. The
severity is the word, so the tint (red for high and critical, amber for medium,
grey for low) is never the only signal. A repo with none open shows nothing. A
repo whose alerts could not be read, because they are switched off or the
credential lacks the permission, is never shown as zero: unknown is no answer.
When every GitHub repo is unknown, one notice above the list says so and links
to [When advisories can't be read](#when-advisories-cant-be-read), and no row
repeats it. When only some are unknown, those rows carry a small grey dash
(read aloud as "Advisories unknown") and no pill. A repo no source reads
shows no pill. A branch whose only trouble is a cancelled run (a
newer push or a person stopped it) reads Cancelled, not Failed, with a stop
glyph; a real
failure beside a cancelled run is Failed and names only the failed job, and a
cancelled run beside one still going is Running. A GitHub branch whose newest
commit has workflow runs held until someone approves them reads "Waiting for
approval" with a pause glyph, the same one the pull request row uses: nothing
has run and nothing has failed, and the pipeline panel lists the held workflows
with a link to GitHub's approve button. A held run beside check runs that all
passed still reads as Passed on a branch, unlike a pull request row: a branch
reads as waiting only when its newest commit has no check run at all. A held run
nobody approves keeps the branch on Waiting for approval until the next push. A
failed row names its first failing jobs. The status pill is a button, as on the
pull request pages: it opens the pipeline panel, a side panel that lists every
job of the branch's newest pipeline with its state and how long it took, a link
to each job, and, for a failed job, the step that broke and the tail of its log.
On Forgejo the list reads no log: the tail of a failed job's log appears a moment
after the panel opens, for the newest five failed jobs.
The panel also links to the run on the forge, in a new tab. Escape, the close
button or a click outside closes it and focus goes back to the pill, and a
screen reader hears the pill as, for example, "Failed. Open pipeline". The jobs
are read from the forge when the panel opens, not from the page's snapshot, so
they are never older than the click, and a read that fails offers Retry. The
pill has the pull request board's colours but is taller and larger, 32 pixels
high on a desktop and 44 on a phone, because this page has room and the pill is
the main control on the row. The "No pipeline" note is plain, not a button,
since there is no pipeline to open. Rows come latest commit first, in the order
the server sends them.

The pills (All, Failing, Passing, Running, Cancelled, Waiting for approval, No
pipeline) keep their filter names, like the quick pills on the pull request
board, and carry the server's counts. A pill, and each forge in the toggle, is
offered only when a row would show under it, given the search and the other
pill, so none leads to an empty list; the one that is active always stays, so it
can be cleared. A forge toggle and a search box narrow the list further; search
matches the repo, branch, commit, author and failing job names. The filter is
saved with the other pages' filters, in the shared filter cookie and in the copy
on the server, so it is still set after a reload and in another browser.

An advisories group (Any, Has advisories, No advisories) sits beside the forge
toggle once some row has an answer, and follows the same rule: a choice is
offered only when a row would show under it. **Has** keeps rows with at least
one open advisory and **No** keeps rows known to have none. A row whose answer
is unknown, or that no source reads, is under neither, because unknown is never
zero. The group says how many rows are left out for that reason, so a missing
row is not read as clean. **Reset filters** sets it back to Any.

Rows from a forge that can't be read, or whose rate limit is spent, keep their
last known status, are marked **stale**, and sit under one banner. The page
offers no write at all: there is no Re-run, because the only re-run endpoint
works on a pull request's checks, not on a default-branch run, so the pipeline
panel here only reads. With every
default branch passing the page says so, and a filter that matches nothing
offers **Reset filters**. A repo with no pipeline says no run was found.

## Forgejo advisories

Forgejo has no alerts of its own, so the advisories on a Forgejo row come from
the repo's lock files. The dashboard lists the root of the default branch, reads
the lock files below if they are there, and asks
[OSV](https://google.github.io/osv.dev/post-v1-querybatch/) which of the
pinned packages have known advisories. The count is the number of
distinct advisories, with one flaw listed under two ids counted once, and the
severity is the highest the advisory database states. An advisory with no
stated severity but a CVSS v3.x or v4 vector gets one from the vector's base
score: under 4.0 is low, 4.0 to 6.9 medium, 7.0 to 8.9 high and 9.0 or more
critical. An advisory with neither still counts, and the pill then shows the
count alone. The pill does not link anywhere, since OSV has no page for a whole
repo.

- `package-lock.json`, any lock file version (npm). Packages not resolved from
  the public npm registry are kept out.
- `bun.lock` (npm). Packages from another registry, git or a tarball, and
  workspace members, are kept out.
- `composer.lock` (Packagist). Branch checkouts such as `dev-main` and path
  repositories are kept out. Composer doesn't record the repository, so
  private packages are still sent by name.
- `poetry.lock` and `uv.lock` (PyPI). Packages from git, a path, a URL or
  another index are kept out, and so is the project itself.
- `Cargo.lock` (crates.io). Crates from git or another registry, and the
  crates built from the workspace itself, are kept out.
- `go.mod` (Go). Modules on the Forgejo host itself and local replacements are
  kept out.

Each file costs one raw read per refresh, on top of the one root listing, and
the refresh interval and cache are the same as before. The binary `bun.lockb`
is not read, and only the root of the branch is looked at. A repo with none of
these files stays `unknown`.

This is off by default, because **the package names and versions in those files
are sent to `api.osv.dev`**, for private repos too. Only what the list above
keeps out stays home. A private Go module on another host, a private scoped
package on the public npm registry, or any Composer package, is still sent by
name, which is why this is off by default. Nothing else is sent: no repo name,
URL or token. Set `OSV_ADVISORIES=on` to turn it on; a line in the log at
startup says so, and a value that is neither `on` nor `off` logs a warning and
leaves it off. While it is off, every Forgejo row is `unknown` with the reason
`not_enabled`: not checked, never zero.

With it on, a repo with no lock file the dashboard reads is `unknown`, never
zero. So is a repo where any lock file is over 8 megabytes, doesn't parse or,
for `go.mod`, has no `module` line (it is asked again after an hour), and one
that matches more than 300 distinct advisories. Only the repo root is read: a
root `go.mod` alone reads as known even when the front end lives in a
subdirectory, so a count is the advisories in the root lock files, not in the
whole repo. A `replace` directive in `go.mod` is applied, and an aliased npm
install is matched by its real name. A lock file lists many packages: past 3000
distinct name and version pairs the repo is `unknown`. So is a repo where every
package was left out for being private, since nothing was checked.

The page does not flag an unknown Forgejo row that has no reason, since most
repos have no lock file, and nothing is said while advisories are off. It does
say when a read failed: a row that is `unknown` with the reason `failed` (OSV
unreachable, or a lock file that can't be read or is too big) or `too_many` gets
a grey dash when other Forgejo rows have an answer, and when none has, one
notice above the list names the cause. That notice is about Forgejo only and
sends nobody to a GitHub permission.

Answers are cached for fifteen minutes. A failed read keeps the last answer for
up to a day, or shows `unknown` if there is none or it is older, and is retried
after five minutes, then ten, up to thirty while OSV stays down, without reading
the lock files from the forge again. One repo's read gives up after ten seconds
so a slow OSV can't hold up the CI row. A read costs one listing of the root
plus one read per lock file, counted under the `advisories` kind in
[Rate limits](rate-limits.md).

## When advisories can't be read

GitHub answers 403 or 404 when the credential can't read a repo's Dependabot
alerts, or alerts are off for it. The API and MCP tools still report that as
`unknown`, never zero. To read them, the credential needs one of:

- a fine-grained personal access token with **Dependabot alerts: Read-only**
  (a repository permission);
- a classic token with the `repo` scope (which includes `security_events`), or
  `security_events` alone; `public_repo` is enough if every tracked repo is
  public;
- a GitHub App with **Dependabot alerts: Read-only**. On an App that is already
  installed, GitHub holds a new permission until the owner accepts it: open the
  installation's page and accept the request, or the App keeps its old
  permissions. A permission accepted later only counts once the dashboard
  holds a new installation token, which GitHub issues for up to an hour (see
  [Generating an installation access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)),
  and a refusal read with the old token is remembered too. Allow up to an hour
  and a quarter. To skip the wait, save Settings (any save will do) or restart
  the dashboard; either starts with a new token and no remembered answers.
  There is no separate refresh button.

Dependabot alerts must also be enabled on the repo. Answers are cached for
fifteen minutes. A failed read, or the first refusal, is retried after five
minutes; the same refusal again waits the full fifteen. A rate limit or a
GitHub error shows as unknown too, so an unknown row does not always mean a
missing permission. The API says which in `reason` on the unknown answer
(`refused`, `switched_off`, `throttled`, `failed` or `too_many`; a Forgejo
repo can also say `not_enabled`, which only the API reports), and the notice on
the page names the cause when every unknown GitHub row shares one (a Forgejo
notice does the same for its own rows). GitHub's reference:
[List Dependabot alerts for a repository](https://docs.github.com/en/rest/dependabot/alerts#list-dependabot-alerts-for-a-repository).

## Main branches API

`GET /api/main-branches` answers the CI status of every tracked repo's default
branch, so a broken main shows up without opening each repo. One row per repo:
its default branch, the status of the pipeline on the newest commit (`failed`,
`passed`, `running`, `cancelled`, `awaiting_approval` or `none`), the commit
(short SHA, subject, author), the names of the failed jobs, when the pipeline
finished and how long it ran, a link to the run, and the repository's latest
published release (`latestRelease`, its tag and the page of its notes, or
null) and its open dependency advisories (`advisories`: `state`, `count`, the
`highest` severity and a `url` to the alerts). A Forgejo repo's
`advisories` is `unknown` with the reason `not_enabled` until `OSV_ADVISORIES=on`.
`state` is `unknown` when the
forge could not say, for example alerts switched off or a token without the
scope, and is never a count of zero; `reason` then says why when the dashboard
can tell. The release's title and notes are a
separate read, `GET /api/releases/details`, made when the dialog opens. The
response also counts the rows per status. Every row is returned whatever its
status, ordered by commit time, latest first (rows with no commit time last,
then by repo name), so a client filters it and its counts always match what it
lists. Status is a filter, not the order.

It reads the snapshot the background refresh already holds and never calls a
forge, so reading it costs no rate-limit budget. The refresh gets the data
cheaply:

- **GitHub**: the default branch's newest commit and its checks ride the
  repository query the refresh already makes for pull requests and issues, so
  they add no request, and neither does the latest release, which rides the same
  query. GitHub leaves drafts and pre-releases out of it, so a repository with
  only drafts or pre-releases has none. All of this covers a personal access
  token and a GitHub App.
  A username with no token has no rows, because its hourly budget is too small
  to spend on this.
- **Forgejo**: the refresh lists the Actions runs of each repo's default
  branch (one call per repo, plus one for the commit, plus one for the jobs of
  each run). The pill counts those jobs, not the runs, so three runs holding
  eleven jobs read as eleven checks. Forgejo sends no ETag, so a finished run's
  jobs are kept in memory instead and read once; only runs still going are
  read again on each poll. Forgejo has no rate limit by default. Its latest
  release would be one more read per repo, so a Forgejo row has none for now.

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

`GET /api/main-branches/checks?forge=&fullName=` answers the jobs behind one
row, in the same `{checks: [...]}` shape as `GET /api/pull-requests/checks`.
Unlike the list, it calls the forge on every request and is not part of the
snapshot, so it spends rate-limit budget: the pipeline panel makes it when it
opens and an MCP client makes it with `get_main_branch_checks`. The commit is
the one the row describes, the newest on the default branch that a check ran
on, so a bot's commit that skips CI does not hide the run. A branch with no
job answers an empty list. `required` is never set, since only a pull request
has a base branch whose protection could require a job.

`POST /api/main-branches/rerun-checks` with `{forge, fullName}` reruns only the
failed jobs of the workflow runs on that same commit, once per run, and answers
204 when the forge has queued them. The pipeline panel of a failed row offers it
as `Rerun failed checks`, with the same permission needs and the same reasons on
a refusal as the pull request button (see
[Pull request actions](pull-request-actions.md)). The button reads "Rerun
queued" until the row's CI changes or ten minutes pass. When the row's forge
can't be reached, or its REST rate limit is spent, the panel draws no button and
says why in the pull request board's words. The button returns when the rate
limit lifts, or on the first refresh that shows the forge healthy again. A queued
note stays, with the reason after it on the same line. With several hosts of one
forge kind, the button is held back only when every one of them would refuse it.
The response carries each forge's health in `forges`, the same entries the
dashboard serves. A branch with nothing left to rerun answers "no failed job to
rerun on this branch" with a 409.
