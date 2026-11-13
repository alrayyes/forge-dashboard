package imageproxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
)

// MaxBytes is the largest image the proxy returns.
const MaxBytes = 8 << 20

// MaxAvatarBytes is the largest avatar or repository logo the proxy returns,
// well under MaxBytes since neither is ever drawn large.
const MaxAvatarBytes = 512 << 10

const (
	defaultTimeout = 10 * time.Second
	maxRedirects   = 3
	sniffLen       = 512
)

var (
	// ErrHostNotAllowed is a URL outside the configured set, malformed, or
	// pointing at a non-public address the proxy was not trusted to reach.
	ErrHostNotAllowed = errors.New("imageproxy: host not allowed")
	// ErrHostNotListed is the plain case of ErrHostNotAllowed: a well-formed
	// URL, on the right scheme and without user info, whose host just isn't
	// on the list. It is routine, unlike the other refusals.
	ErrHostNotListed = fmt.Errorf("%w: not on the list", ErrHostNotAllowed)
	// ErrNotFound is a 404 from the forge.
	ErrNotFound = errors.New("imageproxy: image not found")
	// ErrForbidden is a 401 or 403: the token cannot see the image.
	ErrForbidden = errors.New("imageproxy: image not available to this account")
	// ErrNotImage is a body that is not a PNG, JPEG, GIF or WebP.
	ErrNotImage = errors.New("imageproxy: not a supported image")
	// ErrTooLarge is a body over the limit for its kind.
	ErrTooLarge = errors.New("imageproxy: image too large")
	// ErrUpstream is any other failure reaching the host.
	ErrUpstream = errors.New("imageproxy: could not fetch the image")

	errBlockedAddress = errors.New("imageproxy: non-public address")
)

// Config says where a Proxy may go.
type Config struct {
	// Hosts are the exact host[:port] values that may be fetched.
	Hosts []string
	// Scheme is the only scheme allowed ("https" unless the forge is plain http).
	Scheme string
	// Token is sent as `Authorization: token <Token>` to TokenHost only.
	Token     string
	TokenHost string
	// AllowLocal lets the proxy reach loopback and private addresses. Set it
	// only for a configured self-hosted instance, which is often on one.
	AllowLocal bool
	// Timeout bounds the whole fetch; zero means ten seconds.
	Timeout time.Duration
}

// Image is a fetched image.
type Image struct {
	ContentType string
	Data        []byte
}

// Proxy fetches images under a Config.
type Proxy struct {
	cfg    Config
	hosts  map[string]bool
	client *http.Client
}

// New builds a Proxy.
func New(cfg Config) *Proxy {
	if cfg.Timeout == 0 {
		cfg.Timeout = defaultTimeout
	}
	hosts := make(map[string]bool, len(cfg.Hosts))
	for _, h := range cfg.Hosts {
		hosts[strings.ToLower(h)] = true
	}
	dialer := &net.Dialer{Timeout: cfg.Timeout}
	if !cfg.AllowLocal {
		dialer.Control = refuseNonPublic
	}
	transport := &http.Transport{
		// No proxy from the environment: the dial check must see the real peer.
		Proxy:             nil,
		DialContext:       dialer.DialContext,
		DisableKeepAlives: true,
	}

	return &Proxy{
		cfg:   cfg,
		hosts: hosts,
		client: &http.Client{
			Timeout:   cfg.Timeout,
			Transport: transport,
			// Redirects are followed by hand so every hop is checked.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

func refuseNonPublic(_, address string, _ syscall.RawConn) error {
	addr, err := netip.ParseAddrPort(address)
	if err != nil {
		return errBlockedAddress
	}
	ip := addr.Addr().Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return errBlockedAddress
	}
	for _, p := range specialPurpose {
		if p.Contains(ip) {
			return errBlockedAddress
		}
	}

	return nil
}

// specialPurpose are the ranges net/netip counts as global unicast but that
// reach a private network or a translator: shared address space (CGNAT,
// Tailscale), benchmarking, IETF protocol assignments, NAT64 and 6to4.
var specialPurpose = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("2002::/16"),
}

// check validates one hop's URL against the configured set.
func (p *Proxy) check(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != p.cfg.Scheme || u.User != nil || u.Host == "" {
		return nil, ErrHostNotAllowed
	}
	if !p.hosts[strings.ToLower(u.Host)] {
		return nil, ErrHostNotListed
	}

	return u, nil
}

// Fetch reads the image at raw, up to MaxBytes.
func (p *Proxy) Fetch(ctx context.Context, raw string) (Image, error) {
	return p.FetchMax(ctx, raw, MaxBytes)
}

// FetchMax reads the image at raw, refusing one over limit bytes.
func (p *Proxy) FetchMax(ctx context.Context, raw string, limit int) (Image, error) {
	u, err := p.check(raw)
	if err != nil {
		return Image{}, err
	}
	for range maxRedirects + 1 {
		resp, err := p.get(ctx, u)
		if err != nil {
			return Image{}, err
		}
		if resp.StatusCode < 300 || resp.StatusCode >= 400 {
			defer func() { _ = resp.Body.Close() }()

			return p.read(resp, limit)
		}
		loc, lerr := resp.Location()
		_ = resp.Body.Close()
		if lerr != nil {
			return Image{}, ErrUpstream
		}
		if u, err = p.check(loc.String()); err != nil {
			// A listed host sending us to an unlisted one is not the routine
			// miss of an avatar nobody serves, so it must not read as one.
			if errors.Is(err, ErrHostNotListed) {
				err = fmt.Errorf("%w: redirected off the list", ErrHostNotAllowed)
			}

			return Image{}, err
		}
	}

	return Image{}, fmt.Errorf("%w: too many redirects", ErrUpstream)
}

func (p *Proxy) get(ctx context.Context, u *url.URL) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, ErrHostNotAllowed
	}
	req.Header.Set("Accept", "image/*")
	if p.cfg.Token != "" && strings.EqualFold(u.Host, p.cfg.TokenHost) {
		req.Header.Set("Authorization", "token "+p.cfg.Token)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		if errors.Is(err, errBlockedAddress) {
			return nil, ErrHostNotAllowed
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("imageproxy: %w", ctx.Err())
		}

		// The cause can carry the URL, so it is not wrapped in.
		return nil, ErrUpstream
	}

	return resp, nil
}

func (p *Proxy) read(resp *http.Response, limit int) (Image, error) {
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return Image{}, ErrNotFound
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return Image{}, ErrForbidden
	case resp.StatusCode != http.StatusOK:
		return Image{}, ErrUpstream
	case resp.ContentLength > int64(limit):
		return Image{}, ErrTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, int64(limit)+1))
	if err != nil {
		return Image{}, ErrUpstream
	}
	if len(data) > limit {
		return Image{}, ErrTooLarge
	}
	// The type comes from the bytes: the header is the host's word, and an
	// SVG or HTML page sent as an image must never pass.
	ctype := http.DetectContentType(data[:min(len(data), sniffLen)])
	switch ctype {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return Image{ContentType: ctype, Data: data}, nil
	}

	return Image{}, ErrNotImage
}
