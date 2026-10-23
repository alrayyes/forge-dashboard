// Package osv matches the packages in a repo's lockfiles against the OSV
// database (https://osv.dev), so a forge with no advisory feed of its own can
// still say which default branches carry known vulnerabilities.
package osv

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
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

// Lockfile is what a reader found in one lock file: the packages it can ask
// OSV about, and how many it left out because they are not public (a private
// registry, a git or path source). A file with any left out is only partly
// checked, and its count says so.
type Lockfile struct {
	Packages []Package
	Left     int
}

var errUnknownLockfile = errors.New("osv: not a lock file this package reads")

// lockfileReaders are the readers by file name.
var lockfileReaders = map[string]func([]byte) (Lockfile, error){
	"package-lock.json": readNPMLock,
	"bun.lock":          readBunLock,
	"composer.lock":     readComposerLock,
	"poetry.lock":       readPoetryLock,
	"uv.lock":           readUvLock,
	"Cargo.lock":        readCargoLock,
	"go.mod":            readGoMod,
}

// IsLockfile says whether name (a file's base name) is one ParseLockfile reads.
func IsLockfile(name string) bool {
	_, ok := lockfileReaders[name]

	return ok
}

// ParseLockfile reads the lock file called name (its base name, such as
// "package-lock.json" or "go.mod") and says how many of its packages it left
// out for not being public.
func ParseLockfile(name string, data []byte) (Lockfile, error) {
	read, ok := lockfileReaders[name]
	if !ok {
		return Lockfile{}, fmt.Errorf("%w: %s", errUnknownLockfile, name)
	}

	return read(data)
}

// ErrNoPublicPackages is a package-lock whose dependencies all come from
// somewhere other than the public registry, so nothing in it was checked.
var ErrNoPublicPackages = errors.New("osv: lockfile has no packages from the public registry")

var (
	errNoPackages = errors.New("osv: lockfile has no packages map")
	errNoModule   = errors.New("osv: go.mod has no module directive")
)

// ParsePackageLock reads the installed packages from an npm package-lock.json
// (lockfile version 2 or 3). A version 1 file keeps its tree under
// "dependencies" instead, and is refused rather than read as empty: no packages
// would otherwise look like no advisories.
func ParsePackageLock(data []byte) ([]Package, error) {
	lf, err := readPackageLock(data)

	return lf.Packages, err
}

// readPackageLock is ParsePackageLock with the count of packages it left out.
func readPackageLock(data []byte) (Lockfile, error) {
	var lock struct {
		Packages map[string]struct {
			Name     string `json:"name"`
			Version  string `json:"version"`
			Resolved string `json:"resolved"`
			Link     bool   `json:"link"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		return Lockfile{}, fmt.Errorf("osv: read package-lock.json: %w", err)
	}
	if lock.Packages == nil {
		return Lockfile{}, errNoPackages
	}

	const marker = "node_modules/"
	var out []Package
	left := 0 // installed packages kept out because they are not from the public registry
	for key, p := range lock.Packages {
		i := strings.LastIndex(key, marker) //nolint:modernize // CutLast needs a newer Go than this module pins
		if i < 0 || p.Link || p.Version == "" {
			continue // the root, a workspace folder or a symlink
		}
		if !fromRegistry(p.Resolved) {
			left++

			continue
		}
		name := key[i+len(marker):]
		if p.Name != "" {
			name = p.Name // an aliased install ("my-lodash": npm:lodash) is the real package
		}
		out = append(out, Package{Ecosystem: EcosystemNPM, Name: name, Version: p.Version})
	}

	return publicOrError(out, left)
}

// publicRegistries are the hosts of the public npm registry (and its yarn
// alias), whose package names are public already.
var publicRegistries = []string{"https://registry.npmjs.org/", "https://registry.yarnpkg.com/"}

// fromRegistry says whether a lock entry's resolved source is a tarball of the
// public npm registry (".../name/-/name-1.0.0.tgz"). A private registry's
// package names stay out of the request, and a git, file or plain tarball
// source is not the registry package of that name and version, so matching it
// against OSV could flag the wrong code. An entry with no resolved source (a
// bundled dependency, say) can't be shown to be public, so it stays out too.
func fromRegistry(resolved string) bool {
	return strings.Contains(resolved, "/-/") && slices.ContainsFunc(publicRegistries, func(host string) bool {
		return strings.HasPrefix(resolved, host)
	})
}

// ParseGoMod reads the modules a go.mod builds, direct and indirect, at the
// versions it pins. OSV's Go ecosystem writes versions without the leading "v".
// A replace directive swaps the module that is built: one to another module
// reads as that module and version, one to a local path leaves nothing to match
// and drops the module. A file with no module directive is not a go.mod, and
// is an error rather than a module with nothing to match.
func ParseGoMod(data []byte) ([]Package, error) {
	lf, err := readGoMod(data)

	return lf.Packages, err
}

// readGoMod is ParseGoMod with the count of packages it left out.
func readGoMod(data []byte) (Lockfile, error) {
	requires, replaces, hasModule := goModLines(data)
	if !hasModule {
		return Lockfile{}, errNoModule
	}

	pkgs, left := applyReplaces(requires, replaces)

	return Lockfile{Packages: pkgs, Left: left}, nil
}

// goModFields splits a go.mod line into words, taking the quotes off a path or
// version written as a Go string ("example.com/m" or a raw string in backticks).
func goModFields(line string) []string {
	fields := strings.Fields(line)
	for i, f := range fields {
		if u, err := strconv.Unquote(f); err == nil {
			fields[i] = u
		}
	}

	return fields
}

// stripGoModComment drops a trailing "//" comment, ignoring any "//" inside a
// quoted path ("example.com//m" or a raw string in backticks).
func stripGoModComment(line string) string {
	var quote byte
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case quote == '"' && c == '\\':
			i++ // an escaped character, possibly a quote
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '`':
			quote = c
		case c == '/' && i+1 < len(line) && line[i+1] == '/':
			return line[:i]
		}
	}

	return line
}

// goModLines splits a go.mod into its require and replace lines (the fields
// after the keyword, block or not) and says whether it has a module directive.
func goModLines(data []byte) (requires, replaces [][]string, hasModule bool) {
	block := ""
	for line := range strings.SplitSeq(string(data), "\n") {
		line = stripGoModComment(line)
		fields := goModFields(line)
		switch {
		case len(fields) == 0:
			continue
		case block == "" && fields[0] == "module":
			hasModule = true
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

	return requires, replaces, hasModule
}

// replacement is what a replace directive swaps a module for.
type replacement struct{ module, version string }

// replacements indexes replace lines (old [version] => new [version]): one that
// names a version applies to that version only.
type replacements struct {
	all   map[string]replacement
	exact map[[2]string]replacement
}

func parseReplaces(lines [][]string) replacements {
	r := replacements{all: map[string]replacement{}, exact: map[[2]string]replacement{}}
	for _, f := range lines {
		arrow := slices.Index(f, "=>")
		if arrow < 1 || arrow == len(f)-1 || arrow > 2 {
			continue
		}
		to := replacement{module: f[arrow+1]}
		if len(f) > arrow+2 {
			to.version = f[arrow+2]
		}
		if arrow == 2 {
			r.exact[[2]string{f[0], f[1]}] = to
		} else {
			r.all[f[0]] = to
		}
	}

	return r
}

func (r replacements) find(module, version string) (replacement, bool) {
	if to, ok := r.exact[[2]string{module, version}]; ok {
		return to, true
	}
	to, ok := r.all[module]

	return to, ok
}

// applyReplaces turns require lines (module, version) into packages, after the
// replace lines.
func applyReplaces(requires, replaces [][]string) (out []Package, left int) {
	repl := parseReplaces(replaces)
	for _, f := range requires {
		if len(f) < 2 {
			continue
		}
		module, version := f[0], f[1]
		if to, ok := repl.find(module, version); ok {
			if to.version == "" {
				left++ // a local path: not a published module

				continue
			}
			module, version = to.module, to.version
		}
		out = append(out, goPackage(module, version))
	}

	return out, left
}

func goPackage(module, version string) Package {
	return Package{Ecosystem: EcosystemGo, Name: module, Version: strings.TrimPrefix(version, "v")}
}
