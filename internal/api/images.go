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
// hosts that route redirects to. Avatars and repository logos live on two more
// (#3467). Nothing else is fetched (#3405).
var githubImageHosts = []string{
	"github.com",
	"user-images.githubusercontent.com",
	"private-user-images.githubusercontent.com",
	"raw.githubusercontent.com",
	"avatars.githubusercontent.com",
	"repository-images.githubusercontent.com",
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

// imageRefusalLevel is how loudly a failed fetch is logged. A host that is
// simply not on the list is expected for an avatar the saved Forgejo instance
// doesn't serve (Gravatar, say), and the page asks again on every render, so
// it is debug. Anything else, user info or a blocked address included, is a
// probe worth seeing.
func imageRefusalLevel(err error) slog.Level {
	if errors.Is(err, imageproxy.ErrHostNotListed) {
		return slog.LevelDebug
	}

	return slog.LevelWarn
}

// handleImage serves GET /api/v1/images: an image embedded in a forge's
// Markdown, fetched here so the browser never contacts the forge or a third
// party for it and a private repository's token stays on the server (#3405).
func handleImage(deps Deps) http.HandlerFunc {
	limits := newImageLimits(deps)

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
		img, err := limits.load(r.Context(), q, raw, func(ctx context.Context, kind imageKind) (imageproxy.Image, error) {
			return fetchImage(ctx, deps, creds, proxy, q, raw, kind.maxBytes())
		})
		if errors.Is(err, errImageBusy) {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, http.StatusServiceUnavailable, errorBody("too many images are loading, try again shortly"))

			return
		}
		if err != nil {
			slog.Log(r.Context(), imageRefusalLevel(err), "image fetch refused or failed", "forge", q.Get("forge"), "kind", err)
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

// fetchImage reads raw through the proxy. A GitHub user-attachment link is
// tried at its signed address first, which is what a private repository
// serves; if that can't be found, isn't an allowed host or fails to load, the
// link as written is fetched, so nothing that loaded before stops loading
// (#3469).
func fetchImage(ctx context.Context, deps Deps, creds settings.Credentials, proxy *imageproxy.Proxy, q url.Values, raw string, limit int) (imageproxy.Image, error) {
	if q.Get("forge") == "github" {
		if signed := signedGitHubImage(ctx, deps, creds, q, raw); signed != "" {
			img, err := proxy.FetchMax(ctx, signed, limit)
			if err == nil {
				return img, nil
			}
			slog.Warn("signed image fetch failed, trying the link as written", "forge", "github", "kind", err)
		}
	}

	return proxy.FetchMax(ctx, raw, limit) //nolint:wrapcheck // the kinds are mapped by imageFailure
}

// signedGitHubImage returns the signed address the item's rendered HTML uses
// for a user-attachment link, or "" when there is none. The token goes to the
// GitHub API in that lookup and nowhere else: the image itself is fetched by
// the proxy, which holds no token.
func signedGitHubImage(ctx context.Context, deps Deps, creds settings.Credentials, q url.Values, raw string) string {
	if !isGitHubAttachment(deps, raw) {
		return ""
	}
	item, ok := imageItemOf(q)
	if !ok {
		return ""
	}
	owner, name, ok := splitFullName(q.Get("fullName"))
	if !ok {
		return ""
	}
	src, serr := pickForgeSource(deps, creds, "github")
	if serr != nil {
		return ""
	}
	resolver, ok := src.(dashboard.ImageLinkResolver)
	if !ok {
		return ""
	}
	signed, err := resolver.SignedImageURL(ctx, owner, name, item, raw)
	if err != nil {
		slog.Warn("image link lookup failed", "forge", "github", "kind", err)

		return ""
	}

	return signed
}

// isGitHubAttachment reports whether raw is a github.com/user-attachments
// link, the one kind a private repository won't serve unsigned.
func isGitHubAttachment(deps Deps, raw string) bool {
	origin := deps.GitHubImageOrigin
	if origin == "" {
		origin = "https://github.com"
	}
	u, err := url.Parse(raw)
	home, herr := url.Parse(origin)

	return err == nil && herr == nil && u.Scheme == home.Scheme && strings.EqualFold(u.Host, home.Host) &&
		strings.HasPrefix(u.Path, "/user-attachments/")
}

// imageItemOf reads which issue, pull request or release the image sits in.
func imageItemOf(q url.Values) (dashboard.ImageItem, bool) {
	if q.Has("tag") {
		tag := q.Get("tag")
		if !safeRepoSegment(tag) || strings.Contains(tag, "/") {
			return dashboard.ImageItem{}, false
		}

		return dashboard.ImageItem{Kind: dashboard.ImageItemRelease, Tag: tag}, true
	}
	number, err := strconv.Atoi(q.Get("number"))
	if err != nil || number <= 0 {
		return dashboard.ImageItem{}, false
	}

	return dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: number}, true
}
