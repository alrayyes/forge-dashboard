package settings_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWebhookSecretSynced_NothingRecorded_IsEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	fp, err := store.WebhookSecretSynced(t.Context())

	require.NoError(t, err)
	assert.Empty(t, fp)
}

func TestWebhookSecretSynced_AfterMark_ReturnsTheLatestFingerprint(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.MarkWebhookSecretSynced(t.Context(), "first"))
	require.NoError(t, store.MarkWebhookSecretSynced(t.Context(), "second"))

	fp, err := store.WebhookSecretSynced(t.Context())

	require.NoError(t, err)
	assert.Equal(t, "second", fp)
}
