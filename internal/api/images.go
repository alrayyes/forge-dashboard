package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/hostname"
	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// imageProxyFor builds the proxy for one forge from what its capabilities say.
// A forge that names fixed hosts is reached on those, over https and without
// the token: its attachment links carry their own signature. One that names
// none reads from the saved instance, trusted to be on a private address, and
// the only place its token goes.
func imageProxyFor(deps Deps, forge string, creds settings.Credentials) (*imageproxy.Proxy, *statusError) {
	caps, ok := dashboard.CapabilitiesOf(dashboard.Forge(forge))
	if !ok {
		return nil, forgeProblem(forge)
	}

	return imageProxyForCapabilities(deps, forge, caps, creds)
}

func imageProxyForCapabilities(deps Deps, forge string, caps dashboard.ForgeCapabilities, creds settings.Credentials) (*imageproxy.Proxy, *statusError) {
	if len(caps.ImageHosts) > 0 {
		if p := deps.ImageProxies[forge]; p != nil {
			return p, nil
		}
		hosts := append(append([]string{}, caps.ImageHosts...), caps.AvatarHosts...)

		return imageproxy.New(imageproxy.Config{Hosts: hosts, Scheme: "https"}), nil
	}
	inst, _ := creds.InstanceFor(forge)
	u, err := url.Parse(inst.URL)
	if err != nil || inst.URL == "" || u.Host == "" {
		return nil, &statusError{status: http.StatusBadRequest, message: "no " + forge + " credentials saved"}
	}

	return imageproxy.New(imageproxy.Config{
		Hosts:      []string{u.Host},
		Scheme:     u.Scheme,
		Token:      inst.Token,
		TokenHost:  u.Host,
		AllowLocal: true,
	}), nil
}

// federatedAvatarHosts are the hosts of Gravatar and Libravatar, which serve an
// avatar a forge only links to (#5004). They are taken for kind=avatar alone,
// over https by exact name, through their own tokenless proxy that reaches
// public addresses only.
var federatedAvatarHosts = []string{
	"gravatar.com",
	"secure.gravatar.com",
	"seccdn.libravatar.org",
	"cdn.libravatar.org",
}

// FederatedAvatars is a set of federated avatar hosts and the proxy that
// reaches them.
type FederatedAvatars struct {
	Hosts []string
	Proxy *imageproxy.Proxy
}

var defaultFederatedAvatars = FederatedAvatars{
	Hosts: federatedAvatarHosts,
	Proxy: imageproxy.New(imageproxy.Config{Hosts: federatedAvatarHosts, Scheme: "https"}),
}

// avatarProxyFor is the proxy that fetches raw: the federated one for an
// avatar on a federated host, the forge's own otherwise. The forge's proxy may
// carry its token or reach private addresses, so it serves one of these hosts
// only when that host is already on its list, as a saved instance is.
func avatarProxyFor(deps Deps, forgeProxy *imageproxy.Proxy, kind imageKind, raw string) *imageproxy.Proxy {
	if kind != imageAvatar {
		return forgeProxy
	}
	federated := defaultFederatedAvatars
	if deps.FederatedAvatars != nil {
		federated = *deps.FederatedAvatars
	}
	u, err := url.Parse(raw)
	if err != nil {
		return forgeProxy
	}
	isHost := func(h string) bool { return hostname.Equal(h, u.Host) }
	if !slices.ContainsFunc(federated.Hosts, isHost) || slices.ContainsFunc(forgeProxy.Config().Hosts, isHost) {
		return forgeProxy
	}

	return federated.Proxy
}

// imageFailure is what a caller is told about a refused or failed fetch: a
// fixed sentence per kind, never the error, which could name the host.
func imageFailure(err error) *statusError {
	switch {
	case errors.Is(err, imageproxy.ErrHostNotAllowed):
		return &statusError{status: http.StatusForbidden, message: "that image's host is not allowed"}
	case errors.Is(err, imageproxy.ErrNotFound):
		return &statusError{status: http.StatusNotFound, message: "the forge has no such image"}
	case errors.Is(err, imageproxy.ErrForbidden):
		return &statusError{status: http.StatusForbidden, message: "the saved token can't read this image"}
	case errors.Is(err, imageproxy.ErrNotImage):
		return &statusError{status: http.StatusUnsupportedMediaType, message: "that address is not a PNG, JPEG, GIF or WebP image"}
	case errors.Is(err, imageproxy.ErrTooLarge):
		return &statusError{status: http.StatusRequestEntityTooLarge, message: "the image is too large"}
	default:
		return &statusError{status: http.StatusBadGateway, message: "the image could not be read"}
	}
}

// imageRefusalLevel is how loudly a failed fetch is logged. A host that is
// simply not on the list is expected for an avatar the saved Forgejo instance
// doesn't serve (another site's, say), and the page asks again on every render, so
// it is debug. Anything else, user info or a blocked address included, is a
// probe worth seeing.
func imageRefusalLevel(err error) slog.Level {
	if errors.Is(err, imageproxy.ErrHostNotListed) {
		return slog.LevelDebug
	}

	return slog.LevelWarn
}

// noteSkippedAvatar remembers the host of an avatar the proxy refused only
// because it isn't the saved instance's, so Settings can say so (#3683). Only a
// forge that reads from its own instance has such a host.
func noteSkippedAvatar(deps Deps, q url.Values, raw string, err error) {
	if deps.skipped == nil || q.Get("kind") != string(imageAvatar) {
		return
	}
	if caps, ok := dashboard.CapabilitiesOf(dashboard.Forge(q.Get("forge"))); !ok || len(caps.ImageHosts) > 0 {
		return
	}
	if errors.Is(err, imageproxy.ErrHostNotListed) {
		deps.skipped.noteURL(raw)
	}
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
		width, bad := imageOptionsOf(q)
		if bad != "" {
			writeJSON(w, http.StatusBadRequest, errorBody(bad))

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
		proxy = avatarProxyFor(deps, proxy, imageKind(q.Get("kind")), raw)
		img, err := limits.load(r.Context(), q, raw, func(ctx context.Context, kind imageKind) (imageproxy.Image, error) {
			return fetchSized(ctx, width, func() (imageproxy.Image, error) {
				return fetchImage(ctx, deps, creds, proxy, q, raw, kind.maxBytes())
			})
		})
		if errors.Is(err, errImageBusy) {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, http.StatusServiceUnavailable, errorBody("too many images are loading, try again shortly"))

			return
		}
		if err != nil {
			noteSkippedAvatar(deps, q, raw, err)
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

// fetchSized runs fetch and, when width is set, scales what it returned.
func fetchSized(ctx context.Context, width int, fetch func() (imageproxy.Image, error)) (imageproxy.Image, error) {
	img, err := fetch()
	if err != nil || width == 0 {
		return img, err
	}

	return imageproxy.Resize(ctx, img, width) //nolint:wrapcheck // the kinds are mapped by imageFailure
}

// imageOptionsOf checks the optional kind and width, returning the width (0
// when absent) or the sentence to refuse with.
func imageOptionsOf(q url.Values) (int, string) {
	if k := q.Get("kind"); k != "" && k != string(imageAvatar) {
		return 0, "kind must be avatar or absent"
	}
	width, ok := imageWidthOf(q)
	if !ok {
		return 0, "width must be 320, 640, 960 or 1280"
	}

	return width, ""
}

// imageWidthOf reads the optional width: 0 when absent, else one of the sizes
// imageproxy.AllowedWidth lists. Anything else is refused, not snapped, so a
// caller learns its request was wrong and the cache holds only a few sizes.
func imageWidthOf(q url.Values) (int, bool) {
	if !q.Has("width") {
		return 0, true
	}
	n, err := strconv.Atoi(q.Get("width"))
	// The cache keys on the text, so "0320" or "+320" must not pass as 320.
	if err != nil || !imageproxy.AllowedWidth(n) || strconv.Itoa(n) != q.Get("width") {
		return 0, false
	}

	return n, true
}

// fetchImage reads raw through the proxy. A link under the forge's signed
// attachment prefix is tried at its signed address first, which is what a
// private repository serves; if that can't be found, isn't an allowed host or
// fails to load, the link as written is fetched, so nothing that loaded before
// stops loading (#3469).
func fetchImage(ctx context.Context, deps Deps, creds settings.Credentials, proxy *imageproxy.Proxy, q url.Values, raw string, limit int) (imageproxy.Image, error) {
	forge := q.Get("forge")
	if caps, ok := dashboard.CapabilitiesOf(dashboard.Forge(forge)); ok && caps.SignedAttachmentPrefix != "" {
		if signed := signedImage(ctx, deps, creds, forge, caps.SignedAttachmentPrefix, q, raw); signed != "" {
			img, err := proxy.FetchMax(ctx, signed, limit)
			if err == nil {
				return img, nil
			}
			slog.Warn("signed image fetch failed, trying the link as written", "forge", forge, "kind", err)
		}
	}

	return proxy.FetchMax(ctx, raw, limit) //nolint:wrapcheck // the kinds are mapped by imageFailure
}

// signedImage returns the signed address the item's rendered HTML uses for an
// attachment link, or "" when there is none. The token goes to the forge's API
// in that lookup and nowhere else: the image itself is fetched by the proxy,
// which holds no token.
func signedImage(ctx context.Context, deps Deps, creds settings.Credentials, forge, prefix string, q url.Values, raw string) string {
	if !isSignedAttachment(prefix, deps.ImageOrigins[forge], raw) {
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
	src, serr := pickForgeSource(deps, creds, forge)
	if serr != nil {
		return ""
	}
	resolver, ok := src.(dashboard.ImageLinkResolver)
	if !ok {
		return ""
	}
	signed, err := resolver.SignedImageURL(ctx, owner, name, item, raw)
	if err != nil {
		slog.Warn("image link lookup failed", "forge", forge, "kind", err)

		return ""
	}

	return signed
}

// isSignedAttachment reports whether raw is under prefix, the one kind of link
// a private repository won't serve unsigned. A non-empty origin stands in for
// the prefix's scheme and host, which only tests set.
func isSignedAttachment(prefix, origin, raw string) bool {
	if prefix == "" {
		return false
	}
	u, err := url.Parse(raw)
	home, herr := url.Parse(prefix)
	if err != nil || herr != nil {
		return false
	}
	if origin != "" {
		o, oerr := url.Parse(origin)
		if oerr != nil {
			return false
		}
		home.Scheme, home.Host = o.Scheme, o.Host
	}

	return u.Scheme == home.Scheme && hostname.Equal(u.Host, home.Host) && cleanPath(u) && strings.HasPrefix(u.Path, home.Path)
}

// cleanPath reports whether the link's path is already in its resolved form: no
// dot segments, empty segments, backslashes, or escapes that hide a separator,
// a dot or another escape. A path that changes under cleaning could resolve
// outside the prefix the plain text test sees (#4247).
func cleanPath(u *url.URL) bool {
	segs := strings.Split(strings.TrimPrefix(u.EscapedPath(), "/"), "/")
	for i, seg := range segs {
		dec, err := url.PathUnescape(seg)
		if err != nil || dec == "." || dec == ".." || strings.ContainsAny(dec, `/\%`) {
			return false
		}
		if seg == "" && i < len(segs)-1 {
			return false
		}
	}

	return true
}

// imageItemOf reads which issue, pull request, comment or release the image sits in.
func imageItemOf(q url.Values) (dashboard.ImageItem, bool) {
	// A comment's body is its own object, so it wins: the item's HTML never
	// holds the comment's attachments. Digits only, so nothing but a number
	// reaches the API path (#3676).
	if q.Has("comment") {
		id, err := strconv.ParseInt(q.Get("comment"), 10, 64)
		if err != nil || id <= 0 || strings.HasPrefix(q.Get("comment"), "+") {
			return dashboard.ImageItem{}, false
		}

		return dashboard.ImageItem{Kind: dashboard.ImageItemComment, CommentID: id}, true
	}
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
