package settings_test

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func newTestStore(t *testing.T) *settings.Store {
	t.Helper()

	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "settings.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	cipher, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)

	store := settings.NewStore(db, cipher)
	require.NoError(t, store.Init(t.Context()))

	return store
}

func TestStore_SetThenGet_RoundTrips(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	want := settings.Credentials{
		GitHubToken:     "ghp_abc123",
		GitHubUsername:  "ryan",
		ForgejoURL:      "https://git.example.com",
		ForgejoToken:    "fj_xyz789",
		ForgejoUsername: "ryan",
	}
	require.NoError(t, store.Set(t.Context(), want))

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, want.GitHubToken, got.GitHubToken)
	assert.Equal(t, want.GitHubUsername, got.GitHubUsername)
	assert.Equal(t, want.ForgejoURL, got.ForgejoURL)
	assert.Equal(t, want.ForgejoToken, got.ForgejoToken)
	assert.Equal(t, want.ForgejoUsername, got.ForgejoUsername)
	assert.False(t, got.UpdatedAt.IsZero())
}

func TestStore_SetThenGet_RoundTripsRenovateRebaseLabel(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	want := settings.Credentials{RenovateRebaseLabel: "retry"}
	require.NoError(t, store.Set(t.Context(), want))

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "retry", got.RenovateRebaseLabel)
}

func TestStore_SetThenGet_RoundTripsTheme(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	want := settings.Credentials{Theme: "dark"}
	require.NoError(t, store.Set(t.Context(), want))

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "dark", got.Theme)
}

func TestStore_SetThenGet_RoundTripsGitHubAppInstallationID(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	want := settings.Credentials{GitHubAppInstallationID: 42}
	require.NoError(t, store.Set(t.Context(), want))

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, int64(42), got.GitHubAppInstallationID)
}

// TestStore_GitHubAppInstallationID_StoredAsPlainInteger confirms the
// design decision behind it (#620): unlike GitHubToken/ForgejoToken, this
// field is a bare, non-secret integer, meaningless without the App's own
// server-wide private key — so it's never run through Store's cipher,
// mirroring TestStore_TokensAreEncryptedAtRest's own raw-column-read
// pattern but asserting the opposite: the plaintext value is right there.
func TestStore_GitHubAppInstallationID_StoredAsPlainInteger(t *testing.T) {
	t.Parallel()

	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "settings.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	cipher, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)
	store := settings.NewStore(db, cipher)
	require.NoError(t, store.Init(t.Context()))

	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 42}))

	var rawColumn int64
	require.NoError(t, db.QueryRow(`SELECT github_app_installation_id FROM settings LIMIT 1`).Scan(&rawColumn))
	assert.Equal(t, int64(42), rawColumn)
}

func TestStore_Get_NeverSaved_ThemeDefaultsToEmptyMeaningSystem(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	got, err := store.Get(t.Context())
	require.ErrorIs(t, err, settings.ErrNotFound)
	assert.Empty(t, got.Theme)
}

func TestCredentials_RenovateRebaseLabelOrDefault_EmptyFallsBackToRenovatesOwnDefault(t *testing.T) {
	t.Parallel()
	c := settings.Credentials{}
	assert.Equal(t, "rebase", c.RenovateRebaseLabelOrDefault())
}

func TestCredentials_RenovateRebaseLabelOrDefault_UsesSavedValueWhenSet(t *testing.T) {
	t.Parallel()
	c := settings.Credentials{RenovateRebaseLabel: "needs-rebase"}
	assert.Equal(t, "needs-rebase", c.RenovateRebaseLabelOrDefault())
}

func TestStore_Get_NeverSaved_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.Get(t.Context())

	assert.ErrorIs(t, err, settings.ErrNotFound)
}

func TestStore_Set_Twice_ReplacesTheWholeRow(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubToken: "first-token"}))
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubToken: "second-token"}))

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "second-token", got.GitHubToken)
}

func TestStore_TokensAreEncryptedAtRest(t *testing.T) {
	t.Parallel()

	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "settings.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	cipher, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)
	store := settings.NewStore(db, cipher)
	require.NoError(t, store.Init(t.Context()))

	const secretToken = "ghp_this-must-never-appear-in-plaintext" // #nosec G101 -- a fake test fixture, not a real credential
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubToken: secretToken}))

	// Queried by scanning the one row that exists rather than
	// reconstructing the store's own user-id encoding here — this test
	// only cares what's in the column, not how the row is addressed.
	var rawColumn string
	require.NoError(t, db.QueryRow(`SELECT github_token FROM settings LIMIT 1`).Scan(&rawColumn))
	assert.NotContains(t, rawColumn, secretToken, "the raw database column must never hold the plaintext token")
	assert.NotEmpty(t, rawColumn)
}

func TestStore_EnsureWebhookCredentials_FirstCall_GeneratesNonEmptyValues(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	token, secret, err := store.EnsureWebhookCredentials(t.Context())

	require.NoError(t, err)
	assert.NotEmpty(t, token)
	assert.NotEmpty(t, secret)
	assert.NotEqual(t, token, secret, "the URL-facing token and the HMAC-signing secret must be two different values")
}

func TestStore_EnsureWebhookCredentials_SecondCall_ReturnsTheSameValues(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	firstToken, firstSecret, err := store.EnsureWebhookCredentials(t.Context())
	require.NoError(t, err)

	secondToken, secondSecret, err := store.EnsureWebhookCredentials(t.Context())
	require.NoError(t, err)

	assert.Equal(t, firstToken, secondToken, "a webhook already configured on a forge points at this URL — it can't change on every visit to Settings")
	assert.Equal(t, firstSecret, secondSecret)
}

func TestStore_EnsureWebhookCredentials_AfterExistingSettingsSaved_LeavesThemIntact(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubToken: "ghp_existing", GitHubUsername: "ryan"}))

	_, _, err := store.EnsureWebhookCredentials(t.Context())
	require.NoError(t, err)

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "ghp_existing", got.GitHubToken, "generating webhook credentials must not disturb settings already saved")
	assert.Equal(t, "ryan", got.GitHubUsername)
}

func TestStore_Set_NeverOverwritesAlreadyGeneratedWebhookCredentials(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	token, secret, err := store.EnsureWebhookCredentials(t.Context())
	require.NoError(t, err)

	// A real settings save (the Settings page's own Save button) — it
	// doesn't know about webhook credentials at all, and shouldn't need
	// to for them to survive.
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubUsername: "octocat"}))

	gotToken, gotSecret, err := store.EnsureWebhookCredentials(t.Context())
	require.NoError(t, err)
	assert.Equal(t, token, gotToken)
	assert.Equal(t, secret, gotSecret)
}

func TestStore_Get_IncludesWebhookCredentialsOnceGenerated(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	token, secret, err := store.EnsureWebhookCredentials(t.Context())
	require.NoError(t, err)

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, token, got.WebhookToken)
	assert.Equal(t, secret, got.WebhookSecret)
}

func TestStore_WebhookDeliveries_NeverRecorded_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	got, err := store.WebhookDeliveries(t.Context())

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_RecordWebhookDelivery_ThenWebhookDeliveries_ReturnsIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.RecordWebhookDelivery(t.Context(), "github", "alrayyes/forge-dashboard"))

	got, err := store.WebhookDeliveries(t.Context())
	require.NoError(t, err)
	assert.Contains(t, got, settings.WebhookDeliveryKey("github", "alrayyes/forge-dashboard"))
}

func TestStore_GetFilterState_NeverSaved_ReturnsEmptyObject(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	got, err := store.GetFilterState(t.Context())

	require.NoError(t, err)
	assert.Equal(t, "{}", got)
}

func TestStore_SetFilterState_ThenGetFilterState_RoundTrips(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.SetFilterState(t.Context(), `{"shared":{"forge":"github"}}`))

	got, err := store.GetFilterState(t.Context())
	require.NoError(t, err)
	assert.JSONEq(t, `{"shared":{"forge":"github"}}`, got)
}

func TestStore_SetFilterState_Twice_ReplacesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.SetFilterState(t.Context(), `{"shared":{"forge":"github"}}`))
	require.NoError(t, store.SetFilterState(t.Context(), `{"shared":{"forge":"forgejo"}}`))

	got, err := store.GetFilterState(t.Context())
	require.NoError(t, err)
	assert.JSONEq(t, `{"shared":{"forge":"forgejo"}}`, got)
}

func TestStore_SetFilterState_BeforeAnySettingsSaved_StillWorks(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	// No Set/EnsureWebhookCredentials call first — a brand-new user who's
	// never touched Settings at all, only the filter bar.
	require.NoError(t, store.SetFilterState(t.Context(), `{"shared":{}}`))

	got, err := store.GetFilterState(t.Context())
	require.NoError(t, err)
	assert.JSONEq(t, `{"shared":{}}`, got)
}

func TestStore_SetFilterState_AfterExistingSettingsSaved_LeavesThemIntact(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubUsername: "ryan"}))

	require.NoError(t, store.SetFilterState(t.Context(), `{"shared":{"forge":"github"}}`))

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "ryan", got.GitHubUsername, "saving filter state must not disturb settings already saved")
}

func TestStore_Set_NeverOverwritesAlreadySavedFilterState(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.SetFilterState(t.Context(), `{"shared":{"forge":"github"}}`))

	// A real settings save (the Settings page's own Save button) — it
	// doesn't know about filter state at all, and shouldn't need to for
	// it to survive.
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubUsername: "octocat"}))

	got, err := store.GetFilterState(t.Context())
	require.NoError(t, err)
	assert.JSONEq(t, `{"shared":{"forge":"github"}}`, got)
}

func TestStore_IgnoredRepos_NoneIgnored_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	got, err := store.IgnoredRepos(t.Context())

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_IgnoreRepo_ThenIgnoredRepos_ReturnsIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.IgnoreRepo(t.Context(), "github", "alrayyes/forge-dashboard", true, true))

	got, err := store.IgnoredRepos(t.Context())
	require.NoError(t, err)
	assert.Contains(t, got, settings.WebhookDeliveryKey("github", "alrayyes/forge-dashboard"))
}

func TestStore_IgnoreRepo_Twice_IsANoOp(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.IgnoreRepo(t.Context(), "github", "alrayyes/forge-dashboard", true, true))
	require.NoError(t, store.IgnoreRepo(t.Context(), "github", "alrayyes/forge-dashboard", true, true))

	got, err := store.IgnoredRepos(t.Context())
	require.NoError(t, err)
	assert.Len(t, got, 1)
}

func TestStore_IgnoreRepo_PRsOnly_LeavesIssuesVisible(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.IgnoreRepo(t.Context(), "github", "alrayyes/forge-dashboard", true, false))

	got, err := store.IgnoredRepos(t.Context())
	require.NoError(t, err)
	scope := got[settings.WebhookDeliveryKey("github", "alrayyes/forge-dashboard")]
	assert.True(t, scope.PRs)
	assert.False(t, scope.Issues)
}

func TestStore_IgnoreRepo_IssuesOnly_LeavesPRsVisible(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.IgnoreRepo(t.Context(), "github", "alrayyes/forge-dashboard", false, true))

	got, err := store.IgnoredRepos(t.Context())
	require.NoError(t, err)
	scope := got[settings.WebhookDeliveryKey("github", "alrayyes/forge-dashboard")]
	assert.False(t, scope.PRs)
	assert.True(t, scope.Issues)
}

func TestStore_IgnoreRepo_RepeatWithDifferentScope_ReplacesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.IgnoreRepo(t.Context(), "github", "alrayyes/forge-dashboard", true, false))

	require.NoError(t, store.IgnoreRepo(t.Context(), "github", "alrayyes/forge-dashboard", false, true))

	got, err := store.IgnoredRepos(t.Context())
	require.NoError(t, err)
	scope := got[settings.WebhookDeliveryKey("github", "alrayyes/forge-dashboard")]
	assert.False(t, scope.PRs)
	assert.True(t, scope.Issues)
}

func TestStore_UnignoreRepo_RemovesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.IgnoreRepo(t.Context(), "github", "alrayyes/forge-dashboard", true, true))

	require.NoError(t, store.UnignoreRepo(t.Context(), "github", "alrayyes/forge-dashboard"))

	got, err := store.IgnoredRepos(t.Context())
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_UnignoreRepo_NeverIgnored_IsANoOp(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	err := store.UnignoreRepo(t.Context(), "github", "alrayyes/forge-dashboard")

	require.NoError(t, err)
}

func TestStore_AutoUpdateBranchRepos_NoneEnabled_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	got, err := store.AutoUpdateBranchRepos(t.Context())

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_EnableAutoUpdateBranch_ThenAutoUpdateBranchRepos_ReturnsIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.EnableAutoUpdateBranch(t.Context(), "github", "alrayyes/forge-dashboard"))

	got, err := store.AutoUpdateBranchRepos(t.Context())
	require.NoError(t, err)
	assert.Contains(t, got, settings.WebhookDeliveryKey("github", "alrayyes/forge-dashboard"))
}

func TestStore_EnableAutoUpdateBranch_Twice_IsANoOp(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.EnableAutoUpdateBranch(t.Context(), "github", "alrayyes/forge-dashboard"))
	require.NoError(t, store.EnableAutoUpdateBranch(t.Context(), "github", "alrayyes/forge-dashboard"))

	got, err := store.AutoUpdateBranchRepos(t.Context())
	require.NoError(t, err)
	assert.Len(t, got, 1)
}

func TestStore_DisableAutoUpdateBranch_RemovesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.EnableAutoUpdateBranch(t.Context(), "github", "alrayyes/forge-dashboard"))

	require.NoError(t, store.DisableAutoUpdateBranch(t.Context(), "github", "alrayyes/forge-dashboard"))

	got, err := store.AutoUpdateBranchRepos(t.Context())
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_DisableAutoUpdateBranch_NeverEnabled_IsANoOp(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	err := store.DisableAutoUpdateBranch(t.Context(), "github", "alrayyes/forge-dashboard")

	require.NoError(t, err)
}

func TestStore_RenovateRebaseLabel_NeverSaved_ReturnsDefault(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	got, err := store.RenovateRebaseLabel(t.Context())

	require.NoError(t, err)
	assert.Equal(t, "rebase", got)
}

func TestStore_RenovateRebaseLabel_ReflectsSavedCredentials(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{RenovateRebaseLabel: "needs-rebase"}))

	got, err := store.RenovateRebaseLabel(t.Context())

	require.NoError(t, err)
	assert.Equal(t, "needs-rebase", got)
}

func TestStore_SetThenGet_RoundTripsTimezone(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.Set(t.Context(), settings.Credentials{Timezone: "Europe/Amsterdam"}))

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "Europe/Amsterdam", got.Timezone)
}

func TestStore_Get_NeverSaved_TimezoneDefaultsToEmptyMeaningBrowser(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	got, err := store.Get(t.Context())
	require.ErrorIs(t, err, settings.ErrNotFound)
	assert.Empty(t, got.Timezone)
}

func TestStore_SetThenGet_RoundTripsTheIssueHidingSettings(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	want := settings.Credentials{HideDependencyDashboard: true, IgnoredTitles: []string{"^Weekly report", "a,b"}}
	require.NoError(t, store.Set(t.Context(), want))

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.True(t, got.HideDependencyDashboard)
	assert.Equal(t, []string{"^Weekly report", "a,b"}, got.IgnoredTitles, "a comma inside a pattern survives")
}

func TestStore_NeverSavedIssueHidingSettings_AreOffAndEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{Theme: "dark"}))

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.False(t, got.HideDependencyDashboard)
	assert.Empty(t, got.IgnoredTitles)
}

func TestStore_Get_CorruptIgnoredTitles_FallsBackToNoPatternsAndKeepsTheRest(t *testing.T) {
	t.Parallel()

	for _, bad := range []string{``, `{}`, `"x"`, `[1]`, `not json`} {
		t.Run(bad, func(t *testing.T) {
			t.Parallel()
			db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "settings.db")))
			require.NoError(t, err)
			t.Cleanup(func() { _ = db.Close() })
			cipher, err := settings.NewCipher(randomKey(t))
			require.NoError(t, err)
			store := settings.NewStore(db, cipher)
			require.NoError(t, store.Init(t.Context()))
			require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubToken: "ghp_keep", HideDependencyDashboard: true, IgnoredTitles: []string{"x"}}))
			_, err = db.ExecContext(t.Context(), `UPDATE settings SET ignored_titles = ?`, bad)
			require.NoError(t, err)

			got, err := store.Get(t.Context())

			require.NoError(t, err, "a bad list must not take the credentials with it")
			assert.Empty(t, got.IgnoredTitles)
			assert.Equal(t, "ghp_keep", got.GitHubToken)
			assert.True(t, got.HideDependencyDashboard)
		})
	}
}

func TestStore_WebhookSecretFor_TheSavedToken_ReturnsTheSecret(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	token, secret, err := store.EnsureWebhookCredentials(t.Context())
	require.NoError(t, err)

	got, err := store.WebhookSecretFor(t.Context(), token)

	require.NoError(t, err)
	assert.Equal(t, secret, got)
}

func TestStore_WebhookSecretFor_AnotherToken_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	_, _, err := store.EnsureWebhookCredentials(t.Context())
	require.NoError(t, err)

	_, err = store.WebhookSecretFor(t.Context(), "not-a-real-token")

	assert.ErrorIs(t, err, settings.ErrNotFound)
}

func TestStore_WebhookSecretFor_EmptyToken_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	// Settings saved before the webhook was set up hold an empty token. An
	// empty token in a request must never match it.
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubUsername: "ryan"}))

	_, err := store.WebhookSecretFor(t.Context(), "")

	assert.ErrorIs(t, err, settings.ErrNotFound)
}
