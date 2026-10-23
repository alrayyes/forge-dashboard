package github

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// alertListItem is one Dependabot alert as GET /repos/{owner}/{repo}/dependabot/alerts
// sends it. It is read with a struct of our own rather than go-github's, which
// has no field for the dependency's relationship (direct or transitive).
type alertListItem struct {
	Number     int    `json:"number"`
	State      string `json:"state"`
	HTMLURL    string `json:"html_url"`
	CreatedAt  string `json:"created_at"`
	Dependency struct {
		Package struct {
			Ecosystem string `json:"ecosystem"`
			Name      string `json:"name"`
		} `json:"package"`
		ManifestPath string `json:"manifest_path"`
		Scope        string `json:"scope"`
		Relationship string `json:"relationship"`
	} `json:"dependency"`
	SecurityAdvisory struct {
		GHSAID      string `json:"ghsa_id"`
		CVEID       string `json:"cve_id"`
		Summary     string `json:"summary"`
		Description string `json:"description"`
		Severity    string `json:"severity"`
		CVSS        *struct {
			Score        float64 `json:"score"`
			VectorString string  `json:"vector_string"`
		} `json:"cvss"`
		CWEs []struct {
			CWEID string `json:"cwe_id"`
			Name  string `json:"name"`
		} `json:"cwes"`
		EPSS *struct {
			Percentage float64 `json:"percentage"`
			Percentile float64 `json:"percentile"`
		} `json:"epss"`
		References []struct {
			URL string `json:"url"`
		} `json:"references"`
	} `json:"security_advisory"`
	SecurityVulnerability struct {
		VulnerableVersionRange string `json:"vulnerable_version_range"`
		FirstPatchedVersion    *struct {
			Identifier string `json:"identifier"`
		} `json:"first_patched_version"`
	} `json:"security_vulnerability"`
}

// ListAdvisories implements dashboard.AdvisoryLister: every open Dependabot
// alert of the repo with the fields GitHub's alert page shows, read live when
// the advisories dialog opens. An answer GitHub refused (alerts off, a token
// without the permission), a rate limit, any other failure and a repo with more
// alerts than maxAlertPages hold are an unknown list with the cause, never an
// empty one.
func (c *Client) ListAdvisories(ctx context.Context, owner, name string) (dashboard.AdvisoryList, error) {
	ctx = apistats.WithKind(ctx, apistats.KindAdvisories)
	out := dashboard.AdvisoryList{State: dashboard.AdvisoriesKnown, Advisories: []dashboard.AdvisoryItem{}}
	after := ""
	for range maxAlertPages {
		alerts, next, err := c.readAlertPage(ctx, owner, name, after)
		if err != nil {
			return unknownAdvisoryList(listFailureReason(err)), nil
		}
		for i := range alerts {
			out.Advisories = append(out.Advisories, advisoryItemOf(&alerts[i]))
		}
		if next == "" {
			sortAdvisories(out.Advisories)
			// The repo's alerts page is the folder of an alert's own page, so it
			// follows the forge's host without the client knowing it.
			if alert := out.Advisories; len(alert) > 0 && strings.Contains(alert[0].URL, "/") {
				out.URL = alert[0].URL[:strings.LastIndex(alert[0].URL, "/")]
			}

			return out, nil
		}
		after = next
	}

	return unknownAdvisoryList(dashboard.ReasonTooMany), nil
}

func unknownAdvisoryList(reason dashboard.AdvisoryReason) dashboard.AdvisoryList {
	return dashboard.AdvisoryList{State: dashboard.AdvisoriesUnknown, Reason: reason, Advisories: []dashboard.AdvisoryItem{}}
}

// readAlertPage reads one page of open alerts and the cursor of the next, empty
// on the last page.
func (c *Client) readAlertPage(ctx context.Context, owner, name, after string) ([]alertListItem, string, error) {
	query := url.Values{"state": {"open"}, "per_page": {strconv.Itoa(perPage)}}
	if after != "" {
		query.Set("after", after)
	}
	req, err := c.restClient.NewRequest("GET", "repos/"+url.PathEscape(owner)+"/"+url.PathEscape(name)+"/dependabot/alerts?"+query.Encode(), nil)
	if err != nil {
		return nil, "", fmt.Errorf("list dependabot alerts: %w", err)
	}
	var alerts []alertListItem
	resp, err := c.restClient.Do(ctx, req, &alerts)
	if err != nil {
		return nil, "", fmt.Errorf("list dependabot alerts: %w", err)
	}

	return alerts, resp.After, nil
}

// listFailureReason names the cause of a failed alerts read in the words the
// row's own advisories use.
func listFailureReason(err error) dashboard.AdvisoryReason {
	// Unwrap the call's own prefix, which alertsFailure would not recognise.
	cause := errors.Unwrap(err)
	if cause == nil {
		cause = err
	}
	v, _, failure := alertsFailure(cause)
	switch {
	case errors.Is(failure, errAdvisoriesThrottled):
		return dashboard.ReasonThrottled
	case failure != nil:
		return dashboard.ReasonFailed
	default:
		return v.Reason
	}
}

func advisoryItemOf(a *alertListItem) dashboard.AdvisoryItem {
	adv, vuln := &a.SecurityAdvisory, &a.SecurityVulnerability
	item := dashboard.AdvisoryItem{
		Number: a.Number, State: a.State, Severity: dashboard.AdvisorySeverity(adv.Severity), Summary: adv.Summary,
		GHSAID: adv.GHSAID, CVEID: adv.CVEID,
		Package: a.Dependency.Package.Name, Ecosystem: a.Dependency.Package.Ecosystem,
		Scope: a.Dependency.Scope, Relationship: a.Dependency.Relationship, ManifestPath: a.Dependency.ManifestPath,
		OpenedAt: a.CreatedAt, VulnerableVersions: vuln.VulnerableVersionRange,
		Description: adv.Description, URL: a.HTMLURL,
	}
	if vuln.FirstPatchedVersion != nil {
		item.PatchedVersion = vuln.FirstPatchedVersion.Identifier
	}
	if adv.CVSS != nil && (adv.CVSS.Score > 0 || adv.CVSS.VectorString != "") {
		item.CVSS = &dashboard.AdvisoryCVSS{Score: adv.CVSS.Score, Vector: adv.CVSS.VectorString}
	}
	for _, w := range adv.CWEs {
		item.Weaknesses = append(item.Weaknesses, dashboard.AdvisoryWeakness{ID: w.CWEID, Name: w.Name})
	}
	for _, r := range adv.References {
		item.References = append(item.References, r.URL)
	}
	if adv.EPSS != nil {
		item.EPSS = &dashboard.AdvisoryEPSS{Percentage: adv.EPSS.Percentage, Percentile: adv.EPSS.Percentile}
	}

	return item
}

// sortAdvisories puts the most severe first and, among equals, the newest. The
// timestamps are RFC 3339 in UTC, so comparing them as text orders them.
func sortAdvisories(list []dashboard.AdvisoryItem) {
	sort.SliceStable(list, func(i, j int) bool {
		if ri, rj := list[i].Severity.Rank(), list[j].Severity.Rank(); ri != rj {
			return ri > rj
		}

		return list[i].OpenedAt > list[j].OpenedAt
	})
}
