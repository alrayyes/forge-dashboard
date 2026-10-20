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
waiting for its second click), a More actions menu or a pop-up other than the
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

Draft pull requests are left out by default. The **Show drafts** toggle in the
filter bar, off to start with, brings them back, marked "Draft", and its muted
"N hidden" count says how many are left out. The choice is saved like the other
filters and goes with every dashboard request, refresh and the live stream.

## The first load after a restart

A restarted server holds no state until your first refresh has finished, so its
first snapshot is empty. While the snapshot's `firstRefreshDone` is `false`,
Pull requests, Releases, Bots, Issues and Branches show placeholder rows and one
polite "Loading your repositories…" line, not their empty states, and the
navigation shows a dash where a count would be. After about ten seconds the line
says the first refresh can take a while. The placeholder doesn't animate under
reduced motion. A snapshot without the flag counts as loaded. An unreachable
forge still shows in the forge health banner. While the flag is `false` the
server also advises a short `readIntervalSeconds` of 2, so the rows appear
soon after the refresh ends, not up to 30 seconds later.

## The first refresh

After a restart the server holds no state, so the first snapshot is empty until
the first refresh for that user ends. `firstRefreshDone` on the dashboard
snapshot tells an empty board from one that hasn't loaded: it is `false` from
process start until the viewer's first refresh has finished, whether it
succeeded or failed (a failed one shows in the forge health), and `true` from
then on, including after later refreshes and settings saves. It is per user and
not stored, so a restart resets it. An account with no saved settings has
nothing to refresh, so it reads `true` at once. `GET /api/dashboard`, the
stream and the `get_dashboard` MCP tool all carry it.

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

`GET /api/dashboard` and its stream carry `navCounts`, the numbers behind every
navigation badge: for Branches, Pull requests, Releases and Bots a `total` and
how many have CI `running`, `failed` and `passed` (a branch by its
default-branch pipeline); and for Issues a `total` only. A pull request with no
checks counts in the total alone, so the four numbers need not add up. A branch
with no pipeline is counted as `none`, so a branch's four states add up to its
total. They count what each page shows when it opens. Pull requests
leave out ignored repos, drafts and hidden ones, even while Show drafts or
Show hidden is on. Branches counts the default branches its page lists, which
also leave out ignored repos. They are always present, zero when nothing is
there.

## Which filter choices a page offers

The repo, author and label choices on the pull request, release, bot and issue
pages and on Insights come from what the page can show: the items every other
filter lets through, and without the Dependency Dashboard while it is hidden. A
repo whose only issue is that one isn't offered until **Hide Dependency
Dashboard** is unchecked. Hiding it again clears a repo picked on that basis.
The CI status select, the Created and Updated ranges and the forge buttons on
Insights follow the same rule: a CI state, a range or a forge appears only when
something in the results is in it, and a pick that nothing matches any more is
cleared. On the pull request page the repo, author and label choices and the CI
and age choices also follow the board's own filters (the quick pills, CI status
and Auto-merge), so an author with nothing in the list on screen isn't offered
and picking a choice never leaves an empty list. The quick pills do too: a pill
is offered only when clicking it would show something, and the one that is
active stays so it can be cleared.

## Remembered filters

Filters are remembered per account, in a cookie and in a copy on the server,
so they follow you to another browser. The repo, author, label, created,
updated and CI status choices each page offers come from its own list. When
you open a page that doesn't offer a saved choice (an author who wrote no
pull request, on the pull requests page), that page shows its list without
it and leaves the saved choice alone, so it is still set when you go back to
the page that does. The page says so under the filter bar (`Saved author
"x" is not on this page.`) with a Clear button, and Clear filters is on and
ends the saved choice too. Changing that control on the page ends it as well.
Text typed in the title search or the hide-titles pattern is sent to the
server half a second after the last key, and at once when you leave the page
or switch tab, so a value typed just before leaving is kept.
Each save carries a revision number, in the cookie and in the server copy. When
a page loads, the server copy is applied unless the cookie holds a newer
revision, so a value typed just before a reload is not replaced by an older
copy whose save was slow or lost. The page then sends the cookie's state to the
server. A copy with no revision, or the same one, wins as before.
What is deliberately not remembered: the page you were on and the page size,
the open Filters sheet on a phone, held updates, open menus and pop-ups, the
hidden pull requests panel, and the expanded rows on Branches. The Branches
status, forge and search follow you to another browser the same way, and so do
the Webhooks forge buttons, repo search, status select and sort. The Webhooks
page size is not remembered, as on the other pages.

## Filters on a phone

Below 760px wide the filter bar folds down so the first screen shows pull
requests. Closed, it is one search row (the title filter and a **Filters**
button) and one row of quick filters that scrolls sideways. The button's count,
as in "Filters (2)", is how many filters are on: forge, repo, author, label,
created, updated, CI status, and Show drafts. Each active filter also shows as a
chip you can tap to remove without opening anything.

**Filters** opens a bottom sheet with the rest of the controls: forge, Show
drafts, sort, group, repo, author, label, created and updated. Filters apply as
you change them, and the sheet's **Show N results** button, which closes it,
says what you would see, so a refresh can't change something you are editing.
**Clear all** resets everything. Escape, the close button, or a tap outside
closes the sheet and returns focus to the Filters button. On wider screens
nothing changes except that the title filter now sits first in the bar.
