package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

type failingOwners struct{ err error }

func (f failingOwners) OwnerID(context.Context) ([]byte, error) { return nil, f.err }

func acknowledge(t *testing.T, owners ownerFinder) int {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/api/webhooks/github/x", nil)

	acknowledgeDelivery(t.Context(), r, w, owners, nil, dashboard.ForgeGitHub, "d1", "push", []byte(`{}`))

	return w.Code
}

func TestAcknowledgeDelivery_NobodyRegisteredYet_Answers204(t *testing.T) {
	t.Parallel()

	assert.Equal(t, http.StatusNoContent, acknowledge(t, failingOwners{auth.ErrNotFound}))
}

func TestAcknowledgeDelivery_OwnerLookupFailsTransiently_AsksTheForgeToRetry(t *testing.T) {
	t.Parallel()

	assert.Equal(t, http.StatusServiceUnavailable, acknowledge(t, failingOwners{errors.New("database is locked")}))
}
