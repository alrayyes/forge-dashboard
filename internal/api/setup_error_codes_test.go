package api_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// setupErrorConstants reads the setupErr* constants out of setup_redirect.go:
// the codes a callback may put in its redirect to /setup (#4026). Reading the
// source means a new constant with no spec entry fails here, instead of
// depending on someone updating a second list by hand. The page treats an
// unknown code as a generic failure, so a new code is an additive release.
func setupErrorConstants(t *testing.T) []string {
	t.Helper()

	file, err := parser.ParseFile(token.NewFileSet(), "setup_redirect.go", nil, 0)
	require.NoError(t, err)

	var codes []string

	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}

		for _, spec := range gen.Specs {
			vs := spec.(*ast.ValueSpec)

			for i, name := range vs.Names {
				if !strings.HasPrefix(name.Name, "setupErr") {
					continue
				}

				lit, ok := vs.Values[i].(*ast.BasicLit)
				require.True(t, ok, "%s must be a string literal", name.Name)

				value, err := strconv.Unquote(lit.Value)
				require.NoError(t, err)

				codes = append(codes, value)
			}
		}
	}

	return codes
}

func TestSetupSpec_ErrorCodeIsExtensibleAndMatchesTheGoConstants(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)
	schema := doc.Components.Schemas["SetupErrorCode"].Value

	t.Run("is not a closed enum", func(t *testing.T) {
		t.Parallel()
		assert.Empty(t, schema.Enum, "a closed enum would make every new code a major release")
	})

	t.Run("lists exactly the codes the server can send", func(t *testing.T) {
		t.Parallel()
		assert.ElementsMatch(t, setupErrorConstants(t), extensibleEnum(t, schema))
	})

	t.Run("finds the constants at all", func(t *testing.T) {
		t.Parallel()
		assert.NotEmpty(t, setupErrorConstants(t))
	})
}
