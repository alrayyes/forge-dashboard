package api_test

import (
	"context"
	"net/http"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// kindSpy records the apistats kind its forge calls arrive under.
type kindSpy struct {
	fakePullRequestCloserSource
	fakeDetailerSource

	mu   sync.Mutex
	kind apistats.Kind
}

func (s *kindSpy) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *kindSpy) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}
}

func (s *kindSpy) note(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.kind = apistats.KindFrom(ctx)
}

func (s *kindSpy) seen() apistats.Kind {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.kind
}

func (s *kindSpy) ClosePullRequest(ctx context.Context, _, _ string, _ int) error {
	s.note(ctx)

	return nil
}

func (s *kindSpy) GetPullRequestDetails(ctx context.Context, _, _ string, _ int) (dashboard.PullRequestDetails, error) {
	s.note(ctx)

	return sampleDetails(), nil
}

func TestAPIStats_AUserActionIsTaggedUserAction(t *testing.T) {
	t.Parallel()

	spy := &kindSpy{}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, spy)

	resp := postClosePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, apistats.KindUserAction, spy.seen())
}

func TestAPIStats_ADetailsReadIsTaggedDetails(t *testing.T) {
	t.Parallel()

	spy := &kindSpy{}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, spy)

	resp := getPullRequestDetails(t, srvURL, sessionCookie, "github", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, apistats.KindDetails, spy.seen())
}
