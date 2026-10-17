# Issues

Open issues have their own page, `/issues.html`, reached from the **Issues**
item in the navigation. The item carries a count badge, the number of open
issues without Renovate's Dependency Dashboard, which the page hides by
default. The badge is set from each snapshot on the dashboard and issues
pages, and loaded once on the other signed-in pages.

Next to **Hide Dependency Dashboard**, the **Hide titles matching (regex)**
box hides the issues whose title matches a regular expression. The match is
case-insensitive and can fall anywhere in the title, so `^Weekly report` hides
every issue whose title starts with "Weekly report". Empty hides nothing. A
note says how many issues the pattern hides, and the repo, author and label
choices leave out what it hides. The pattern is saved with the other filters,
and **Clear filters** empties it. A pattern the page can't use is ignored and
the list stays as it was. A syntax error shows "That pattern isn't valid." A
pattern that parses but could be slow shows "That pattern is too complex to
check safely. Try a simpler one." The page estimates how many ways the pattern
can match, multiplying every alternative and repeat, and refuses one that is
too many: more than 200 characters, two or more open-ended repeats (`*`, `+`,
`{2,}`) in one pattern (so `\d+\.\d+` and `.*foo.*bar` are refused, while
`start.*end` is fine), or repeated and chained groups such as `(a+)+`,
`(a+){5}` or `(a|b)?` written twenty times in a row. It tests only
the first 128 characters of a title. This is a safety margin tested by
fuzzing, not a proof. The rule applies to the Issues board only; Insights
charts ignore it.

## First refresh

After a restart the server holds no state, so the first snapshot is empty until
the first refresh for that user ends. `firstRefreshDone` on the dashboard
snapshot tells an empty board from one that hasn't loaded: it is `false` from
process start until the viewer's first refresh has finished, whether it
succeeded or failed (a failed one shows in the forge health), and `true` from
then on, including after later refreshes and settings saves. It is per user and
not stored, so a restart resets it. An account with no saved settings has
nothing to refresh, so it reads `true` at once. `GET /api/dashboard`, the
stream and the `get_dashboard` MCP tool all carry it.

## Issues your settings hide

Two settings, saved with your account and applied by the server, keep issues
out of everything you see:

- **Hide Dependency Dashboard** (`hideDependencyDashboard` in the API) leaves
  out the bot-kept Dependency Dashboard issue.
- **Ignored titles** (`ignoredTitles`) is a list of patterns. An issue whose
  title matches at least one is left out. A pattern matches anywhere in the title
  and ignores case, so `^Weekly report` leaves out every issue whose title
  starts with "Weekly report".

The server drops those issues from `issues` in `GET /api/dashboard`, its
stream and the `get_dashboard` MCP tool. `openIssueCount` and
`navCounts.issues.total` count what remains, so the navigation badge, the
Issues board and Insights agree with no arithmetic in the client.
`settingsHiddenIssueCount` says how many issues the settings dropped, and is
`0` when none were. The same response carries `hideDependencyDashboard` and
`ignoredTitlesSet` (true when the list isn't empty), so a client knows whether
to draw its own fields without reading `/api/settings`.

`GET /api/settings` and the response to saving it also carry
`ignoredTitleCounts`: for each pattern in `ignoredTitles`, in the same order,
how many of your open issues that pattern matches on its own. An issue two
patterns match counts for both, so the entries can add up to more than
`settingsHiddenIssueCount`. Issues of a repo whose issues you ignore aren't
counted, as with that total. Every entry is `null` while the answer isn't known
yet, because your first refresh hasn't finished or no forge answered it, and
never a made-up `0`. The
response to a save counts the list just saved, against the issues you had
before the save.

Patterns use Go's RE2 syntax. It has no lookahead, lookbehind or
backreferences, and it can't run slowly, so no pattern is refused for being
complex. A pattern that matches the empty string, such as `.*` or `^`, is
refused: it would match every title and hide every issue. Saving trims each
pattern, drops blanks and repeats (ignoring case), and takes at most 20
patterns of at most 200 characters. A pattern that doesn't compile is a 400
that names `ignoredTitles` and the entry, counted from 1 in the list as sent,
and says why, as in `ignoredTitles entry 2 ("("): missing closing )`.
Nothing is saved then, not the other patterns and not the other settings.

On a dashboard someone shared with you (`?owner=`), the issues are theirs and
the settings are yours: your own choices decide what you see, and theirs don't
reach you.

## Issues in Settings

The **Issues** section of Settings holds two standing rules, saved with the
account and applied by the server, so they follow you to another browser:

- **Hide the Dependency Dashboard issue** leaves Renovate's Dependency
  Dashboard out everywhere.
- **Ignored issue titles** is a list of up to 20 patterns of up to 200
  characters. An issue whose title matches any of them is left out. A
  pattern matches anywhere in the title and ignores case, so `^Weekly report`
  leaves out every issue whose title starts with those words. Type a pattern
  in **Pattern**, then press **Add**. **Remove** drops an entry. Blanks and
  repeats are dropped. Both settings save with the **Save** button.
  Next to each saved pattern a small label says how many of your open
  issues it hides on its own: "hides 3 issues", "hides 1 issue" or "hides no
  issues", so a typo that matches nothing stands out. An issue that two
  patterns match counts for both. The server does the counting, so the numbers
  agree with the Issues page. A pattern you just added says "Counted after you
  save" until the save finishes, and the labels follow each save without a
  reload. When a save comes back before the server can count (your first save,
  or one before the first refresh finished), the labels say "Counting…" and the
  page asks again, up to five times two seconds apart. If no count arrives,
  nothing shows next to the pattern.

Because the server applies them, the Issues badge in the navigation, the
Issues page and the Insights issue charts all leave those issues out, and the
Issues page and Insights say "N hidden by your settings" with a link back to
Settings. They cover issues only, not pull requests. The server checks the
patterns with Go's own syntax (RE2), which cannot look ahead or refer
back to an earlier match, unlike the filter box on the Issues page. A pattern it
refuses is shown beside the list with the reason, and nothing is saved.

While a setting applies, the page's own field for it is not shown: the **Hide
Dependency Dashboard** checkbox on the Issues page and Insights while the first
setting is on, and the **Hide titles matching (regex)** box while the list has
an entry. What you had in those fields is kept, not used, and comes back when
you turn the setting off or empty the list. **Clear filters** changes neither
setting.

The repo, author and label choices on the pull request, release, bot and issue
pages and on Insights come from what the page can show: the items every other
filter lets through, and without the Dependency Dashboard while it is hidden. A
repo whose only issue is that one isn't offered until **Hide Dependency
Dashboard** is unchecked. Hiding it again clears a repo picked on that basis.
The CI status select, the Created and Updated ranges and the forge buttons on
Insights follow the same rule: a CI state, a range or a forge appears only when
something in the results is in it, and a pick that nothing matches any more is
cleared. The CI and age choices also follow the other one and the quick pills,
so picking one never leaves an empty list. The quick pills do too: a pill is
offered only when clicking it would show something, and the one that is active
stays so it can be cleared.

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

The issues page filters like the pull request page: forge, repo, title,
author, label, created and updated, plus Group by. Those filters are shared
and saved with your other filters, so a filter set on one page is still set on
the other. The pull-request-only controls (CI status, the quick filters for
failing, ready, needs-review and conflicting pull requests, Show drafts)
are not on the issues page.

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
What is deliberately not remembered: the page you were on and the page size,
the open Filters sheet on a phone, held updates, open menus and pop-ups, and
the expanded rows on Branches. The Branches status, forge and search follow
you to another browser the same way.

The issue list holds still while you read it. A refresh that would add, remove
or move rows is held behind an "N updates available" bar while you're scrolled
below the top, a control in the list has focus, or live updates are paused;
**Show updates**, or a change to a filter or the sort, applies it. The bar
counts only issues the list would show: a change to one the filters or the
hidden Dependency Dashboard keep out of sight asks for nothing, and neither does
a change to pull requests. At the top with nothing focused, changes just appear.
A row whose own content changed updates where it stands, and a refresh with no
change leaves every row alone. Sort works as it does for pull requests. The
pause setting is shared with the pull request page.
