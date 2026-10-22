// Package osv matches the packages in a repo's lockfiles against the OSV
// database (https://osv.dev), so a forge with no advisory feed of its own can
// still say which default branches carry known vulnerabilities.
package osv

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Package is one pinned dependency, in the names OSV uses for its ecosystem
// (https://ossf.github.io/osv-schema/#affectedpackage-field).
type Package struct {
	Ecosystem string
	Name      string
	Version   string
}

// Ecosystems the readers below produce.
const (
	EcosystemNPM = "npm"
	EcosystemGo  = "Go"
)

var errNoPackages = errors.New("osv: lockfile has no packages map")

// ParsePackageLock reads the installed packages from an npm package-lock.json
// (lockfile version 2 or 3). A version 1 file keeps its tree under
// "dependencies" instead, and is refused rather than read as empty: no packages
// would otherwise look like no advisories.
func ParsePackageLock(data []byte) ([]Package, error) {
	var lock struct {
		Packages map[string]struct {
			Version string `json:"version"`
			Link    bool   `json:"link"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		return nil, fmt.Errorf("osv: read package-lock.json: %w", err)
	}
	if lock.Packages == nil {
		return nil, errNoPackages
	}

	const marker = "node_modules/"
	var out []Package
	for key, p := range lock.Packages {
		i := strings.LastIndex(key, marker)
		if i < 0 || p.Link || p.Version == "" {
			continue // the root, a workspace folder or a symlink
		}
		out = append(out, Package{Ecosystem: EcosystemNPM, Name: key[i+len(marker):], Version: p.Version})
	}

	return out, nil
}

// ParseGoMod reads the modules a go.mod requires, direct and indirect, at the
// versions it pins. OSV's Go ecosystem writes versions without the leading "v".
func ParseGoMod(data []byte) ([]Package, error) {
	var out []Package
	inBlock := false
	for line := range strings.SplitSeq(string(data), "\n") {
		line, _, _ = strings.Cut(line, "//")
		fields := strings.Fields(line)
		switch {
		case len(fields) == 0:
			continue
		case inBlock && fields[0] == ")":
			inBlock = false
		case inBlock:
			if len(fields) >= 2 {
				out = append(out, goPackage(fields[0], fields[1]))
			}
		case fields[0] == "require" && len(fields) == 2 && fields[1] == "(":
			inBlock = true
		case fields[0] == "require" && len(fields) >= 3:
			out = append(out, goPackage(fields[1], fields[2]))
		}
	}

	return out, nil
}

func goPackage(module, version string) Package {
	return Package{Ecosystem: EcosystemGo, Name: module, Version: strings.TrimPrefix(version, "v")}
}
