package github

import "net/http"

// ETagTransport is the caching transport this Client sends its REST reads
// through, so a test can send a request the Client's own methods never make.
func (c *Client) ETagTransport() http.RoundTripper { return c.etag }

// NewETagTransport is a caching transport over base for the given credential
// label, backed by the shared store.
func NewETagTransport(base http.RoundTripper, credential string) http.RoundTripper {
	return newETagTransport(base, credential)
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
