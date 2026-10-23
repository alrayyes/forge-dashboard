package dashboard

import "context"

// AdvisoryList is one repo's open dependency advisories in full, for the
// advisories dialog on the Main branches page. Matches
// components.schemas.AdvisoryList.
type AdvisoryList struct {
	// State is known when the forge answered, unknown when it could not say.
	// An unknown list is empty, never a statement that nothing is open.
	State AdvisoryState `json:"state"`
	// Reason says why the state is unknown, when the dashboard knows.
	Reason AdvisoryReason `json:"reason,omitempty"`
	// URL is the repo's advisories page on the forge. Empty when there are none.
	URL string `json:"url,omitempty"`
	// Advisories is sorted by severity, highest first, then newest first.
	Advisories []AdvisoryItem `json:"advisories"`
}

// AdvisoryItem is one open advisory with the fields the forge's own alert page
// shows. A field the forge did not send is empty and left out. Matches
// components.schemas.AdvisoryItem.
type AdvisoryItem struct {
	Number   int              `json:"number"`
	State    string           `json:"state"`
	Severity AdvisorySeverity `json:"severity,omitempty"`
	Summary  string           `json:"summary"`
	GHSAID   string           `json:"ghsaId,omitempty"`
	CVEID    string           `json:"cveId,omitempty"`
	// Package and Ecosystem name the vulnerable dependency.
	Package   string `json:"package,omitempty"`
	Ecosystem string `json:"ecosystem,omitempty"`
	// Scope is runtime or development; Relationship is direct or transitive.
	Scope        string `json:"scope,omitempty"`
	Relationship string `json:"relationship,omitempty"`
	// ManifestPath is the file the dependency was detected in.
	ManifestPath       string             `json:"manifestPath,omitempty"`
	OpenedAt           string             `json:"openedAt,omitempty"`
	VulnerableVersions string             `json:"vulnerableVersions,omitempty"`
	PatchedVersion     string             `json:"patchedVersion,omitempty"`
	CVSS               *AdvisoryCVSS      `json:"cvss,omitempty"`
	Weaknesses         []AdvisoryWeakness `json:"weaknesses,omitempty"`
	// Description is Markdown as the forge stores it: render it with raw HTML
	// disabled.
	Description string        `json:"description,omitempty"`
	References  []string      `json:"references,omitempty"`
	EPSS        *AdvisoryEPSS `json:"epss,omitempty"`
	// URL is the alert on the forge.
	URL string `json:"url,omitempty"`
}

// AdvisoryCVSS is a CVSS base score with its vector.
type AdvisoryCVSS struct {
	Score  float64 `json:"score"`
	Vector string  `json:"vector,omitempty"`
}

// AdvisoryWeakness is one CWE the advisory is filed under.
type AdvisoryWeakness struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

// AdvisoryEPSS is the chance, in percent, that the flaw is exploited in the next
// 30 days, and how that ranks among all scored flaws (also percent).
type AdvisoryEPSS struct {
	Percentage float64 `json:"percentage"`
	Percentile float64 `json:"percentile"`
}

// AdvisoryLister is implemented by a Source that can list a repo's open
// advisories in full, on demand and never as part of a refresh.
type AdvisoryLister interface {
	ListAdvisories(ctx context.Context, owner, name string) (AdvisoryList, error)
}
