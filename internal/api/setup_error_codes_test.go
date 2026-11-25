package api_test

import (
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// knownSetupErrorCodes is the Go side of SetupErrorCode (#4026): the codes a
// callback may put in its redirect to /setup. A new one is added here, in the
// spec and where the server emits it. The page treats an unknown one as a
// generic failure, so a new code is an additive release.
var knownSetupErrorCodes = []string{
	"access_denied", "invalid_state", "exchange_failed", "account_unreadable", "save_failed",
	"not_connected", "installation_unverified", "installations_unavailable",
}

func TestSetupSpec_ErrorCodeIsExtensibleAndMatchesTheGoList(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)
	schema := doc.Components.Schemas["SetupErrorCode"].Value

	t.Run("is not a closed enum", func(t *testing.T) {
		t.Parallel()
		assert.Empty(t, schema.Enum, "a closed enum would make every new code a major release")
	})

	t.Run("lists what the server knows", func(t *testing.T) {
		t.Parallel()
		assert.ElementsMatch(t, knownSetupErrorCodes, extensibleEnum(t, schema))
	})
}
