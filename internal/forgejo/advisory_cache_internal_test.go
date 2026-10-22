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

func TestAdvisoryCache_DropsExpiredEntriesWhenFull(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c := &advisoryCache{max: 3, now: func() time.Time { return now }}

	c.put("gone-1", advisoryEntry{}, time.Minute)
	c.put("gone-2", advisoryEntry{pkgs: nil}, time.Minute)
	now = now.Add(time.Hour)
	c.put("live-1", advisoryEntry{}, time.Hour)
	c.put("live-2", advisoryEntry{}, time.Hour)

	assert.Len(t, c.entries, 2, "the two expired entries went when the cache filled")
	assert.Contains(t, c.entries, "live-1")
	assert.Contains(t, c.entries, "live-2")
}

func TestAdvisoryCache_NeverGrowsPastItsLimit(t *testing.T) {
	t.Parallel()
	c := &advisoryCache{max: 3}
	for _, k := range []string{"a", "b", "c", "d", "e"} {
		c.put(k, advisoryEntry{}, time.Hour)
	}
	assert.LessOrEqual(t, len(c.entries), 3)
	assert.Contains(t, c.entries, "e", "the newest entry is kept")
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
	c := &Client{clientState: &clientState{advisories: &advisoryCache{}}}
	old := advisoryEntry{unreadable: true, value: dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}}
	c.failedRead("k", dashboard.RepoRef{FullName: "o/n"}, old, true, nil, nil, assert.AnError)

	assert.True(t, c.advisories.entries["k"].unreadable, "a transient failure must not make the next success warn again")
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
