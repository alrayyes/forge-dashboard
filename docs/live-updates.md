# Live updates

The board polls on the schedule in `readIntervalSeconds` (30 seconds today, set
by the server, or 2 until your first refresh has finished) and takes pushes
over a live stream, but
rows don't move while you're reading. A change to a row's own content (CI,
merge status, behind, labels, title) updates that row where it stands and
marks it "Updated just now" for a couple of seconds. Anything that would
add, remove or reorder rows waits behind an "N updates available" bar
under the filter bar; **Show updates** applies it all in one render, and so
does changing a filter, the sort or the page. Nothing re-renders while
focus is inside a row, a More actions menu is open, a modal window is open, or a
row action is in flight. **Pause live updates** stops every automatic
update until you turn it back on (Refresh now still works). The **Sort**
control offers Last activity (the default, the server's order: most recently
updated first, whether or not a pull request is ready to merge), Created and
Repository. Pause and sort are saved with your other filters.

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
