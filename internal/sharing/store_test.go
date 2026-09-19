package sharing_test

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/sharing"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func newTestStore(t *testing.T) *sharing.Store {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "sharing.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	store := sharing.NewStore(db)
	require.NoError(t, store.Init(t.Context()))

	return store
}

func TestStore_Share_ThenIsSharedWith_ReportsTrue(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	owner, viewer := []byte("owner-1"), []byte("viewer-1")

	require.NoError(t, store.Share(t.Context(), owner, viewer))

	shared, err := store.IsSharedWith(t.Context(), owner, viewer)
	require.NoError(t, err)
	assert.True(t, shared)
}

func TestStore_IsSharedWith_NeverShared_ReportsFalse(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	shared, err := store.IsSharedWith(t.Context(), []byte("owner-1"), []byte("viewer-1"))
	require.NoError(t, err)
	assert.False(t, shared)
}

func TestStore_Share_Twice_IsIdempotent(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	owner, viewer := []byte("owner-1"), []byte("viewer-1")

	require.NoError(t, store.Share(t.Context(), owner, viewer))
	require.NoError(t, store.Share(t.Context(), owner, viewer))

	all, err := store.SharedWith(t.Context(), owner)
	require.NoError(t, err)
	assert.Len(t, all, 1)
}

func TestStore_Unshare_MakesIsSharedWithFalse(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	owner, viewer := []byte("owner-1"), []byte("viewer-1")
	require.NoError(t, store.Share(t.Context(), owner, viewer))

	require.NoError(t, store.Unshare(t.Context(), owner, viewer))

	shared, err := store.IsSharedWith(t.Context(), owner, viewer)
	require.NoError(t, err)
	assert.False(t, shared)
}

func TestStore_Unshare_NeverShared_IsANoOp(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	assert.NoError(t, store.Unshare(t.Context(), []byte("owner-1"), []byte("viewer-1")))
}

func TestStore_SharedWith_ReturnsEveryViewer(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	owner := []byte("owner-1")
	viewerA, viewerB := []byte("viewer-a"), []byte("viewer-b")

	require.NoError(t, store.Share(t.Context(), owner, viewerA))
	require.NoError(t, store.Share(t.Context(), owner, viewerB))

	viewers, err := store.SharedWith(t.Context(), owner)
	require.NoError(t, err)
	assert.ElementsMatch(t, [][]byte{viewerA, viewerB}, viewers)
}

func TestStore_SharedWithMe_ReturnsEveryOwner(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	viewer := []byte("viewer-1")
	ownerA, ownerB := []byte("owner-a"), []byte("owner-b")

	require.NoError(t, store.Share(t.Context(), ownerA, viewer))
	require.NoError(t, store.Share(t.Context(), ownerB, viewer))

	owners, err := store.SharedWithMe(t.Context(), viewer)
	require.NoError(t, err)
	assert.ElementsMatch(t, [][]byte{ownerA, ownerB}, owners)
}

func TestStore_DeleteUser_RemovesEveryShareInvolvingThem(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	owner, viewer, other := []byte("owner-1"), []byte("viewer-1"), []byte("other-1")

	require.NoError(t, store.Share(t.Context(), owner, viewer))
	require.NoError(t, store.Share(t.Context(), viewer, other))

	require.NoError(t, store.DeleteUser(t.Context(), viewer))

	sharedByOwner, err := store.SharedWith(t.Context(), owner)
	require.NoError(t, err)
	assert.Empty(t, sharedByOwner, "the share where the deleted user was the viewer should be gone")

	sharedByViewer, err := store.SharedWith(t.Context(), viewer)
	require.NoError(t, err)
	assert.Empty(t, sharedByViewer, "the share where the deleted user was the owner should be gone")
}
