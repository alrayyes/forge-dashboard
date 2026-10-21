package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestClassifyEvent(t *testing.T) {
	t.Parallel()

	cases := map[string]dashboard.EventClass{
		"check_run":     dashboard.EventClassCheck,
		"check_suite":   dashboard.EventClassCheck,
		"status":        dashboard.EventClassCheck,
		"pull_request":  dashboard.EventClassPullRequest,
		"issue_comment": dashboard.EventClassOther,
		"ping":          dashboard.EventClassOther,
		"":              dashboard.EventClassOther,
	}
	for event, want := range cases {
		t.Run(event, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, want, dashboard.ClassifyEvent(event))
		})
	}
}

func TestAggregator_RecordDelivery_CommentDoesNotMarkChecksSeen(t *testing.T) {
	t.Parallel()

	agg := dashboard.NewAggregator([]dashboard.Source{newFakeRepoRefresherSource()})
	agg.RecordDelivery(dashboard.ForgeGitHub, "alrayyes/a", "issue_comment")

	_, seen := agg.LastDelivery(dashboard.ForgeGitHub, "alrayyes/a", dashboard.EventClassCheck)

	assert.False(t, seen)
}

func TestAggregator_RecordDelivery_CheckEventMarksChecksSeenAtTheClockTime(t *testing.T) {
	t.Parallel()

	at := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	agg := dashboard.NewAggregator([]dashboard.Source{newFakeRepoRefresherSource()},
		dashboard.WithClock(func() time.Time { return at }))
	agg.RecordDelivery(dashboard.ForgeGitHub, "alrayyes/a", "check_run")

	got, seen := agg.LastDelivery(dashboard.ForgeGitHub, "alrayyes/a", dashboard.EventClassCheck)

	assert.True(t, seen)
	assert.Equal(t, at, got)
}

func TestAggregator_RecordDelivery_KeepsReposAndForgesApart(t *testing.T) {
	t.Parallel()

	agg := dashboard.NewAggregator([]dashboard.Source{newFakeRepoRefresherSource()})
	agg.RecordDelivery(dashboard.ForgeGitHub, "alrayyes/a", "check_run")

	_, otherRepo := agg.LastDelivery(dashboard.ForgeGitHub, "alrayyes/b", dashboard.EventClassCheck)
	_, otherForge := agg.LastDelivery(dashboard.ForgeForgejo, "alrayyes/a", dashboard.EventClassCheck)

	assert.False(t, otherRepo)
	assert.False(t, otherForge)
}

func TestAggregator_RecordDelivery_KeysByTheSourcesCredential(t *testing.T) {
	t.Parallel()

	src := &labeledSource{fakeRepoRefresherSource: newFakeRepoRefresherSource(), label: "tok-1"}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.RecordDelivery(dashboard.ForgeGitHub, "alrayyes/a", "check_run")

	src.label = "tok-2"
	_, seen := agg.LastDelivery(dashboard.ForgeGitHub, "alrayyes/a", dashboard.EventClassCheck)

	assert.False(t, seen, "a replaced credential starts with no deliveries")
}

type labeledSource struct {
	*fakeRepoRefresherSource
	label string
}

func (l *labeledSource) CredentialLabel() string { return l.label }
