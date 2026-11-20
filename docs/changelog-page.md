# The changelog page

The version in the footer links to `/changelog.html`, which needs a session like
the dashboard does, and so does its data, `/changelog.json`: the newest entry is
the running version, so a signed-out visitor is sent to sign in and never sees
it. The login page's footer shows no version. The page lists the releases in
`CHANGELOG.md`, newest first, 20 at a time with a button for the older ones, and
makes no request to GitHub. The web build
turns `CHANGELOG.md` into `/changelog.json` (`scripts/changelog-json.ts`, a
build output that isn't committed) and the page reads that one same-origin file.
It therefore lists exactly the releases the running version was built from, so
the footer version and the newest entry agree. The notes are Markdown, drawn
with the same renderer as pull request descriptions: a bold scope shows bold,
raw HTML stays text, and only `http(s)` and `mailto` links are links. A link
labelled with a pull request number or a commit hash is set in the mono face.
A pull request or issue number there opens the forge in a new tab, and its
accessible name says so. It does not open the in-app dialog the other pages use:
the number is a plain link to the forge.
The footer reads the running binary, so it lags the published release until the
deployment updates. The page used to live at `/releases.html`. That address now
serves the [Releases page](pull-request-pages.md#releases), with no redirect,
so an old bookmark or a browser that cached the earlier 301 needs
`/changelog.html` typed once.
