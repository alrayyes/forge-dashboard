package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// githubImageHosts are the hosts GitHub serves an image embedded in a pull
// request, issue or release from: its own attachment route and the user-content
// hosts that route redirects to. Nothing else is fetched (#3405).
var githubImageHosts = []string{
	"github.com",
	"user-images.githubusercontent.com",
	"private-user-images.githubusercontent.com",
	"raw.githubusercontent.com",
}

// imageProxyFor builds the proxy for one forge. Forgejo's allowed host is the
// saved instance, trusted to be on a private address, and the only place its
// token goes. GitHub's are fixed public hosts, reached without the token: its
// attachment links carry their own signature.
func imageProxyFor(deps Deps, forge string, creds settings.Credentials) (*imageproxy.Proxy, *statusError) {
	switch forge {
	case "github":
		if deps.GitHubImageProxy != nil {
			return deps.GitHubImageProxy, nil
		}

		return imageproxy.New(imageproxy.Config{Hosts: githubImageHosts, Scheme: "https"}), nil
	case "forgejo":
		u, err := url.Parse(creds.ForgejoURL)
		if err != nil || creds.ForgejoURL == "" || u.Host == "" {
			return nil, &statusError{http.StatusBadRequest, "no forgejo credentials saved"}
		}

		return imageproxy.New(imageproxy.Config{
			Hosts:      []string{u.Host},
			Scheme:     u.Scheme,
			Token:      creds.ForgejoToken,
			TokenHost:  u.Host,
			AllowLocal: true,
		}), nil
	default:
		return nil, &statusError{http.StatusBadRequest, "forge must be github or forgejo"}
	}
}

// imageFailure is what a caller is told about a refused or failed fetch: a
// fixed sentence per kind, never the error, which could name the host.
func imageFailure(err error) *statusError {
	switch {
	case errors.Is(err, imageproxy.ErrHostNotAllowed):
		return &statusError{http.StatusForbidden, "images load only from the forge the item belongs to"}
	case errors.Is(err, imageproxy.ErrNotFound):
		return &statusError{http.StatusNotFound, "the forge has no such image"}
	case errors.Is(err, imageproxy.ErrForbidden):
		return &statusError{http.StatusForbidden, "the saved token can't read this image"}
	case errors.Is(err, imageproxy.ErrNotImage):
		return &statusError{http.StatusUnsupportedMediaType, "that address is not a PNG, JPEG, GIF or WebP image"}
	case errors.Is(err, imageproxy.ErrTooLarge):
		return &statusError{http.StatusRequestEntityTooLarge, "the image is too large"}
	default:
		return &statusError{http.StatusBadGateway, "the image could not be read"}
	}
}

// handleImage serves GET /api/v1/images: an image embedded in a forge's
// Markdown, fetched here so the browser never contacts the forge or a third
// party for it and a private repository's token stays on the server (#3405).
func handleImage(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		raw := q.Get("url")
		if raw == "" {
			writeJSON(w, http.StatusBadRequest, errorBody("url is required"))

			return
		}
		creds, err := deps.SettingsStore.Get(r.Context())
		if err != nil && !errors.Is(err, settings.ErrNotFound) {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load settings"))

			return
		}
		proxy, serr := imageProxyFor(deps, q.Get("forge"), creds)
		if serr != nil {
			serr.write(w)

			return
		}
		if q.Get("forge") == "github" {
			raw = signedGitHubImage(r.Context(), deps, creds, q, raw)
		}
		img, err := proxy.Fetch(r.Context(), raw)
		if err != nil {
			slog.Warn("image fetch refused or failed", "forge", q.Get("forge"), "kind", err)
			imageFailure(err).write(w)

			return
		}

		h := w.Header()
		h.Set("Content-Type", img.ContentType)
		h.Set("Content-Length", strconv.Itoa(len(img.Data)))
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
		h.Set("Cache-Control", "private, max-age=3600")
		_, _ = w.Write(img.Data)
	}
}

// signedGitHubImage swaps a user-attachment link for the signed address the
// item's rendered HTML uses, which is what a private repository serves. The
// token goes to the GitHub API in that lookup and nowhere else: the image
// itself is fetched by the proxy, which holds no token. Any miss leaves the
// link as it was, so a public repository's image still loads (#3469).
func signedGitHubImage(ctx context.Context, deps Deps, creds settings.Credentials, q url.Values, raw string) string {
	if !isGitHubAttachment(raw) {
		return raw
	}
	item, ok := imageItemOf(q)
	if !ok {
		return raw
	}
	owner, name, ok := splitFullName(q.Get("fullName"))
	if !ok {
		return raw
	}
	src, serr := pickForgeSource(deps, creds, "github")
	if serr != nil {
		return raw
	}
	resolver, ok := src.(dashboard.ImageLinkResolver)
	if !ok {
		return raw
	}
	signed, err := resolver.SignedImageURL(ctx, owner, name, item, raw)
	if err != nil || signed == "" {
		if err != nil {
			slog.Warn("image link lookup failed", "forge", "github", "kind", err)
		}

		return raw
	}

	return signed
}

// isGitHubAttachment reports whether raw is a github.com/user-attachments
// link, the one kind a private repository won't serve unsigned.
func isGitHubAttachment(raw string) bool {
	u, err := url.Parse(raw)

	return err == nil && u.Scheme == "https" && strings.EqualFold(u.Host, "github.com") &&
		strings.HasPrefix(u.Path, "/user-attachments/")
}

// imageItemOf reads which issue, pull request or release the image sits in.
func imageItemOf(q url.Values) (dashboard.ImageItem, bool) {
	if tag := q.Get("tag"); tag != "" {
		return dashboard.ImageItem{Kind: dashboard.ImageItemRelease, Tag: tag}, true
	}
	number, err := strconv.Atoi(q.Get("number"))
	if err != nil || number <= 0 {
		return dashboard.ImageItem{}, false
	}

	return dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: number}, true
}
