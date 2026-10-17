# Pull request pages

## Pull request details

Clicking a pull request row, anywhere on it, opens a read-only pop-up. The
row's title is the button that does it, stretched over the row; the CI pill,
the labels and the action buttons stay clickable on top of it. The pop-up has
the pull request's description, its comments and the thumbs up and thumbs
down reactions on each, and an **Open on GitHub** (or Forgejo) link. On the
Releases page the pop-up shows the release notes in place of the description.
A Dependabot or Renovate pull request opens the same pop-up, with its long
generated description folded away until you open it. There are no actions in
it yet: Merge, Update branch and the rest stay on the row.

The pop-up loads when it opens, from `GET /api/pull-requests/details`, and
never as part of the dashboard snapshot, so a forge's budget isn't spent on
rows nobody opens. It shows the first 50 comments and says so when there are
more. The header draws the row's three tiers as they were when it opened: the CI
slot first (Running, Failed or Passed, the row's glyphs and words) with a
Conflicting or Blocked pill beside it when the row has one, then the title,
then the attributes as quiet outlined chips (auto-merge, draft, bot, out of
date, labels, and the version on the Releases page). Each comment carries the
author's avatar (the forge's own HTTPS image URL, or an initial if it isn't one
or can't load), a relative time and an
"edited" mark. A deleted author reads "ghost". Hovering or focusing a reaction
lists who gave it, up to ten names and then "and N more"; Escape hides that
list first and a second press closes the pop-up. Reactions are display only.
When the details can't load, it says so in plain words with **Try again**.

The text is Markdown and the server doesn't sanitise it, so the page renders
it with [markdown-it](https://github.com/markdown-it/markdown-it) with raw HTML
off: tags show as text, images aren't loaded, only absolute `http`, `https`
and `mailto` links are links (anything else stays plain text), and they open
in a new tab with `rel="noopener noreferrer"`. Task list items (`- [x]` and
`- [ ]`) show as read-only checkboxes; ticking one changes nothing on the
forge. The library loads the first time a pop-up opens.

## Releases

Release pull requests have their own page, `/releases.html`, reached from the
**Releases** item in the navigation. It is the pull request board over the
pull requests the server marks `kind: release` (release-please's, by its
`autorelease:` label), with the same filters, rows and actions as the main
page. The main pull request page lists none of them, and doesn't count them. Each
row shows the version being released next to the title. Merge is offered when
the release can merge, or greyed out with the reason when it can't. A release
that is behind its base branch gets Update branch and a line saying
release-please won't update it until a releasable change lands. With no release
pull requests open the page says nothing is waiting to ship.

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
open the page says there is nothing to review.

## Hiding one pull request

A pull request you can't or won't act on yet can be hidden. **More actions** on
its row has **Hide this pull request**, and **Hide for 7 days** under it. It
leaves the list, the quick-filter counts and Insights at once,
with no confirm step, since it is reversible. Nothing is sent to the forge.

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
