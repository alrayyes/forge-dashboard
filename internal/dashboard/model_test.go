package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// TestHumanizeForgeError_EveryKindGetsAMappedSentence proves every known
// ForgeErrorKind (and the zero value, plus an unrecognized one) resolves
// to a non-empty, human-written sentence rather than falling through to
// something that reads as unhandled (#360).
func TestHumanizeForgeError_EveryKindGetsAMappedSentence(t *testing.T) {
	t.Parallel()

	kinds := []dashboard.ForgeErrorKind{
		dashboard.ForgeErrorUnreachable,
		dashboard.ForgeErrorUnauthorized,
		dashboard.ForgeErrorNotFound,
		dashboard.ForgeErrorRateLimited,
		dashboard.ForgeErrorConflict,
		dashboard.ForgeErrorUnknown,
		dashboard.ForgeErrorKind("something-new-a-future-kind-might-add"),
	}

	for _, kind := range kinds {
		t.Run(string(kind), func(t *testing.T) {
			t.Parallel()

			assert.NotEmpty(t, dashboard.HumanizeForgeError(kind))
		})
	}
}

func TestHumanizeForgeError_UnrecognizedKind_FallsBackRatherThanEmpty(t *testing.T) {
	t.Parallel()

	msg := dashboard.HumanizeForgeError(dashboard.ForgeErrorKind("not-a-real-kind"))

	assert.Equal(t, "An unexpected error occurred talking to the forge.", msg)
}
