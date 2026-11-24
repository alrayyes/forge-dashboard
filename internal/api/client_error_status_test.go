package api_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
)

func TestClientErrorStatus_AnUnknownRepositoryIsNotFound(t *testing.T) {
	t.Parallel()

	err := fmt.Errorf("merge: %w", fmt.Errorf("%w: acme/b", github.ErrUnknownRepository))

	assert.Equal(t, http.StatusNotFound, api.ClientErrorStatus(err))
}
