package github_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRefreshPending_TheBehindLookupIsOneRequestForTheWholeChunk(t *testing.T) {
	t.Parallel()

	srv, requests := pendingServerWithState(t, "CLEAN", nil, nil)
	c := github.NewClient("test-token", "", srv.URL)

	_, err := c.RefreshPending(t.Context(), pendingRefs(12))

	require.NoError(t, err)
	assert.EqualValues(t, 2, requests.Load(), "one batched read and one batched behind lookup")
}
