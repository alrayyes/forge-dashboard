package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// optionalCapability is one optional interface the API asks a Source for.
// githubOnly marks the ones that are GitHub-only by design, so the Forgejo
// client has nothing to forward for them.
type optionalCapability struct {
	name       string
	has        func(any) bool
	githubOnly bool
}

func capabilityNamed[T any](githubOnly bool) optionalCapability {
	return optionalCapability{name: reflect.TypeFor[T]().Name(), githubOnly: githubOnly, has: func(v any) bool {
		_, ok := v.(T)

		return ok
	}}
}

// optionalCapabilities is every optional capability the API (or the aggregator,
// for the ones listed from there) asks a Source for.
// TestOptionalCapabilities_CoverEveryOneTheAPIAsksFor scans internal/api for
// them, so a new one fails that test until it is added here, as forwarded or
// as GitHub-only with its reason.
var optionalCapabilities = []optionalCapability{
	capabilityNamed[dashboard.WebhookManager](false),
	capabilityNamed[dashboard.PullRequestMerger](false),
	capabilityNamed[dashboard.PullRequestStateReader](false),
	capabilityNamed[dashboard.PullRequestCloser](false),
	capabilityNamed[dashboard.ChecksRerunner](false),
	capabilityNamed[dashboard.BranchUpdater](false),
	capabilityNamed[dashboard.PullRequestChecker](false),
	capabilityNamed[dashboard.PullRequestLabeler](false),
	capabilityNamed[dashboard.PullRequestBodyEditor](false),

	// Forgejo cancels a merge scheduled on the forge (#1571).
	capabilityNamed[dashboard.PullRequestAutoMergeDisabler](false),

	// GitHub-only by design: Forgejo has no Dependabot, and arming auto-merge
	// there is this app's own intent rather than a forge call.
	capabilityNamed[dashboard.PullRequestCommenter](true),
	capabilityNamed[dashboard.PullRequestAutoMerger](true),
	capabilityNamed[dashboard.PullRequestDetailer](false),
}

// capabilitiesTheAPIAsksFor is every dashboard.<Name> the non-test code in
// internal/api uses as the type argument of capabilityOf or guardedAction,
// asserts a value to, or names in a type switch. It reads the package by name,
// so it doesn't see an import alias, a differently named helper, or an
// assertion made in internal/dashboard (the aggregator's own).
func capabilitiesTheAPIAsksFor(t *testing.T) []string {
	t.Helper()

	const apiDir = "../../internal/api"
	entries, err := os.ReadDir(apiDir)
	require.NoError(t, err)

	fset := token.NewFileSet()
	found := map[string]bool{}
	parsed := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, filepath.Join(apiDir, entry.Name()), nil, 0)
		require.NoError(t, err)
		parsed++
		collectDashboardTypes(file, found)
	}
	require.NotZero(t, parsed, "found no API source files to scan")

	return slices.Sorted(maps.Keys(found))
}

// collectDashboardTypes adds to found the dashboard.<Name> types file passes to
// capabilityOf or guardedAction as a type argument, asserts a value to, or
// names in a type switch. A plain value switch (case dashboard.ActionMerge) is
// not a type, so only a TypeSwitchStmt's cases are read.
func collectDashboardTypes(file *ast.File, found map[string]bool) {
	add := func(e ast.Expr) {
		if sel, ok := e.(*ast.SelectorExpr); ok {
			if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == "dashboard" {
				found[sel.Sel.Name] = true
			}
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.IndexExpr:
			if fn, ok := node.X.(*ast.Ident); ok && (fn.Name == "capabilityOf" || fn.Name == "guardedAction") {
				add(node.Index)
			}
		case *ast.TypeAssertExpr:
			add(node.Type)
		case *ast.TypeSwitchStmt:
			addTypeSwitchCases(node, add)
		}

		return true
	})
}

// addTypeSwitchCases passes every type a type switch names to add.
func addTypeSwitchCases(sw *ast.TypeSwitchStmt, add func(ast.Expr)) {
	for _, stmt := range sw.Body.List {
		if clause, ok := stmt.(*ast.CaseClause); ok {
			for _, e := range clause.List {
				add(e)
			}
		}
	}
}

// A capability the API starts asking a Source for has to be added to the list
// above, or the parity test below never looks at it (#1363).
func TestOptionalCapabilities_CoverEveryOneTheAPIAsksFor(t *testing.T) {
	t.Parallel()

	var known []string
	for _, c := range optionalCapabilities {
		known = append(known, c.name)
	}

	for _, asked := range capabilitiesTheAPIAsksFor(t) {
		assert.Contains(t, known, asked, "the API uses dashboard.%s: add it to optionalCapabilities, as forwarded or as githubOnly (if it isn't a Source capability, teach collectDashboardTypes to skip it)", asked)
	}
}

// capabilityGaps names each non-GitHub-only capability the Forgejo client has
// but the Source the app registers for it lacks. The API asks the Source, not
// the client, so a forwarder missing from GenericSource answers 400 "doesn't
// support" in production while every API test passes against a fake Source
// (#455, #564, #1347, #1351).
func capabilityGaps(client, source any) []string {
	var missing []string
	for _, c := range optionalCapabilities {
		if !c.githubOnly && c.has(client) && !c.has(source) {
			missing = append(missing, c.name)
		}
	}

	return missing
}

func TestForgejoSource_ExposesEveryCapabilityItsClientHas(t *testing.T) {
	t.Parallel()

	creds := settings.Credentials{ForgejoURL: "https://forge.example", ForgejoToken: "t"}
	sources := buildSourcesForUser(newTestAuthStore(t), nil, 0, nil)([]byte("user"), creds)
	require.Len(t, sources, 1)
	source := sources[0]
	require.Equal(t, dashboard.ForgeForgejo, source.Forge())
	client := forgejo.NewClient(creds.ForgejoURL, creds.ForgejoToken, "")

	assert.Empty(t, capabilityGaps(client, source), "the Forgejo client has these capabilities but its Source doesn't forward them")
}

// An exclusion has to stay true: a capability marked GitHub-only that the
// Forgejo client now implements is a forwarder nobody wrote.
func TestOptionalCapabilities_GitHubOnlyOnesAreNotInTheForgejoClient(t *testing.T) {
	t.Parallel()

	client := forgejo.NewClient("https://forge.example", "t", "")
	for _, c := range optionalCapabilities {
		if c.githubOnly {
			assert.False(t, c.has(client), "%s is marked GitHub-only but the Forgejo client implements it: forward it and unmark it", c.name)
		}
	}
}
