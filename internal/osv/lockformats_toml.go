package osv

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Ecosystems the other lock file readers produce.
const (
	EcosystemPackagist = "Packagist"
	EcosystemPyPI      = "PyPI"
	EcosystemCratesIO  = "crates.io"
)

var (
	errNoTOMLPackages = errors.New("osv: lockfile has no [[package]] tables")
	errUnreadableLine = errors.New("osv: unreadable lockfile line")
)

// tomlKey matches a top-level "key = value" line of a lock file.
var tomlKey = regexp.MustCompile(`^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*=\s*(.*)$`)

// tomlPackage is one [[package]] table of a TOML lock file: its plain string
// values, keyed by name, and the keys of any table nested under it
// ("source.type" for a [package.source] table).
type tomlPackage map[string]string

// readTOMLPackages reads the [[package]] tables of a poetry.lock, uv.lock or
// Cargo.lock. Those files use a small, regular slice of TOML (string values,
// inline tables, arrays of either), so this keeps the string values and the
// raw text of inline tables, and steps over the arrays, rather than pulling in
// a full TOML parser for three keys. A line it can't place is an error, so a
// file in another format is refused rather than read as having no packages.
func readTOMLPackages(data []byte) ([]tomlPackage, error) {
	var r tomlReader
	for line := range strings.SplitSeq(string(data), "\n") {
		if err := r.line(strings.TrimSpace(line)); err != nil {
			return nil, err
		}
	}
	if len(r.pkgs) == 0 {
		return nil, errNoTOMLPackages
	}

	return r.pkgs, nil
}

// tomlReader is the state of readTOMLPackages between lines.
type tomlReader struct {
	pkgs   []tomlPackage
	cur    tomlPackage // the open table, nil outside a [[package]] or its subtables
	prefix string      // "source." inside [package.source]
	depth  int         // open brackets of a multi-line array
}

func (r *tomlReader) line(line string) error {
	switch {
	case r.depth > 0:
		r.depth += bracketDelta(line)
	case line == "" || strings.HasPrefix(line, "#"):
	case line == "[[package]]":
		r.cur, r.prefix = tomlPackage{}, ""
		r.pkgs = append(r.pkgs, r.cur)
	case strings.HasPrefix(line, "["):
		r.cur, r.prefix = nil, ""
		if rest, ok := strings.CutPrefix(line, "[package."); ok && strings.HasSuffix(rest, "]") && len(r.pkgs) > 0 {
			r.cur, r.prefix = r.pkgs[len(r.pkgs)-1], strings.TrimSuffix(rest, "]")+"."
		}
	default:
		m := tomlKey.FindStringSubmatch(line)
		if m == nil {
			return fmt.Errorf("%w: %q", errUnreadableLine, line)
		}
		if strings.HasPrefix(m[2], "[") {
			r.depth = bracketDelta(m[2])
		}
		if r.cur != nil {
			r.cur[r.prefix+tomlValue(m[1])] = tomlValue(m[2])
		}
	}

	return nil
}

// bracketDelta is how many more arrays a line opens than it closes, leaving
// out brackets inside strings.
func bracketDelta(s string) int {
	n, inString := 0, false
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '\\' && inString:
			i++
		case c == '"':
			inString = !inString
		case inString:
		case c == '[':
			n++
		case c == ']':
			n--
		}
	}

	return n
}

// tomlValue is a quoted string without its quotes, or the raw text of anything
// else (an inline table, a number, an array).
func tomlValue(v string) string {
	v = strings.TrimSpace(v)
	if strings.HasPrefix(v, `"`) {
		if i := strings.LastIndex(v, `"`); i > 0 {
			if u, err := strconv.Unquote(v[:i+1]); err == nil {
				return u
			}
		}
	}
	if strings.HasPrefix(v, "'") && strings.HasSuffix(v, "'") && len(v) >= 2 {
		return v[1 : len(v)-1]
	}

	return v
}

// uvRegistry picks the registry URL out of a uv.lock source's inline table:
// `{ registry = "https://pypi.org/simple" }`.
var uvRegistry = regexp.MustCompile(`[{,]\s*registry\s*=\s*"((?:[^"\\]|\\.)*)"`)

// inlineRegistry is the registry named in a uv.lock source table.
func inlineRegistry(table string) (string, bool) {
	m := uvRegistry.FindStringSubmatch(table)
	if m == nil {
		return "", false
	}

	return m[1], true
}

// publicOrError turns the tables a reader kept into packages, or says that nothing
// public was left when the lock file named packages and all of them came from
// somewhere else.
func publicOrError(out []Package, left int) (Lockfile, error) {
	if left > 0 && len(out) == 0 {
		return Lockfile{}, ErrNoPublicPackages
	}

	return Lockfile{Packages: out, Left: left}, nil
}

// ParsePoetryLock reads the packages in a poetry.lock. Poetry writes a
// [package.source] table for a package from a git repo, a path, a URL or a
// package index other than PyPI; those stay out, since they are not the PyPI
// package of that name.
func ParsePoetryLock(data []byte) ([]Package, error) {
	lf, err := readPoetryLock(data)

	return lf.Packages, err
}

// readPoetryLock is ParsePoetryLock with the count of packages it left out.
func readPoetryLock(data []byte) (Lockfile, error) {
	tables, err := readTOMLPackages(data)
	if err != nil {
		return Lockfile{}, fmt.Errorf("osv: read poetry.lock: %w", err)
	}
	var out []Package
	left := 0
	for _, p := range tables {
		if p["name"] == "" || p["version"] == "" {
			continue
		}
		if p["source.type"] != "" {
			left++

			continue
		}
		out = append(out, Package{Ecosystem: EcosystemPyPI, Name: p["name"], Version: p["version"]})
	}

	return publicOrError(out, left)
}

// publicPyPIIndexes are the PyPI simple indexes a uv.lock names for packages
// from the public index.
var publicPyPIIndexes = []string{"https://pypi.org/simple", "https://pypi.python.org/simple"}

// ParseUvLock reads the packages in a uv.lock. A package's source is an inline
// table: only one from the public PyPI index is kept. The project itself
// (editable, virtual or a workspace member) and git, path or URL sources are
// not PyPI releases.
func ParseUvLock(data []byte) ([]Package, error) {
	lf, err := readUvLock(data)

	return lf.Packages, err
}

// readUvLock is ParseUvLock with the count of packages it left out.
func readUvLock(data []byte) (Lockfile, error) {
	tables, err := readTOMLPackages(data)
	if err != nil {
		return Lockfile{}, fmt.Errorf("osv: read uv.lock: %w", err)
	}
	var out []Package
	left := 0
	for _, p := range tables {
		if p["name"] == "" || p["version"] == "" {
			continue
		}
		reg, ok := inlineRegistry(p["source"])
		if !ok {
			if strings.Contains(p["source"], "registry") || strings.Contains(p["source"], "git") ||
				strings.Contains(p["source"], "url") {
				left++
			}

			continue
		}
		if !isOneOf(strings.TrimSuffix(reg, "/"), publicPyPIIndexes) {
			left++

			continue
		}
		out = append(out, Package{Ecosystem: EcosystemPyPI, Name: p["name"], Version: p["version"]})
	}

	return publicOrError(out, left)
}

// publicCrateIndexes are the source values Cargo writes for crates.io.
var publicCrateIndexes = []string{
	"registry+https://github.com/rust-lang/crates.io-index",
	"sparse+https://index.crates.io/",
	"registry+sparse+https://index.crates.io/",
}

// ParseCargoLock reads the packages in a Cargo.lock. A crate with no source is
// the workspace's own; one from git or another registry is not on crates.io.
func ParseCargoLock(data []byte) ([]Package, error) {
	lf, err := readCargoLock(data)

	return lf.Packages, err
}

// readCargoLock is ParseCargoLock with the count of packages it left out.
func readCargoLock(data []byte) (Lockfile, error) {
	tables, err := readTOMLPackages(data)
	if err != nil {
		return Lockfile{}, fmt.Errorf("osv: read Cargo.lock: %w", err)
	}
	var out []Package
	left := 0
	for _, p := range tables {
		if p["name"] == "" || p["version"] == "" || p["source"] == "" {
			continue
		}
		if !isOneOf(p["source"], publicCrateIndexes) {
			left++

			continue
		}
		out = append(out, Package{Ecosystem: EcosystemCratesIO, Name: p["name"], Version: p["version"]})
	}

	return publicOrError(out, left)
}

func isOneOf(s string, set []string) bool { return slices.Contains(set, s) }
