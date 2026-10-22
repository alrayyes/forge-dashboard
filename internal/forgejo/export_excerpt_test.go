package forgejo

import "time"

// SetExcerptReadTimeoutForTest shortens how long c waits on one job log.
func SetExcerptReadTimeoutForTest(c *Client, d time.Duration) {
	c.excerptTimeout = d
}
