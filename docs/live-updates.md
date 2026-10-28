# Live updates and filters

The board polls on the schedule in `readIntervalSeconds` (30 seconds today, set
by the server, or 2 until your first refresh has finished) and takes pushes
over a live stream, but
rows don't move under you. A change to a row's own content (CI,
merge status, behind, labels, title) updates that row where it stands and
marks it "Updated just now" for a couple of seconds; it never reorders the
list. Rows that are added, removed or reordered land by themselves in one
render, with nothing to press. They wait only while something would be
disturbed, and land the moment it ends: a row action is in flight (or a Merge is
waiting for its second click), a pop-up other than the
pull request pop-up is open, the mouse rests on the list (until you move away,
close a pop-up or leave the window), or a finger has just touched or scrolled
the page (for about a second). A refresh you asked for (Refresh now, or the one
after your own merge) lands at once. When rows land above what you are reading,
the page scrolls by the same amount so nothing you can see moves. The pull
request pop-up itself doesn't hold the board: the list behind it keeps updating,
and the pop-up follows its own pull request, including a merge result or a
failure line. Keyboard focus on a row doesn't hold either, and stays on the row
when the list redraws. When rows land, one polite line tells a screen reader
what changed ("List updated: 1 added, 2 removed"). **Pause live updates** is
your own control: it stops every automatic update until you turn it back on,
which applies what waited (Refresh now still works). The **Sort** control offers
Last activity (the default, the server's order: most recently updated first,
whether or not a pull request is ready to merge), Created and Repository. Pause
and sort are saved with your other filters.

The pull requests page also watches the first seven rows it draws, in the order
it draws them, so their CI pills fold from the live jobs without a dialog open.
The stream takes eight watched subjects at once, and the pipeline panel keeps
the eighth. A filter, a page of the pager or a grouping changes which rows are
drawn, and the page watches the ones that came in and stops watching the ones
that left. A row past the seventh keeps the pill from the last refresh. When
the live stream drops, a watched row reads the refresh again, so it doesn't
show a pill the stream can no longer vouch for. The row stays watched, and it
folds live again once the stream is back and lists it. The Main branches page
does the same. The
releases and bots pages share the pull request board but watch no rows, so
their pills read the refresh. A cancelled
run reads as cancelled on a watched row, as it does in the panel. On Forgejo,
jobs behind a failed one stay queued in a run that has finished, and nothing
will start them. A watched row and the panel leave them out of the waiting
count, so a failed run reads as Failed without a spinner. A rerun is a new
attempt, so its queued jobs still wait. The quick
filters and the auto-merge status still read the refresh.

The pipeline panel is one dialog on the pull request, bot and Main branches
pages, so what follows holds on all three. It follows its row. While it is open,
a check's pill changes where it stands, in the order the panel already shows,
when the live stream says that pull request's or branch's CI changed. The
panel tells the stream which row it shows, and the server sends that row's job
list when the panel opens and again for each such change, and none while
nothing changes, so a finished pipeline is not read again, and a rerun
that starts sends it again once. The panel never polls the forge, and the list
arrives as named `run` events that the plain snapshot readers don't see. There
is one event for each workflow run attempt, and one for each check that
belongs to no run. A rerun is a new attempt, so it sends a new event, and a
`gone` event retires the attempt it replaces. The last event of a list is
marked `final`, and the panel redraws once it arrives.
A run event also carries what the forge reported about the run attempt itself:
its `status`, its `conclusion` once it has ended, and when it started and
finished. They are the forge's words, and a run's conclusion can differ from
its jobs'. Each is left out where the forge gave none. A check that belongs to
no run, such as a legacy commit status or a third-party check, has none of
them, and neither does a GitHub check run whose workflow run the forge's lists
don't hold. GitHub gives no finish time for a run, so that one is always
missing there. A Forgejo run held back with no jobs yet arrives with nothing
but its status. A held GitHub run has no run event of its own, so it carries no
run facts.
Each job in it carries a `status` (queued, in progress, completed or waiting)
and, once it has finished, a `conclusion`. The conclusion is the forge's own
word, not a fixed set: GitHub's `neutral`, `stale` and `action_required` arrive
as they are, next to `success`, `failure`, `cancelled`, `skipped` and
`timed_out`. The panel works out the word and glyph it shows from those two, so
a client of the stream does the same. The panel reads `neutral` as passed, and
`stale`, `startup_failure` or a word it doesn't know as failed.
If the stream is down, the panel says so with a Retry button. If the browser
can't hold a stream open at all, the panel reads the list once when it opens
and again on Retry, and doesn't follow changes. A change to any
check's state is announced politely once
("Checks updated: test is now Passed.", or "Checks updated: 2 checks changed."
when several moved), the same line again when the same thing happens twice, and
the panel redraws nothing when no check differs. With **Pause live updates** on,
the panel holds the newest list and says "Live updates are paused. These
checks may be out of date."; turning updates back on draws the held list.
A redraw keeps keyboard focus on the same check's link or log, even
when checks above it came or went; if that check is gone, focus moves to the
close button.

Draft pull requests are left out by default. The **Show drafts** toggle in the
filter bar, off to start with, brings them back, marked "Draft", and its muted
"N hidden" count says how many are left out. The choice is saved like the other
filters and goes with every dashboard request, refresh and the live stream.

## When nobody is looking

The server refreshes your forges on a schedule (`REFRESH_INTERVAL`), but it
rests that schedule once nothing has used the dashboard for `IDLE_AFTER` (15
minutes by default). What counts as use is a tab someone is looking at: the page
tells the server when its tab is visible or hidden and sends a short heartbeat
while it is visible, and a visible tab with no pointer, key or scroll input for
the period stops counting too. A forgotten tab in the background, a laptop with
the lid shut, or a browser that crashed (no heartbeat for three minutes) lets
the schedule rest. The live stream stays open and keeps delivering snapshots
either way; it just doesn't hold the schedule. A visible tab that nobody
is at, on a second monitor say, counts only until its input has been quiet for
the period. The first request after a rest, or a tab becoming visible again,
makes one refresh, and the live stream pushes it to the
open board a moment later; that first request itself, and a client with no live
stream such as the API or MCP, is answered with the data from before the rest.
A webhook delivery still refreshes the repository it names while the schedule
rests, and so does the schedule while a pull request armed for merge or a
behind one waiting for auto-update needs it
([Rate limits](rate-limits.md) has the full list).

## The first load after a restart

A restarted server starts from the snapshot its last run saved, so the board
shows those rows at once. Their forge reads as unreachable with a stale time
until the first refresh succeeds, then the mark clears. The rest of this section
covers a start with nothing saved, such as a first install or a new database.
There the first snapshot is empty. While the snapshot's `firstRefreshDone` is `false`,
Pull requests, Releases, Bots, Issues and Branches show placeholder rows and one
polite "Loading your repositories…" line, not their empty states, and the
navigation shows a dash where a count would be. After about ten seconds the line
says the first refresh can take a while. The placeholder doesn't animate under
reduced motion. A snapshot without the flag counts as loaded. An unreachable
forge still shows in the forge health banner. While the flag is `false` the
server also advises a short `readIntervalSeconds` of 2, so the rows appear
soon after the refresh ends, not up to 30 seconds later.

## The first refresh

With nothing saved, the first snapshot is empty until the first refresh for that
user ends. A snapshot restored from the last run already counts as loaded, so
`firstRefreshDone` is `true` for it. `firstRefreshDone` on the dashboard
snapshot tells an empty board from one that hasn't loaded: it is `false` from
process start until the viewer's first refresh has finished, whether it
succeeded or failed (a failed one shows in the forge health), and `true` from
then on, including after later refreshes and settings saves. It is not stored,
so a restart resets it. The first refresh starts when the process does, from the
saved credentials, so it is usually done before you sign in. An account with no
saved settings has nothing to refresh, so it reads `true` at once. `GET
/api/dashboard`, the stream and the `get_dashboard` MCP tool all carry it.

The page doesn't wait for that answer to say it is loading. The server can hold
`GET /api/dashboard` for up to 15 seconds on a cold start, so if nothing has
answered after 200 ms the list pages show their placeholder rows, the polite
"Loading your repositories…" line and a dash in the navigation, and a warm
server that answers inside that time shows none of it. A failed first request
drops the placeholders. The "Still loading" text appears 10 seconds after the
page opens, and the page reads again after the interval the server advises
(`readIntervalSeconds`, between 1 and 300 seconds). The "Refreshed … ago" label
stays hidden until a snapshot carries a real time.

## Navigation counts

Every item in the navigation shows how many items its page lists, and how many
of them are failing. It is one pill: a neutral **total**, then the outcomes,
failing (red) and passing (green), then a thin divider and the state, running
(amber, a spinner, or a still clock under reduced motion). Each count has its
own glyph so colour is never the only signal. Branches counts default
branches. Pull requests, Releases and Bots count their pull requests (without
the ones that belong to another of the three). All four show those three
counts, in that order. The divider appears only when a running count follows an
outcome, and not on a phone. A pull request with no checks is in the total
only, so its numbers needn't add up. Branches adds a fifth, neutral count with
a dashed circle for the branches with no pipeline, last, so its numbers do add
up. A zero is never drawn, and the link's name says the same in words, in the
same order, after the numbers as drawn: "15 2 10 3, Pull requests, 15 total,
2 failing, 10 passing, 3 running", and "7 2 3 1 1, Branches, 7 total, 2 failing,
3 passing, 1 running, 1 without a pipeline". On
a phone the total sits on its own line above the counts, and with three-digit
numbers each count takes a line, so the busy tabs grow to about 110px. Issues
counts open issues, without Renovate's Dependency Dashboard or what your
settings hide, and has no failed count. The server works the numbers out from
the same lists the pages show (`navCounts` on `/api/dashboard`), so a page
agrees with its icon, and a hidden pull request is in neither. The dashboard
pages set them from each snapshot. The other signed-in pages (Branches,
Insights, Settings and the rest) load them and ask again every 30 seconds
while the tab is visible, so a refresh or a webhook changes them without a
reload.

A zero is never drawn: a page with nothing in it has no total, and nothing
failing means no red pill. A page with nothing to show leaves the navigation:
the Pull requests, Releases, Bots and Issues links are not in the header or the
phone's tab bar while their total is 0. Branches always shows. A count that
isn't known yet is not 0, so the links stay until the first snapshot says
otherwise, and the page you are on keeps its own link until you leave it. The
page still opens when typed into the address bar, and says it is empty.

The pages start with their list, with no row of tiles repeating those numbers.
One line near the list's heading says how many rows show: "12 open" with no
filter, "Showing 1 of 12" when a filter narrows it. The Failing CI pill filters
to failing pull requests, and All clears it. How many repositories are tracked
is a quiet line under the Insights heading. A page with nothing open says so,
even when its nav item is hidden.

On a phone the numbers sit above each tab's icon. An item's accessible name says
both in words, and opens with the numbers as drawn so the name contains the text
on screen: "12 3 8 1, Branches, 12 total, 3 failing, 8 passing, 1 running" on
the header icon, "12 3 8 1 Branches, 3 failing, 8 passing, 1 running" on the
tab, which shows its numbers before its word.

The menu runs Branches, Pull requests, Releases, Bots, Issues, then the rest.

`GET /api/dashboard` and its stream carry `navCounts`, the numbers behind the
navigation badges for Pull requests, Releases and Bots: a `total` and how many
have CI `running`, `failed` and `passed`; and for Issues a `total` only. A pull
request with no checks counts in the total alone, so the four numbers need not
add up. They count what each page shows when it opens. Pull requests leave out
ignored repos, drafts and hidden ones, even while Show drafts or Show hidden is
on. They are always present, zero when nothing is there.

The Branches badge isn't in `navCounts`. The page counts the default branches
in `mainBranchPage`, the same rows the Main branches page lists, so the badge
and the page's filter pills come from one count. A branch with no pipeline is
counted as `none`, so a branch's states add up to the total. A repo ignored for
pull requests is left out of both.

## Which filter choices a page offers

The repo, author and label choices on the pull request, release, bot and issue
pages and on Insights come from what the page can show: the items every other
filter lets through, and without the Dependency Dashboard while it is hidden. A
repo whose only issue is that one isn't offered until **Hide Dependency
Dashboard** is unchecked. Hiding it again clears a repo picked on that basis.
The Created and Updated ranges and the forge buttons on Insights follow the same
rule: a range or a forge appears only when something in the results is in it,
and a pick that nothing matches any more is cleared. On the pull request page
the repo, author and label choices and the age choices also follow the board's
own filters (the quick pills, Auto-merge and the closing-issue choice; on the
issue page, the closing-pull-request choice), so an author with nothing in the
list on screen isn't offered and picking a choice never leaves an empty list.
The quick pills do too: a pill is offered only when clicking it would show
something, and the one that is active stays so it can be cleared.

## The Label filter

The Label filter takes several labels at once and shows the pull requests or
issues that carry **any** of them, so ticking "bug" and "security" lists
everything with either. Pick one to see it by name, or two or more to see the
count ("2 labels"). The button opens a group of checkboxes, one per label on
offer, with a **Clear labels** button under it. Tab and Space tick and clear a box,
Escape closes the group and puts focus back on the button, and each change is
announced once with the number of results. A label on a row does the same as
its checkbox: click it to add it to the pick, click it again to remove it.

It matches any rather than all because that is the question a triage usually
asks, and because every label offered then still leads to a non-empty list.
Some trackers match all and some any, and users of both ask for the other, so
the group says which one this is.

The other filters' choices follow the labels ticked, and the label choices
follow the other filters. A ticked label that a later filter leaves nothing for
is cleared, and the others stay. On a phone each ticked label also shows as its
own chip in the row under the search, and the group sits in the Filters sheet
with 44px choices.

A label saved before the list existed is read as a list of one, so nothing
needs doing after an upgrade. A pick holds up to 20 labels and 1000
characters, and the server refuses a longer one. The browser keeps the saved
filters in one cookie of about 4 KB, and label, repo and author each
take a share of it, so a pick is also held to 1000 characters as that cookie
writes it; labels in a script that takes several
bytes a letter run out of room sooner, and the page stops ticking more once
the room is gone. A saved pick over any of these limits is cut down to fit
when the page loads. That includes a pick saved by an earlier build, which
allowed up to 2000 characters as the cookie writes it: one over 1000 is cut to
fit. The page shows a notice naming each filter and the choices it dropped, once
when it loads, so tick the rest again.

A long title search on top of the picks can still push the cookie past its
limit when the page saves. The page then cuts the title search first, then the
last names of the largest pick one at a time, then the largest other saved
value, and stops as soon as the cookie fits. A notice names what was cut. The
notice shows only on the save that cut: after a reload the cookie is already
trimmed, so nothing is left to report. The copy kept on the server stays whole.

If the server still refuses a
save, the page says the filter was not saved and does not send it again by
itself. The pick is saved in the same field as before, the labels in
lowercase one after another. A page that doesn't offer one of the saved labels
leaves it saved and says so, as it does for any other filter.

## The repo and author filters

The repo and author filters work like the Label filter: each is a button that
opens a group of checkboxes, the pull requests and issues shown are the ones
that match **any** ticked repo and **any** ticked author, and the button names
one pick or counts several ("2 repos", "2 authors"). Each has a Clear button
under the choices. A repo is listed with its forge, under a heading per forge
when more than one forge has a repo on screen, so one name on two forges stays
two choices. Each heading is a named group for a screen reader, and a single
picked repo is named with its forge in the button and the chip ("acme/web
(Forgejo)").

An author is listed the way a repo is: one login on two forges is two people,
so it is two choices, each under its forge's heading when several forges
show, and a pick matches only that forge's pull requests and issues. A
single picked author is named with its forge in the button, as a repo is. An
author matches on the whole login, in any case. The filter used to match
any login that contained the saved text, so a saved `ann` also showed
`annabel`; it no longer does, and the list offers whole logins to tick. A
partial login saved by hand, such as `ren` for `renovate[bot]`, is not on offer
either, so it is set aside and named under the filter bar with a Clear button,
and it is dropped for good once you change the author control.

Each repo shows its own logo and each author their avatar beside the name, in
the choices and on the chips below the search on a phone. When there is no
image, or it does not load, the first letter of the name stands in. The images
are decoration for sighted readers; the name beside them is what a screen
reader speaks. An avatar or logo is shown only over HTTPS.

The choices narrow each other as the Label filter's do, so ticking a repo
drops an author who has nothing in it. Pick the control you care most about
last, or tick the other one again afterwards. A value saved before the list
existed is read as a list of one. A pick holds up to 20 values, and the server
refuses a longer one. A page that does not offer a saved repo or author leaves
it saved and says so. The Insights page shows the same two controls.

A live update redraws an open panel's choices without moving you: keyboard
focus stays on the checkbox you are on, even when the update adds a second forge
and the repos regroup under their headings. If that choice is gone, focus moves
to the panel's button, the panel stays open and a screen reader hears that the
choice is no longer offered.

## Remembered filters

Filters are remembered per account, in a cookie and in a copy on the server,
so they follow you to another browser. The repo, author, label, created
and updated choices each page offers come from its own list. When
you open a page that doesn't offer a saved choice (an author who wrote no
pull request, on the pull requests page), that page shows its list without
it and leaves the saved choice alone, so it is still set when you go back to
the page that does. The page says so under the filter bar (`Saved author
"x" is not on this page.`) with a Clear button, and Clear filters is on and
ends the saved choice too. Changing that control on the page ends it as well.
An author saved by an earlier release as a bare login (`ann`, with no forge) is
read as that whole login (in any case) on every forge that has it, and saved
again in the forge-qualified form (`github:ann`) the first time the page
reconciles its picks. A bare login no author on the page has is set aside like
any other, and the note says it has no forge (`Saved author "ann" has no forge
and is not on this page.`); Clear removes it. A pick holds at most 20 values, so
a bare login that expands past that leaves the extra choices out, and a
"Filters trimmed" notice says how many.
Text typed in the title search or the hide-titles pattern is sent to the
server half a second after the last key, and at once when you leave the page
or switch tab, so a value typed just before leaving is kept. The title search
stops at 200 characters to keep it small in the cookie. A title in a script
that takes several bytes a letter still counts for more there, and with three
full picks it can pass the cookie's room.
Each save carries a revision number, in the cookie and in the server copy. When
a page loads, the server copy is applied unless the cookie holds a newer
revision, so a value typed just before a reload is not replaced by an older
copy whose save was slow or lost. The page then sends the cookie's state to the
server. A copy with no revision, or the same one, wins as before.
What is deliberately not remembered: the page you were on and the page size,
the open Filters sheet on a phone, held updates, open menus and pop-ups, the
hidden pull requests panel, and the expanded rows on Branches. The Branches
status, forge, advisories and search follow you to another browser the same
way, and so do the Webhooks forge buttons, repo search, status select and sort.
The Webhooks page size is not remembered, as on the other pages.

## Filters on a phone

Below 760px wide the filter bar folds down so the first screen shows pull
requests. Closed, it is one search row (the title filter and a **Filters**
button) and one row of quick filters that scrolls sideways. The button's count,
as in "Filters (2)", is how many filters are on: forge, repo, author, each label,
created, updated and Show drafts. Each active filter also shows as a chip you
can tap to remove without opening anything.

**Filters** opens a bottom sheet with the rest of the controls: forge, Show
drafts, sort, group, repo, author, label, created and updated. Filters apply as
you change them, and the sheet's **Show N results** button, which closes it,
says what you would see, so a refresh can't change something you are editing.
**Clear all** resets everything. Escape, the close button, or a tap outside
closes the sheet and returns focus to the Filters button. On wider screens
nothing changes except that the title filter now sits first in the bar.
