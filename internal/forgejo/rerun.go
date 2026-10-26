package forgejo

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// errNothingToRerun is why a rerun found no failed Actions run on the pull
// request's head commit. Shown to a person, so it reads as a sentence and
// carries no "forgejo: " prefix the page would swap for a generic one.
var errNothingToRerun = errors.New("no failed job to rerun on this pull request")

// rerunJobPath is the route Forgejo offers to rerun one Actions job, as an
// OpenAPI path template. It first shipped in Forgejo 17.0.0, beside a route
// that reruns a whole run; 16 and earlier have no rerun route at all. The job
// route is the one used, so a job that passed doesn't go again. Forgejo
// restarts the jobs that need the one asked for along with it.
const rerunJobPath = "/repos/{owner}/{repo}/actions/jobs/{job_id}/rerun"

// firstRerunMajor is the first Forgejo major version with rerunJobPath.
const firstRerunMajor = 17

// firstForgejoMajor is the first major version only a Forgejo reports. Before
// it Forgejo numbered itself like the Gitea it forked, so a 1.x could be either
// and the button is not hidden. The forge then decides: a 404 may mean it has
// no job rerun route, which the refusal says without naming a version.
const firstForgejoMajor = 7

// errNoRerunRoute is why a rerun on a Forgejo older than firstRerunMajor never
// reaches the forge. Shown to a person, so it reads as a sentence.
var errNoRerunRoute = errors.New("This Forgejo is older than version 17 and has no way to rerun checks. Rerun them on the forge.") //nolint:staticcheck,revive // shown to a person

// RerunChecksBlockedReason implements dashboard.RerunChecksBlocker: why this
// instance can't rerun checks, or "" when it can or its version isn't known.
// It never waits on the network. The version is read in the background the
// first time it is asked for, read again after an hour while it blocks, and
// retried after a failed read; until a read lands the rerun is left to the
// forge.
func (c *Client) RerunChecksBlockedReason() string {
	if major, ok := c.serverMajor(); ok && major < firstRerunMajor {
		return errNoRerunRoute.Error()
	}

	return ""
}

// rerunBlocked is the refusal for an instance with no rerun route, or nil.
// A stale answer is read again under the click's own context first.
func (c *Client) rerunBlocked(ctx context.Context) error {
	major, ok, err := c.serverMajorFor(ctx)
	if err != nil {
		return err
	}
	if !ok || major >= firstRerunMajor {
		return nil
	}

	return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errNoRerunRoute}
}

// RerunFailedChecks implements dashboard.ChecksRerunner: it finds the Actions
// runs on the pull request's head commit, reads the jobs of each run that
// failed, and asks Forgejo to rerun each job that failed. A commit status
// doesn't say which run it came from, so the runs are looked up by commit
// instead. A status with no run behind it (an external CI) isn't there to find
// and is skipped.
//
// The rerun is a raw request, not an SDK call: the SDK drops the body of a
// refusal, and Forgejo's own reason (a token without the Actions scope, an
// instance without the route) is what a person needs.
func (c *Client) RerunFailedChecks(ctx context.Context, owner, name string, number int) error {
	if err := c.rerunBlocked(ctx); err != nil {
		return err
	}
	c = c.withContext(ctx)
	prPath := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", prPath)
	pr, resp, err := c.sdk.GetPullRequest(owner, name, int64(number))
	if err != nil {
		return c.forgejoError(ctx, http.MethodGet, prPath, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, prPath, resp.StatusCode, requestlog.OutcomeSuccess)

	var sha string
	if pr.Head != nil {
		sha = pr.Head.Sha
	}
	failed, err := c.failedRunIDs(ctx, owner, name, sha)
	if err != nil {
		return err
	}
	if len(failed) == 0 {
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errNothingToRerun}
	}
	n, err := c.rerunFailedJobs(ctx, owner, name, failed)
	if err != nil {
		return err
	}
	if n == 0 {
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errNothingToRerun}
	}

	return nil
}

// errNothingToRerunOnBranch is errNothingToRerun for a default branch.
var errNothingToRerunOnBranch = errors.New("no failed job to rerun on this branch")

// RerunFailedDefaultBranchChecks implements dashboard.DefaultBranchRerunner: it
// asks Forgejo to rerun the failed jobs of every failed Actions run on the
// newest commit of owner/name's default branch that has one, the commit the
// Main branches row reports. The row names the branch, so the repository isn't
// read to learn it.
func (c *Client) RerunFailedDefaultBranchChecks(ctx context.Context, owner, name, defaultBranch string) error {
	if err := c.rerunBlocked(ctx); err != nil {
		return err
	}
	c = c.withContext(ctx)
	var failed []int64
	if defaultBranch != "" {
		runs, err := c.branchRunsList(ctx, dashboard.RepoRef{
			FullName: owner + "/" + name, Owner: owner, Name: name, DefaultBranch: defaultBranch,
		}, true)
		if err != nil {
			return err
		}
		for _, run := range runs {
			if checkStateFromWorkflowStatus(run.Status) == dashboard.CheckFailure {
				failed = append(failed, run.ID)
			}
		}
	}
	if len(failed) == 0 {
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errNothingToRerunOnBranch}
	}
	n, err := c.rerunFailedJobs(ctx, owner, name, failed)
	if err != nil {
		return err
	}
	if n == 0 {
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errNothingToRerunOnBranch}
	}

	return nil
}

// partialNote is the sentence for a refusal that came partway, and whether it
// leaves a job that may be running.
type partialNote struct {
	text string
	// mayRun is set when a job may have restarted without the forge saying so,
	// which is when "try again" would read oddly beside the refusal.
	mayRun bool
}

// rerunProgress is what a rerun has done so far, for a refusal that comes
// partway.
type rerunProgress struct {
	restarted []string
}

// partial is the sentence for a refusal after some jobs went, or after one whose
// request got no answer: which restarted, which may have, and which did not.
// notYet is the failed jobs of the run being worked on that were not restarted,
// and laterRuns the failed runs not yet looked at. maybe names the job whose
// request got no answer, which the forge may have queued; with othersMaybe the
// run's other failed jobs may have gone along with it, so they are not listed
// as left undone. It is empty when nothing restarted and nothing may have,
// since the refusal then says it all.
func (p *rerunProgress) partial(notYet []string, laterRuns int, maybe string, othersMaybe bool) partialNote {
	if len(p.restarted) == 0 && maybe == "" {
		return partialNote{}
	}
	var out []string
	if len(p.restarted) > 0 {
		out = append(out, p.restartedSentence())
	}
	if maybe != "" {
		sentence := maybe + " may have restarted"
		if othersMaybe {
			sentence += ", and so may the other failed jobs of this run"
		}
		out = append(out, sentence+".")
	}
	if skipped := listWithRuns(notYet, laterRuns); skipped != "" {
		out = append(out, "Did not restart "+skipped+".")
	}

	return partialNote{text: strings.Join(out, " "), mayRun: maybe != ""}
}

// partialUnknown is partial for a refusal that left the run's jobs unread, so
// which of its other failed jobs went along with a restarted one is not known.
func (p *rerunProgress) partialUnknown(laterRuns int) partialNote {
	if len(p.restarted) == 0 {
		return partialNote{}
	}
	out := p.restartedSentence() + " The other failed jobs of this run may have restarted with them."
	if later := listWithRuns(nil, laterRuns); later != "" {
		out += " Did not restart " + later + "."
	}

	return partialNote{text: out, mayRun: true}
}

func (p *rerunProgress) restartedSentence() string {
	return "Restarted " + strings.Join(p.restarted, ", ") + "."
}

// listWithRuns lists the job names, then a note on the failed runs not yet
// looked at, joined on with "and".
func listWithRuns(names []string, laterRuns int) string {
	var note string
	switch {
	case laterRuns == 1:
		note = "the failed jobs of 1 other run"
	case laterRuns > 1:
		note = fmt.Sprintf("the failed jobs of %d other runs", laterRuns)
	}
	switch {
	case len(names) == 0:
		return note
	case note == "":
		return strings.Join(names, ", ")
	}

	return strings.Join(names, ", ") + " and " + note
}

// withPartial returns err with the partial rerun sentence attached. An error
// that isn't a ClientError (an undecodable job list, say) is wrapped in one, so
// the sentence is not lost.
func withPartial(err error, partial partialNote) error {
	if partial.text == "" {
		return err
	}
	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	if !ok {
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorUnknown, Err: err, Partial: partial.text, MayHaveRestarted: partial.mayRun}
	}
	cp := *clientErr
	cp.Partial, cp.MayHaveRestarted = partial.text, partial.mayRun

	return &cp
}

// rerunFailedJobs asks Forgejo to rerun each failed job of each run in ids, and
// says how many it asked for. A run's jobs are read once. Forgejo restarts the
// jobs that need a rerun job along with it, and refuses to rerun one that is
// going again, so before each job after the first the run's jobs are read
// again and a job that is no longer failed is left alone. That re-read can't be
// cut to one: whether a rerun restarts other jobs depends on the run's
// dependency graph, which the job list doesn't carry, so any job's rerun may
// have started the next failed one.
func (c *Client) rerunFailedJobs(ctx context.Context, owner, name string, ids []int64) (int, error) {
	progress := &rerunProgress{}
	for i, runID := range ids {
		err := c.rerunFailedJobsOfRun(ctx, owner, name, runID, progress, len(ids)-i-1)
		if err != nil {
			return len(progress.restarted), err
		}
	}

	return len(progress.restarted), nil
}

// rerunFailedJobsOfRun does rerunFailedJobs for one run. laterRuns is how many
// failed runs come after it.
func (c *Client) rerunFailedJobsOfRun(ctx context.Context, owner, name string, runID int64, progress *rerunProgress, laterRuns int) error {
	jobs, err := c.listWholeRunJobs(ctx, owner, name, runID)
	if err != nil {
		return withPartial(err, progress.partial(nil, laterRuns+1, "", false))
	}
	failed := failedJobIDs(jobs)
	for i, jobID := range failed {
		if i > 0 {
			fresh, err := c.listWholeRunJobs(ctx, owner, name, runID)
			if err != nil {
				return withPartial(err, progress.partialUnknown(laterRuns))
			}
			jobs = fresh
			if !slices.Contains(failedJobIDs(jobs), jobID) {
				continue
			}
		}
		rerunPath := fmt.Sprintf("/repos/%s/%s/actions/jobs/%d/rerun", owner, name, jobID)
		slog.Debug("forgejo request", "method", http.MethodPost, "url", rerunPath)
		if _, resp, err := c.rawRequest(ctx, http.MethodPost, rerunPath, nil); err != nil {
			// Read from the error as the transport gave it: forgejoError keeps
			// only its text, which hides a refused dial or a failed lookup.
			mayHaveQueued := requestMayHaveQueued(resp, err)
			err = c.forgejoError(ctx, http.MethodPost, rerunPath, resp, err)

			return withPartial(err, progress.refusedPartial(jobs, failed[i:], laterRuns, mayHaveQueued))
		}
		progress.restarted = append(progress.restarted, jobNames(jobs, []int64{jobID})...)
	}

	return nil
}

// refusedPartial is partial for a request that failed on the first of ids, the
// failed jobs of the run from there on. A request that certainly did not go
// leaves the job, and those after it that are still failed, as not restarted.
// One that may have gone leaves the first as one that may have restarted and
// the run's other failed jobs as unknown, since Forgejo restarts the jobs that
// need a job along with it and the forge cannot be asked what it did.
func (p *rerunProgress) refusedPartial(jobs []*gitea.ActionWorkflowJob, ids []int64, laterRuns int, mayHaveQueued bool) partialNote {
	left := stillFailed(jobs, ids)
	if !mayHaveQueued {
		return p.partial(jobNames(jobs, left), laterRuns, "", false)
	}
	first := ids[0]
	others := slices.DeleteFunc(left, func(id int64) bool { return id == first })

	return p.partial(nil, laterRuns, strings.Join(jobNames(jobs, []int64{first}), ""), len(others) > 0)
}

// requestMayHaveQueued reports whether a failed job rerun request may still have
// been acted on by the forge. err is the error as the transport returned it,
// not one forgejoError has rebuilt. An answer with a failing status was a
// refusal, except a gateway's 502, 503 or 504, which a proxy can send after
// the forge queued the job. An answer that succeeded but could not be read was
// most likely acted on. With no answer at all it depends on how far the request
// got: one that provably never reached the forge (the name did not resolve, the
// connection or proxy was refused, the certificate was rejected) did nothing.
// Anything else (a timeout, a reset, a handshake that timed out, a cancelled
// wait) says nothing about what the forge did and counts as possibly queued.
func requestMayHaveQueued(resp *gitea.Response, err error) bool {
	if resp != nil && resp.Response != nil {
		switch resp.StatusCode {
		case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
			return true
		}

		return resp.StatusCode < http.StatusMultipleChoices
	}
	var (
		dnsErr    *net.DNSError
		opErr     *net.OpError
		certErr   *tls.CertificateVerificationError
		unknownCA x509.UnknownAuthorityError
		hostErr   x509.HostnameError
		invalid   x509.CertificateInvalidError
		alert     tls.AlertError
		header    tls.RecordHeaderError
	)
	switch {
	case errors.As(err, &dnsErr), errors.As(err, &certErr), errors.As(err, &unknownCA),
		errors.As(err, &hostErr), errors.As(err, &invalid), errors.As(err, &alert), errors.As(err, &header):
		return false
	case errors.As(err, &opErr) && (opErr.Op == "dial" || opErr.Op == "proxyconnect"):
		return false
	}

	return true
}

// stillFailed is the ids that jobs still reads as failed: a job Forgejo
// restarted along with another is going again and wasn't left undone.
func stillFailed(jobs []*gitea.ActionWorkflowJob, ids []int64) []int64 {
	now := failedJobIDs(jobs)

	return slices.DeleteFunc(slices.Clone(ids), func(id int64) bool { return !slices.Contains(now, id) })
}

// jobNames is the name of each job in ids, or its id when the forge sent none.
func jobNames(jobs []*gitea.ActionWorkflowJob, ids []int64) []string {
	names := make([]string, 0, len(ids))
	for _, id := range ids {
		name := strconv.FormatInt(id, 10)
		for _, j := range jobs {
			if j.ID == id && j.Name != "" {
				name = j.Name
			}
		}
		names = append(names, name)
	}

	return names
}

// failedJobIDs is the id of every job in jobs that failed.
func failedJobIDs(jobs []*gitea.ActionWorkflowJob) []int64 {
	var ids []int64
	for _, j := range jobs {
		if checkStateFromWorkflowStatus(j.Status) == dashboard.CheckFailure {
			ids = append(ids, j.ID)
		}
	}

	return ids
}

// failedRunIDs is the id of every Actions run on commit sha that failed. A
// commit nobody can name has none.
func (c *Client) failedRunIDs(ctx context.Context, owner, name, sha string) ([]int64, error) {
	c = c.withContext(ctx)
	if sha == "" {
		return nil, nil
	}
	runsPath := fmt.Sprintf("/repos/%s/%s/actions/runs", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", runsPath)
	runs, resp, err := c.sdk.ListRepoActionRuns(owner, name, gitea.ListRepoActionRunsOptions{
		PageSize: pageLimit,
		HeadSHA:  sha,
	})
	if err != nil {
		return nil, c.forgejoError(ctx, http.MethodGet, runsPath, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, runsPath, resp.StatusCode, requestlog.OutcomeSuccess)

	var ids []int64
	for _, run := range runs.WorkflowRuns {
		if checkStateFromWorkflowStatus(run.Status) == dashboard.CheckFailure {
			ids = append(ids, run.ID)
		}
	}

	return ids, nil
}
