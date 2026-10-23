package github

import (
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/advisorycache"
)

// ExpireAdvisories ages every cached advisory answer past its TTL and retry delay.
func (c *Client) ExpireAdvisories() { c.advisories.cache.Expire() }

// BaseURLForTest is the base URL this Client talks to.
func (c *Client) BaseURLForTest() string { return c.baseURL }

// ETagTransport is the caching transport this Client sends its REST reads
// through, so a test can send a request the Client's own methods never make.
func (c *Client) ETagTransport() http.RoundTripper { return c.etag }

// NewBackedETagTransport is NewETagTransport with a persistent backing behind
// its store, which starts empty in memory, the way a restarted process does.
func NewBackedETagTransport(base http.RoundTripper, credential string, backing ETagBacking) http.RoundTripper {
	rt := newETagTransport(base, credential)
	rt.store = newETagStore(maxETagEntries, maxETagTotalBytes)
	rt.store.backing = backing

	return rt
}

// NewETagTransport is a caching transport over base for the given credential
// label. It gets a store of its own, so no entry outlives the test that made
// it: the shared store is process-wide, and a repeated run (-count=N) would
// otherwise find the previous run's entry and send a conditional request.
func NewETagTransport(base http.RoundTripper, credential string) http.RoundTripper {
	rt := newETagTransport(base, credential)
	rt.store = newETagStore(maxETagEntries, maxETagTotalBytes)

	return rt
}

// ETagStoreBytes returns the byte total the ETag store tracks and the sum of
// the bodies it really holds. They must always be equal.
func (c *Client) ETagStoreBytes() (tracked, live int) {
	s := c.etag.store
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, el := range s.items {
		live += len(el.Value.(*etagItem).resp.body) //nolint:forcetypeassert // only etagItems are stored
	}

	return s.bytes, live
}

// ExpirePartialRequiredContexts ages every partial required-contexts entry past
// its short TTL, so a test can show what the next poll does without sleeping.
func (c *Client) ExpirePartialRequiredContexts() {
	c.requiredChecks.mu.Lock()
	defer c.requiredChecks.mu.Unlock()
	for key, entry := range c.requiredChecks.contexts {
		if !entry.answered {
			entry.fetched = entry.fetched.Add(-2 * partialContextsTTL)
			c.requiredChecks.contexts[key] = entry
		}
	}
}

// ExpireRequiredContexts ages every required-contexts entry, partial or not,
// past its TTL, so a test can show what the next poll does without sleeping.
func (c *Client) ExpireRequiredContexts() {
	c.requiredChecks.mu.Lock()
	defer c.requiredChecks.mu.Unlock()
	for key, entry := range c.requiredChecks.contexts {
		entry.fetched = entry.fetched.Add(-2 * requiredContextsTTL)
		c.requiredChecks.contexts[key] = entry
	}
}

// UseETagStoreLimits gives this Client a private ETag store with the given
// limits, so a test can reach an eviction without caching thousands of bodies.
func (c *Client) UseETagStoreLimits(maxEntries, maxBytes int) {
	c.etag.store = newETagStore(maxEntries, maxBytes)
}

// MaxETagBodyBytes is the largest body the ETag cache keeps.
const MaxETagBodyBytes = maxETagBodyBytes

// AdvisoriesRetry is how long a refused or failed alerts read waits to be asked again.
const AdvisoriesRetry = advisorycache.Retry

// AdvisoriesTTL is how long a known or settled-refused answer is reused.
const AdvisoriesTTL = advisorycache.TTL

// SetLogger gives the client its own logger in place of slog's default.
func (c *Client) SetLogger(l *slog.Logger) { c.log = l }

// AdvisoryTTLForTest is how long a repo's cached advisory answer has left.
func (c *Client) AdvisoryTTLForTest(repo string) time.Duration {
	return c.advisories.cache.Remaining(repo)
}

// SetLogProxyForTest replaces the proxy choice of the log blob client; call it
// before the first JobLog.
func (c *Client) SetLogProxyForTest(fn func(*http.Request) (*url.URL, error)) { c.logProxy = fn }

// LogBlobClientForTest is the shared client the log downloads use.
func (c *Client) LogBlobClientForTest() *http.Client { return c.logBlobClient() }
func DialAddressForTest(u *url.URL) string           { return dialAddress(u) }

// IssueSinceForTest is the issues since marker held for fullName, nil for none.
func (c *Client) IssueSinceForTest(fullName string) *time.Time {
	return c.issueState.sinceFor([]string{fullName})
}
