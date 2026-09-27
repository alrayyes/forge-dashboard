package github_test

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testAppPrivateKeyPEM is a throwaway RSA key generated once and reused
// across every App-mode test in this file — key generation isn't free,
// and every case here needs the identical, merely-valid-shaped key.
var testAppPrivateKeyPEM = generateTestAppPrivateKeyPEM()

func generateTestAppPrivateKeyPEM() []byte {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}

	return pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
}

func TestValidateAppPrivateKey_MalformedKey_ReturnsError(t *testing.T) {
	t.Parallel()

	err := github.ValidateAppPrivateKey(1, []byte("not a pem"))

	require.Error(t, err)
}

func TestValidateAppPrivateKey_ValidKey_ReturnsNil(t *testing.T) {
	t.Parallel()

	err := github.ValidateAppPrivateKey(1, testAppPrivateKeyPEM)

	require.NoError(t, err)
}

func TestNewAppClient_MalformedKey_ReturnsError(t *testing.T) {
	t.Parallel()

	_, err := github.NewAppClient(1, 1, []byte("not a pem"), "")

	require.Error(t, err)
}

// testInstallationID is the installation ID every test in this file
// authenticates as — a fixed value rather than a parameter, since no
// case here needs a second one.
const testInstallationID = 1

// appInstallationTestServer serves both the installation-token-minting
// endpoint ghinstallation's Transport calls internally and the /graphql
// endpoint a real Fetch exercises — the same single-httptest.Server
// pattern this package's token-based tests already use for baseURL
// overrides, just with one more route. mintCount lets a test assert the
// mint endpoint was actually hit, so a passing Fetch can't be accidentally
// explained by silently falling through to the unauthenticated REST path
// instead of GraphQL.
func appInstallationTestServer(t *testing.T) (srv *httptest.Server, mintCount *int, lastAuthHeader *string) {
	t.Helper()
	mintCount = new(int)
	lastAuthHeader = new(string)

	mux := http.NewServeMux()
	mintPath := fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID)
	mux.HandleFunc(mintPath, func(w http.ResponseWriter, _ *http.Request) {
		*mintCount++
		writeJSON(t, w, map[string]any{
			"token":      "installation-token-value",
			"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		*lastAuthHeader = r.Header.Get("Authorization")
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{},
					},
				},
			},
		})
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv, mintCount, lastAuthHeader
}

func TestAppClient_Fetch_UsesGraphQLPath(t *testing.T) {
	t.Parallel()

	srv, _, _ := appInstallationTestServer(t)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
}

func TestAppClient_Fetch_MintsAnInstallationToken(t *testing.T) {
	t.Parallel()

	srv, mintCount, _ := appInstallationTestServer(t)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	client.Fetch(t.Context())

	assert.Equal(t, 1, *mintCount, "Fetch should have minted a real installation token, not fallen through to an unauthenticated path")
}

func TestAppClient_Fetch_DoesNotSendTheBrokenEmptyBearerHeader(t *testing.T) {
	t.Parallel()

	srv, _, lastAuthHeader := appInstallationTestServer(t)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	client.Fetch(t.Context())

	assert.NotEqual(t, "Bearer ", *lastAuthHeader, "graphqlDo's own header-set must be guarded so an App-mode Client never sends this broken value")
}

func TestAppClient_Fetch_SendsTheRealMintedToken(t *testing.T) {
	t.Parallel()

	srv, _, lastAuthHeader := appInstallationTestServer(t)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	client.Fetch(t.Context())

	assert.Contains(t, *lastAuthHeader, "installation-token-value")
}

func TestNewUnreachableClient_Fetch_ReportsTheGivenReason(t *testing.T) {
	t.Parallel()

	client := github.NewUnreachableClient("github: app installation credentials are invalid")
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Equal(t, "github: app installation credentials are invalid", result.Health.Error)
}
