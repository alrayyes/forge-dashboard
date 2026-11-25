package settings_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStore_OAuthClientID_RoundTripsAndForgets(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)

	id, err := store.OAuthClientID(t.Context(), "forgejo")
	require.NoError(t, err)
	assert.Empty(t, id, "nothing saved yet")

	require.NoError(t, store.SaveOAuthClientID(t.Context(), "forgejo", "client-1"))
	require.NoError(t, store.SaveOAuthClientID(t.Context(), "forgejo", "client-2"))

	id, err = store.OAuthClientID(t.Context(), "forgejo")
	require.NoError(t, err)
	assert.Equal(t, "client-2", id)

	require.NoError(t, store.DeleteOAuthClientID(t.Context(), "forgejo"))

	id, err = store.OAuthClientID(t.Context(), "forgejo")
	require.NoError(t, err)
	assert.Empty(t, id)
}
