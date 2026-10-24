# Pull request pages

## Pull request details

Clicking a pull request row, anywhere on it, opens a pop-up. The row's title is
the button that does it, stretched over the row; the CI pill, the labels and the
row's own buttons stay clickable on top of it. On a phone the row's one button
is the last tier of the card: after a divider, the full width and 44 pixels
tall. A locked Merge stays there greyed; the status block just above it says
why, and the button is described by it. The pop-up has the pull request's
description, its comments and the thumbs up and thumbs down reactions on each,
and an **Open on GitHub** (or Forgejo) link. On the Releases page the pop-up
shows the release notes in place of the description. A Dependabot or Renovate
pull request opens the same pop-up, with its long generated description folded
away until you open it.

The footer of the pop-up has every action a pull request offers, so it can be
acted on from it. The row itself draws only the main one. The footer lists the
main action first (the one the server marks primary), then the others, with
**Close pull request** last, on the right. Close pull request is an outlined red
button with a pull-request-closed icon, so it doesn't pass for the pop-up's own
close, which is the X at the top right. Closing can't be undone from the
dashboard, and the two-step confirm still guards it. The buttons have the same
states on the row and in the footer: locked with the reason, queued, in flight
and the two-step confirm for Merge and Close. A locked button stays on screen,
greyed, with the reason printed as text beside it or in the status block under
the header, and described to screen readers. A failure shows as a line above
the footer, with room for several, and leaves the buttons usable. The footer
also holds Hide this pull request and Hide for 7 days, and **Rerun failed
checks** when CI is failing and the server offers it. Results are spoken
through a status region inside the pop-up, since the page's own is out of reach
while a modal is open. Escape first ends an armed confirm and a second press
closes the pop-up. The footer follows its
pull request while the pop-up is open: when a refresh changes what it offers,
the footer changes with it, and when the pull request has left the board
(closed or hidden, or merged somewhere else) the footer says so and keeps only
the link to the forge. Merging from the pop-up closes it. On a phone the pop-up
is a full-height sheet whose footer stays at the bottom, with 44 pixel buttons
that wrap.

A pull request's pop-up can also open from the address. A page that lists
pull requests opens it when the address ends in `?pr=` followed by
`forge/owner/name/number`, as the links on the
[Issues page](issues.md#pull-requests-that-close-an-issue) do, and then drops
that part of the address. A pull request that isn't on the board because it is a
draft or you hid it opens read only, without actions in the footer. One that
isn't open any more gets a note over the list instead. Closing a pop-up opened
this way leaves you on the page, with keyboard focus on that pull request's
title in the list. If your filters leave the row out, or it was opened read
only, focus goes to the title filter box.

The pop-up loads when it opens, from `GET /api/pull-requests/details`, and
never as part of the dashboard snapshot, so a forge's budget isn't spent on
rows nobody opens. While the pop-up is open, a refresh that shows the pull
request was updated fetches the details again and swaps them in place, without
the loading skeleton. It shows the first 50 comments and says so when there are
more. The header draws the row's three tiers as they were when it opened: the CI
slot first (Running, Failed or Passed, the row's glyphs and words) with a
Conflicting or Blocked pill beside it when the row has one, then the title,
then the attributes as quiet outlined chips (auto-merge, draft, bot, out of
date, labels, and the version on the Releases page). Each comment carries the
author's avatar (the forge's own HTTPS image URL, or an initial if it isn't one
or can't load), a relative time and an
"edited" mark. The avatar and the name are one link to that person's page on
the forge. A deleted author reads "ghost" and isn't a link. Hovering or
focusing a reaction lists who gave it, up to ten names and then "and N more";
Escape hides that list first and a second press closes the pop-up. Reactions
are display only. When the details can't load, it says so in plain words with
**Try again**.

The text is Markdown and the server doesn't sanitise it, so the page renders
it with [markdown-it](https://github.com/markdown-it/markdown-it) with raw HTML
off: tags show as text, images aren't loaded, only absolute `http`, `https`
and `mailto` links are links (anything else stays plain text), and they open
in a new tab with `rel="noopener noreferrer"`. Task list items (`- [x]` and
`- [ ]`) show as read-only checkboxes; ticking one changes nothing on the
forge. Emoji codes such as `:robot:` show as the emoji, as the forges
draw them; they become plain Unicode characters, never images, and code stays
as written. Emoticons like `:)` aren't touched. The library and its emoji
table load the first time a pop-up opens.

The header's repository name and number are two links, to the repository and
to the pull request on the forge. In the description, release notes and
comments, `#12` and `owner/repo#12` become links to that issue or pull request
on the same forge, as the forges themselves draw them; the forge sends you on
to the pull request when the number is one. Code, a word like `abc#12` and
text already inside a link stay as written. The page builds these addresses
from the pull request's own address, so they follow whichever forge it came
from.

## Finding a pull request by its number

The title box (`Title or #number`) on the Pull requests, Bots and Releases
pages also takes a pull request number. `2509` or `#2509` lists the pull
requests whose number starts with it, one per repo that has it, and `25` lists
25, 250, 2509, and so on. The `#` is optional. The box still matches titles
too, so `2024` finds a pull request with 2024 in its title. It is the same box
as the title search, so it is remembered with the other filters and **Clear
filters** empties it.

## Issues a pull request closes

A pull request that will close issues shows a "Closes" link for each, after
its title on the row and among the attributes in the pop-up. The row shows the
first two and, when there are more, a link such as "2 more" that shows the rest
in place. An issue in another repository than the pull request's names its
repo. On a row, each pill is a button that opens that issue's pop-up on this page,
and Escape puts focus back on the pill. An issue the board doesn't list still
opens, with a link to its forge, and the pop-up says plainly if the forge can't
show it. Inside a pull request's own pop-up the pill is a link to the
[Issues page](issues.md#opening-an-issue-from-its-address), so a middle or
modified click opens that page in a new tab. A plain click closes the pull
request's pop-up and opens the issue's in its place without leaving the
page, with the address and your filters untouched. Screen readers hear
"Closes", the number and "opens the issue".

The server works out which issues those are, and builds the address that opens
each. In `GET /api/dashboard` each pull request has `closesIssues`, always
present, and each entry carries the `pageUrl` that opens it.

## Tickets a pull request mentions

Besides the issues it closes, a pull request can mention others: `Refs #12` in
its description, or a link to a ticket in its title. The server reads the title
and description on both forges and lists what it finds, without a closing
reference, in `GET /api/dashboard` as `mentionsIssues`, always present. A
mention is what GitHub and Forgejo both turn into a link: `#12`,
`owner/repo#12`, the address of an issue or pull request page on the forge, and
on GitHub `GH-12`. It has to stand alone, so `abc#12` and `#12abc` are not
mentions, while emphasis and table markup around one (`**#12**`, `_#12_`,
`|#12|`) is fine. Code and HTML comments are skipped, as they are for closing
references, and a quoted line still counts. The text of a link is
skipped too, whether it is written in Markdown (also the reference style) or as
an HTML anchor, since a dependency update's release notes are full of links such
as `<a href="https://redirect.github.com/org/lib/issues/1234">#1234</a>` that
name another project's tickets. A link counts only by its address, and only when
that is a page on the forge. Only the first 64 KiB of the description is read
(cut at a space, Unicode spaces included, or at the last comma or semicolon
outside brackets when there is none, so a number is never read half-written; a
bracket left open for over 1 KiB there is taken for a stray one, and a link
anchor still open within 1 KiB of the cut loses the text after its tag),
and the first 100 references in it, so a pasted changelog doesn't slow the
refresh down. Whether a closing keyword closes depends on the branch the
pull request aims at: on one that doesn't target the default branch (a stacked
pull request) `Closes #12` closes nothing, so it is listed as a mention. A
keyword in the title doesn't close either, so it is a mention as well. A
closing keyword takes an ordinary space before its number, as Forgejo reads it;
a no-break or other Unicode space there closes nothing and the number is listed
as a mention. A ticket
the pull request does close is never repeated, and neither is the pull request
itself. The list holds at most 20, counted after the closed ones are taken off.
Comments, reviews and commit messages are not read. Without a GitHub token the
server reads the same text from GitHub's public listing, so the lists are the
same.

Each entry says whether the dashboard `tracked` it as an open issue it shows.
Where it does, `pageUrl` opens that issue's pop-up; where it doesn't (a closed
issue, another repo, a pull request), a client links to `url` on the forge.

The pull request's pop-up shows each one among the attributes, after the issues
it closes, as a "Mentions" link drawn like the "Closes" ones. A tracked ticket
opens on the [Issues page](issues.md#opening-an-issue-from-its-address) in a
new tab on a middle or modified click, and its pop-up in place of this one on a
plain click. One the
dashboard doesn't hold opens on its forge in a new tab, and screen readers hear
"opens on the forge" instead of "opens the issue". The first two show, and the
rest sit behind a "more" button that opens them in place, as with the closing
ones. With nothing mentioned, the pop-up shows no label and no empty space. The
rows don't show mentions.

## Author on a row

A row shows the author's avatar to the left of their name. It is the forge's
own HTTPS image URL, loaded straight from the forge by your browser. When the
forge sends none, the URL isn't HTTPS, or the image can't load, the row shows
the name alone. The narrow layout drops the author column, avatar and all.

The avatar and the name are one link to the author's page on the forge, opening
in a new tab. The server builds the address from the forge's own web address, so
a self-hosted Forgejo works the same as GitHub. A GitHub bot such as Dependabot
links to its app page. A deleted account ("ghost"), or an address that isn't a
web address, shows the name without a link. Clicking it never opens the row's
pop-up. Issues rows link their author the same way.

## Repository logo

A row, and the Repositories page, show a repository's own logo to the left of
its name when it has one. On Forgejo, that is the avatar set on the repository.
On GitHub, it is the custom social preview image uploaded in the repository's
settings, which is a wide banner, so it is cropped to a small square. The
generated card GitHub makes for a repository with no image is never shown, and
neither is the owner's avatar. The image is the forge's own HTTPS URL, loaded
straight from the forge by your browser. A repository with no logo, an image
that isn't HTTPS or one that can't load shows the name alone. The unauthenticated
username-only listing carries no images, so it shows none.

## Long repository names

A repository name that is too long for its column is cut with an ellipsis. Hover
it and the whole `owner/name` shows as hover text, the same as a cut pull
request title. A name that fits has no hover text, since it would only repeat
what the row already shows. A click on the name opens the pull request, like a click
anywhere else on the row.

## Releases

Release pull requests have their own page, `/releases.html`, reached from the
**Releases** item in the navigation. It is the pull request board over the pull
requests the server marks `kind: release` (release-please's, by its
`autorelease:` label, or by its `release-please--branches--<base>` head branch
when release-please failed before it could label the pull request, as long as
the pull request is from the same repository and aimed at that base), with the
same filters, rows and actions as the main page. The main pull request page
lists none of them, and doesn't count them. Each row shows the version being
released next to the title. Merge is offered when the release can merge, or
greyed out with the reason when it can't. A release that is behind its base
branch gets Update branch and a line saying release-please won't update it until
a releasable change lands, and its row carries the Out of date badge like any
other behind pull request. With no release pull requests open the page says
nothing is waiting to ship.

The quick filter pills above the list include **Failing CI**, **Running CI**,
**Passing CI** and **No checks**, each offered only when it would show
something. They are the only CI filter: the board header has no separate CI
status dropdown, on this page, Releases and Bots. The **No checks** pill shows
the pull requests that have no CI configured. A CI status saved from when the
dropdown existed becomes the matching pill when the page loads, unless a pill or
a forge is already picked, in which case it is dropped, so nothing stays
filtered out of sight. The **Out of date** pill, on this page and on Bots,
keeps the pull requests whose base branch has moved on, the same ones that
carry the row's Out of date badge. An empty pull request is left out. The
choice is saved like the other pills. Next to them an **Auto-merge** control
has Any, On and Off. On shows only pull requests that have auto-merge armed, Off
only those without. It combines with a pill, so Failing CI with Auto-merge On
finds armed pull requests whose checks have since failed.

A **Closing issue** control beside it has Any, **Closes an issue** and **Closes
no issue**. The first keeps the pull requests that will close at least one
issue when they merge (the ones with a "Closes" pill), the second the rest.
Like Auto-merge it is saved with your other filters, comes back after a reload,
is emptied by **Clear filters**, and offers a choice only when something in the
list is that way. On a phone it is in the Filters sheet with 44px choices. The
pick is shared with the Bots and Releases pages, which filter by it too, so a
pick made here can leave those lists empty; the control shows it there, and Any
or **Clear filters** brings the rows back.

## Bots

Dependabot and Renovate pull requests have their own page, `/bots.html`,
reached from the **Bots** item in the navigation. Like Releases, it is the pull
request board over the pull requests the server marks `kind: dependency`, with
the same filters, rows and actions as the main page. Its rows leave out the
**Bot** pill, since every row there is a bot's and the author already names it;
the pop-up still shows it. The main pull request page
lists none of them, so it has no quick filter for bots. A saved quick filter
for bots, from before this page existed, is ignored. With no bot pull requests
open the page says there is nothing to review.

## Hiding one pull request

A pull request you can't or won't act on yet can be hidden. The footer of the
pop-up has **Hide this pull request** and **Hide for 7 days**. Hiding from the
pop-up closes it, so the
status message and its **Undo** below are within reach. A failed hide shows as a
line in the pop-up instead. It leaves the list, the quick-filter counts and
Insights at once, with no confirm step, since it is reversible. Nothing is sent
to the forge.

A status message says `Hid PR #123 ‘title’.` with an **Undo** button. It stays
until the next message, and the same restore is in the list below, so it isn't
lost to a timeout. Once anything is hidden, a **Hidden (N)** button by the list
header opens that list: repo, number, title, "Hidden until you restore it" or
"Back in 6 days", and a **Restore** button on each. With none hidden, neither
shows.

A hide for days ends by itself. A hide is forgotten once the pull request is no
longer open, while its forge answers. A forge that is rate limited or
unreachable draws no controls on its rows, so Hide is absent there too until it
answers again.
