package oauth_test

import (
	"context"
	"errors"
	"net/url"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

// failingTokens is a token store that cannot save.
type failingTokens struct{ *memoryTokens }

func (failingTokens) SaveOAuthToken(context.Context, string, string, *oauth2.Token) error {
	return errors.New("disk full")
}

func TestForgejo_Finish_APublicClientIDDoesNotOutliveAFailedTokenSave(t *testing.T) {
	t.Parallel()

	forge, clients := newFakeForgejo(t), &memoryClients{}
	forge.publicClient = "owner-client"
	conn := oauth.NewForgejo(t.Context(), "", "", testRedirect, failingTokens{&memoryTokens{}})
	conn.UseClientStore(clients)

	u, err := url.Parse(conn.BeginPublic(forge.server.URL, "owner-client"))
	require.NoError(t, err)
	forge.setChallenge(u.Query().Get("code_challenge"))

	_, _, err = conn.Finish(t.Context(), u.Query().Get("state"), goodCode)

	require.Error(t, err)
	assert.Empty(t, clients.current(), "an id with no token would poison the next refresh")
}

func TestForgejo_Finish_LinkingThroughTheServersClientForgetsAStalePublicID(t *testing.T) {
	t.Parallel()

	forge, store, clients := newFakeForgejo(t), &memoryTokens{}, &memoryClients{id: "stale-owner-client"}
	conn := newForgejoConn(t, store)
	conn.UseClientStore(clients)
	q := begun(t, conn, forge, forge.server.URL)

	_, _, err := conn.Finish(t.Context(), q.Get("state"), goodCode)

	require.NoError(t, err)
	assert.Empty(t, clients.current(), "a refresh must use the server's client, not an old public one")
}
