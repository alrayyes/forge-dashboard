package forgejo

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/osv"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// osvAdvisoryPage is where OSV shows one advisory. OSV has no page for a whole
// repo, so the list has no link of its own.
const osvAdvisoryPage = "https://osv.dev/vulnerability/"

// ListAdvisories implements dashboard.AdvisoryLister: the advisories behind a
// Forgejo row's count, read live when the advisories dialog opens. It reads the
// lock files of the default branch and matches them against OSV exactly as the
// row does, but past the cache, so it costs the same reads as a refresh does.
// What the row would call unknown (advisories off, no lock file, one that can't
// be read, OSV or the forge failing, too many advisories) is an unknown list
// with the cause, never an empty one.
//
// Opens that overlap on one repo share a single read: a double click costs
// once. The shared read doesn't stop when the first caller goes away; its own
// time budget bounds it.
func (c *Client) ListAdvisories(ctx context.Context, owner, name string) (dashboard.AdvisoryList, error) {
	repo := owner + "/" + name
	c.listMu.Lock()
	call, running := c.listCalls[repo]
	if !running {
		call = &listCall{done: make(chan struct{})}
		if c.listCalls == nil {
			c.listCalls = map[string]*listCall{}
		}
		c.listCalls[repo] = call
	}
	c.listMu.Unlock()

	if running {
		select {
		case <-call.done:
			return call.list, call.err
		case <-ctx.Done():
			return dashboard.AdvisoryList{}, fmt.Errorf("list advisories for %s: %w", repo, ctx.Err())
		}
	}

	call.list, call.err = c.readAdvisoryList(context.WithoutCancel(ctx), owner, name)
	c.listMu.Lock()
	delete(c.listCalls, repo)
	c.listMu.Unlock()
	close(call.done)

	return call.list, call.err
}

// listCall is one repo's dialog read in flight, and its outcome once done.
type listCall struct {
	done chan struct{}
	list dashboard.AdvisoryList
	err  error
}

func (c *Client) readAdvisoryList(ctx context.Context, owner, name string) (dashboard.AdvisoryList, error) {
	repo := owner + "/" + name
	if c.advisoryScanner == nil {
		return unknownList(dashboard.ReasonNotEnabled), nil
	}
	ctx = apistats.WithKind(ctx, apistats.KindAdvisories)

	branch, err := c.defaultBranch(ctx, owner, name)
	if err != nil {
		slog.Warn("advisory list: read the repo failed", "forge", dashboard.ForgeForgejo, "repo", repo, "error", err)

		return unknownList(dashboard.ReasonFailed), nil
	}
	if branch == "" {
		return unknownList(""), nil // an empty repo has no lock file
	}

	readCtx, cancel := osv.WithBudget(ctx, cmp.Or(c.advisoryDeadline, advisoryDeadline))
	defer cancel()
	pkgs, answer, err := c.lockfilePackages(readCtx, owner, name, branch)
	switch {
	case err != nil:
		slog.Warn("advisory list: lock files read failed", "forge", dashboard.ForgeForgejo, "repo", repo, "error", err)

		return unknownList(dashboard.ReasonFailed), nil
	case answer != nil:
		return unknownList(answer.Reason), nil
	}

	findings, err := c.advisoryScanner.Find(readCtx, pkgs.pkgs)
	switch {
	case errors.Is(err, osv.ErrTooMany):
		return unknownList(dashboard.ReasonTooMany), nil
	case err != nil:
		slog.Warn("advisory list: match against OSV failed", "forge", dashboard.ForgeForgejo, "repo", repo, "error", err)

		return unknownList(dashboard.ReasonFailed), nil
	}

	items := make([]dashboard.AdvisoryItem, 0, len(findings))
	for i := range findings {
		items = append(items, advisoryItemOf(&findings[i], pkgs.files))
	}
	sortItems(items)
	for i := range items {
		items[i].Number = i + 1
	}

	return dashboard.AdvisoryList{State: dashboard.AdvisoriesKnown, Partial: pkgs.partial, Advisories: items}, nil
}

func unknownList(reason dashboard.AdvisoryReason) dashboard.AdvisoryList {
	return dashboard.AdvisoryList{State: dashboard.AdvisoriesUnknown, Reason: reason, Advisories: []dashboard.AdvisoryItem{}}
}

// defaultBranch reads the repo's default branch, empty for a repo with none.
func (c *Client) defaultBranch(ctx context.Context, owner, name string) (string, error) {
	c = c.withContext(ctx)
	repoPath := fmt.Sprintf("/repos/%s/%s", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", repoPath)
	repo, resp, err := c.sdk.GetRepo(owner, name)
	if err != nil {
		return "", c.forgejoError(ctx, http.MethodGet, repoPath, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, repoPath, resp.StatusCode, requestlog.OutcomeSuccess)

	return repo.DefaultBranch, nil
}

// advisoryItemOf shapes one finding as the dialog shows it. What OSV does not
// state (the relationship, the scope, EPSS, the versions as a range) is left
// out. An advisory that hits more than one package names them all.
func advisoryItemOf(f *osv.Finding, from map[osv.Package][]string) dashboard.AdvisoryItem {
	item := dashboard.AdvisoryItem{
		State: "open", Severity: dashboard.AdvisorySeverity(f.Severity), Summary: cmp.Or(f.Summary, f.ID), ID: f.ID,
		OpenedAt: f.Published, Description: f.Details, References: f.References,
		URL: osvAdvisoryPage + f.ID,
	}
	for _, id := range f.IDs {
		switch {
		case strings.HasPrefix(id, "GHSA-") && item.GHSAID == "":
			item.GHSAID = id
		case strings.HasPrefix(id, "CVE-") && item.CVEID == "":
			item.CVEID = id
		}
	}
	if f.CVSSVector != "" {
		item.CVSS = &dashboard.AdvisoryCVSS{Score: f.CVSSScore, Vector: f.CVSSVector}
	}
	for _, cwe := range f.CWEs {
		item.Weaknesses = append(item.Weaknesses, dashboard.AdvisoryWeakness{ID: cwe})
	}

	var packages, ecosystems, files, fixed []string
	for _, h := range f.Hits {
		packages = append(packages, h.Package.Name+"@"+h.Package.Version)
		ecosystems = appendNew(ecosystems, h.Package.Ecosystem)
		files = appendNew(files, from[h.Package]...)
		fixed = appendNew(fixed, h.Fixed...)
	}
	slices.Sort(files)
	item.Package = strings.Join(packages, ", ")
	item.Ecosystem = strings.Join(ecosystems, ", ")
	item.ManifestPath = strings.Join(files, ", ")
	item.PatchedVersion = strings.Join(fixed, ", ")

	return item
}

func appendNew(dst []string, values ...string) []string {
	for _, v := range values {
		if v != "" && !slices.Contains(dst, v) {
			dst = append(dst, v)
		}
	}

	return dst
}

// sortItems puts the most severe first and, among equals, the newest, then by
// id so the order is the same on every read. The dates are RFC 3339 in UTC.
func sortItems(items []dashboard.AdvisoryItem) {
	slices.SortStableFunc(items, func(a, b dashboard.AdvisoryItem) int {
		return cmp.Or(
			cmp.Compare(b.Severity.Rank(), a.Severity.Rank()),
			cmp.Compare(b.OpenedAt, a.OpenedAt),
			cmp.Compare(a.ID, b.ID),
		)
	})
}
