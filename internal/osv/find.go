package osv

import (
	"cmp"
	"context"
	"slices"
	"strings"
)

// Finding is one advisory that hits the packages asked about, with what its
// OSV records state. A field no record states is empty. Records that list one
// another as aliases are one finding.
type Finding struct {
	// ID is the id the finding is known by: a GHSA id when the group has one.
	ID string
	// IDs is every id the group goes by (GHSA, CVE, PYSEC and so on), sorted.
	IDs      []string
	Summary  string
	Details  string // Markdown, as the database stores it
	Severity string // low, medium, high or critical; empty when none is stated
	// CVSSVector and CVSSScore are the highest scoring v3.x or v4 vector the
	// records state; both are empty when none is.
	CVSSVector string
	CVSSScore  float64
	Published  string // RFC 3339
	CWEs       []string
	References []string
	// Hits are the packages the finding applies to.
	Hits []Hit
}

// Hit is one of the asked-about packages that an advisory applies to, and the
// versions the records say fix it.
type Hit struct {
	Package Package
	Fixed   []string
}

// Find matches pkgs against OSV like Scan, but returns each distinct advisory
// with the fields its records state, for a list on demand. Any failed call is
// an error, and so is a scan past the same caps Scan has (ErrTooMany).
func (c *Client) Find(ctx context.Context, pkgs []Package) ([]Finding, error) {
	recs, hits, err := c.match(ctx, pkgs)
	if err != nil {
		return nil, err
	}
	roots := aliasRoots(recs)
	groups := map[string][]string{} // group root -> record ids
	for id, root := range roots {
		groups[root] = append(groups[root], id)
	}
	if len(groups) > maxAdvisories {
		return nil, ErrTooMany
	}

	out := make([]Finding, 0, len(groups))
	for _, ids := range groups {
		slices.Sort(ids)
		out = append(out, buildFinding(ids, recs, hits))
	}
	slices.SortFunc(out, func(a, b Finding) int { return strings.Compare(a.ID, b.ID) })

	return out, nil
}

// buildFinding merges the records of one advisory. The primary record, a GHSA
// one when there is one, speaks first; the others fill what it leaves out.
func buildFinding(ids []string, recs map[string]record, hits map[string][]Package) Finding {
	primary := ids[0]
	for _, id := range ids {
		if strings.HasPrefix(id, "GHSA-") {
			primary = id

			break
		}
	}
	order := append([]string{primary}, slices.DeleteFunc(slices.Clone(ids), func(id string) bool { return id == primary })...)

	f := Finding{ID: primary}
	all := map[string]struct{}{}
	var pkgs []Package
	for _, id := range order {
		r := recs[id]
		all[id] = struct{}{}
		for _, a := range r.aliases {
			all[a] = struct{}{}
		}
		f.Summary = cmp.Or(f.Summary, r.summary)
		f.Details = cmp.Or(f.Details, r.details)
		f.Published = cmp.Or(f.Published, r.published)
		if severityRank[r.severity] > severityRank[f.Severity] {
			f.Severity = r.severity
		}
		for _, v := range r.vectors {
			if score := baseScore(v); score > f.CVSSScore {
				f.CVSSScore, f.CVSSVector = score, v
			}
		}
		f.CWEs = appendNew(f.CWEs, r.cwes...)
		f.References = appendNew(f.References, r.references...)
		for _, p := range hits[id] {
			if !slices.Contains(pkgs, p) {
				pkgs = append(pkgs, p)
			}
		}
	}
	f.IDs = slices.Sorted(func(yield func(string) bool) {
		for id := range all {
			if !yield(id) {
				return
			}
		}
	})
	slices.SortFunc(pkgs, func(a, b Package) int {
		return cmp.Or(cmp.Compare(a.Ecosystem, b.Ecosystem), cmp.Compare(a.Name, b.Name), cmp.Compare(a.Version, b.Version))
	})
	for _, p := range pkgs {
		hit := Hit{Package: p}
		for _, id := range order {
			for _, a := range recs[id].affected {
				if a.name == p.Name {
					hit.Fixed = appendNew(hit.Fixed, a.fixed...)
				}
			}
		}
		f.Hits = append(f.Hits, hit)
	}

	return f
}

// appendNew appends the values not already in dst, in order.
func appendNew(dst []string, values ...string) []string {
	for _, v := range values {
		if v != "" && !slices.Contains(dst, v) {
			dst = append(dst, v)
		}
	}

	return dst
}
