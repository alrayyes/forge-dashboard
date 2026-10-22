package github

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"syscall"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
)

var (
	errJobLogRefused = errors.New("github: the forge refused the request")
	errJobLogExpired = errors.New("github: the job's log is gone")
	errJobLogStatus  = errors.New("github: unexpected job log status")

	errJobLogDownload = errors.New("github: job log download failed")
	errJobLogRedirect = errors.New("github: refused job log redirect")
	errJobLogTooLarge = errors.New("github: job log download is larger than the read cap")
)

// JobLog reads the output of Actions job id, the end of it when it is long.
// GitHub answers the logs request with a redirect to a short-lived blob URL;
// that blob is fetched without the token, asking only for its last bytes. A
// job the token cannot read, a log that has expired and a check run that is
// not an Actions job come back as classified client errors, never as text.
func (c *Client) JobLog(ctx context.Context, owner, name string, id int64) (dashboard.JobLog, error) {
	path := fmt.Sprintf("/repos/%s/%s/actions/jobs/%d/logs", owner, name, id)
	slog.Debug("github request", "method", http.MethodGet, "url", path)
	loc, resp, err := c.restClient.Actions.GetWorkflowJobLogs(ctx, owner, name, id, 0)
	if err != nil {
		return dashboard.JobLog{}, c.logRequestError(ctx, path, resp, err)
	}
	c.recordRESTSuccess(ctx, http.MethodGet, path, resp)

	blob, cancel, err := c.fetchLogBlob(ctx, loc, dashboard.MaxJobLogBytes)
	if err != nil {
		return dashboard.JobLog{}, err
	}
	defer cancel()
	defer func() { _ = blob.Body.Close() }()

	if err := blobStatusError(blob.StatusCode, id); err != nil {
		return dashboard.JobLog{}, err
	}

	if blob.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		// Only a size of 0 means an empty log. Any other answer means the
		// range was wrong for a log that has content, so ask for all of it.
		if emptyUnsatisfiable(blob.Header.Get("Content-Range")) {
			return dashboard.JobLog{}, nil
		}
		_ = blob.Body.Close()
		cancel()
		blob, cancel, err = c.fetchLogBlob(ctx, loc, 0)
		if err != nil {
			return dashboard.JobLog{}, err
		}
		defer cancel()
		defer func() { _ = blob.Body.Close() }()
		if err := blobStatusError(blob.StatusCode, id); err != nil {
			return dashboard.JobLog{}, err
		}
		if blob.StatusCode == http.StatusRequestedRangeNotSatisfiable {
			return dashboard.JobLog{}, nil
		}
	}
	body, skipped, err := readTail(blob.Body, dashboard.MaxJobLogBytes)
	if err != nil {
		return dashboard.JobLog{}, fmt.Errorf("%w: %w", errJobLogDownload, redactedCause(err))
	}
	// A 206 that starts at byte 0 is the whole log; any other 206 starts
	// mid-log, and a 200 that was longer than the window lost its start.
	cut := skipped || (blob.StatusCode == http.StatusPartialContent && !startsAtZero(blob.Header.Get("Content-Range")))

	return dashboard.NewJobLog(body, cut), nil
}

// logRequestError classifies a failed logs request. The SDK answers a status
// other than the redirect with a plain error and the response, so the status
// is what classifies it; an exhausted rate limit is a 403 with no budget left.
func (c *Client) logRequestError(ctx context.Context, path string, resp *ghsdk.Response, err error) error {
	if resp != nil && resp.Response != nil {
		kind := forgeErrorKindFromStatus(resp.StatusCode)
		if resp.StatusCode == http.StatusForbidden && (resp.Header.Get("X-RateLimit-Remaining") == "0" || resp.Header.Get("Retry-After") != "") {
			kind = dashboard.ForgeErrorRateLimited
		}
		if kind != dashboard.ForgeErrorUnknown {
			c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, string(kind), nil)

			return &dashboard.ClientError{Kind: kind, Err: fmt.Errorf("%w: GET %s: %s", errJobLogRefused, path, resp.Status)}
		}
	}

	return asClientError(c.restError(ctx, http.MethodGet, path, err))
}

// emptyUnsatisfiable reports whether a 416's Content-Range ("bytes */N") says
// the blob is empty. A missing or unreadable header does not say so.
func emptyUnsatisfiable(contentRange string) bool {
	size, ok := strings.CutPrefix(strings.TrimSpace(contentRange), "bytes */")

	return ok && strings.TrimSpace(size) == "0"
}

// blobStatusError classifies the status the blob host answered with: nil for
// the two that carry text.
func blobStatusError(status int, id int64) error {
	switch status {
	case http.StatusOK, http.StatusPartialContent, http.StatusRequestedRangeNotSatisfiable:
		return nil
	case http.StatusNotFound, http.StatusGone:
		return &dashboard.ClientError{
			Kind: dashboard.ForgeErrorNotFound,
			Err:  fmt.Errorf("%w: job %d has expired", errJobLogExpired, id),
		}
	case http.StatusForbidden, http.StatusUnauthorized:
		return &dashboard.ClientError{
			Kind: dashboard.ForgeErrorUnauthorized,
			Err:  fmt.Errorf("%w: the log of job %d is not readable", errJobLogRefused, id),
		}
	default:
		return fmt.Errorf("%w: download answered %d", errJobLogStatus, status)
	}
}

// fetchLogBlob asks the short-lived blob URL a logs request redirected to for
// its last n bytes, or all of it when n is 0. The request carries no token. A redirect target must be
// https, or the API's own origin (a GitHub Enterprise Server host, a test), so
// a hostile Location can't make the server fetch from an arbitrary plain-http
// host. Errors never carry the URL, which is a credential. The returned cancel
// releases the request's timeout; call it once the body is read.
func (c *Client) fetchLogBlob(ctx context.Context, loc *url.URL, n int) (*http.Response, context.CancelFunc, error) {
	target := c.restClient.BaseURL.ResolveReference(loc)
	if err := c.checkLogTarget(target); err != nil {
		return nil, nil, err
	}
	fetchCtx, cancel := context.WithTimeout(ctx, logFetchTimeout)
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, target.String(), nil)
	if err != nil {
		cancel()

		return nil, nil, fmt.Errorf("%w: %w", errJobLogDownload, redactedCause(err))
	}
	if n > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=-%d", n))
	}
	blob, err := c.logBlobClient().Do(req)
	if err != nil {
		cancel()

		return nil, nil, fmt.Errorf("%w: %w", errJobLogDownload, redactedCause(err))
	}

	return blob, cancel, nil
}

// maxLogRedirects is how many hops a blob download may follow.
const maxLogRedirects = 3

// maxLogDownload bounds the bytes read from a blob host that ignores the range
// request and sends more than a log can reasonably be.
const maxLogDownload = 64 * 1024 * 1024

// checkLogTarget applies one rule to every URL a log download touches, the
// first and each redirect hop: https, or the API's own origin.
func (c *Client) checkLogTarget(target *url.URL) error {
	base := c.restClient.BaseURL
	if target.Scheme == "https" || (target.Scheme == base.Scheme && target.Host == base.Host) {
		return nil
	}

	return fmt.Errorf("%w: the log redirect is not https", errJobLogRedirect)
}

// publicAddr reports whether ip is one a log download may dial: not loopback,
// private, link-local, shared (100.64.0.0/10), multicast, unspecified, or the
// NAT64 prefix (64:ff9b::/96), which can name a private IPv4 address.
func publicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsMulticast() || !ip.IsValid() {
		return false
	}

	return !cgnat.Contains(ip) && !nat64.Contains(ip)
}

var (
	cgnat = netip.MustParsePrefix("100.64.0.0/10")
	nat64 = netip.MustParsePrefix("64:ff9b::/96")
)

// dialAddress is the host:port a dial to u's host carries, with the scheme's
// default port filled in, so it matches what the transport asks to dial.
func dialAddress(u *url.URL) string {
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}

	return net.JoinHostPort(strings.ToLower(u.Hostname()), port)
}

// logBlobClient is the one token-free client every blob download shares, so
// its connections are reused. It checks every redirect hop with checkLogTarget
// and follows at most maxLogRedirects. A direct dial goes only to a public
// address, except the API's own host (a GitHub Enterprise Server instance, a
// test), compared by name and port before it resolves. A proxied request is
// refused up front when its target is a literal non-public address or
// localhost; the proxy owns the rest, and the dial to the proxy itself is
// allowed.
func (c *Client) logBlobClient() *http.Client {
	c.logBlobMu.Lock()
	defer c.logBlobMu.Unlock()
	if c.logBlob == nil {
		c.logBlob = &http.Client{
			Timeout:       logFetchTimeout,
			Transport:     c.logTransport(),
			CheckRedirect: c.checkLogRedirect,
		}
	}

	return c.logBlob
}

func (c *Client) checkLogRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > maxLogRedirects {
		return fmt.Errorf("%w: too many redirects", errJobLogRedirect)
	}

	return c.checkLogTarget(req.URL)
}

// refusedTarget reports whether a proxied request's own host is one no proxy
// should be asked to reach: localhost or a literal non-public address.
func refusedTarget(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip, err := netip.ParseAddr(host)

	return err == nil && !publicAddr(ip)
}

func (c *Client) logTransport() *http.Transport {
	apiHost := dialAddress(c.restClient.BaseURL)
	proxyFor := c.logProxy
	if proxyFor == nil {
		proxyFor = http.ProxyFromEnvironment
	}
	var proxies sync.Map // host:port of each proxy chosen
	checked := &net.Dialer{
		Timeout: logFetchTimeout,
		Control: func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || !publicAddr(ap.Addr()) {
				return fmt.Errorf("%w: non-public address", errJobLogRedirect)
			}

			return nil
		},
	}
	open := &net.Dialer{Timeout: logFetchTimeout}

	return &http.Transport{
		Proxy: func(req *http.Request) (*url.URL, error) {
			pu, err := proxyFor(req)
			if err != nil || pu == nil {
				return nil, err
			}
			if refusedTarget(req.URL.Hostname()) {
				return nil, fmt.Errorf("%w: non-public address", errJobLogRedirect)
			}
			proxies.Store(pu.Host, true)

			return pu, nil
		},
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if _, isProxy := proxies.Load(address); isProxy || strings.EqualFold(address, apiHost) {
				return open.DialContext(ctx, network, address)
			}

			return checked.DialContext(ctx, network, address)
		},
		TLSHandshakeTimeout: logFetchTimeout,
	}
}

// redactedCause is err without the URL a *url.Error carries.
func redactedCause(err error) error {
	if ue, ok := errors.AsType[*url.Error](err); ok {
		return ue.Err
	}

	return err
}

// readTail reads r to its end but keeps only the last n bytes, so a body
// longer than asked for (a host that ignored the range) costs no more memory
// than n. skipped says bytes were dropped from the start.
func readTail(r io.Reader, n int) (tail []byte, skipped bool, err error) {
	buf := make([]byte, 0, 2*n)
	chunk := make([]byte, 32*1024)
	var total int
	for total < maxLogDownload {
		m, rerr := r.Read(chunk)
		total += m
		buf = append(buf, chunk[:m]...)
		if len(buf) >= 2*n {
			buf = append(buf[:0], buf[len(buf)-n:]...)
			skipped = true
		}
		if rerr == io.EOF {
			return finishTail(buf, n, skipped), skipped || len(buf) > n, nil
		}
		if rerr != nil {
			return nil, false, fmt.Errorf("read log: %w", rerr)
		}
	}
	// The cap came before the end: what is held is the middle of the body, not
	// its tail, so it is not shown as the end of the log.
	return nil, false, errJobLogTooLarge
}

func finishTail(buf []byte, n int, _ bool) []byte {
	if len(buf) > n {
		return buf[len(buf)-n:]
	}

	return buf
}

// startsAtZero reports whether a Content-Range header ("bytes 0-99/100")
// starts at the first byte. A missing or odd header counts as not.
func startsAtZero(header string) bool {
	return strings.HasPrefix(header, "bytes 0-")
}
