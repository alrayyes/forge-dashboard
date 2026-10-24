# Issues

Open issues have their own page, `/issues.html`, reached from the **Issues**
item in the navigation. The item carries a count badge, the number of open
issues without Renovate's Dependency Dashboard, which the page hides by
default. The badge is set from each snapshot on the dashboard and issues
pages, and loaded once on the other signed-in pages.

An issue's title opens a pop-up with its description and comments, laid out
like a pull request's. It loads when it opens, from `GET /api/issues/details`,
and nothing about it is part of the snapshot. The header shows whether the
issue is open or closed, who filed it with their avatar, and its labels, and
the footer links to the issue on its forge. The status follows the forge while
the pop-up is open: when a refresh no longer lists the issue, lists it again,
or shows it changed, the pop-up reads the forge again, so closing or reopening
the issue there turns the badge to Closed or back to Open without reopening the
pop-up. If the forge can't be read, the pop-up says why and offers **Try
again** instead of showing an empty thread. Escape or **Close details**
returns you to the issue's row.

## Closing an issue from its pop-up

The footer offers **Close issue** and **Close with a comment**. There is no
merge or rebase on an issue.

- **Close issue** asks you to confirm. **Confirm close issue?** closes it,
  **Cancel** or Escape drops the step.
- **Close with a comment** opens a **Comment** field. **Comment and close**
  posts the comment, then closes the issue. A blank comment is not sent.
  Escape closes the field and keeps the pop-up open.

A close works the way it does on a pull request. The pop-up stays open, the
badge turns to Closed, and focus moves to **Reopen issue**, which is the undo:
there is no timer. The issue leaves the list on the next refresh. Reopening
puts the badge back to Open.

Because the comment and the close are two requests to the forge, one can work
while the other fails. The pop-up then says which: "Your comment was posted.
The issue is still open." offers **Retry close** and never posts the comment
again, and "Your comment was not posted." offers **Retry comment**. Your text
stays in the field until the close goes through.

When the forge refuses, the buttons lock and the reason is printed beside
them, as it is for a pull request: a token without write access to issues, a
spent rate limit (with the time it resets), or a forge that can't be reached.
A refusal about permission does not clear by clicking again. Fix the token and
reopen the pop-up. A forge error that passes by itself keeps the buttons live.

Closing and commenting need write access to issues, which listing them does
not. On GitHub that is **Issues: Read and write** on a fine-grained token, the
`repo` scope on a classic one, or the repository permission for issues set to
read and write on a GitHub App installation, accepted on the installation. On
Forgejo it is the `write:issue` scope. The Connections page in Settings lists
them.

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

## Finding an issue by its number

The title box (`Title or #number`) also takes a ticket number. `1884` or
`#1884` lists the issues whose number starts with it, one per repo that has it,
and `18` lists 18, 180, 1884, and so on. The `#` is optional. The box still
matches titles too, so `2024` finds an issue with 2024 in its title, and
`#1884` finds one whose title holds those characters. It is the same box as the
title search, so it is remembered with the other filters and **Clear filters**
empties it. The Pull requests and Bots
pages take a number in their title box the same way.

## Who filed it

A row shows the avatar of whoever filed the issue to the left of their name,
the same as a pull request row. It is the forge's own HTTPS image URL, loaded
straight from the forge by your browser. When the forge sends none, the URL
isn't HTTPS, or the image can't load, the row shows the name alone. The narrow
layout drops the author column, avatar and all.

The avatar and the name are one link to that person's page on the forge, in a new
tab, on the row and on the pop-up's "Filed by" line. A deleted account has no
link.

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

## Pull requests that close an issue

An issue that an open pull request is set to close shows a small link after its
title and labels: the pull request's number with a hash sign, followed by
`draft` when it is a draft. A pull request in another repository than the
issue's adds the repo name before the number. Screen readers hear "Pull
request", the number, "draft" when it is one, and "closes this issue". A pull
request counts when its description closes the issue with a keyword such as
"closes" or "fixes" and it aims at its repo's default branch, the same rule the
pull request page uses for the issues it lists.

The issue's pop-up shows the same links among its attributes, with the
pipeline of each pull request as on the row, and nothing when no pull request
closes it. They are links to the
[pull request page](pull-request-pages.md#pull-request-details), so a middle
or modified click opens that page in a new tab. A plain click closes the
issue's pop-up and opens the pull request's in its place, on the Issues page, so
you stay where you are and the address and the browser history don't change.
Closing that pop-up puts keyboard focus back on the pill in the list. The links
follow the board while the pop-up stays open.

The server works this out, from the pull requests it already holds, so it costs
the forge no request. It counts a draft, and a pull request you hid, but not
one in a repo whose pull requests you ignore. When it merges or closes, the
link goes with the next refresh. In `GET /api/dashboard` each issue has
`linkedPullRequests`, ordered by repo and number, and always present.

A row shows the first two and, when there are more, a link such as "2 more"
that shows the rest in place. Each pill is a button that opens that pull
request's pop-up on the Issues page, where you are, so your filters and place in
the list stay as they were. Closing the pop-up with Escape puts keyboard focus
back on the pill. The address stays as it is. A pull request has its own page
too, and `/pull-requests.html?pr=github/alrayyes/hush-hush/12` (or Releases or
Bots for a release or a dependency update) still opens the same pop-up from a
link or a bookmark, then drops `?pr=` so a reload doesn't open it again. A
draft while **Show drafts** is off, or a pull request you hid, opens read only,
without the actions, since it has no row to act from. A pull request that isn't
open any more, or whose repo the dashboard doesn't track, opens nothing, and
the page says so in a note over the list.

## Pull requests that mention an issue

A pull request can mention an issue without closing it, with `Refs #12` or a
link in its description. In `GET /api/dashboard` each issue lists those open
pull requests as `mentionedByPullRequests`, always present, ordered by repo and
number and with the same entries as `linkedPullRequests`. A pull request that
closes the issue is only in `linkedPullRequests`; one whose `Closes` doesn't
close, because it aims at a branch other than the default, is listed here. The
server works this out from the pull requests it already holds, so it costs the
forge no request. The
issue's pop-up lists them after "Mentioned in", drawn like the closing pull
requests, and a plain click swaps the pop-up for that pull request's. The label
and the pills are absent when no pull request mentions the issue. The rows don't
show them. How a
mention is read is in [Tickets a pull request
mentions](pull-request-pages.md#tickets-a-pull-request-mentions).

## Opening an issue from its address

An issue's pop-up can open from the address. The Issues page opens it when the
address ends in `?issue=` followed by `forge/owner/name/number`, so
`/issues.html?issue=github/alrayyes/hush-hush/12` opens the pop-up for that
issue. The "Closes" pills on [pull
requests](pull-request-pages.md#issues-a-pull-request-closes) open the same
pop-up in place instead. Closing the pop-up leaves you on the page, with
keyboard focus on that issue's title in the list. If your filters leave the row
out, focus goes to the **Filter by title** box instead, so it never falls back
to the top of the page. The address loses `?issue=` so a reload doesn't open it
again. If the issue is closed, hidden by your settings, or in a repo the
dashboard doesn't track, no pop-up opens and a note over the list says why.

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

The issues page filters like the pull request page: forge, repo, title, author,
label, created and updated, plus Group by. Those filters are shared and saved
with your other filters, so a filter set on one page is still set on the other.
A **Closing PR** control adds Any, **Has a closing pull request** and **No
closing pull request**, to find the issues something is already fixing and the
ones nothing is. Only this page's list is filtered by it, it is saved and
restored like the others, and a choice is offered only when some issue is that
way. On a phone it is in the Filters sheet.
The pull-request-only controls (the CI quick filters, the quick filters for
failing, ready, needs-review and conflicting pull requests, Show drafts) are not
on the issues page. Which choices a page offers, and how filters are remembered,
is in [Live updates and filters](live-updates.md#remembered-filters).

The issue list holds still while you read it. A refresh that would add, remove
or move rows waits while you're scrolled below the top, a control in the list
has focus, the pointer rests on the list, another pop-up is open, or live
updates are paused, and then lands by itself: scroll back to the top, move the
pointer off the list, close the pop-up or resume. Nothing needs pressing, and a
change to a filter or the sort applies it too. Only issues the list would show
count: a change to one the filters or the hidden Dependency Dashboard keep out
of sight waits for nothing, and neither does a change to pull requests. When
rows do land, one polite line tells a screen reader ("List updated: 1 added").
A row whose own content changed updates where it stands, and a refresh with no
change leaves every row alone. Sort works as it does for pull requests. The
pause setting is shared with the pull request page.
