package osv

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// ParseBunLock reads the packages in a bun.lock, the text lock file bun
// writes. It is JSON with comments and trailing commas. Each package maps to
// [ "name@version", registry, metadata, integrity ], where an empty registry
// means the default (public) npm registry. A package from a custom registry,
// git, a tarball or the workspace stays out. The binary bun.lockb is not read.
func ParseBunLock(data []byte) ([]Package, error) {
	var lock struct {
		Packages map[string][]json.RawMessage `json:"packages"`
	}
	if err := json.Unmarshal(jsoncToJSON(data), &lock); err != nil {
		return nil, fmt.Errorf("osv: read bun.lock: %w", err)
	}
	if lock.Packages == nil {
		return nil, errNoPackages
	}

	var out []Package
	left := 0
	for _, entry := range lock.Packages {
		var ident, registry string
		if len(entry) == 0 || json.Unmarshal(entry[0], &ident) != nil {
			continue
		}
		name, version, ok := bunIdent(ident)
		if !ok || strings.HasPrefix(version, "workspace:") {
			continue
		}
		if len(entry) < 2 || json.Unmarshal(entry[1], &registry) != nil || registry != "" {
			left++ // a custom registry, or a source that has no registry slot (git, file)

			continue
		}
		if strings.Contains(version, ":") {
			left++

			continue
		}
		out = append(out, Package{Ecosystem: EcosystemNPM, Name: name, Version: version})
	}

	return publicOrError(out, left)
}

// bunIdent reads a bun package ident. An aliased install is written
// "alias@npm:real@1.0.0" and is the real package.
func bunIdent(ident string) (name, version string, ok bool) {
	if i := strings.Index(ident[min(1, len(ident)):], "@npm:"); i >= 0 {
		ident = ident[i+1+len("@npm:"):]
	}

	return splitAt(ident)
}

// splitAt splits "name@version" at the last "@", which leaves a scoped
// "@scope/name" whole.
func splitAt(ident string) (name, version string, ok bool) {
	i := strings.LastIndex(ident, "@")
	if i <= 0 || i == len(ident)-1 {
		return "", "", false
	}

	return ident[:i], ident[i+1:], true
}

// jsoncToJSON drops comments and trailing commas, which bun writes and
// encoding/json refuses. Strings are left as they are.
func jsoncToJSON(data []byte) []byte {
	out := make([]byte, 0, len(data))
	for i := 0; i < len(data); i++ {
		c := data[i]
		switch {
		case c == '"':
			end := stringEnd(data, i)
			out = append(out, data[i:end]...)
			i = end - 1
		case c == '/' && i+1 < len(data) && (data[i+1] == '/' || data[i+1] == '*'):
			i = commentEnd(data, i)
			out = append(out, '\n')
		case (c == '}' || c == ']') && trailingComma(out):
			out = bytes.TrimRight(out, " \t\r\n")
			out = append(out[:len(out)-1], c)
		default:
			out = append(out, c)
		}
	}

	return out
}

// stringEnd is the index just past the string that opens at data[start].
func stringEnd(data []byte, start int) int {
	for i := start + 1; i < len(data); i++ {
		switch data[i] {
		case '\\':
			i++
		case '"':
			return i + 1
		}
	}

	return len(data)
}

// commentEnd is the index of the last byte of the comment that opens at
// data[start]: a line comment stops before its newline.
func commentEnd(data []byte, start int) int {
	if data[start+1] == '/' {
		end := bytes.IndexByte(data[start:], '\n')
		if end < 0 {
			return len(data)
		}

		return start + end - 1
	}
	end := bytes.Index(data[start+2:], []byte("*/"))
	if end < 0 {
		return len(data)
	}

	return start + 2 + end + 1
}

// trailingComma says whether the last thing written, whitespace aside, is a comma.
func trailingComma(out []byte) bool {
	t := bytes.TrimRight(out, " \t\r\n")

	return len(t) > 0 && t[len(t)-1] == ','
}

// ParseComposerLock reads the packages in a composer.lock, "packages" and
// "packages-dev" alike. Composer doesn't record which repository a package came
// from, so every release is looked up by name on Packagist; a branch checkout
// ("dev-main") has no release to match and is left out. A leading "v" is taken
// off the version, as OSV writes them without.
func ParseComposerLock(data []byte) ([]Package, error) {
	var lock struct {
		Packages    *[]composerPackage `json:"packages"`
		PackagesDev *[]composerPackage `json:"packages-dev"`
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		return nil, fmt.Errorf("osv: read composer.lock: %w", err)
	}
	if lock.Packages == nil && lock.PackagesDev == nil {
		return nil, errNoPackages
	}

	var out []Package
	for _, list := range []*[]composerPackage{lock.Packages, lock.PackagesDev} {
		if list == nil {
			continue
		}
		for _, p := range *list {
			version := strings.TrimPrefix(p.Version, "v")
			if p.Name == "" || version == "" || strings.HasPrefix(version, "dev-") || strings.HasSuffix(version, "-dev") {
				continue
			}
			out = append(out, Package{Ecosystem: EcosystemPackagist, Name: p.Name, Version: version})
		}
	}

	return out, nil
}

type composerPackage struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// npmV1Entry is one dependency of an npm lock file version 1, which nests what
// a package pulls in under its own "dependencies".
type npmV1Entry struct {
	Version      string                `json:"version"`
	Resolved     string                `json:"resolved"`
	Dependencies map[string]npmV1Entry `json:"dependencies"`
}

// ParseNPMLock reads a package-lock.json of any lock file version. Version 2
// and 3 keep a flat "packages" map (ParsePackageLock); version 1 keeps a tree
// under "dependencies", read here with the same registry rules.
func ParseNPMLock(data []byte) ([]Package, error) {
	var lock struct {
		Packages     map[string]json.RawMessage `json:"packages"`
		Dependencies map[string]npmV1Entry      `json:"dependencies"`
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		return nil, fmt.Errorf("osv: read package-lock.json: %w", err)
	}
	if lock.Packages != nil {
		return ParsePackageLock(data)
	}
	if lock.Dependencies == nil {
		return nil, errNoPackages
	}

	var w npmV1Walk
	w.walk(lock.Dependencies)

	return publicOrError(w.out, w.left)
}

// npmV1Walk collects the registry packages of a version 1 tree, and counts the
// ones kept out.
type npmV1Walk struct {
	out  []Package
	left int
}

func (w *npmV1Walk) walk(deps map[string]npmV1Entry) {
	for name, d := range deps {
		w.walk(d.Dependencies)
		if d.Version == "" {
			continue
		}
		if !fromRegistry(d.Resolved) {
			w.left++

			continue
		}
		version := d.Version
		if alias, ok := strings.CutPrefix(version, "npm:"); ok {
			n, v, ok := splitAt(alias)
			if !ok {
				continue
			}
			name, version = n, v
		}
		w.out = append(w.out, Package{Ecosystem: EcosystemNPM, Name: name, Version: version})
	}
}
