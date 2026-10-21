package apistats_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"maps"
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
	maps.Copy(found, getSites(t, "forgejo"))
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

// isHTTPClient reports whether expr names the http package or a client field.
func isHTTPClient(expr ast.Expr) bool {
	switch x := expr.(type) {
	case *ast.Ident:
		return x.Name == "http"
	case *ast.SelectorExpr:
		return x.Sel.Name == "httpClient" || x.Sel.Name == "client"
	}

	return false
}

// isRiskyCall reports whether call could send a GET without being a site
// getSites counts. hasSite says whether its function has a counted site.
func isRiskyCall(dir string, call *ast.CallExpr, hasSite bool) (string, bool) {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return "", false
	}
	name := sel.Sel.Name
	switch name {
	case "Get", "Head":
		return name, isHTTPClient(sel.X)
	case "Do", "NewRequest":
		return name, true
	case "NewRequestWithContext":
		return name, !isGetSite(dir, call)
	case "rawRequest":
		return name, mentionsMethodGet(call) && !hasSite
	}

	return name, false
}

func hasCountedSite(dir string, fn *ast.FuncDecl) bool {
	found := false
	ast.Inspect(fn, func(node ast.Node) bool {
		if call, ok := node.(*ast.CallExpr); ok && isGetSite(dir, call) {
			found = true
		}

		return !found
	})

	return found
}

func riskyIDs(dir, file string, parsed *ast.File, allowed map[string]bool) []string {
	var found []string
	for _, decl := range parsed.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}
		hasSite := hasCountedSite(dir, fn)
		ast.Inspect(fn, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			name, risky := isRiskyCall(dir, call, hasSite)
			id := "internal/" + dir + "/" + filepath.Base(file) + ":" + fn.Name.Name + ":" + name
			if risky && !allowed[id] {
				found = append(found, id)
			}

			return true
		})
	}

	return found
}

// httpCallsOutsideTheCount lists calls that could send a GET without being
// one of the sites getSites counts: Get or Head on a plain http client, and
// Do, a hand-built request or a rawRequest GET in a function with no counted
// site of its own. Known senders are named in allowed.
func httpCallsOutsideTheCount(t *testing.T, dir string, allowed map[string]bool) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join("..", "..", "internal", dir, "*.go"))
	require.NoError(t, err)

	var found []string
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), file, nil, 0)
		require.NoError(t, err)
		found = append(found, riskyIDs(dir, file, parsed, allowed)...)
	}
	sort.Strings(found)

	return found
}

// The count above only sees the shapes it knows. This catches the others: a
// plain http.Client Get, or a new function that sends a request by hand. A
// legitimate new sender goes in the allowed list below, and its GETs in the
// table.
//
// Limit: a Forgejo read that goes through the gitea SDK instead of
// rawRequest, or a GitHub read through a client other than restClient, is not
// recognised here; review catches those.
func TestRESTGetInventory_NoRequestBypassesTheCount(t *testing.T) {
	t.Parallel()

	allowedGitHub := map[string]bool{
		"internal/github/client.go:graphqlExec:NewRequestWithContext": true, // POST
		"internal/github/client.go:graphqlExec:Do":                    true, // POST
		"internal/github/client.go:logExcerpt:Do":                     true, // job log download, listed as not conditional
	}
	allowedForgejo := map[string]bool{
		"internal/forgejo/client.go:rawRequest:NewRequestWithContext": true,
		"internal/forgejo/client.go:rawRequest:Do":                    true,
	}

	assert.Empty(t, httpCallsOutsideTheCount(t, "github", allowedGitHub))
	assert.Empty(t, httpCallsOutsideTheCount(t, "forgejo", allowedForgejo))
}
