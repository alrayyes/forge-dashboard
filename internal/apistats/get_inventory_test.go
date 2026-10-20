package apistats_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// getSites counts the REST GET call sites in every non-test file of dir:
// a request log line naming http.MethodGet (Forgejo), a go-github call whose
// method starts with Get or List (GitHub), and a hand-built GET request.
// The counts are keyed by the file's path from the module root.
func getSites(t *testing.T, dir string) map[string]int {
	t.Helper()
	files, err := filepath.Glob(filepath.Join("..", "..", "internal", dir, "*.go"))
	require.NoError(t, err)

	counts := map[string]int{}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), file, nil, 0)
		require.NoError(t, err)
		n := 0
		ast.Inspect(parsed, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			if isGetSite(dir, call) {
				n++
			}

			return true
		})
		if n > 0 {
			counts["internal/"+dir+"/"+filepath.Base(file)] = n
		}
	}

	return counts
}

func mentionsMethodGet(call *ast.CallExpr) bool {
	found := false
	for _, arg := range call.Args {
		ast.Inspect(arg, func(n ast.Node) bool {
			if sel, ok := n.(*ast.SelectorExpr); ok && sel.Sel.Name == "MethodGet" {
				found = true
			}

			return true
		})
	}

	return found
}

func isGetSite(dir string, call *ast.CallExpr) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	switch {
	case sel.Sel.Name == "Debug" && dir == "forgejo":
		lit, ok := call.Args[0].(*ast.BasicLit)

		return ok && lit.Value == `"forgejo request"` && mentionsMethodGet(call)
	case sel.Sel.Name == "NewRequestWithContext":
		return dir == "github" && mentionsMethodGet(call)
	case dir == "github":
		// c.restClient.<Service>.<Method>(...)
		inner, ok := sel.X.(*ast.SelectorExpr)
		if !ok {
			return false
		}
		root, ok := inner.X.(*ast.SelectorExpr)
		if !ok || root.Sel.Name != "restClient" {
			return false
		}

		return strings.HasPrefix(sel.Sel.Name, "Get") || strings.HasPrefix(sel.Sel.Name, "List")
	}

	return false
}

// documentedSites reads the inventory table in docs/rate-limits.md: a row
// whose first cell is a source file in backticks and whose second is the
// number of GET call sites in it.
func documentedSites(t *testing.T) map[string]int {
	t.Helper()
	doc, err := os.ReadFile(filepath.Join("..", "..", "docs", "rate-limits.md"))
	require.NoError(t, err)

	row := regexp.MustCompile("(?m)^\\| `(internal/[a-z]+/[a-z_]+\\.go)` +\\| +(\\d+) +\\|")
	counts := map[string]int{}
	for _, m := range row.FindAllStringSubmatch(string(doc), -1) {
		n, err := strconv.Atoi(m[2])
		require.NoError(t, err)
		counts[m[1]] = n
	}

	return counts
}

// Every REST GET in the two forge clients is listed in docs/rate-limits.md,
// cached or marked why not. A new GET without a row fails here, so nobody
// adds a read that skips the conditional-request question.
func TestRESTGetInventory_MatchesTheSource(t *testing.T) {
	t.Parallel()

	found := getSites(t, "github")
	for k, v := range getSites(t, "forgejo") {
		found[k] = v
	}
	documented := documentedSites(t)

	var drift []string
	for file, n := range found {
		if documented[file] != n {
			drift = append(drift, file+": source has "+strconv.Itoa(n)+", docs/rate-limits.md has "+strconv.Itoa(documented[file]))
		}
	}
	for file := range documented {
		if _, ok := found[file]; !ok {
			drift = append(drift, file+": listed in docs/rate-limits.md but has no GET")
		}
	}
	sort.Strings(drift)

	assert.Empty(t, drift)
}
