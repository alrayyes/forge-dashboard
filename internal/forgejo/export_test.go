package forgejo

import (
	"context"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// SetVersionClock replaces the clock the cached server version expires by.
func SetVersionClock(c *Client, now func() time.Time) { c.version.now = now }

// WaitForVersionProbe waits for the version read a refresh started in the
// background.
func WaitForVersionProbe(c *Client) { c.version.probes.Wait() }

// ReadAdvisories reads a repo's advisories once, past the cache, deadline and
// back-off that ReadMainBranch applies.
func ReadAdvisories(ctx context.Context, c *Client, owner, name string) (dashboard.Advisories, error) {
	return ReadAdvisoriesOn(ctx, c, owner, name, "main")
}

// ReadAdvisoriesOn is ReadAdvisories for a named default branch.
func ReadAdvisoriesOn(ctx context.Context, c *Client, owner, name, branch string) (dashboard.Advisories, error) {
	v, _, err := c.readAdvisories(ctx, owner, name, branch, nil)

	return v, err
}

// SetAdvisoryClock replaces the clock the advisory cache expires by.
func SetAdvisoryClock(c *Client, now func() time.Time) { c.advisories.Now = now }

// SetAdvisoryDeadline replaces how long one repo's advisory read may take.
func SetAdvisoryDeadline(c *Client, d time.Duration) { c.advisoryDeadline = d }

// WaitForAdvisories waits for the advisory reads ReadMainBranch started in the
// background.
func WaitForAdvisories(c *Client) { c.advisoryReads.Wait() }

// ReadMainBranchSettled is ReadMainBranch as a caller sees it once the advisory
// read it started has finished: the first call starts the read, and the second
// one is answered from what it remembered. It is not safe to call concurrently
// on one client: its Wait would race another caller's first read starting its
// background read. Start concurrent reads with ReadMainBranch, then settle once.
// A mutex here would not fix that: the racing Add comes from ReadMainBranch,
// which does not take it, so the hazard is documented instead.
func ReadMainBranchSettled(ctx context.Context, c *Client, repo dashboard.RepoRef) (dashboard.MainBranch, error) {
	if _, err := c.ReadMainBranch(ctx, repo); err != nil {
		return dashboard.MainBranch{}, err
	}
	WaitForAdvisories(c)

	return c.ReadMainBranch(ctx, repo)
}

// ListJoined is how many opens have joined a dialog read already in flight.
func ListJoined(c *Client) int { return int(c.listJoined.Load()) }

// CountChecks exposes the production tally of a check list to the black-box tests.
var CountChecks = countChecks

// RerunJobPath is the route the client reruns one Actions job through, as an
// OpenAPI path template.
const RerunJobPath = rerunJobPath
