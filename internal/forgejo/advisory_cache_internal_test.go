package forgejo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/osv"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAdvisoryCache_KeepsPackagesForARetryPastTheAnswer(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c := newAdvisoryCache()
	c.Max = 2
	c.Now = func() time.Time { return now }

	c.Put("held", advisoryEntry{havePkgs: true, pkgsUntil: now.Add(2 * time.Hour)}, time.Minute)
	c.Put("plain", advisoryEntry{}, time.Minute)
	now = now.Add(time.Hour)
	c.Put("new", advisoryEntry{}, time.Hour)

	_, _, held := c.Get("held")
	_, _, plain := c.Get("plain")
	assert.True(t, held, "packages read from the forge outlive the answer for the retry")
	assert.False(t, plain)
}

func TestWithoutOwnHost_IgnoresCaseAndPort(t *testing.T) {
	t.Parallel()
	pkgs := []osv.Package{
		{Ecosystem: osv.EcosystemGo, Name: "git.example.com/team/lib", Version: "1.0.0"},
		{Ecosystem: osv.EcosystemGo, Name: "Git.Example.COM:3000/team/other", Version: "1.0.0"},
		{Ecosystem: osv.EcosystemGo, Name: "git.example.com", Version: "1.0.0"},
		{Ecosystem: osv.EcosystemGo, Name: "git.example.com.evil.io/x", Version: "1.0.0"},
		{Ecosystem: osv.EcosystemGo, Name: "github.com/a/b", Version: "1.0.0"},
		{Ecosystem: osv.EcosystemNPM, Name: "git.example.com", Version: "1.0.0"},
	}
	for _, instance := range []string{"https://Git.Example.com", "https://git.example.com:3000", "HTTPS://GIT.EXAMPLE.COM:8443/"} {
		c := &Client{clientState: &clientState{instanceURL: strings.TrimSuffix(instance, "/")}}
		kept, dropped := c.withoutOwnHost(pkgs)
		assert.Equal(t, 3, dropped, instance)
		assert.Equal(t, []string{"git.example.com.evil.io/x", "github.com/a/b", "git.example.com"},
			[]string{kept[0].Name, kept[1].Name, kept[2].Name}, instance)
	}
}

func TestFailedRead_KeepsTheUnreadableMark(t *testing.T) {
	t.Parallel()
	c := &Client{clientState: &clientState{advisories: newAdvisoryCache()}}
	old := advisoryEntry{unreadable: true, value: dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}}
	c.failedRead("k", dashboard.RepoRef{FullName: "o/n"}, old, true, nil, nil, assert.AnError)

	got, _, _ := c.advisories.Get("k")
	assert.True(t, got.unreadable, "a transient failure must not make the next success warn again")
}

func TestRawRequestMax_ARefusalWithABigBodyIsNotASuccess(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(strings.Repeat("x", 100)))
	}))
	t.Cleanup(srv.Close)
	rec := &recordingRecorder{}
	c := NewClient(srv.URL, "t", "", rec)

	_, _, err := c.rawRequestMax(t.Context(), http.MethodGet, "/x", nil, 10)
	require.Error(t, err)
	require.ErrorIs(t, err, errForgeRefused, "a refusal stays a refusal whatever the size of its body")
	for _, e := range rec.entries {
		assert.NotEqual(t, requestlog.OutcomeSuccess, e.Outcome, "a 500 is not counted as a success")
	}
}

type recordingRecorder struct{ entries []requestlog.Entry }

func (r *recordingRecorder) Record(_ context.Context, e requestlog.Entry) error {
	r.entries = append(r.entries, e)

	return nil
}
