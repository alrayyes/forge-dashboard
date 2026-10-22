package forgejo

// ExpireAdvisories makes every remembered advisory answer stale, so the next
// read asks again.
func ExpireAdvisories(c *Client) { c.advisories.expireAll() }
