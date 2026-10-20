# Pull request pages

## Pull request details

Clicking a pull request row, anywhere on it, opens a pop-up. The
row's title is the button that does it, stretched over the row; the CI pill,
the labels and the row's own buttons stay clickable on top of it. The pop-up has
the pull request's description, its comments and the thumbs up and thumbs
down reactions on each, and an **Open on GitHub** (or Forgejo) link. On the
Releases page the pop-up shows the release notes in place of the description.
A Dependabot or Renovate pull request opens the same pop-up, with its long
generated description folded away until you open it.

The footer of the pop-up has every action a pull request offers, so it can be
acted on from it. The row itself draws only the main one. The footer lists the
main action first (the one the server marks primary), then the others, with
**Close pull request** last, on the right. The buttons have the same states on
the row and in the footer: locked with the reason, queued, in flight and the
two-step confirm for Merge and Close. A locked button stays on screen,
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

## Releases

Release pull requests have their own page, `/releases.html`, reached from the
**Releases** item in the navigation. It is the pull request board over the
pull requests the server marks `kind: release` (release-please's, by its
`autorelease:` label, or by its `release-please--branches--<base>` head branch
when release-please failed before it could label the pull request, as long as
the pull request is from the same repository and aimed at that base), with the
same filters, rows and actions as the main page. The main pull request page
lists none of them, and doesn't count them. Each row shows the version being
released next to the title. Merge is offered when the release can merge, or
greyed out with the reason when it can't. A release that is behind its base
branch gets Update branch and a line saying release-please won't update it
until a releasable change lands. With no release pull requests open the page
says nothing is waiting to ship.

The quick filter pills above the list include **Failing CI**, **Running CI**
and **Passing CI**, each offered only when it would show something. Next to
them an **Auto-merge** control has Any, On and Off. On shows only pull requests
that have auto-merge armed, Off only those without. It combines with a pill, so
Failing CI with Auto-merge On finds armed pull requests whose checks have since
failed.

## Bots

Dependabot and Renovate pull requests have their own page, `/bots.html`,
reached from the **Bots** item in the navigation. Like Releases, it is the pull
request board over the pull requests the server marks `kind: dependency`, with
the same filters, rows and actions as the main page. The main pull request page
lists none of them, so it has no quick filter for bots. A saved quick filter
for bots, from before this page existed, is ignored. With no bot pull requests
open the page says there is nothing to review. Its rows carry no "Bot" pill,
since every row there is a bot's; the pull request pop-up still shows one.

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
