package github

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
