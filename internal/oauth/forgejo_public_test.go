package oauth_test

import (
	"context"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

// What Forgejo is asked for. The "Permissions requested" line on the setup page
// says the same thing in words; the page's own test checks the two agree.
const forgejoScopes = "write:repository write:issue read:user"

// memoryClients is a fake client id store.
type memoryClients struct {
	mu sync.Mutex
	id string
}

func (m *memoryClients) SaveOAuthClientID(_ context.Context, _, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.id = id

	return nil
}

func (m *memoryClients) OAuthClientID(_ context.Context, _ string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	return m.id, nil
}

func (m *memoryClients) DeleteOAuthClientID(_ context.Context, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.id = ""

	return nil
}

func (m *memoryClients) current() string {
	m.mu.Lock()
	defer m.mu.Unlock()

	return m.id
}

// A public client is registered by the owner on their own Forgejo and has no
// secret: the setup page asks for a Client ID alone.
func newPublicConn(t *testing.T, store *memoryTokens, clients *memoryClients) *oauth.Forgejo {
	t.Helper()

	conn := oauth.NewForgejo(t.Context(), "", "", testRedirect, store)
	conn.UseClientStore(clients)

	return conn
}

func TestForgejo_BeginPublic_AsksForTheOwnersClientWithNoSecret(t *testing.T) {
	t.Parallel()

	conn := newPublicConn(t, &memoryTokens{}, &memoryClients{})
	u, err := url.Parse(conn.BeginPublic("https://git.example.com", "owner-client"))
	require.NoError(t, err)

	assert.Equal(t, "owner-client", u.Query().Get("client_id"))
	assert.Equal(t, "S256", u.Query().Get("code_challenge_method"))
	assert.Equal(t, testRedirect, u.Query().Get("redirect_uri"))
	assert.Equal(t, forgejoScopes, u.Query().Get("scope"), "scopes are asked for explicitly, since a grant with none is given all")
}

func TestForgejo_Scopes_ListsWhatTheCodeAsksFor(t *testing.T) {
	t.Parallel()

	assert.Equal(t, forgejoScopes, strings.Join(oauth.ForgejoScopes(), " "))
}

func TestForgejo_Finish_PublicClientStoresItsClientIDOnlyOnSuccess(t *testing.T) {
	t.Parallel()

	forge, store, clients := newFakeForgejo(t), &memoryTokens{}, &memoryClients{}
	forge.publicClient = "owner-client"
	conn := newPublicConn(t, store, clients)

	u, err := url.Parse(conn.BeginPublic(forge.server.URL, "owner-client"))
	require.NoError(t, err)
	forge.setChallenge(u.Query().Get("code_challenge"))

	_, _, err = conn.Finish(t.Context(), "wrong-state", goodCode)
	require.Error(t, err)
	assert.Empty(t, clients.current(), "a failed attempt stores nothing")

	_, account, err := conn.Finish(t.Context(), u.Query().Get("state"), goodCode)
	require.NoError(t, err)
	assert.Equal(t, "alice", account)
	assert.Equal(t, "owner-client", clients.current())
}

func TestForgejo_Bearer_PublicClientRefreshesWithItsStoredClientIDAndNoSecret(t *testing.T) {
	t.Parallel()

	forge := newFakeForgejo(t)
	forge.publicClient = "owner-client"
	store := &memoryTokens{instance: forge.server.URL, token: &oauth2.Token{
		AccessToken: "access-1", RefreshToken: "refresh-1", Expiry: time.Now().Add(-time.Minute),
	}}
	conn := newPublicConn(t, store, &memoryClients{id: "owner-client"})

	bearer, ok := conn.Bearer(t.Context(), forge.server.URL)
	require.True(t, ok)

	tok, err := bearer()
	require.NoError(t, err)
	assert.Equal(t, "access-2", tok)
	assert.Equal(t, "refresh-2", store.current().RefreshToken, "the rotated pair is saved")
}

func TestForgejo_Disconnect_ForgetsTheClientID(t *testing.T) {
	t.Parallel()

	clients := &memoryClients{id: "owner-client"}
	conn := newPublicConn(t, &memoryTokens{}, clients)

	require.NoError(t, conn.Disconnect(t.Context()))
	assert.Empty(t, clients.current())
}
