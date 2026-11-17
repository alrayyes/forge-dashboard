package api_test

import (
	"io"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Every endpoint that takes a forge in its body refuses an unknown one with
// the same answer, because they share one check.
func TestPullRequestEndpoints_RefuseAnUnknownForgeTheSameWay(t *testing.T) {
	t.Parallel()

	srvURL, cookie, _ := newHideServer(t)
	body := map[string]any{"forge": "gitlab", "fullName": hideRepo, "number": 1}

	var first string
	for i, path := range []string{
		"/api/v1/pull-requests/hide",
		"/api/v1/pull-requests/auto-update",
		"/api/v1/pull-requests/auto-merge",
		"/api/v1/pull-requests/auto-merge/cancel",
	} {
		resp := postHide(t, srvURL, cookie, path, body)
		raw, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		require.NoError(t, err)

		assert.Equal(t, http.StatusBadRequest, resp.StatusCode, path)
		assert.Contains(t, string(raw), "forge must be github or forgejo", path)
		if i == 0 {
			first = string(raw)
		}
		assert.JSONEq(t, first, string(raw), path)
	}
}
