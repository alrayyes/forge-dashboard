# The changelog page

The version in the footer links to `/changelog.html`, which needs a session like
the dashboard does, and so does its data, `/changelog.json`: the newest entry is
the running version, so a signed-out visitor is sent to sign in and never sees
it. The login page's footer shows no version. The page lists the releases in
`CHANGELOG.md`, newest first, 20 at a time with a button for the older ones, and
makes no request to GitHub. The web build turns `CHANGELOG.md` into
`/changelog.json` (`scripts/changelog-json.ts`, a build output that isn't
committed) and the page reads that one same-origin file. It therefore lists
exactly the releases the running version was built from, so the footer version
and the newest entry agree. The notes are Markdown, drawn with the same renderer
as pull request descriptions: a bold scope shows bold, raw HTML stays text, and
only `http(s)` and `mailto` links are links. A link labelled with a pull request
number or a commit hash is set in the mono face. A pull request or issue number
there (`#12`, `owner/repo#12`, or a link to an item's page on GitHub) opens that
item's dialog where you are, read-only, with no actions: the page tracks no
repositories, so it asks the forge, the same lookup a mention in a pull request
description uses. The forge is asked while the pointer or keyboard focus rests
on the link, and a click opens the dialog only once it has answered. Escape, the
close button and the backdrop return focus to the link, and Enter on the focused
link opens it. A modified or middle click, a click before the forge has
answered, and an item the forge can't show (no access, a rate limit, missing)
follow the link to the forge in a new tab, and the link's accessible name says
so. A reference resolves against the repository it names, so `other/repo#9` is
never read as the project's own. Every reference is read-only here, whether or
not its repository is tracked. A release whose address isn't a GitHub release
keeps plain forge links. The footer reads the running binary, so it lags the
published release until the deployment updates. The page used to live at
`/releases.html`. That address now serves the
[Releases page](pull-request-pages.md#releases), with no redirect, so an old
bookmark or a browser that cached the earlier 301 needs `/changelog.html` typed
once.
