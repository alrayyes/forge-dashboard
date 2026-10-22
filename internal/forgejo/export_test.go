package forgejo

import (
	"context"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// ReadAdvisories reads a repo's advisories once, past the cache, deadline and
// back-off that ReadMainBranch applies.
func ReadAdvisories(ctx context.Context, c *Client, owner, name string) (dashboard.Advisories, error) {
	v, _, err := c.readAdvisories(ctx, owner, name, nil)

	return v, err
}

// SetAdvisoryClock replaces the clock the advisory cache expires by.
func SetAdvisoryClock(c *Client, now func() time.Time) { c.advisories.now = now }

// SetAdvisoryDeadline replaces how long one repo's advisory read may take.
func SetAdvisoryDeadline(c *Client, d time.Duration) { c.advisoryDeadline = d }
