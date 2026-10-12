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
