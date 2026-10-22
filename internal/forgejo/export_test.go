package forgejo

import "time"

// ExpireAdvisories makes every remembered advisory answer stale, so the next
// read asks again.
func ExpireAdvisories(c *Client) { c.advisories.expireAll() }

// SetAdvisoryClock replaces the clock the advisory cache expires by.
func SetAdvisoryClock(c *Client, now func() time.Time) { c.advisories.now = now }

// SetAdvisoryDeadline replaces how long one repo's advisory read may take.
func SetAdvisoryDeadline(c *Client, d time.Duration) { c.advisoryDeadline = d }
