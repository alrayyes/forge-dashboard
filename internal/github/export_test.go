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
