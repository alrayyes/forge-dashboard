package forgejo

import (
	"context"
	"net/http"
	"time"

	gitea "code.gitea.io/sdk/gitea"
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
// A mutex here would only serialise Settled callers. The hazard is a Settled
// call racing a direct ReadMainBranch, which would not take it, so the
// hazard is documented instead.
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

// RequestMayHaveQueued is requestMayHaveQueued.
func RequestMayHaveQueued(resp *gitea.Response, err error) bool {
	return requestMayHaveQueued(resp, err)
}

// SetVersionParkHook calls fn each time a click starts waiting for the version
// read another click is making.
func SetVersionParkHook(c *Client, fn func()) { c.version.parked = fn }

// VersionAnswerFresh is whether the cached version can still be trusted.
func VersionAnswerFresh(c *Client) bool {
	_, _, fresh := c.version.answer()

	return fresh
}

// RecordVersion lands a version read's answer, as a read finishing would.
func RecordVersion(c *Client, major int, ok bool) { c.version.record(major, ok) }

// JoinVersionRead is the step a click takes after finding the answer stale.
func JoinVersionRead(c *Client) (wait <-chan struct{}, lead bool) { return c.version.join() }

// VersionReadOpen is whether a version read holds the flight.
func VersionReadOpen(c *Client) bool {
	c.version.mu.Lock()
	defer c.version.mu.Unlock()

	return c.version.flight != nil
}

// WrapTransport puts wrap around the transport every request goes through.
func WrapTransport(c *Client, wrap func(next http.RoundTripper) http.RoundTripper) {
	c.httpClient.Transport = wrap(c.httpClient.Transport)
}
