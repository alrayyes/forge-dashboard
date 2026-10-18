# Error pages

The dashboard has its own error pages, built with the rest of the web app as
`404.html` ("Page not found") and `500.html` ("Something went wrong on our
side"). The Go server sends the first for an address nothing matches and the
second for a crash, each with its real status code. Asking for either file by
name gets the 404, never a 200. Each page says what happened in plain words and
gives a way back: a primary link to the pull requests and a short list of the
other pages. The 500 page also has a `Try again` link to the same address. They
show nothing about the server beyond the release version the footer shows
everywhere (no stack trace, path or host), and follow the light or dark theme.
They run no script, so the app can't fetch that version: the Go server fills it
into the `#footer-version` slot of the footer when it starts, and a test fails
if the web build drops the slot. The same no-script rule means the app's router
can't swap one for the page whose address it was sent at. Inside the app,
`+error.svelte` renders the same page for an error the router meets, and
`handleError` keeps the message generic. `src/error.html` is the static fallback
for an error the app can't render itself.
