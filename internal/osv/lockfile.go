// Package osv matches the packages in a repo's lockfiles against the OSV
// database (https://osv.dev), so a forge with no advisory feed of its own can
// still say which default branches carry known vulnerabilities.
package osv

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
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
			Name    string `json:"name"`
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
		i := strings.LastIndex(key, marker) //nolint:modernize // CutLast needs a newer Go than this module pins
		if i < 0 || p.Link || p.Version == "" {
			continue // the root, a workspace folder or a symlink
		}
		name := key[i+len(marker):]
		if p.Name != "" {
			name = p.Name // an aliased install ("my-lodash": npm:lodash) is the real package
		}
		out = append(out, Package{Ecosystem: EcosystemNPM, Name: name, Version: p.Version})
	}

	return out, nil
}

// ParseGoMod reads the modules a go.mod builds, direct and indirect, at the
// versions it pins. OSV's Go ecosystem writes versions without the leading "v".
// A replace directive swaps the module that is built: one to another module
// reads as that module and version, one to a local path leaves nothing to match
// and drops the module.
func ParseGoMod(data []byte) ([]Package, error) {
	var requires, replaces [][]string
	block := ""
	for line := range strings.SplitSeq(string(data), "\n") {
		line, _, _ = strings.Cut(line, "//")
		fields := strings.Fields(line)
		switch {
		case len(fields) == 0:
			continue
		case block != "" && fields[0] == ")":
			block = ""
		case block == "require":
			requires = append(requires, fields)
		case block == "replace":
			replaces = append(replaces, fields)
		case len(fields) == 2 && fields[1] == "(" && (fields[0] == "require" || fields[0] == "replace"):
			block = fields[0]
		case fields[0] == "require":
			requires = append(requires, fields[1:])
		case fields[0] == "replace":
			replaces = append(replaces, fields[1:])
		}
	}

	return applyReplaces(requires, replaces), nil
}

// applyReplaces turns require lines (module, version) into packages, after the
// replace lines (old [version] => new [version]).
func applyReplaces(requires, replaces [][]string) []Package {
	type target struct{ module, version string }
	all := map[string]target{}      // replaces every version of a module
	exact := map[[2]string]target{} // replaces one version
	for _, f := range replaces {
		arrow := slices.Index(f, "=>")
		if arrow < 1 || arrow == len(f)-1 || arrow > 2 {
			continue
		}
		to := target{module: f[arrow+1]}
		if len(f) > arrow+2 {
			to.version = f[arrow+2]
		}
		if arrow == 2 {
			exact[[2]string{f[0], f[1]}] = to
		} else {
			all[f[0]] = to
		}
	}

	var out []Package
	for _, f := range requires {
		if len(f) < 2 {
			continue
		}
		module, version := f[0], f[1]
		to, ok := exact[[2]string{module, version}]
		if !ok {
			to, ok = all[module]
		}
		if ok {
			if to.version == "" {
				continue // a local path: not a published module
			}
			module, version = to.module, to.version
		}
		out = append(out, goPackage(module, version))
	}

	return out
}

func goPackage(module, version string) Package {
	return Package{Ecosystem: EcosystemGo, Name: module, Version: strings.TrimPrefix(version, "v")}
}
